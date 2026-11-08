import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import WebSocket from '../resources/xiaozhi/network/ws-8.22.1/wrapper.mjs';
import {createXiaozhiGateway} from '../src/xiaozhi/gateway.mjs';
import {createXiaozhiOpenAIAdapter} from '../src/xiaozhi/adapter.mjs';
import {createOpusCodec} from '../src/xiaozhi/codec.mjs';
import {createTestTls} from './fixtures/tls.mjs';

const HELLO={type:'hello',version:1,transport:'websocket',audio_params:{format:'opus',sample_rate:16000,channels:1,frame_duration:60}};
const configuration={api_key:'SYNTHETIC_PROVIDER_NEVER_LIVE',api_base_url:'https://api.openai.com/v1',model:'gpt-realtime'};
async function until(check,ms=3000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await sleep(5);}assert.fail('bounded condition did not settle');}
function pcm(samples){const b=Buffer.alloc(samples*2);for(let n=0;n<samples;n++)b.writeInt16LE(Math.round(6000*Math.sin(2*Math.PI*330*n/24000)),n*2);return b;}

async function fixture(t,{signal}={}){
 const tls=createTestTls(),provider=[],reports=[],received=[];let callbacks,adapter,providerClosed=0,packets=0;
 const receiverCodec=createOpusCodec();t.after(()=>receiverCodec.close());
 const gateway=createXiaozhiGateway({tls,authorize:async()=>({configuration,signal}),onStatus:s=>reports.push(s),
  createAdapter:options=>adapter=createXiaozhiOpenAIAdapter({...options,connect:async c=>{
   callbacks=c;return {async send(event){provider.push(event);if(event.type==='session.update')queueMicrotask(()=>c.onEvent({type:'session.updated'}));},close(){providerClosed++;}};
  }})});
 await gateway.listen();t.after(()=>gateway.close());
 const ws=new WebSocket(`wss://127.0.0.1:${gateway.address().port}/kibi-xiaozhi/v1`,{ca:tls.cert,servername:'localhost',headers:{Authorization:'Bearer synthetic-long-audio-capability'}});
 ws.on('error',()=>{});t.after(()=>ws.terminate());
 ws.on('message',(data,binary)=>{
  if(binary){assert.equal(receiverCodec.decode(data).length,1920);packets++;return;}
  received.push(JSON.parse(data));
 });
 await once(ws,'open');ws.send(JSON.stringify(HELLO));await until(()=>received.some(x=>x.type==='hello'));
 ws.send(JSON.stringify({type:'listen',state:'start',mode:'realtime'}));await until(()=>gateway.snapshot().metrics.inputMessages===2);
 return {gateway,ws,provider,reports,received,get adapter(){return adapter;},get packets(){return packets;},get providerClosed(){return providerClosed;},event:e=>callbacks.onEvent(e)};
}

async function burst(f,id,frames=320,{transcripts=false}={}){
 await f.event({type:'input_audio_buffer.speech_stopped'});await f.event({type:'response.created',response:{id}});
 // Each provider message is 600 ms / ten 60 ms Opus packets. A complete
 // 19.2-second reply can arrive much faster than its existing 60 ms playout.
 for(let at=0;at<frames;at+=10){
  await f.event({type:'response.output_audio.delta',response_id:id,item_id:'item-'+id,content_index:0,delta:pcm(Math.min(10,frames-at)*1440).toString('base64')});
  if(transcripts)for(let n=0;n<3;n++)await f.event({type:'response.output_audio_transcript.delta',response_id:id,delta:'synthetic transcript fragment '});
  assert.equal(f.adapter.snapshot().closed,false,JSON.stringify({adapter:f.adapter.snapshot(),gateway:f.gateway.snapshot(),producedFrames:Math.min(frames,at+10)}));
 }
 await f.event({type:'response.done',response:{id,status:'completed'}});
}

test('a bounded fast provider burst exceeding 250 packets completes and the next conversation keeps acknowledged history',async t=>{
 const f=await fixture(t);const began=Date.now();await burst(f,'long',320,{transcripts:true});
 await until(()=>f.received.some(x=>x.type==='tts'&&x.state==='stop'&&!x.flush&&x.response_id==='long'),24000);
 assert.equal(f.packets,320);
 assert.ok(Date.now()-began>=19000,'retain real 60 ms playout pacing');
 assert.equal(f.received.filter(x=>x.type==='text').length,96);
 const stop=f.received.find(x=>x.type==='tts'&&x.state==='stop'&&!x.flush&&x.response_id==='long');
 assert.equal(stop.total_samples,307200);assert.equal(stop.audio_end_ms,19200);
 f.ws.send(JSON.stringify({type:'playback',response_id:'long',playback_id:stop.playback_id,audio_end_ms:19200}));
 await until(()=>f.gateway.snapshot().metrics.inputMessages===3);
 await f.event({type:'input_audio_buffer.speech_started'});await burst(f,'next',2);
 await until(()=>f.received.some(x=>x.type==='tts'&&x.state==='stop'&&!x.flush&&x.response_id==='next'));
 assert.equal(f.packets,322);assert.equal(f.provider.filter(x=>x.type==='conversation.item.truncate'||x.type==='response.cancel').length,0);
 assert.equal(f.gateway.snapshot().code,'ready');assert.equal(f.providerClosed,0);
 assert.ok(f.adapter.snapshot().metrics.peakOutputBytes<=512000);assert.ok(f.gateway.snapshot().metrics.peakOutputBytes<=65536);
 assert.ok(f.adapter.snapshot().metrics.peakOutputMessages>250);assert.ok(f.adapter.snapshot().metrics.peakOutputMessages<=1500);
 assert.equal(f.adapter.snapshot().metrics.pendingOutputMessages,0);
});

test('abort flushes a queued long reply promptly and stale audio cannot follow the flush',async t=>{
 const f=await fixture(t);await burst(f,'cancel-long',320,{transcripts:true});await until(()=>f.packets>0);
 const began=Date.now();f.ws.send(JSON.stringify({type:'abort'}));
 await until(()=>f.received.some(x=>x.type==='tts'&&x.flush===true),500);
 assert.ok(Date.now()-began<250,'flush must not wait for queued long audio');
 const packetsAtFlush=f.packets;await sleep(150);assert.equal(f.packets,packetsAtFlush);assert.ok(f.packets<320);
 assert.equal(f.adapter.snapshot().metrics.pendingOutputMessages,0);assert.equal(f.adapter.snapshot().metrics.pendingOutputBytes,0);
 const cut=f.provider.find(x=>x.type==='conversation.item.truncate');assert.equal(cut.audio_end_ms,0);
 await f.event({type:'response.output_audio.delta',response_id:'cancel-long',item_id:'item-cancel-long',content_index:0,delta:pcm(1440).toString('base64')});
 await sleep(80);assert.equal(f.packets,packetsAtFlush);assert.equal(f.gateway.snapshot().code,'ready');
});

test('owner cancellation closes a session with a long reply queued without waiting for playout',async t=>{
 const controller=new AbortController(),f=await fixture(t,{signal:controller.signal});await burst(f,'revoked-long');
 const closed=once(f.ws,'close'),began=Date.now();controller.abort();await closed;
 assert.ok(Date.now()-began<250);assert.equal(f.providerClosed,1);assert.equal(f.adapter.snapshot().metrics.pendingOutputMessages,0);
 assert.equal(f.adapter.snapshot().metrics.pendingOutputBytes,0);assert.equal(f.gateway.snapshot().metrics.activeSessions,0);
});
