import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createPluginService} from '../src/plugins/service.mjs';

const pluginId='test.video';
const frameBytes=Buffer.alloc(142080,0x39);
const frame={rgb565:frameBytes,width:240,height:296,sha256:createHash('sha256').update(frameBytes).digest('hex')};
const mediaEffect={youtubeFrame:{videoId:'4t4AQ15yj1M',fit:'contain'}};
const notificationEffect={notifications:[{title:'Test',message:'Fixture only'}]};
const status=()=>({configured:true,available:true});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const error=code=>Object.assign(new Error(code),{code});
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('operation did not start');}
const pack=()=>{const packageText=JSON.stringify({format:'kibi-plugin',manifestVersion:2,sdkVersion:'1.1',id:pluginId,version:'1.0.0',name:'Video',description:'',capabilities:['request-handler'],permissions:['media:youtube-frame','notifications:create'],settings:[],secrets:[],server:{language:'javascript',source:'throw new Error("DO NOT RUN")'}});return{packageText,sha256:createHash('sha256').update(packageText).digest('hex')};};
const binding=(patch={})=>({pluginId,version:'1.0.0',expectedRevision:0,enabled:true,settings:{},...patch});
async function harness(t){
 const services=[],dirs=[],gates=[];
 t.after(async()=>{for(const gate of gates)gate.resolve();await Promise.all(services.map(service=>service.close()));await Promise.all(dirs.map(dir=>rm(dir,{recursive:true,force:true})));});
 return{
  gate(){const gate=deferred();gates.push(gate);return gate;},
  async service({runtime={status,invoke:async()=>({ok:true})},media,notify,devices=new Set(['own']),dataDir}={}){
   const fresh=!dataDir;if(fresh){dataDir=await mkdtemp(join(tmpdir(),'kibi-plugin-service-'));dirs.push(dataDir);}
   const service=await createPluginService({dataDir,deviceExists:id=>devices.has(id),runtime,media,notify});services.push(service);
   if(fresh){await service.publish(pack());for(const deviceId of devices)await service.bind(deviceId,binding());}
   return{service,devices,dataDir};
  }
 };
}

test('four whole invocations include media and notification stages across account services',async t=>{
 const h=await harness(t),gate=h.gate();let entered=0,fifthStarted=false;
 const media={status,frame:async()=>{entered++;await gate.promise;return frame;}};
 const notify=async()=>{entered++;await gate.promise;};
 const services=[];
 for(let i=0;i<4;i++)services.push((await h.service({runtime:{status,invoke:async()=>i<2?mediaEffect:notificationEffect},media,notify})).service);
 const pending=services.map(service=>service.invoke('own',pluginId,{}));const outcomes=Promise.allSettled(pending);
 await until(()=>entered===4);
 const fifth=(await h.service({runtime:{status,invoke:async()=>{fifthStarted=true;return{ok:true};}}})).service;
 await assert.rejects(fifth.invoke('own',pluginId,{}),{code:'plugin_busy',status:429});assert.equal(fifthStarted,false);
 gate.resolve();assert.equal((await outcomes).every(result=>result.status==='fulfilled'),true);
 assert.deepEqual(await fifth.invoke('own',pluginId,{}),{result:{ok:true}});
});

test('one account device and plugin admission is shared by services for the same tenant store',async t=>{
 const h=await harness(t),gate=h.gate();let entered=false;
 const first=await h.service({runtime:{status,invoke:async()=>{entered=true;await gate.promise;return{ok:true};}}});
 const second=await h.service({dataDir:first.dataDir});
 const pending=first.service.invoke('own',pluginId,{});await until(()=>entered);
 await assert.rejects(second.service.invoke('own',pluginId,{}),{code:'plugin_busy'});
 const other=await h.service();assert.deepEqual(await other.service.invoke('own',pluginId,{}),{result:{ok:true}});
 gate.resolve();await pending;
 assert.deepEqual(await second.service.invoke('own',pluginId,{}),{result:{ok:true}});
});

test('runtime, effect validation, media and notification failures release whole-invocation admission',async t=>{
 const h=await harness(t),gate=h.gate(),devices=new Set(['one','two','three','four','five']);let mode='runtime',entered=0;
 const runtime={status,invoke:async()=>{
  if(mode==='runtime')throw error('fixture_runtime_failed');
  if(mode==='invalid')return undefined;
  if(mode==='media')return mediaEffect;
  if(mode==='notification')return notificationEffect;
  if(mode==='effect')return{youtubeFrame:{videoId:'bad'}};
  if(entered===4)return{overflow:true};entered++;await gate.promise;return{ok:true};
 }};
 const media={status,frame:async()=>{throw error('fixture_media_failed');}},notify=async()=>{throw error('fixture_notify_failed');};
 const{service}=await h.service({runtime,media,notify,devices});
 for(const [next,code] of [['runtime','fixture_runtime_failed'],['invalid','plugin_invalid_result'],['effect','plugin_invalid_effect'],['media','fixture_media_failed'],['notification','fixture_notify_failed']]){mode=next;await assert.rejects(service.invoke('one',pluginId,{}),{code});}
 mode='pending';const pending=[...devices].slice(0,4).map(id=>service.invoke(id,pluginId,{})),outcomes=Promise.allSettled(pending);
 await until(()=>entered===4);await assert.rejects(service.invoke('five',pluginId,{}),{code:'plugin_busy'});
 gate.resolve();assert.equal((await outcomes).every(result=>result.status==='fulfilled'),true);
});

test('caller cancellation retains admission until the actual runtime operation settles',async t=>{
 const h=await harness(t),gate=h.gate(),controller=new AbortController();let entered=false;
 const{service}=await h.service({runtime:{status,invoke:async()=>{entered=true;await gate.promise;return{late:true};}}});
 const pending=service.invoke('own',pluginId,{},{signal:controller.signal});const outcome=assert.rejects(pending,{code:'plugin_invocation_cancelled'});
 await until(()=>entered);controller.abort();await assert.rejects(service.invoke('own',pluginId,{}),{code:'plugin_busy'});
 const others=[];for(let i=0;i<3;i++){const next=await h.service({runtime:{status,invoke:async()=>{await gate.promise;return{};}}});others.push(next.service.invoke('own',pluginId,{}));}
 const otherOutcomes=Promise.allSettled(others),fifth=await h.service();
 await assert.rejects(fifth.service.invoke('own',pluginId,{}),{code:'plugin_busy'});
 gate.resolve();await outcome;await otherOutcomes;
 assert.deepEqual(await fifth.service.invoke('own',pluginId,{}),{result:{ok:true}});
});

for(const change of ['disable','rebind','rollback'])test(`${change} cancels media and rejects the prior revision without releasing admission early`,async t=>{
 const h=await harness(t),gate=h.gate();let mediaSignal;
 const{service}=await h.service({runtime:{status,invoke:async()=>mediaEffect},media:{status,frame:async input=>{mediaSignal=input.signal;await gate.promise;return frame;}}});
 if(change==='rollback')await service.bind('own',binding({expectedRevision:1}));
 const pending=service.invoke('own',pluginId,{}),outcome=assert.rejects(pending,{code:'plugin_binding_changed'});
 await until(()=>mediaSignal);
 if(change==='rollback')await service.rollback('own',{pluginId,expectedRevision:2,toRevision:1});
 else await service.bind('own',binding({expectedRevision:1,enabled:change!=='disable'}));
 assert.equal(mediaSignal.aborted,true);
 if(change==='disable')await service.bind('own',binding({expectedRevision:2}));
 await assert.rejects(service.invoke('own',pluginId,{}),{code:'plugin_busy'});
 gate.resolve();await outcome;
 const result=await service.invoke('own',pluginId,{});assert.equal(result.frame.sha256,frame.sha256);
});

test('deleting and re-adding a device cannot receive an earlier media result',async t=>{
 const h=await harness(t),gate=h.gate();let mediaSignal;
 const{service,devices}=await h.service({runtime:{status,invoke:async()=>mediaEffect},media:{status,frame:async input=>{mediaSignal=input.signal;await gate.promise;return frame;}}});
 const pending=service.invoke('own',pluginId,{}),outcome=assert.rejects(pending,{code:'plugin_invocation_cancelled'});
 await until(()=>mediaSignal);devices.delete('own');service.reconcile();devices.add('own');assert.equal(mediaSignal.aborted,true);
 await assert.rejects(service.invoke('own',pluginId,{}),{code:'plugin_busy'});gate.resolve();await outcome;
 assert.equal((await service.invoke('own',pluginId,{})).frame.sha256,frame.sha256);
});

test('service close waits for active notification operations and fences their late result',async t=>{
 const h=await harness(t),gate=h.gate();let entered=false,stopped=false;
 const{service}=await h.service({runtime:{status,invoke:async()=>notificationEffect},notify:async(deviceId,notifications,check)=>{entered=true;await gate.promise;stopped=true;check();}});
 const pending=service.invoke('own',pluginId,{}),outcome=assert.rejects(pending,{code:'plugin_service_closed'});
 await until(()=>entered);let closed=false;const closing=service.close().then(()=>closed=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(stopped,false);
 await assert.rejects(service.invoke('own',pluginId,{}),{code:'plugin_service_closed'});
 gate.resolve();await closing;await outcome;assert.equal(stopped,true);
});

test('a pre-aborted invocation does not start a runtime and returns its slot',async t=>{
 const h=await harness(t),controller=new AbortController();controller.abort();let calls=0;
 const{service}=await h.service({runtime:{status,invoke:async()=>{calls++;return{};}}});
 await assert.rejects(service.invoke('own',pluginId,{},{signal:controller.signal}),{code:'plugin_invocation_cancelled'});assert.equal(calls,0);
 await service.invoke('own',pluginId,{});assert.equal(calls,1);
});

// A quarantined slot intentionally lasts for this process, so keep this case last.
test('uncertain worker cleanup quarantines admission while close still completes',async t=>{
 const h=await harness(t),gate=h.gate();let entered=0;
 const failed=await h.service({runtime:{status,invoke:async()=>{throw error('plugin_runtime_cleanup_failed');}}});
 await assert.rejects(failed.service.invoke('own',pluginId,{}),{code:'plugin_runtime_cleanup_failed'});await failed.service.close();
 const pending=[];for(let i=0;i<3;i++){const next=await h.service({runtime:{status,invoke:async()=>{entered++;await gate.promise;return{};}}});pending.push(next.service.invoke('own',pluginId,{}));}
 const outcomes=Promise.allSettled(pending);await until(()=>entered===3);
 const overflow=await h.service();await assert.rejects(overflow.service.invoke('own',pluginId,{}),{code:'plugin_busy'});
 gate.resolve();await outcomes;
});
