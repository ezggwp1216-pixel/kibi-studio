import test from 'node:test';
import assert from 'node:assert/strict';
import {createXiaozhiOpenAIAdapter} from '../src/xiaozhi/adapter.mjs';
import {createOpusCodec} from '../src/xiaozhi/codec.mjs';

const configuration={api_key:'test-private-key-never-in-status',api_base_url:'https://api.openai.com/v1'};
const hello={type:'hello',version:1,transport:'websocket',audio_params:{format:'opus',sample_rate:16000,channels:1,frame_duration:60}};
const pcm=(rate,count)=>{const b=Buffer.alloc(count*2);for(let n=0;n<count;n++)b.writeInt16LE(Math.round(7000*Math.sin(2*Math.PI*440*n/rate)),n*2);return b;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let n=0;n<100;n++){if(check())return;await sleep(10);}assert.fail('condition did not settle');}
function fixture(options={}){
 const device=[],provider=[],statuses=[];let callbacks,closed=0,connects=0;
 const adapter=createXiaozhiOpenAIAdapter({configuration,sendDevice:async(payload,meta)=>{device.push({payload,meta});},onStatus:s=>statuses.push(s),connect:async c=>{callbacks=c;connects++;return {send:async event=>{provider.push(event);if(event.type==='session.update')queueMicrotask(()=>c.onEvent({type:'session.updated',session:{id:'upstream-private-session'}}));await options.providerSend?.(event);},close(){closed++;}};},...options});
 return {adapter,device,provider,statuses,event:e=>callbacks.onEvent(e),get closed(){return closed;},get connects(){return connects;}};
}
async function open(f){await f.adapter.receiveDevice(hello);await f.adapter.receiveDevice({type:'listen',state:'start',mode:'realtime'});}
async function turn(f,id){await f.event({type:'input_audio_buffer.speech_started'});await f.event({type:'input_audio_buffer.speech_stopped'});await f.event({type:'response.created',response:{id,status:'in_progress'}});await f.event({type:'response.output_audio.delta',response_id:id,item_id:'item-'+id,content_index:0,delta:pcm(24000,2880).toString('base64')});await f.event({type:'response.output_audio.done',response_id:id});await f.event({type:'response.done',response:{id,status:'completed'}});}

test('trusted server character instructions reach the live voice session while empty instructions preserve the default',async()=>{
 const character='Ты Киби. Говори спокойно и используй короткие фразы.';
 const f=fixture({configuration:{...configuration,instructions:character}});
 try{await open(f);assert.equal(f.provider.find(event=>event.type==='session.update').session.instructions,character);}finally{await f.adapter.close();}
 const empty=fixture({configuration:{...configuration,instructions:''}});
 try{await open(empty);assert.match(empty.provider.find(event=>event.type==='session.update').session.instructions,/Говори по-русски/);}finally{await empty.adapter.close();}
});

test('invalid or excessive trusted character instructions fail before provider connection',async()=>{
 for(const instructions of [123,{},'x'.repeat(4001)]){
  const f=fixture({configuration:{...configuration,instructions}});
  await assert.rejects(f.adapter.receiveDevice(hello),error=>error.code==='configuration_required');
  assert.equal(f.connects,0);assert.equal(f.adapter.snapshot().closed,true);
 }
});

test('actual Opus binary becomes Realtime PCM and two responses return Opus over one live connection',async()=>{
 const f=fixture(),codec=createOpusCodec();try{
 await open(f);const greeting=f.device.find(x=>x.payload.type==='hello').payload;assert.equal(greeting.audio_params.format,'opus');assert.equal(greeting.audio_params.frame_duration,60);assert.ok(greeting.session_id);
 const update=f.provider.find(x=>x.type==='session.update');assert.equal(update.session.audio.input.turn_detection.create_response,true);assert.equal(update.session.audio.input.turn_detection.interrupt_response,true);
 await f.adapter.receiveDevice(codec.encode(pcm(16000,960)),{binary:true});const upload=f.provider.find(x=>x.type==='input_audio_buffer.append');assert.equal(Buffer.from(upload.audio,'base64').length,2880);assert.ok(Buffer.from(upload.audio,'base64').some(x=>x!==0));
 await turn(f,'one');await until(()=>f.device.filter(x=>x.payload.type==='tts'&&x.payload.state==='stop'&&!x.payload.flush).length===1);
 await turn(f,'two');await until(()=>f.device.filter(x=>x.payload.type==='tts'&&x.payload.state==='stop'&&!x.payload.flush).length===2);
 const packets=f.device.filter(x=>x.meta.binary);assert.equal(packets.length,4);assert.ok(codec.decode(packets[0].payload).some(x=>x!==0));assert.equal(f.connects,1);assert.equal(f.adapter.snapshot().metrics.turnsCompleted,2);
 await f.adapter.receiveDevice({type:'listen',state:'stop'});assert.equal(f.adapter.snapshot().code,'closed');assert.equal(f.closed,1);
 }finally{codec.close();await f.adapter.close();}
});

test('unsupported hello and untrusted endpoints never start a provider',async()=>{
 for(const audio_params of [{...hello.audio_params,sample_rate:24000},{...hello.audio_params,channels:2},{...hello.audio_params,frame_duration:20}]){const f=fixture();await assert.rejects(f.adapter.receiveDevice({...hello,audio_params}),{message:'device_protocol_invalid'});assert.equal(f.connects,0);await f.adapter.close();}
 const f=fixture({configuration:{...configuration,api_base_url:'https://api.openai.com.evil.invalid/v1'}});await assert.rejects(f.adapter.receiveDevice(hello),{message:'unsupported_endpoint'});assert.equal(f.connects,0);await f.adapter.close();
});

test('abort flushes queued audio, truncates only acknowledged playback and ignores stale deltas',async()=>{
 const f=fixture();try{await open(f);await f.event({type:'input_audio_buffer.speech_stopped'});await f.event({type:'response.created',response:{id:'old'}});await f.event({type:'response.output_audio.delta',response_id:'old',item_id:'item-old',content_index:0,delta:pcm(24000,14400).toString('base64')});await until(()=>f.device.some(x=>x.meta.binary));
 await f.adapter.receiveDevice({type:'playback',response_id:'old',audio_end_ms:30});await f.adapter.receiveDevice({type:'abort'});
 const truncate=f.provider.find(x=>x.type==='conversation.item.truncate');assert.equal(truncate.audio_end_ms,30);const count=f.device.filter(x=>x.meta.binary).length;
 await f.event({type:'response.output_audio.delta',response_id:'old',item_id:'item-old',delta:pcm(24000,1440).toString('base64')});await sleep(90);assert.equal(f.device.filter(x=>x.meta.binary).length,count);assert.ok(f.device.some(x=>x.payload.type==='tts'&&x.payload.flush===true));assert.equal(f.adapter.snapshot().code,'ready');
 }finally{await f.adapter.close();}
});

test('slow provider has a bounded input queue and fixed privacy-safe failure',async()=>{
 let unblock;const blocked=new Promise(resolve=>{unblock=resolve;});const f=fixture({providerSend:event=>event.type==='input_audio_buffer.append'?blocked:undefined});const codec=createOpusCodec();try{await open(f);const packet=codec.encode(pcm(16000,960));const pending=Array.from({length:60},()=>f.adapter.receiveDevice(packet,{binary:true}).catch(e=>e.message));await until(()=>f.adapter.snapshot().code==='input_backpressure');assert.ok(f.adapter.snapshot().metrics.pendingInputBytes<=65536);unblock();await Promise.allSettled(pending);assert.equal(f.closed,1);assert.ok(!JSON.stringify(f.statuses).includes(configuration.api_key));}finally{unblock();codec.close();await f.adapter.close();}
});

test('provider auth/rate errors expose fixed codes, never provider messages, and do not retry',async()=>{
 for(const [code,want] of [['invalid_api_key','authentication_required'],['rate_limit_exceeded','quota_or_rate_limit'],['other','provider_error']]){const f=fixture();try{await open(f);await f.event({type:'error',error:{code,message:'secret transcript '+configuration.api_key}});assert.equal(f.adapter.snapshot().code,want);assert.equal(f.connects,1);assert.equal(f.closed,1);assert.ok(!JSON.stringify(f.statuses).includes('secret transcript'));assert.ok(!JSON.stringify(f.statuses).includes(configuration.api_key));}finally{await f.adapter.close();}}
});

test('abort signal closes provider and abort without play acknowledgement never claims heard duration',async()=>{
 const controller=new AbortController(),f=fixture({signal:controller.signal});try{await open(f);await f.event({type:'input_audio_buffer.speech_stopped'});await f.event({type:'response.created',response:{id:'x'}});await f.event({type:'response.output_audio.delta',response_id:'x',item_id:'item-x',delta:pcm(24000,1440).toString('base64')});await f.adapter.receiveDevice({type:'abort'});assert.equal(f.provider.find(x=>x.type==='conversation.item.truncate').audio_end_ms,0);controller.abort();await until(()=>f.adapter.snapshot().code==='cancelled');assert.equal(f.closed,1);}finally{await f.adapter.close();}
});

test('closing wakes a stalled upstream write immediately instead of leaving an operation deadline alive',async()=>{
 let began;const writing=new Promise(resolve=>{began=resolve;});
 const f=fixture({providerSend:event=>event.type==='input_audio_buffer.append'?(began(),new Promise(()=>{})):undefined}),codec=createOpusCodec();
 try{await open(f);const pending=f.adapter.receiveDevice(codec.encode(pcm(16000,960)),{binary:true}).catch(error=>error.message);await writing;await f.adapter.close();assert.equal(await Promise.race([pending,sleep(100).then(()=> 'still-waiting')]),'closed');}
 finally{codec.close();await f.adapter.close();}
});

test('a stalled device cannot accumulate unlimited generated speech',async()=>{
 const device=[];const f=fixture({sendDevice:async(payload,meta)=>{device.push({payload,meta});if(meta.binary)await new Promise(()=>{});}});
 try{await open(f);await f.event({type:'input_audio_buffer.speech_stopped'});await f.event({type:'response.created',response:{id:'long'}});
 for(let n=0;n<30&&!f.adapter.snapshot().closed;n++)await f.event({type:'response.output_audio.delta',response_id:'long',item_id:'item-long',delta:pcm(24000,14400).toString('base64')});
 assert.equal(f.adapter.snapshot().code,'output_backpressure');assert.ok(f.adapter.snapshot().metrics.peakOutputBytes<=512000);assert.equal(f.closed,1);
 }finally{await f.adapter.close();}
});

test('missing provider response has a deadline without retrying or billing another session',async t=>{
 const f=fixture();try{await open(f);t.mock.timers.enable({apis:['setTimeout']});await f.event({type:'input_audio_buffer.speech_stopped'});t.mock.timers.tick(30001);await Promise.resolve();assert.equal(f.adapter.snapshot().code,'timeout');assert.equal(f.connects,1);assert.equal(f.closed,1);}finally{t.mock.timers.reset();await f.adapter.close();}
});

test('closing during connect aborts it and retires even a cancellation-ignoring late connection',async()=>{
 let resolveConnect,options,retired=0;
 const f=fixture({connect:async supplied=>{options=supplied;return new Promise(resolve=>{resolveConnect=resolve;});}});
 const opened=f.adapter.receiveDevice(hello).catch(error=>error.message);await until(()=>options);await f.adapter.close();assert.equal(await opened,'closed');
 resolveConnect({send:async()=>{},close(){retired++;}});await sleep(0);
 assert.equal(options.signal.aborted,true);assert.equal(retired,1);
});

async function shortReply(f,id){
 await f.event({type:'input_audio_buffer.speech_stopped'});await f.event({type:'response.created',response:{id,status:'in_progress'}});
 await f.event({type:'response.output_audio.delta',response_id:id,item_id:'item-'+id,content_index:0,delta:pcm(24000,1440).toString('base64')});
 await f.event({type:'response.done',response:{id,status:'completed'}});
 await until(()=>f.device.some(x=>x.payload.type==='tts'&&x.payload.state==='stop'&&!x.payload.flush&&x.payload.response_id===id));
}

test('ordinary tts.stop never proves playback: a late zero ack followed by abort flushes and truncates completed audio',async()=>{
 const f=fixture();try{await open(f);await shortReply(f,'completed');await f.adapter.receiveDevice({type:'playback',response_id:'completed',audio_end_ms:0});await f.adapter.receiveDevice({type:'abort'});
 await until(()=>f.device.some(x=>x.payload.type==='tts'&&x.payload.flush===true));
 const cut=f.provider.find(x=>x.type==='conversation.item.truncate');assert.equal(cut.item_id,'item-completed');assert.equal(cut.audio_end_ms,0);assert.equal(f.provider.filter(x=>x.type==='response.cancel').length,0);assert.equal(f.adapter.snapshot().code,'ready');
 }finally{await f.adapter.close();}
});

test('late valid acknowledgements for prior delivered responses survive a new response and cannot change its heard position',async()=>{
 const f=fixture();try{await open(f);await shortReply(f,'previous');await f.event({type:'input_audio_buffer.speech_stopped'});await f.event({type:'response.created',response:{id:'current',status:'in_progress'}});
 await f.event({type:'response.output_audio.delta',response_id:'current',item_id:'item-current',content_index:0,delta:pcm(24000,1440).toString('base64')});await until(()=>f.device.filter(x=>x.meta.binary).length===2);
 await f.adapter.receiveDevice({type:'playback',response_id:'previous',audio_end_ms:0});await f.adapter.receiveDevice({type:'playback',response_id:'previous',audio_end_ms:30});assert.equal(f.adapter.snapshot().code,'ready');
 await f.adapter.receiveDevice({type:'abort'});const cut=f.provider.filter(x=>x.type==='conversation.item.truncate').at(-1);assert.equal(cut.item_id,'item-current');assert.equal(cut.audio_end_ms,0);assert.equal(f.provider.filter(x=>x.type==='response.cancel').at(-1).response_id,'current');
 }finally{await f.adapter.close();}
});

test('retained acknowledgement metadata still rejects forged, out-of-range and backwards positions',async()=>{
 for(const bad of [{response_id:'forged',audio_end_ms:0},{response_id:'old',audio_end_ms:61},{response_id:'old',audio_end_ms:29}]){
  const f=fixture();try{await open(f);await shortReply(f,'old');await f.adapter.receiveDevice({type:'playback',response_id:'old',audio_end_ms:30});await f.event({type:'input_audio_buffer.speech_stopped'});await f.event({type:'response.created',response:{id:'new'}});await assert.rejects(f.adapter.receiveDevice({type:'playback',...bad}),{message:'device_protocol_invalid'});}finally{await f.adapter.close();}
 }
});

test('VAD speech start truncates a transport-complete reply only to actual acknowledged playback',async()=>{
 const f=fixture();try{await open(f);await shortReply(f,'dma-tail');await f.adapter.receiveDevice({type:'playback',response_id:'dma-tail',audio_end_ms:0});await f.event({type:'input_audio_buffer.speech_started'});
 assert.equal(f.provider.find(x=>x.type==='conversation.item.truncate').audio_end_ms,0);assert.equal(f.provider.filter(x=>x.type==='response.cancel').length,0);await until(()=>f.device.some(x=>x.payload.flush===true));
 }finally{await f.adapter.close();}
});

test('fully acknowledged completed playback keeps its history without a redundant interruption',async()=>{
 const f=fixture();try{await open(f);await shortReply(f,'heard');await f.adapter.receiveDevice({type:'playback',response_id:'heard',audio_end_ms:60});await f.adapter.receiveDevice({type:'abort'});assert.equal(f.provider.filter(x=>x.type==='conversation.item.truncate'||x.type==='response.cancel').length,0);assert.equal(f.device.filter(x=>x.payload.flush===true).length,0);assert.equal(f.adapter.snapshot().code,'ready');}finally{await f.adapter.close();}
});

test('ordinary stop exposes exact unpadded final samples and its acknowledgement preserves history on the next speech start',async()=>{
 const f=fixture();try{await open(f);await f.event({type:'input_audio_buffer.speech_stopped'});await f.event({type:'response.created',response:{id:'partial'}});
 // 1502 input samples resample to 1001 samples: two Opus packets, only 62 whole milliseconds of real audio.
 await f.event({type:'response.output_audio.delta',response_id:'partial',item_id:'item-partial',content_index:0,delta:pcm(24000,1502).toString('base64')});
 await f.event({type:'response.done',response:{id:'partial',status:'completed'}});
 await until(()=>f.device.some(x=>x.payload.type==='tts'&&x.payload.state==='stop'&&!x.payload.flush));
 const start=f.device.find(x=>x.payload.type==='tts'&&x.payload.state==='start').payload,stop=f.device.find(x=>x.payload.type==='tts'&&x.payload.state==='stop'&&!x.payload.flush).payload;
 assert.equal(f.device.filter(x=>x.meta.binary).length,2);assert.equal(stop.total_samples,1001);assert.equal(stop.sample_rate,16000);assert.equal(stop.audio_end_ms,62);
 assert.equal(stop.response_id,'partial');assert.equal(stop.playback_id,start.playback_id);
 await f.adapter.receiveDevice({type:'playback',response_id:stop.response_id,playback_id:stop.playback_id,audio_end_ms:stop.audio_end_ms});
 await f.event({type:'input_audio_buffer.speech_started'});
 assert.equal(f.provider.filter(x=>x.type==='conversation.item.truncate'||x.type==='response.cancel').length,0);assert.equal(f.device.filter(x=>x.payload.flush===true).length,0);
 }finally{await f.adapter.close();}
});

test('completed transport without any playback acknowledgement stays conservative on the next speech start',async()=>{
 const f=fixture();try{await open(f);await shortReply(f,'no-ack');await f.event({type:'input_audio_buffer.speech_started'});
 const cut=f.provider.find(x=>x.type==='conversation.item.truncate');assert.equal(cut.item_id,'item-no-ack');assert.equal(cut.audio_end_ms,0);assert.equal(f.provider.filter(x=>x.type==='response.cancel').length,0);
 await until(()=>f.device.some(x=>x.payload.flush===true));
 }finally{await f.adapter.close();}
});

test('playback correlation retention is bounded to the most recent 32 responses',async()=>{
 const f=fixture();try{await open(f);
 for(let n=0;n<33;n++){const id='bounded-'+n;await f.event({type:'input_audio_buffer.speech_stopped'});await f.event({type:'response.created',response:{id}});await f.event({type:'response.done',response:{id,status:'completed'}});await until(()=>f.device.some(x=>x.payload.type==='tts'&&x.payload.state==='stop'&&x.payload.response_id===id));}
 await f.adapter.receiveDevice({type:'playback',response_id:'bounded-1',audio_end_ms:0});assert.equal(f.adapter.snapshot().code,'ready');await assert.rejects(f.adapter.receiveDevice({type:'playback',response_id:'bounded-0',audio_end_ms:0}),{message:'device_protocol_invalid'});assert.equal(f.connects,1);
 }finally{await f.adapter.close();}
});
