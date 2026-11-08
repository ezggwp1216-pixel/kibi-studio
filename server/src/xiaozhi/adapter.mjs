import {randomUUID} from 'node:crypto';
import {createOpusCodec} from './codec.mjs';
import {PcmResampler} from './resample.mjs';
import {connectOpenAI,validateOpenAIConfiguration} from './openai-socket.mjs';

const INPUT_LIMIT=65536,OUTPUT_LIMIT=512000,OUTPUT_PACKETS=250,EVENT_LIMIT=131072;
const codes=new Set(['configuration_required','unsupported_endpoint','device_protocol_invalid','codec_failed','input_backpressure','output_backpressure','authentication_required','quota_or_rate_limit','provider_error','provider_protocol_invalid','network_error','tls_failed','timeout','cancelled','closed','ready','connecting','idle']);
const failure=code=>Object.assign(new Error(codes.has(code)?code:'provider_error'),{code:codes.has(code)?code:'provider_error'});
const providerFailure=error=>['invalid_api_key','authentication_error'].includes(error?.code)?'authentication_required':['insufficient_quota','rate_limit_exceeded'].includes(error?.code)?'quota_or_rate_limit':'provider_error';
const textValue=value=>typeof value==='string'&&value.length<=8192?value:null;
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256;

/** Trusted Node session core; never expose configuration/connect/createCodec to browser input.
 * sendDevice(payload,{binary}) must resolve after its bounded transport write completes.
 * Audio/text are transient user-channel payloads; snapshots/status never include either.
 */
export function createXiaozhiOpenAIAdapter({configuration,sendDevice,connect=connectOpenAI,createCodec=createOpusCodec,signal,onStatus}={}){
 if(typeof sendDevice!=='function')throw failure('device_protocol_invalid');
 const sessionId=randomUUID(),lifetime=new AbortController(),up=new PcmResampler(16000,24000),down=new PcmResampler(24000,16000);
 const metrics={inputPackets:0,inputPcmBytes:0,outputPackets:0,outputPcmBytes:0,turnsCompleted:0,pendingInputBytes:0,pendingOutputBytes:0,peakInputBytes:0,peakOutputBytes:0};
 let state='idle',closed=false,helloSeen=false,listening=false,connection,codec,providerReady=false,readyResolve,readyReject;
 let inputTail=Promise.resolve(),eventTail=Promise.resolve(),eventBytes=0,inputPacketsPending=0,pumping=false,generation=0,nextPacketAt=0,expectingResponse=false,current=null,responseDeadline;
 const outbox=[],timers=new Set(),operations=new Set(),stale=new Set(),playbacks=new Map();
 const snapshot=()=>({kind:'xiaozhi-openai-realtime',sessionId,code:state,closed,metrics:{...metrics}});
 const status=code=>{state=code;try{onStatus?.(snapshot());}catch{/* Presentation callbacks cannot affect the audio session. */}};
 function bounded(promise,ms=5000){return new Promise((resolve,reject)=>{
  let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);timers.delete(timer);operations.delete(cancelOperation);error?reject(error):resolve(value);};
  const cancelOperation=()=>finish(failure(state)),timer=setTimeout(()=>finish(failure('timeout')),ms);timers.add(timer);operations.add(cancelOperation);
  Promise.resolve(promise).then(value=>finish(null,value),error=>finish(codes.has(error?.code)?failure(error.code):failure('network_error')));
  if(closed)cancelOperation();
 });}
 async function close(code='closed'){
  if(closed)return;closed=true;listening=false;generation++;status(codes.has(code)?code:'provider_error');lifetime.abort();
  readyReject?.(failure(state));outbox.length=0;metrics.pendingOutputBytes=0;
  signal?.removeEventListener('abort',cancel);
  for(const stop of [...operations])stop();for(const timer of timers)clearTimeout(timer);timers.clear();
  try{connection?.close();}catch{}connection=null;
  try{codec?.close();}catch{}codec=null;up.reset();down.reset();playbacks.clear();current=null;
 }
 const cancel=()=>{void close('cancelled');};
 if(signal?.aborted)void close('cancelled');else signal?.addEventListener('abort',cancel,{once:true});
 const fatal=code=>{void close(code);};
 function responseTimeout(ms=0){if(responseDeadline){clearTimeout(responseDeadline);timers.delete(responseDeadline);responseDeadline=null;}if(ms){responseDeadline=setTimeout(()=>{timers.delete(responseDeadline);responseDeadline=null;fatal('timeout');},ms);timers.add(responseDeadline);}}
 async function sendProvider(event){if(closed||!connection)throw failure(closed?state:'network_error');await bounded(connection.send(event));if(closed)throw failure(state);}
 function forget(id){if(!id)return;stale.add(id);while(stale.size>32)stale.delete(stale.values().next().value);}
 function enqueue(payload,binary=false,response=null,kind='control',actualSamples=0){
  if(closed)return;
  const bytes=binary?payload.length:Buffer.byteLength(JSON.stringify(payload));
  if(metrics.pendingOutputBytes+bytes>OUTPUT_LIMIT||outbox.length>=OUTPUT_PACKETS){fatal('output_backpressure');return;}
  outbox.push({payload,binary,response,kind,actualSamples,generation:response?generation:null,bytes});metrics.pendingOutputBytes+=bytes;metrics.peakOutputBytes=Math.max(metrics.peakOutputBytes,metrics.pendingOutputBytes);
  void pump();
 }
 async function pump(){
  if(pumping||closed)return;pumping=true;
  try{while(outbox.length&&!closed){
   const item=outbox.shift();metrics.pendingOutputBytes-=item.bytes;
   if(item.generation!==null&&item.generation!==generation)continue;
   if(item.binary||item.kind==='stop'){
    const wait=nextPacketAt-Date.now();if(wait>0)await bounded(new Promise(resolve=>{const t=setTimeout(()=>{timers.delete(t);resolve();},wait);timers.add(t);}),Math.max(1000,wait+100));
    if(closed||(item.generation!==null&&item.generation!==generation))continue;
   }
   await bounded(sendDevice(item.payload,{binary:item.binary}));
   if(closed||item.generation!==null&&item.generation!==generation)continue;
   if(item.binary){metrics.outputPackets++;item.response.deliveredSamples+=item.actualSamples;nextPacketAt=Date.now()+60;}
   // A completed transport write is not a speaker/DMA playback acknowledgement.
   if(item.kind==='stop')item.response.transportDone=true;
  }}catch(error){fatal(error?.code==='timeout'?'timeout':'network_error');}finally{pumping=false;}
 }
 function control(type,values={}){return {session_id:sessionId,type,...values};}
 function beginOutput(response){
  if(response.started)return;response.started=true;
  enqueue(control('tts',{state:'start',response_id:response.id,playback_id:response.playbackId}),false,response);
 }
 function packetize(pcm,response,finish=false){
  const combined=response.tail.length?Buffer.concat([response.tail,pcm]):pcm;let at=0;
  while(combined.length-at>=1920&&!closed){beginOutput(response);const frame=combined.subarray(at,at+1920);enqueue(codec.encode(frame),true,response,'audio',960);at+=1920;}
  response.tail=Buffer.from(combined.subarray(at));
  if(finish&&response.tail.length&&!closed){beginOutput(response);const final=Buffer.alloc(1920);response.tail.copy(final);enqueue(codec.encode(final),true,response,'audio',response.tail.length/2);response.tail=Buffer.alloc(0);}
 }
 function fullyPlayed(response){return response.done&&response.transportDone&&response.acknowledgedMs!==null&&response.acknowledgedMs>=Math.floor(response.totalSamples/16);}
 async function interrupt(reason){
  if(!current||current.interrupted||fullyPlayed(current))return;
  const old=current;old.interrupted=true;forget(old.id);generation++;outbox.length=0;metrics.pendingOutputBytes=0;nextPacketAt=0;old.tail=Buffer.alloc(0);current=null;down.reset();codec?.resetEncoder();
  // Flush is a Kibi extension: the device must discard queued decoder/DMA audio.
  enqueue(control('tts',{state:'stop',reason,flush:true,response_id:old.id,playback_id:old.playbackId}));
  if(reason==='client_abort'&&!old.done)await sendProvider({type:'response.cancel',response_id:old.id});
  if(old.itemId){
   // With no hardware playback acknowledgement, zero is deliberately conservative.
   // Transport delivery is never reported as audio heard by the user.
   await sendProvider({type:'conversation.item.truncate',item_id:old.itemId,content_index:old.contentIndex,audio_end_ms:old.acknowledgedMs??0});
  }
 }
 async function event(event){
  if(closed)return;
  if(!event||typeof event!=='object'||typeof event.type!=='string')throw failure('provider_protocol_invalid');
  const type=event.type;
  if(type==='error'){fatal(providerFailure(event.error));return;}
  if(type==='session.updated'){providerReady=true;readyResolve?.();return;}
  if(type==='conversation.item.input_audio_transcription.failed')return; // Optional text, not the audio path.
  if(type==='input_audio_buffer.speech_started'){
   responseTimeout();expectingResponse=false;await interrupt('speech_started');return;
  }
  if(type==='input_audio_buffer.speech_stopped'){expectingResponse=true;responseTimeout(30000);return;}
  if(type==='conversation.item.input_audio_transcription.completed'){
   const text=textValue(event.transcript);if(text!==null)enqueue(control('stt',{text}));return;
  }
  if(type==='response.created'){
   const id=event.response?.id;if(!validId(id))throw failure('provider_protocol_invalid');
   if(stale.has(id))return;
   if(!expectingResponse){forget(id);return;}
   if(current&&!current.transportDone)await interrupt('superseded');
   expectingResponse=false;responseTimeout(90000);generation++;down.reset();codec.resetEncoder();
   current={id,playbackId:randomUUID(),itemId:null,contentIndex:0,tail:Buffer.alloc(0),started:false,done:false,transportDone:false,interrupted:false,totalSamples:0,deliveredSamples:0,acknowledgedMs:null};
   // Retain only recent correlation/duration state. Old PCM tails are empty after
   // completion/interruption; no transcript or whole audio response is retained.
   playbacks.set(id,current);while(playbacks.size>32)playbacks.delete(playbacks.keys().next().value);return;
  }
  if(!['response.output_audio.delta','response.output_audio.done','response.done','response.output_audio_transcript.delta','response.output_text.delta'].includes(type))return;
  const id=type==='response.done'?event.response?.id:event.response_id;
  if(!current||stale.has(id)||current.id!==id)return;
  if(type==='response.output_audio.delta'){
   if(current.done)return;
   if(!validId(event.item_id)||!Number.isSafeInteger(event.content_index??0)||(event.content_index??0)<0)throw failure('provider_protocol_invalid');
   if(current.itemId&&current.itemId!==event.item_id)throw failure('provider_protocol_invalid');
   current.itemId=event.item_id;current.contentIndex=event.content_index??0;
   const value=event.delta;
   if(typeof value!=='string'||!value.length||value.length>128000||value.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw failure('provider_protocol_invalid');
   const pcm=Buffer.from(value,'base64');if(pcm.length%2)throw failure('provider_protocol_invalid');
   const converted=down.process(pcm);metrics.outputPcmBytes+=converted.length;current.totalSamples+=converted.length/2;packetize(converted,current);return;
  }
  if(type==='response.output_audio_transcript.delta'||type==='response.output_text.delta'){
   const text=textValue(event.delta);if(text!==null)enqueue(control('text',{text,response_id:id}));return;
  }
  if(type==='response.output_audio.done')return; // response.done validates the final status before padding/STOP.
  responseTimeout();
  const result=event.response?.status,reason=event.response?.status_details?.reason;
  if(result==='cancelled'){current.done=true;await interrupt('provider_cancelled');return;}
  if(result!=='completed'&&!(result==='incomplete'&&reason==='max_output_tokens'))throw failure('provider_error');
  if(current.done)return;current.done=true;metrics.turnsCompleted++;packetize(Buffer.alloc(0),current,true);
  // Durations describe real PCM only; final Opus frame padding is not content.
  // The device can correlate a completed hardware drain with this exact target.
  enqueue(control('tts',{state:'stop',response_id:id,playback_id:current.playbackId,total_samples:current.totalSamples,sample_rate:16000,audio_end_ms:Math.floor(current.totalSamples/16)}),false,current,'stop');
 }
 function onEvent(value){
  if(closed)return Promise.resolve();
  let bytes;try{bytes=Buffer.byteLength(JSON.stringify(value));}catch{fatal('provider_protocol_invalid');return Promise.resolve();}
  if(bytes>EVENT_LIMIT||eventBytes+bytes>EVENT_LIMIT*2){fatal('output_backpressure');return Promise.resolve();}
  eventBytes+=bytes;
  const next=eventTail.then(async()=>{try{if(!closed)await event(value);}catch(error){fatal(codes.has(error?.code)?error.code:'provider_protocol_invalid');}finally{eventBytes-=bytes;}});
  eventTail=next.catch(()=>{});return next;
 }
 async function hello(message){
  if(helloSeen||message.version!==1||message.transport!=='websocket'||message.audio_params?.format!=='opus'||message.audio_params?.sample_rate!==16000||message.audio_params?.channels!==1||message.audio_params?.frame_duration!==60)throw failure('device_protocol_invalid');
  const {instructions}=validateOpenAIConfiguration(configuration);helloSeen=true;status('connecting');
  codec=createCodec();const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
  // The connector may ignore cancellation (test DI / late network completion).
  // Retire its eventual result even after the bounded caller has already unwound.
  const connecting=Promise.resolve(connect({configuration,signal:lifetime.signal,onEvent,onClose:code=>fatal(codes.has(code)?code:'network_error')})).then(created=>{if(closed){try{created?.close();}catch{}return null;}return created;});
  const created=await bounded(connecting,10000);
  if(closed){created?.close();throw failure(state);}connection=created;
  if(!connection||typeof connection.send!=='function'||typeof connection.close!=='function')throw failure('network_error');
  await sendProvider({type:'session.update',session:{type:'realtime',output_modalities:['audio'],instructions:instructions?.trim()?instructions:'Говори по-русски, естественно и кратко. Это непрерывный живой разговор.',max_output_tokens:512,audio:{input:{format:{type:'audio/pcm',rate:24000},noise_reduction:{type:'far_field'},transcription:{model:'gpt-4o-mini-transcribe',language:'ru'},turn_detection:{type:'server_vad',threshold:0.6,prefix_padding_ms:300,silence_duration_ms:650,create_response:true,interrupt_response:true}},output:{format:{type:'audio/pcm',rate:24000},voice:'marin'}}}});
  if(!providerReady)await bounded(ready,10000);if(closed)throw failure(state);
  enqueue(control('hello',{version:1,transport:'websocket',audio_params:{format:'opus',sample_rate:16000,channels:1,frame_duration:60},features:{playback_ack:true,flush:true}}));status('ready');
 }
 async function receiveDevice(message,{binary=false}={}){
  if(closed)throw failure(state);
  try{
   if(binary){
    if(!providerReady||!listening||!Buffer.isBuffer(message)||!message.length||message.length>1275)throw failure('device_protocol_invalid');
    if(metrics.pendingInputBytes+message.length>INPUT_LIMIT||inputPacketsPending>=40)throw failure('input_backpressure');
    const packet=Buffer.from(message);inputPacketsPending++;metrics.pendingInputBytes+=packet.length;metrics.peakInputBytes=Math.max(metrics.peakInputBytes,metrics.pendingInputBytes);
    const job=inputTail.then(async()=>{try{if(closed)throw failure(state);const decoded=codec.decode(packet),converted=up.process(decoded);await sendProvider({type:'input_audio_buffer.append',audio:converted.toString('base64')});metrics.inputPackets++;metrics.inputPcmBytes+=decoded.length;}finally{inputPacketsPending--;metrics.pendingInputBytes-=packet.length;}});
    inputTail=job.catch(()=>{});return await job;
   }
   if(typeof message==='string'){if(Buffer.byteLength(message)>16384)throw failure('device_protocol_invalid');try{message=JSON.parse(message);}catch{throw failure('device_protocol_invalid');}}
   if(!message||typeof message!=='object'||Array.isArray(message)||typeof message.type!=='string')throw failure('device_protocol_invalid');
   if(message.type==='hello'){await hello(message);return;}
   if(!providerReady||message.session_id!==undefined&&message.session_id!==sessionId)throw failure('device_protocol_invalid');
   if(message.type==='listen'&&message.state==='start'&&['auto','realtime'].includes(message.mode)){listening=true;return;}
   if(message.type==='listen'&&message.state==='stop'){await close();return;}
   if(message.type==='abort'){responseTimeout();expectingResponse=false;await interrupt('client_abort');return;}
   if(message.type==='playback'){
    const playback=playbacks.get(message.response_id);
    if(!playback||message.playback_id!==undefined&&message.playback_id!==playback.playbackId||!Number.isSafeInteger(message.audio_end_ms)||message.audio_end_ms<0||message.audio_end_ms>Math.floor(playback.deliveredSamples/16)||message.audio_end_ms<(playback.acknowledgedMs??0))throw failure('device_protocol_invalid');
    playback.acknowledgedMs=message.audio_end_ms;return;
   }
   throw failure('device_protocol_invalid');
  }catch(error){const code=codes.has(error?.code)?error.code:/^codec_/.test(error?.message??'')?'codec_failed':'device_protocol_invalid';await close(code);throw failure(code);}
 }
 return {receiveDevice,close,snapshot};
}
