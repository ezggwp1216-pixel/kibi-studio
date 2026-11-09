import {randomUUID} from 'node:crypto';
import {createOpusCodec} from './codec.mjs';
import {connectOfficialCloud,validateOfficialCloudConfiguration} from './official-socket.mjs';

const INPUT_BYTES=65536,INPUT_PACKETS=40,EVENT_BYTES=131072,OUTPUT_BYTES=512000,OUTPUT_MESSAGES=1500;
const codes=new Set(['idle','connecting','ready','closed','cancelled','configuration_required','unsupported_endpoint','device_protocol_invalid','codec_failed','input_backpressure','output_backpressure','authentication_required','quota_or_rate_limit','provider_error','provider_protocol_invalid','network_error','tls_failed','timeout']);
const failure=code=>Object.assign(new Error(codes.has(code)?code:'provider_error'),{code:codes.has(code)?code:'provider_error'});
const text=value=>typeof value==='string'&&value.length<=8192?value:null;
const validAudio=a=>a?.format==='opus'&&[16000,24000].includes(a.sample_rate)&&a.channels===1&&a.frame_duration===60;

/** Trusted gateway session. Configuration and transports are never device-controlled.
 * Hardware ACK is local playout information, never an upstream history truncate.
 */
export function createOfficialXiaozhiAdapter({configuration,sendDevice,connect=connectOfficialCloud,createCodec=createOpusCodec,signal,onStatus}={}){
 if(typeof sendDevice!=='function')throw failure('device_protocol_invalid');
 const sessionId=randomUUID(),life=new AbortController(),timers=new Set(),operations=new Set(),outbox=[],playbacks=new Map();
 const metrics={inputPackets:0,inputPcmBytes:0,droppedInputPackets:0,outputPackets:0,outputPcmBytes:0,turnsCompleted:0,pendingInputBytes:0,pendingOutputBytes:0,pendingOutputMessages:0,peakInputBytes:0,peakOutputBytes:0,peakOutputMessages:0};
 let code='idle',closed=false,helloSeen=false,codec,upstreamCodec,channel=null,epoch=0,connecting=null,desiredListen=false,listening=false;
 let current=null,generation=0,inputCount=0,eventBytes=0,eventCount=0,pumping=false,nextPacketAt=0,responseTimer=null;
 let inputTail=Promise.resolve(),eventTail=Promise.resolve();
 const snapshot=()=>({kind:'xiaozhi-official',code,closed,metrics:{...metrics}});
 const status=value=>{code=codes.has(value)?value:'provider_error';try{onStatus?.(snapshot());}catch{}};
 function bounded(value,ms=5000){return new Promise((resolve,reject)=>{
  let settled=false;const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);timers.delete(timer);operations.delete(cancel);error?reject(error):resolve(result);};
  const cancel=()=>finish(failure(code)),timer=setTimeout(()=>finish(failure('timeout')),ms);timers.add(timer);operations.add(cancel);
  Promise.resolve(value).then(result=>finish(null,result),error=>finish(failure(codes.has(error?.code)?error.code:'network_error')));if(closed)cancel();
 });}
 function deadline(active=false){if(responseTimer){clearTimeout(responseTimer);timers.delete(responseTimer);responseTimer=null;}if(active){responseTimer=setTimeout(()=>{responseTimer=null;void close('timeout');},90000);timers.add(responseTimer);}}
 function dropOutput(){for(const item of outbox.splice(0)){metrics.pendingOutputBytes-=item.bytes;metrics.pendingOutputMessages--;}}
 function retire(){const old=channel;channel=null;epoch++;listening=false;old?.controller.abort();try{old?.transport?.close();}catch{}}
 async function close(reason='closed'){
  if(closed)return;closed=true;desiredListen=false;generation++;status(reason);life.abort();retire();deadline();dropOutput();
  signal?.removeEventListener('abort',cancel);for(const stop of [...operations])stop();for(const timer of timers)clearTimeout(timer);timers.clear();
  try{codec?.close();}catch{}try{upstreamCodec?.close();}catch{}codec=null;upstreamCodec=null;playbacks.clear();current=null;
 }
 const cancel=()=>{void close('cancelled');};if(signal?.aborted)void close('cancelled');else signal?.addEventListener('abort',cancel,{once:true});
 const control=(type,values={})=>({session_id:sessionId,type,...values});
 function enqueue(payload,binary=false,response=null,kind='control',samples=0){
  if(closed)return;const bytes=binary?payload.length:Buffer.byteLength(JSON.stringify(payload));
  if(metrics.pendingOutputBytes+bytes>OUTPUT_BYTES||metrics.pendingOutputMessages>=OUTPUT_MESSAGES){void close('output_backpressure');return;}
  outbox.push({payload,binary,response,kind,samples,bytes,generation:response?generation:null});metrics.pendingOutputBytes+=bytes;metrics.pendingOutputMessages++;
  metrics.peakOutputBytes=Math.max(metrics.peakOutputBytes,metrics.pendingOutputBytes);metrics.peakOutputMessages=Math.max(metrics.peakOutputMessages,metrics.pendingOutputMessages);void pump();
 }
 async function pump(){
  if(pumping||closed)return;pumping=true;
  try{while(outbox.length&&!closed){const item=outbox.shift();try{
   if(item.generation!==null&&item.generation!==generation)continue;
   if(item.binary||item.kind==='stop'){
    const wait=nextPacketAt-Date.now();if(wait>0)await bounded(new Promise(resolve=>{const timer=setTimeout(()=>{timers.delete(timer);resolve();},wait);timers.add(timer);}),Math.max(1000,wait+100));
    if(closed||item.generation!==null&&item.generation!==generation)continue;
   }
   if(item.kind==='start'){item.response.start='sending';item.response.startResult=new Promise(resolve=>{item.response.resolveStart=resolve;});}
   try{await bounded(sendDevice(item.payload,{binary:item.binary}));}catch(error){if(item.kind==='start'){item.response.start='failed';item.response.resolveStart(false);}throw error;}
   // Resolve START even after its generation was cancelled: abort must know
   // whether the device actually saw it before deciding to emit a matching flush.
   if(item.kind==='start'){item.response.start='written';item.response.resolveStart(true);}
   if(closed)continue;
   if(item.binary){metrics.outputPackets++;item.response.deliveredSamples+=item.samples;nextPacketAt=Date.now()+60;}
   if(item.kind==='stop'){item.response.transportDone=true;await resumeAfterPlayback(item.response);}
  }finally{metrics.pendingOutputBytes-=item.bytes;metrics.pendingOutputMessages--;}}}
  catch(error){await close(error?.code==='timeout'?'timeout':'network_error');}finally{pumping=false;}
 }
 async function sendJson(payload,owner=channel){if(!owner?.transport||closed||owner!==channel)throw failure(closed?code:'network_error');await bounded(owner.transport.sendJson({...payload,...(owner.sessionId?{session_id:owner.sessionId}:{})}));}
 async function ensureChannel(){
  if(channel?.transport)return channel;if(connecting)return connecting;
  const owner={epoch:++epoch,controller:new AbortController(),transport:null,sessionId:null};channel=owner;
  const abort=()=>owner.controller.abort();life.signal.addEventListener('abort',abort,{once:true});
  connecting=(async()=>{
   const pending=Promise.resolve().then(()=>connect({configuration,signal:owner.controller.signal,onEvent:value=>{
    if(closed||owner!==channel||owner.epoch!==epoch)return Promise.resolve();
    // A connector can deliver a first event in the microtask before its promise
    // resolution. Queue it through the same finite event accounting.
    return queueEvent(owner,value);
   },onClose:reason=>{if(!closed&&owner===channel&&owner.epoch===epoch)void close(reason);}})).then(created=>{if(closed||owner!==channel||owner.epoch!==epoch){try{created?.close();}catch{}return null;}owner.transport=created;return created;});
   const created=await bounded(pending,10000);if(!created||closed)throw failure(code);
   if(!validAudio(created.hello?.audio_params)||typeof created.sendJson!=='function'||typeof created.sendAudio!=='function'||typeof created.close!=='function')throw failure('provider_protocol_invalid');
   owner.sessionId=typeof created.hello.session_id==='string'?created.hello.session_id:null;
   return owner;
  })();
  try{return await connecting;}finally{connecting=null;life.signal.removeEventListener('abort',abort);}
 }
 async function startListening(){
  if(closed||!desiredListen||current&&!current.resumed)return;
  const owner=await ensureChannel();if(closed||!desiredListen||owner!==channel||listening)return;
  // Official auto mode performs turn detection upstream; downstream V47 keeps
  // its unchanged realtime label. The uploaded payload stays raw 16 kHz Opus.
  await sendJson({type:'listen',state:'start',mode:'auto'},owner);listening=true;
 }
 async function resumeAfterPlayback(response){
  if(response.resumed||response.interrupted||!response.done||!response.transportDone||response.totalSamples>0&&(response.acknowledgedMs===null||response.acknowledgedMs<Math.floor(response.totalSamples/16)))return;
  response.resumed=true;if(current===response)current=null;await startListening();
 }
 function newResponse(){
  if(current&&!current.resumed)throw failure('provider_protocol_invalid');generation++;listening=false;deadline(true);codec.resetEncoder();upstreamCodec.resetDecoder();
  current={id:randomUUID(),playbackId:randomUUID(),start:'none',startResult:null,done:false,interrupted:false,transportDone:false,resumed:false,totalSamples:0,deliveredSamples:0,acknowledgedMs:null};
  playbacks.set(current.id,current);while(playbacks.size>32)playbacks.delete(playbacks.keys().next().value);return current;
 }
 async function event(owner,value){
  if(closed||owner!==channel||owner.epoch!==epoch)return;
  // Wait for the same channel's validated hello, without waiting on eventTail.
  if(!owner.transport)await ensureChannel();if(closed||owner!==channel)return;
  const {binary,payload}=value;
  if(binary){
   if(!Buffer.isBuffer(payload)||!payload.length||payload.length>1275)throw failure('provider_protocol_invalid');
   if(!current||current.done||current.interrupted)throw failure('provider_protocol_invalid');
   let decoded,packet;try{decoded=upstreamCodec.decode(payload);packet=codec.encode(decoded);}catch{throw failure('codec_failed');}
   const response=current;if(response.start==='none'){response.start='queued';enqueue(control('tts',{state:'start',response_id:response.id,playback_id:response.playbackId}),false,response,'start');}
   response.totalSamples+=decoded.length/2;metrics.outputPcmBytes+=decoded.length;enqueue(packet,true,response,'audio',decoded.length/2);return;
  }
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.type!=='string')throw failure('provider_protocol_invalid');
  if(payload.type==='error')throw failure('provider_error');
  if(payload.type==='stt'){const value=text(payload.text);if(value!==null){deadline(true);enqueue(control('stt',{text:value}));}return;}
  if(payload.type==='llm'||payload.type==='text'){const value=text(payload.text);if(value!==null)enqueue(control('text',{text:value,...(current?{response_id:current.id}:{})}),false,current);return;}
  if(payload.type!=='tts')return;
  if(payload.state==='start'){newResponse();return;}
  if(payload.state==='sentence_start'){const value=text(payload.text);if(value!==null)enqueue(control('text',{text:value,...(current?{response_id:current.id}:{})}),false,current);return;}
  if(payload.state==='sentence_end')return;
  if(payload.state!=='stop')throw failure('provider_protocol_invalid');
  if(!current||current.done)return;const response=current;response.done=true;deadline();metrics.turnsCompleted++;
  if(response.start==='none'){response.transportDone=true;await resumeAfterPlayback(response);return;}
  enqueue(control('tts',{state:'stop',response_id:response.id,playback_id:response.playbackId,total_samples:response.totalSamples,sample_rate:16000,audio_end_ms:Math.floor(response.totalSamples/16)}),false,response,'stop');
 }
 function queueEvent(owner,value){
  if(closed||owner!==channel)return Promise.resolve();let bytes;
  try{bytes=value?.binary?value.payload.length:Buffer.byteLength(JSON.stringify(value?.payload));}catch{void close('provider_protocol_invalid');return Promise.resolve();}
  if(!Number.isSafeInteger(bytes)||bytes>EVENT_BYTES||eventBytes+bytes>EVENT_BYTES||eventCount>=1500){void close('output_backpressure');return Promise.resolve();}
  const saved=value?.binary?{binary:true,payload:Buffer.from(value.payload)}:value;
  eventBytes+=bytes;eventCount++;const job=eventTail.then(async()=>{try{await event(owner,saved);}catch(error){await close(codes.has(error?.code)?error.code:'provider_protocol_invalid');}finally{eventBytes-=bytes;eventCount--;}});eventTail=job.catch(()=>{});return job;
 }
 async function interrupt(){
  deadline();desiredListen=false;listening=false;generation++;dropOutput();nextPacketAt=0;
  const response=current;current=null;if(response)response.interrupted=true;
  // Raw official packets carry no response identity. Retire the entire channel
  // before accepting another listen; a fresh hello fences late cloud audio.
  retire();if(!response)return;
  if(response.start==='sending')await response.startResult;
  if(!closed&&response.start==='written')enqueue(control('tts',{state:'stop',reason:'client_abort',flush:true,response_id:response.id,playback_id:response.playbackId}));
 }
 async function receiveDevice(message,{binary=false}={}){
  if(closed)throw failure(code);
  try{
   if(binary){
    if(!helloSeen||!listening&&!current||!Buffer.isBuffer(message)||!message.length||message.length>1275)throw failure('device_protocol_invalid');
    if(inputCount>=INPUT_PACKETS||metrics.pendingInputBytes+message.length>INPUT_BYTES)throw failure('input_backpressure');
    const packet=Buffer.from(message),owner=channel,wasListening=listening;inputCount++;metrics.pendingInputBytes+=packet.length;metrics.peakInputBytes=Math.max(metrics.peakInputBytes,metrics.pendingInputBytes);
    const job=inputTail.then(async()=>{try{if(closed)throw failure(code);if(owner!==channel)return;try{codec.decode(packet);}catch{throw failure('codec_failed');}if(!wasListening||!listening){metrics.droppedInputPackets++;return;}await bounded(owner.transport.sendAudio(packet));metrics.inputPackets++;metrics.inputPcmBytes+=1920;}finally{inputCount--;metrics.pendingInputBytes-=packet.length;}});inputTail=job.catch(()=>{});return await job;
   }
   if(typeof message==='string'){if(Buffer.byteLength(message)>16384)throw failure('device_protocol_invalid');try{message=JSON.parse(message);}catch{throw failure('device_protocol_invalid');}}
   if(!message||typeof message!=='object'||Array.isArray(message)||typeof message.type!=='string')throw failure('device_protocol_invalid');
   if(message.type==='hello'){
    if(helloSeen||message.version!==1||message.transport!=='websocket'||message.audio_params?.sample_rate!==16000||!validAudio(message.audio_params))throw failure('device_protocol_invalid');
    validateOfficialCloudConfiguration(configuration);helloSeen=true;status('connecting');codec=createCodec();upstreamCodec=createCodec();await ensureChannel();
    if(closed)throw failure(code);enqueue(control('hello',{version:1,transport:'websocket',audio_params:{format:'opus',sample_rate:16000,channels:1,frame_duration:60},features:{playback_ack:true,flush:true}}));status('ready');return;
   }
   if(!helloSeen||message.session_id!==undefined&&message.session_id!==sessionId)throw failure('device_protocol_invalid');
   if(message.type==='listen'&&message.state==='start'&&['auto','realtime'].includes(message.mode)){desiredListen=true;await startListening();return;}
   if(message.type==='listen'&&message.state==='stop'){await close();return;}
   if(message.type==='abort'){await interrupt();return;}
   if(message.type==='playback'){
    const response=playbacks.get(message.response_id);
    if(!response||message.playback_id!==response.playbackId||!Number.isSafeInteger(message.audio_end_ms)||message.audio_end_ms<0||message.audio_end_ms>Math.floor(response.deliveredSamples/16)||message.audio_end_ms<(response.acknowledgedMs??0))throw failure('device_protocol_invalid');
    response.acknowledgedMs=message.audio_end_ms;await resumeAfterPlayback(response);return;
   }
   throw failure('device_protocol_invalid');
  }catch(error){const reason=codes.has(error?.code)?error.code:/^codec_/.test(error?.message??'')?'codec_failed':'device_protocol_invalid';await close(reason);throw failure(reason);}
 }
 return {receiveDevice,close,snapshot};
}
