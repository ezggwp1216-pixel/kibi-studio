import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createPluginService} from '../src/plugins/service.mjs';
import {createPluginBrokerServer} from '../src/plugins/broker.mjs';
import {createPluginBrokerClient} from '../src/plugins/broker-client.mjs';

const pluginId='test.readiness';
const status=()=>({configured:true,available:true,reason:'ready'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const binding=(patch={})=>({pluginId,version:'1.0.0',expectedRevision:0,enabled:true,settings:{},...patch});
const packageInput=()=>{
 const packageText=JSON.stringify({format:'kibi-plugin',manifestVersion:2,sdkVersion:'1.1',id:pluginId,version:'1.0.0',name:'Readiness fixture',description:'',capabilities:['request-handler'],permissions:[],settings:[],secrets:[],server:{language:'javascript',source:'throw new Error("NEVER EXECUTE THIS SOURCE")'}});
 return{packageText,sha256:createHash('sha256').update(packageText).digest('hex')};
};
async function bounded(promise){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('operation waited for unresolved readiness')),1000);})]);}
 finally{clearTimeout(timer);}
}
async function serviceFixture(t,runtime,{cleanup=async()=>{}}={}){
 const directory=await mkdtemp('/private/tmp/kibi-service-ready-'),devices=new Set(['own']);
 const service=await createPluginService({dataDir:directory,deviceExists:id=>devices.has(id),runtime});
 t.after(async()=>{await cleanup();await service.close();await rm(directory,{recursive:true,force:true});});
 await service.publish(packageInput());await service.bind('own',binding());
 return{service,devices};
}
async function ipcFixture(t){
 const directory=await mkdtemp('/private/tmp/kibi-service-ipc-');let executions=0;
 const broker=createPluginBrokerServer({socketPath:directory+'/worker.sock',runtime:{status,invoke:async()=>{executions++;return{ok:true};}}});
 await broker.listen();const client=createPluginBrokerClient({socketPath:directory+'/worker.sock'});
 const fixture=await serviceFixture(t,client.runtime,{cleanup:async()=>{await client.close();await broker.close();await rm(directory,{recursive:true,force:true});}});
 return{...fixture,client,executions:()=>executions};
}
async function gatedFixture(t){
 const entered=deferred(),ready=deferred();let executions=0;
 const fixture=await serviceFixture(t,{status,ready:()=>{entered.resolve();return ready.promise;},invoke:async()=>{executions++;return{ok:true};}},{cleanup:async()=>ready.resolve()});
 return{...fixture,entered,ready,executions:()=>executions};
}
function rejection(pending,code){
 const outcome=assert.rejects(pending,{code});outcome.catch(()=>{});return outcome;
}
async function assertWaiting(entered,pending){
 const waiting=await Promise.race([entered.promise.then(()=>true),pending.then(()=>false,()=>false)]);
 assert.equal(waiting,true,'execution or listing completed before runtime readiness was observed');
}

test('first service list after broker cache expiry reports the freshly observed runtime',async t=>{
 const{service,client}=await ipcFixture(t);
 await client.ready();assert.equal(client.runtime.status().available,true);
 const now=Date.now();t.mock.method(Date,'now',()=>now+6000);
 const listing=await service.list();
 assert.deepEqual(listing.capabilities.runtime,{configured:true,available:true});
 assert.equal(listing.plugins[0].id,pluginId);
});

test('a cold broker client can execute the first service invocation without startup priming',async t=>{
 const{service,executions}=await ipcFixture(t);
 assert.deepEqual(await service.invoke('own',pluginId,{}),{result:{ok:true}});
 assert.equal(executions(),1);
});

test('disable and re-enable acknowledge while readiness is pending and fence the earlier revision',async t=>{
 const{service,entered,ready,executions}=await gatedFixture(t);
 const pending=service.invoke('own',pluginId,{});const outcome=rejection(pending,'plugin_binding_changed');
 await assertWaiting(entered,pending);
 await bounded(service.bind('own',binding({expectedRevision:1,enabled:false})));
 await bounded(service.bind('own',binding({expectedRevision:2})));
 await bounded(outcome);assert.equal(executions(),0);
 ready.resolve();assert.deepEqual(await service.invoke('own',pluginId,{}),{result:{ok:true}});
 assert.equal(executions(),1);
});

test('service shutdown completes while readiness is pending and a late readiness failure executes nothing',async t=>{
 const{service,entered,ready,executions}=await gatedFixture(t);
 const pending=service.invoke('own',pluginId,{});const outcome=rejection(pending,'plugin_service_closed');
 await assertWaiting(entered,pending);
 await bounded(service.close());await bounded(outcome);assert.equal(executions(),0);
 ready.reject(new Error('late fixture readiness failure'));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(executions(),0);
});

test('caller cancellation completes before pending readiness and releases invocation admission',async t=>{
 const{service,entered,ready,executions}=await gatedFixture(t),controller=new AbortController();
 const pending=service.invoke('own',pluginId,{},{signal:controller.signal});const outcome=rejection(pending,'plugin_invocation_cancelled');
 await assertWaiting(entered,pending);controller.abort();await bounded(outcome);assert.equal(executions(),0);
 ready.resolve();assert.deepEqual(await service.invoke('own',pluginId,{}),{result:{ok:true}});
 assert.equal(executions(),1);
});

test('device removal and reconcile during readiness fence a deleted and re-added device',async t=>{
 const{service,devices,entered,ready,executions}=await gatedFixture(t);
 const pending=service.invoke('own',pluginId,{});const outcome=rejection(pending,'plugin_invocation_cancelled');
 await assertWaiting(entered,pending);devices.delete('own');service.reconcile();devices.add('own');
 await bounded(outcome);ready.resolve();assert.equal(executions(),0);
 assert.deepEqual(await service.invoke('own',pluginId,{}),{result:{ok:true}});
});

test('a waiting list does not block shutdown or return a catalog after the registry closes',async t=>{
 const{service,entered,ready}=await gatedFixture(t);
 const pending=service.list(),outcome=rejection(pending,'plugin_registry_closed');
 await assertWaiting(entered,pending);await bounded(service.close());ready.resolve();await bounded(outcome);
});
