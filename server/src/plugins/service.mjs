import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {acquirePluginInvocation} from './invocation-limit.mjs';
import {openPluginRegistry} from './registry.mjs';

const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const safeStatus=worker=>{
 const status=worker?.status?.();
 return{configured:status?.configured===true,available:status?.available===true};
};
const publicMetadata=value=>{const{id,version,name,description,sha256,createdAt}=value;return{id,version,name,description,sha256,createdAt};};

export async function createPluginService({dataDir,deviceExists,runtime,media,notify}={}){
 const registry=await openPluginRegistry(dataDir,{deviceExists}),accountDir=await realpath(dataDir),active=new Map();
 let closed=false,closing;
 const device=id=>{if(closed)throw fail(503,'plugin_service_closed');if(!deviceExists(id))throw fail(404,'device_not_found');};
 const capabilities=()=>({protocol:1,publish:true,bind:true,rollback:true,runtime:safeStatus(runtime),media:safeStatus(media)});
 async function invoke(deviceId,pluginId,input,{signal}={}){
  device(deviceId);
  if(!object(input)||Buffer.byteLength(JSON.stringify(input))>65536)throw fail(400,'plugin_invalid_input');
  const lease=await registry.lease(deviceId,pluginId),key=deviceId+'\0'+pluginId;
  device(deviceId);
  if(active.has(key))throw fail(429,'plugin_busy');
  if(!runtime)throw fail(503,'plugin_runtime_unavailable');
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw fail(400,'plugin_invalid_input');
  const admission=acquirePluginInvocation({key:JSON.stringify([accountDir,deviceId,pluginId])});
  const controller=new AbortController(),signals=[lease.signal,signal].filter(Boolean),listening=[];
  const onAbort=()=>controller.abort();
  let drained;const done=new Promise(resolve=>drained=resolve);
  active.set(key,{controller,deviceId,done});
  try{
   for(const source of signals){if(source.aborted)controller.abort();source.addEventListener('abort',onAbort,{once:true});listening.push(source);}
   const check=()=>{device(deviceId);lease.assertCurrent();if(controller.signal.aborted)throw fail(409,'plugin_invocation_cancelled');};
   check();
   // Readiness is a bounded observation, not an executing worker. Keep the
   // invocation tracked while waiting, and let revoke/close/cancel stop this
   // wait immediately without admitting a late runtime call.
   let readyAbort;
   try{
    await Promise.race([Promise.resolve().then(()=>runtime.ready?.()),new Promise(resolve=>{
     readyAbort=resolve;controller.signal.addEventListener('abort',readyAbort,{once:true});
    })]);
   }finally{controller.signal.removeEventListener('abort',readyAbort);}
   check();
   if(!safeStatus(runtime).configured)throw fail(503,'plugin_runtime_unavailable');
   const{manifest}=await registry.get(pluginId,lease.binding.version);
   const handler=manifest.capabilities.includes('request-handler')?'onDeviceRequest':manifest.capabilities.includes('event-handler')?'onDeviceEvent':'onDeviceMessage';
   const result=await runtime.invoke({source:manifest.server.source,handler,input,settings:lease.binding.settings,signal:controller.signal});
   check();
   if(result===undefined||Buffer.byteLength(JSON.stringify(result))>65536)throw fail(502,'plugin_invalid_result');
   if(object(result)&&Object.hasOwn(result,'youtubeFrame')){
    if(!exact(result,['youtubeFrame'])||!manifest.permissions.includes('media:youtube-frame'))throw fail(403,'plugin_effect_forbidden');
    if(!media||!safeStatus(media).configured)throw fail(503,'plugin_media_unavailable');
    const effect=result.youtubeFrame;
    if(!exact(effect,['videoId','fit']))throw fail(400,'plugin_invalid_effect');
    const frame=await media.frame({...effect,signal:controller.signal});
    check();
    if(!Buffer.isBuffer(frame?.rgb565)||frame.rgb565.length!==142080||frame.width!==240||frame.height!==296)throw fail(502,'plugin_media_invalid_frame');
    const sha256=createHash('sha256').update(frame.rgb565).digest('hex');
    if(frame.sha256!==sha256)throw fail(502,'plugin_media_invalid_frame');
    return{frame:{...frame,sha256},revision:lease.binding.revision};
   }
   if(object(result)&&Object.hasOwn(result,'notifications')){
    if(!exact(result,['notifications'])||!manifest.permissions.includes('notifications:create')||!notify)throw fail(403,'plugin_effect_forbidden');
    if(!Array.isArray(result.notifications)||result.notifications.length>8||result.notifications.some(item=>!exact(item,['title','message'])||typeof item.title!=='string'||!item.title.trim()||item.title.length>120||typeof item.message!=='string'||item.message.length>2000))throw fail(400,'plugin_invalid_effect');
    await lease.commit(async()=>{check();await notify(deviceId,result.notifications,check);check();});
    return{result:{queued:result.notifications.length}};
   }
   return{result};
  }catch(error){
   // A bounded adapter failure may leave work whose termination is uncertain.
   if(['plugin_runtime_cleanup_failed','plugin_media_cleanup_failed'].includes(error?.code))admission.quarantine();
   throw error;
  }finally{
   active.delete(key);for(const source of listening)source.removeEventListener('abort',onAbort);
   admission.release();drained();
  }
 }
 return{
  capabilities,
  list:async()=>{await runtime?.ready?.();return{capabilities:capabilities(),plugins:(await registry.list()).map(publicMetadata)};},
  publish:async input=>({plugin:publicMetadata(await registry.publish(input))}),
  bindings:async deviceId=>{device(deviceId);return{bindings:await registry.bindings(deviceId)};},
  bind:async(deviceId,input)=>{device(deviceId);return{binding:await registry.bind(deviceId,input)};},
  rollback:async(deviceId,input)=>{device(deviceId);return{binding:await registry.rollback(deviceId,input)};},
  invoke,
  reconcile(){for(const entry of active.values())if(!deviceExists(entry.deviceId))entry.controller.abort();},
  close(){
   if(!closing){
    closed=true;const running=[...active.values()];for(const entry of running)entry.controller.abort();
    closing=Promise.allSettled([registry.close(),...running.map(entry=>entry.done)]).then(results=>{if(results[0].status==='rejected')throw results[0].reason;});
   }
   return closing;
  },
 };
}
