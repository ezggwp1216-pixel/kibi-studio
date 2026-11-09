import WebSocket from '../../resources/xiaozhi/network/ws-8.22.1/wrapper.mjs';

const MESSAGE_BYTES=131072,AUDIO_BYTES=1275,EVENT_BYTES=512000,EVENT_COUNT=1500,WRITE_COUNT=128;
const READY_MS=10000,WRITE_MS=5000;
const fault=code=>Object.assign(new Error(code),{code});
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&!Buffer.isBuffer(value);
const isEvent=value=>isObject(value)&&typeof value.type==='string'&&/^[A-Za-z0-9_.:-]{1,64}$/.test(value.type);

/** Trusted process configuration only; HTTP/device JSON cannot supply transport options. */
export function validateOfficialCloudConfiguration(configuration){
 if(!isObject(configuration))throw fault('configuration_required');
 let url;try{
  if(typeof configuration.url!=='string'||configuration.url.length>8192||!/^[\x21-\x7e]+$/.test(configuration.url))throw new Error();
  url=new URL(configuration.url);
  // OTA may return a private query. Keep the fixed official TLS origin/path;
  // neither queries nor transport metadata may change the destination.
  if(url.protocol!=='wss:'||url.hostname!=='api.tenclass.net'||url.port&&url.port!=='443'||url.pathname!=='/xiaozhi/v1/'||url.username||url.password||url.hash)throw new Error();
 }catch{throw fault('unsupported_endpoint');}
 const fields=['url','token','deviceId','clientId'];
 if(Object.keys(configuration).some(key=>!fields.includes(key)))throw fault('configuration_required');
 for(const [name,limit] of [['token',4096],['deviceId',256],['clientId',256]]){
  const value=configuration[name];if(typeof value!=='string'||!value.length||value.length>limit||!/^[\x21-\x7e]+$/.test(value))throw fault('configuration_required');
 }
 return {url:url.href,token:configuration.token,deviceId:configuration.deviceId,clientId:configuration.clientId};
}

function validHello(value){
 const audio=value.audio_params;
 return value.type==='hello'&&value.transport==='websocket'&&(value.version===undefined||value.version===1)&&
  isObject(audio)&&audio.format==='opus'&&[16000,24000].includes(audio.sample_rate)&&audio.channels===1&&audio.frame_duration===60&&
  (value.session_id===undefined||typeof value.session_id==='string'&&/^[\x20-\x7e]{1,256}$/.test(value.session_id));
}

function transportError(error){
 const code=error?.code;
 if(typeof code==='string'&&(code.startsWith('ERR_TLS_')||code.startsWith('ERR_SSL_')||code.startsWith('CERT_')||code.includes('SELF_SIGNED')||['UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)))return 'tls_failed';
 if(typeof code==='string'&&code.startsWith('WS_ERR_'))return 'provider_protocol_invalid';
 return 'network_error';
}

/** Official protocol v1: JSON control and raw Opus; no PCM/API-key transport.
 * WebSocketImpl is trusted dependency injection, never part of persisted configuration.
 * Events are awaited in order with finite pending byte/count budgets. Every outgoing
 * promise includes queue time and resolves only after ws's transport-write callback.
 */
export async function connectOfficialCloud({configuration,signal,onEvent,onClose,WebSocketImpl=WebSocket}={}){
 const config=validateOfficialCloudConfiguration(configuration);
 if(signal?.aborted)throw fault('cancelled');
 let ws,ended=false,ready=false,deliveryEnabled=false,helloWritten=false,hello=null,closeCode='closed';
 let writing=false,eventRunning=false,eventBytes=0,eventCount=0,writeBytes=0,writeCount=0;
 const events=[],writes=[],operations=new Set();
 let resolveReady,rejectReady;
 const opened=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const readyTimer=setTimeout(()=>finish('timeout'),READY_MS);
 const abort=()=>finish('cancelled');

 function finish(code){
  if(ended)return;ended=true;closeCode=code;clearTimeout(readyTimer);signal?.removeEventListener('abort',abort);
  events.length=0;eventBytes=0;eventCount=0;
  for(const cancel of [...operations])cancel(code);operations.clear();writes.length=0;
  // Keep the error sink and late-open handler: ws can still emit errors while
  // aborting its HTTP/TLS handshake, or finish opening after cancellation.
  try{ws?.terminate();}catch{}
  if(!ready)rejectReady(fault(code));
  try{Promise.resolve(onClose?.(code)).catch(()=>{});}catch{}
 }
 function maybeReady(){
  if(ended||ready||!hello||!helloWritten)return;
  ready=true;clearTimeout(readyTimer);resolveReady(connection);
  // Let the consumer receive the connection before handling a coalesced first event.
  setImmediate(()=>{deliveryEnabled=true;void pumpEvents();});
 }
 function boundedEvent(job){
  return new Promise((resolve,reject)=>{
   let settled=false;
   const done=(error)=>{if(settled)return;settled=true;clearTimeout(timer);operations.delete(cancel);error?reject(error):resolve();};
   const cancel=code=>done(fault(code));
   const timer=setTimeout(()=>{done(fault('timeout'));finish('timeout');},30000);
   operations.add(cancel);Promise.resolve(job).then(()=>done(),()=>done(fault('provider_protocol_invalid')));
   if(ended)cancel(closeCode);
  });
 }
 async function pumpEvents(){
  if(!deliveryEnabled||ended||eventRunning)return;eventRunning=true;
  try{
   while(events.length&&!ended){
    const item=events.shift();
    try{await boundedEvent(onEvent?.(item.event));}
    finally{eventBytes=Math.max(0,eventBytes-item.bytes);eventCount=Math.max(0,eventCount-1);}
   }
  }catch{if(!ended)finish('provider_protocol_invalid');}
  finally{eventRunning=false;}
 }
 function incoming(data,binary){
  if(ended)return;
  try{
   if(!Buffer.isBuffer(data)||data.length>MESSAGE_BYTES||binary&&(!data.length||data.length>AUDIO_BYTES))throw new Error();
   let payload;
   if(binary){if(!hello)throw new Error();payload=Buffer.from(data);}
   else{
    payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
    if(!isEvent(payload))throw new Error();
    if(!hello){if(!validHello(payload))throw new Error();hello=payload;connection.hello=hello;maybeReady();return;}
    if(payload.type==='hello')throw new Error();
   }
   if(eventCount>=EVENT_COUNT||eventBytes+data.length>EVENT_BYTES){finish('output_backpressure');return;}
   events.push({event:{binary:!!binary,payload},bytes:data.length});eventCount++;eventBytes+=data.length;
   void pumpEvents();
  }catch{finish('provider_protocol_invalid');}
 }
 function completeWrite(item,code){
  if(item.settled)return;item.settled=true;clearTimeout(item.timer);operations.delete(item.cancel);
  writeBytes=Math.max(0,writeBytes-item.bytes);writeCount=Math.max(0,writeCount-1);
  code?item.reject(fault(code)):item.resolve();
 }
 function pumpWrites(){
  if(writing||ended)return;
  const item=writes.shift();if(!item)return;
  writing=true;
  const done=error=>{
   if(item.settled)return;
   writing=false;
   if(error){completeWrite(item,'network_error');finish('network_error');return;}
   if((ws.bufferedAmount??0)>MESSAGE_BYTES){completeWrite(item,'input_backpressure');finish('input_backpressure');return;}
   completeWrite(item);pumpWrites();
  };
  try{
   if(ws.readyState!==1)throw new Error();
   if((ws.bufferedAmount??0)>MESSAGE_BYTES){completeWrite(item,'input_backpressure');writing=false;finish('input_backpressure');return;}
   if(item.pong)ws.pong(item.payload,undefined,done);
   else ws.send(item.payload,{binary:item.binary,compress:false},done);
  }catch{done(new Error());}
 }
 function write(payload,binary,pong=false){
  if(ended)return Promise.reject(fault(closeCode));
  const bytes=Buffer.byteLength(payload);
  if(writeCount>=WRITE_COUNT||writeBytes+bytes>MESSAGE_BYTES||(ws?.bufferedAmount??0)>MESSAGE_BYTES){finish('input_backpressure');return Promise.reject(fault('input_backpressure'));}
  return new Promise((resolve,reject)=>{
   const item={payload,binary,pong,bytes,resolve,reject,settled:false};
   item.cancel=code=>completeWrite(item,code);
   item.timer=setTimeout(()=>{completeWrite(item,'timeout');finish('timeout');},WRITE_MS);
   operations.add(item.cancel);writeBytes+=bytes;writeCount++;writes.push(item);pumpWrites();
  });
 }
 function sendJson(value){
  if(ended)return Promise.reject(fault(closeCode));
  let payload;try{if(!isEvent(value))throw new Error();payload=JSON.stringify(value);if(Buffer.byteLength(payload)>MESSAGE_BYTES)throw new Error();}catch{return Promise.reject(fault('provider_protocol_invalid'));}
  return write(payload,false);
 }
 function sendAudio(value){
  if(ended)return Promise.reject(fault(closeCode));
  if(!Buffer.isBuffer(value)||!value.length||value.length>AUDIO_BYTES)return Promise.reject(fault('provider_protocol_invalid'));
  return write(Buffer.from(value),true);
 }
 const connection={hello:null,sendJson,sendAudio,close:()=>finish('closed')};
 function open(){
  if(ended){try{ws.terminate();}catch{}return;}
  void sendJson({type:'hello',version:1,transport:'websocket',audio_params:{format:'opus',sample_rate:16000,channels:1,frame_duration:60}}).then(()=>{helloWritten=true;maybeReady();},()=>{if(!ended)finish('network_error');});
 }
 signal?.addEventListener('abort',abort,{once:true});
 try{
  ws=new WebSocketImpl(config.url,{
   headers:{Authorization:'Bearer '+config.token,'Protocol-Version':'1','Device-Id':config.deviceId,'Client-Id':config.clientId},
   rejectUnauthorized:true,minVersion:'TLSv1.2',followRedirects:false,perMessageDeflate:false,
   maxPayload:MESSAGE_BYTES,maxFragments:32,maxBufferedChunks:64,handshakeTimeout:READY_MS,
   closeTimeout:1000,skipUTF8Validation:false,autoPong:false
  });
  ws.on('error',error=>finish(transportError(error)));
  ws.on('close',()=>finish('closed'));
  ws.on('open',open);
  ws.on('message',incoming);
  ws.on('ping',payload=>{if(!ended)void write(Buffer.from(payload),true,true).catch(()=>{});});
  ws.on('unexpected-response',(request,response)=>{
   const status=response?.statusCode;
   finish(status===401||status===403?'authentication_required':status===429?'quota_or_rate_limit':'network_error');
   try{request.destroy();}catch{}try{response.destroy();}catch{}
  });
  if(ended||signal?.aborted){if(!ended)finish('cancelled');else ws.terminate();}
 }catch{finish('network_error');}
 return opened;
}
