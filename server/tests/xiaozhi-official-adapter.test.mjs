import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createOfficialXiaozhiAdapter} from '../src/xiaozhi/official-adapter.mjs';
import {createOpusCodec} from '../src/xiaozhi/codec.mjs';
const OpusScript=createRequire(import.meta.url)('../resources/xiaozhi/codec/opusscript-0.1.1/index.js');
const configuration={url:'wss://api.tenclass.net/xiaozhi/v1/',token:'private-token',deviceId:'00:11:22:33:44:55',clientId:'software-client'};
const hello={type:'hello',version:1,transport:'websocket',audio_params:{format:'opus',sample_rate:16000,channels:1,frame_duration:60}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pcm=(rate,n)=>{const b=Buffer.alloc(n*2);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(8000*Math.sin(2*Math.PI*440*i/rate)),i*2);return b;};
async function until(check){for(let i=0;i<200;i++){if(check())return;await sleep(5);}assert.fail('condition did not settle');}
function fixture(options={}){
 const device=[],provider=[],statuses=[],channels=[];
 const adapter=createOfficialXiaozhiAdapter({configuration,sendDevice:async(payload,meta)=>{device.push({payload,meta,at:Date.now()});await options.deviceSend?.(payload,meta);},onStatus:s=>statuses.push(s),connect:async c=>{
  const ch={callbacks:c,closed:0};channels.push(ch);await options.connectWait?.(c);
  return {hello:{type:'hello',session_id:'upstream-secret-'+channels.length,audio_params:{format:'opus',sample_rate:options.rate??16000,channels:1,frame_duration:60}},sendJson:async payload=>{provider.push({payload,channel:ch});await options.providerSend?.(payload);},sendAudio:async payload=>{provider.push({payload:Buffer.from(payload),channel:ch});await options.audioSend?.(payload);},close(){ch.closed++;}};
 },...options.adapterOptions});
 return {adapter,device,provider,statuses,channels,event:(payload,binary=false,index=channels.length-1)=>channels[index].callbacks.onEvent({payload,binary})};
}
async function open(f){await f.adapter.receiveDevice(hello);await f.adapter.receiveDevice({type:'listen',state:'start',mode:'realtime'});}
async function reply(f,packet,count=1){await f.event({type:'tts',state:'start'});for(let i=0;i<count;i++)await f.event(packet,true);await f.event({type:'tts',state:'stop'});}
const stops=f=>f.device.filter(x=>x.payload.type==='tts'&&x.payload.state==='stop'&&!x.payload.flush);
async function ack(f,stop=stops(f).at(-1).payload){await f.adapter.receiveDevice({type:'playback',response_id:stop.response_id,playback_id:stop.playback_id,audio_end_ms:stop.audio_end_ms});}

test('local hello, raw input and two turns retain exact local IDs and playback-based listening',async()=>{
 const f=fixture(),codec=createOpusCodec();try{await open(f);const greeting=f.device[0].payload;assert.equal(greeting.audio_params.sample_rate,16000);assert.deepEqual(greeting.features,{playback_ack:true,flush:true});assert.ok(greeting.session_id);assert.equal(f.provider[0].payload.mode,'auto');
 const packet=codec.encode(pcm(16000,960));await f.adapter.receiveDevice(packet,{binary:true});assert.deepEqual(f.provider.find(x=>Buffer.isBuffer(x.payload)).payload,packet);
 for(let i=1;i<=2;i++){await f.event({type:'stt',text:'речь'});await f.event({type:'llm',text:'ответ'});await reply(f,packet,2);await until(()=>stops(f).length===i);const stop=stops(f).at(-1).payload;assert.equal(stop.total_samples,1920);assert.equal(stop.audio_end_ms,120);assert.equal(stop.sample_rate,16000);assert.ok(!stop.response_id.startsWith('upstream'));await ack(f);}
 assert.notEqual(stops(f)[0].payload.response_id,stops(f)[1].payload.response_id);assert.equal(f.channels.length,1);assert.equal(f.adapter.snapshot().metrics.turnsCompleted,2);assert.ok(f.provider.filter(x=>x.payload.type==='listen').length>=3);assert.equal(f.device.filter(x=>x.payload.type==='stt').length,2);assert.equal(f.device.filter(x=>x.payload.type==='text').length,2);
 assert.ok(!JSON.stringify(f.statuses).includes('речь'));assert.ok(!JSON.stringify(f.statuses).includes('private-token'));assert.ok(!JSON.stringify(f.adapter.snapshot()).includes('upstream-secret'));
 }finally{codec.close();await f.adapter.close();}
});

test('real 24 kHz Opus normalizes to real 16 kHz Opus with decoded duration',async()=>{
 const f=fixture({rate:24000}),source=new OpusScript(24000,1,OpusScript.Application.VOIP),sink=createOpusCodec();try{await open(f);const packet=source.encode(pcm(24000,1440),1440);await reply(f,packet);await until(()=>stops(f).length===1);const out=f.device.find(x=>x.meta.binary).payload;assert.equal(sink.decode(out).length,1920);assert.ok(sink.decode(out).some(x=>x!==0));assert.equal(stops(f)[0].payload.total_samples,960);}finally{source.delete();sink.close();await f.adapter.close();}
});

test('zero audio creates no orphan TTS and automatically resumes listening',async()=>{
 const f=fixture();try{await open(f);await reply(f,Buffer.alloc(0),0);await sleep(5);assert.equal(f.device.filter(x=>x.payload.type==='tts').length,0);assert.equal(f.adapter.snapshot().metrics.turnsCompleted,1);assert.equal(f.provider.filter(x=>x.payload.type==='listen').length,2);}finally{await f.adapter.close();}
});

test('abort during START waits for successful write then flushes only matching IDs and retires stale audio',async()=>{
 let release,started;const began=new Promise(r=>{started=r;}),blocked=new Promise(r=>{release=r;});
 const f=fixture({deviceSend:async p=>{if(p.type==='tts'&&p.state==='start'){started();await blocked;}}}),codec=createOpusCodec();
 try{await open(f);const packet=codec.encode(pcm(16000,960));await f.event({type:'tts',state:'start'});await f.event(packet,true);await began;const abort=f.adapter.receiveDevice({type:'abort'});await sleep(5);assert.equal(f.device.filter(x=>x.payload.flush).length,0);assert.equal(f.channels[0].closed,1);release();await abort;await until(()=>f.device.some(x=>x.payload.flush));const start=f.device.find(x=>x.payload.state==='start'&&x.payload.type==='tts').payload,flush=f.device.find(x=>x.payload.flush).payload;assert.equal(start.response_id,flush.response_id);assert.equal(start.playback_id,flush.playback_id);await f.event(packet,true,0);assert.equal(f.device.filter(x=>x.meta.binary).length,0);
 await f.adapter.receiveDevice({type:'listen',state:'start',mode:'realtime'});assert.equal(f.channels.length,2);await reply(f,packet);await until(()=>stops(f).length===1);assert.equal(f.adapter.snapshot().closed,false);
 }finally{release();codec.close();await f.adapter.close();}
});

test('abort before queued START drops it without STOP; failed START also emits no flush',async()=>{
 for(const failed of [false,true]){let release,started;const wait=new Promise(r=>{release=r;}),began=new Promise(r=>{started=r;});const f=fixture({deviceSend:async p=>{if(!failed&&p.type==='stt'||failed&&p.type==='tts'&&p.state==='start'){started();await wait;if(failed)throw Error('private transport reason');}}}),codec=createOpusCodec();
 try{await open(f);if(!failed)await f.event({type:'stt',text:'block'});await f.event({type:'tts',state:'start'});await f.event(codec.encode(pcm(16000,960)),true);await began;const aborted=f.adapter.receiveDevice({type:'abort'});release();await aborted.catch(()=>{});await sleep(5);assert.equal(f.device.filter(x=>x.payload.flush).length,0);if(!failed)assert.equal(f.device.filter(x=>x.payload.type==='tts').length,0);}finally{release();codec.close();await f.adapter.close();}}
});

test('invalid, mismatched, future and backwards playback ACKs fail locally without cloud history operations',async()=>{
 for(const bad of ['response','playback','future','backwards']){const f=fixture(),codec=createOpusCodec();try{await open(f);await reply(f,codec.encode(pcm(16000,960)));await until(()=>stops(f).length);const stop=stops(f)[0].payload;await f.adapter.receiveDevice({type:'playback',response_id:stop.response_id,playback_id:stop.playback_id,audio_end_ms:30});const message={type:'playback',response_id:stop.response_id,playback_id:stop.playback_id,audio_end_ms:bad==='future'?61:bad==='backwards'?29:30};if(bad==='response')message.response_id='forged';if(bad==='playback')message.playback_id='forged';await assert.rejects(f.adapter.receiveDevice(message),{code:'device_protocol_invalid'});assert.ok(!f.provider.some(x=>/truncate|cancel/.test(x.payload.type??'')));}finally{codec.close();await f.adapter.close();}}
});

test('long replies exceeding old short queue budget retain 60 ms media pacing',async()=>{
 const f=fixture(),codec=createOpusCodec();try{await open(f);await reply(f,codec.encode(pcm(16000,960)),35);await until(()=>f.device.filter(x=>x.meta.binary).length>=2);assert.ok(f.adapter.snapshot().metrics.peakOutputMessages>=32);assert.equal(f.adapter.snapshot().closed,false);await sleep(2050);await until(()=>stops(f).length);const packets=f.device.filter(x=>x.meta.binary);assert.equal(packets.length,35);for(let i=1;i<packets.length;i++)assert.ok(packets[i].at-packets[i-1].at>=55);assert.equal(stops(f)[0].payload.total_samples,33600);}finally{codec.close();await f.adapter.close();}
});

test('pending input packets and output bytes/messages are bounded with no secret diagnostics',async()=>{
 let release;const waiting=new Promise(r=>{release=r;}),f=fixture({audioSend:()=>waiting}),codec=createOpusCodec();try{await open(f);const packet=codec.encode(pcm(16000,960));const jobs=Array.from({length:42},()=>f.adapter.receiveDevice(packet,{binary:true}).catch(e=>e.code));await until(()=>f.adapter.snapshot().closed);assert.equal(f.adapter.snapshot().code,'input_backpressure');release();await Promise.all(jobs);assert.ok(f.adapter.snapshot().metrics.peakInputBytes<=65536);}finally{release();codec.close();await f.adapter.close();}
 const g=fixture({deviceSend:p=>p.type==='text'?new Promise(()=>{}):undefined});try{await open(g);for(let i=0;i<80&&!g.adapter.snapshot().closed;i++)await g.event({type:'llm',text:'x'.repeat(8192)});assert.equal(g.adapter.snapshot().code,'output_backpressure');assert.ok(g.adapter.snapshot().metrics.peakOutputBytes<=512000);assert.ok(g.adapter.snapshot().metrics.peakOutputMessages<=1500);}finally{await g.adapter.close();}
});

test('oversize events, invalid hello and unsupported upstream audio fail without fallback',async()=>{
 const invalid=fixture();await assert.rejects(invalid.adapter.receiveDevice({...hello,audio_params:{...hello.audio_params,sample_rate:24000}}),{code:'device_protocol_invalid'});assert.equal(invalid.channels.length,0);
 const f=fixture({rate:48000});await assert.rejects(f.adapter.receiveDevice(hello),{code:'provider_protocol_invalid'});assert.equal(f.channels.length,1);assert.equal(f.channels[0].closed,1);
 const g=fixture();try{await open(g);await g.event({type:'llm',text:'x'.repeat(131073)});assert.equal(g.adapter.snapshot().closed,true);}finally{await g.adapter.close();}
});

test('response and device write deadlines close cleanly; closing cancels a stalled connect',async t=>{
 const f=fixture();try{await open(f);t.mock.timers.enable({apis:['setTimeout']});await f.event({type:'tts',state:'start'});t.mock.timers.tick(90001);await Promise.resolve();assert.equal(f.adapter.snapshot().code,'timeout');}finally{t.mock.timers.reset();await f.adapter.close();}
 const g=fixture({deviceSend:p=>p.type==='tts'?new Promise(()=>{}):undefined}),codec=createOpusCodec();try{await open(g);t.mock.timers.enable({apis:['setTimeout']});await g.event({type:'tts',state:'start'});await g.event(codec.encode(pcm(16000,960)),true);t.mock.timers.tick(5001);await Promise.resolve();await Promise.resolve();assert.equal(g.adapter.snapshot().code,'timeout');}finally{t.mock.timers.reset();codec.close();await g.adapter.close();}
 let release,seen;const began=new Promise(r=>{seen=r;}),blocked=new Promise(r=>{release=r;});const h=fixture({connectWait:()=>{seen();return blocked;}});const pending=h.adapter.receiveDevice(hello).catch(e=>e.code);await began;await h.adapter.close();assert.equal(await pending,'closed');release();await sleep(0);assert.equal(h.channels[0].closed,1);assert.equal(h.channels[0].callbacks.signal.aborted,true);
});

test('validated in-flight microphone audio is dropped during playback, then accepted after exact ACK',async()=>{
 const f=fixture(),codec=createOpusCodec();try{await open(f);const packet=codec.encode(pcm(16000,960));await f.event({type:'tts',state:'start'});await f.adapter.receiveDevice(packet,{binary:true});assert.equal(f.provider.filter(x=>Buffer.isBuffer(x.payload)).length,0);await f.event(packet,true);await f.event({type:'tts',state:'stop'});await until(()=>stops(f).length);await f.adapter.receiveDevice(packet,{binary:true});assert.equal(f.provider.filter(x=>Buffer.isBuffer(x.payload)).length,0);await ack(f);await f.adapter.receiveDevice(packet,{binary:true});assert.equal(f.provider.filter(x=>Buffer.isBuffer(x.payload)).length,1);assert.equal(f.adapter.snapshot().metrics.droppedInputPackets,2);}finally{codec.close();await f.adapter.close();}
});

test('output message count is bounded independently from bytes and queued upstream events are bounded',async()=>{
 const f=fixture({deviceSend:p=>p.type==='text'?new Promise(()=>{}):undefined});try{await open(f);for(let i=0;i<1501&&!f.adapter.snapshot().closed;i++)await f.event({type:'llm',text:'x'});assert.equal(f.adapter.snapshot().code,'output_backpressure');assert.equal(f.adapter.snapshot().metrics.peakOutputMessages,1500);assert.ok(f.adapter.snapshot().metrics.peakOutputBytes<512000);}finally{await f.adapter.close();}
 const g=fixture();try{await open(g);const jobs=Array.from({length:20},()=>g.event({type:'llm',text:'x'.repeat(8192)}));await Promise.all(jobs);assert.equal(g.adapter.snapshot().code,'output_backpressure');}finally{await g.adapter.close();}
});

test('unconfigured hello never connects and stalled upstream writes time out',async t=>{
 const f=fixture({adapterOptions:{configuration:{}}});await assert.rejects(f.adapter.receiveDevice(hello),{code:'unsupported_endpoint'});assert.equal(f.channels.length,0);
 const g=fixture({audioSend:()=>new Promise(()=>{})}),codec=createOpusCodec();try{await open(g);t.mock.timers.enable({apis:['setTimeout']});const job=g.adapter.receiveDevice(codec.encode(pcm(16000,960)),{binary:true}).catch(e=>e.code);await Promise.resolve();await Promise.resolve();t.mock.timers.tick(5001);assert.equal(await job,'timeout');assert.equal(g.adapter.snapshot().closed,true);assert.equal(g.channels[0].closed,1);}finally{t.mock.timers.reset();codec.close();await g.adapter.close();}
});

test('early cloud events stay behind validated hello and the local device hello',async()=>{
 const device=[];let callbacks;
 const adapter=createOfficialXiaozhiAdapter({configuration,sendDevice:async p=>{device.push(p);},connect:async c=>{callbacks=c;void c.onEvent({binary:false,payload:{type:'stt',text:'early'}});return {hello:{audio_params:hello.audio_params},sendJson:async()=>{},sendAudio:async()=>{},close(){}};}});
 try{await adapter.receiveDevice(hello);await until(()=>device.length>=2);assert.equal(device[0].type,'hello');assert.equal(device[1].type,'stt');assert.equal(adapter.snapshot().closed,false);}finally{await adapter.close();}
});

test('owner cancellation immediately unwinds a pending transport write and clears queued audio',async()=>{
 const controller=new AbortController();let began;const started=new Promise(r=>{began=r;});const f=fixture({audioSend:()=>{began();return new Promise(()=>{});},adapterOptions:{signal:controller.signal}}),codec=createOpusCodec();try{await open(f);const pending=f.adapter.receiveDevice(codec.encode(pcm(16000,960)),{binary:true}).catch(e=>e.code);await started;controller.abort();assert.equal(await Promise.race([pending,sleep(100).then(()=> 'still-pending')]),'cancelled');assert.equal(f.adapter.snapshot().code,'cancelled');assert.equal(f.channels[0].closed,1);assert.equal(f.channels[0].callbacks.signal.aborted,true);assert.equal(f.adapter.snapshot().metrics.pendingOutputMessages,0);}finally{codec.close();await f.adapter.close();}
});
