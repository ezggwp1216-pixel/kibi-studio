import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import WebSocket from '../resources/xiaozhi/network/ws-8.22.1/wrapper.mjs';
import {createXiaozhiGateway} from '../src/xiaozhi/gateway.mjs';
import {createVoiceDiagnostics} from '../src/voice-diagnostics.mjs';
import {createTestTls} from './fixtures/tls.mjs';

const principal={kind:'account',accountId:'alice',id:'device-a'},TOKEN='A'.repeat(43);
async function until(check){for(let i=0;i<600;i++){if(check())return;await sleep(5);}assert.fail('bounded diagnostic observation expected');}
async function fixture(t,{identity=principal,onDiagnostics,adapterFactory}={}){
 const tls=createTestTls(),observations=[],reports=[],metrics={inputPackets:0,outputPackets:0,turnsCompleted:0};let created=0;
 const gateway=createXiaozhiGateway({tls,authorize:async({token})=>token===TOKEN?{principal:identity,configuration:{token:'SYNTHETIC_SECRET'}}:null,
  onDiagnostics:value=>{observations.push(value);return onDiagnostics?.(value);},
  createAdapter:options=>{created++;reports.push(options.onStatus);if(adapterFactory)return adapterFactory(options);
   options.onStatus({code:'ready',metrics:{...metrics,secret:'SYNTHETIC_SECRET'},transcript:'SYNTHETIC_PRIVATE_SPEECH'});
   return {async receiveDevice(message,{binary}={}){if(binary){metrics.inputPackets++;return;}await options.sendDevice({type:'hello'});},snapshot(){return{code:'ready',metrics:{...metrics,secret:'SYNTHETIC_SECRET'}};},close(){}};
  }});
 await gateway.listen();t.after(()=>gateway.close());
 const connect=async(token=TOKEN)=>{
  const ws=new WebSocket(`wss://127.0.0.1:${gateway.address().port}/kibi-xiaozhi/v1`,{ca:tls.cert,servername:'localhost',headers:{Authorization:'Bearer '+token}});
  ws.on('error',()=>{});t.after(()=>ws.terminate());
  const status=await new Promise(resolve=>{ws.once('open',()=>resolve(101));ws.once('unexpected-response',(_,r)=>{r.resume();resolve(r.statusCode);});ws.once('error',()=>resolve(0));});
  return {ws,status};
 };
 return {gateway,observations,reports,metrics,connect,created:()=>created};
}

test('authenticated observations carry only trusted identity and measured counters, not another socket rejection',async t=>{
 const d=createVoiceDiagnostics();const f=await fixture(t,{onDiagnostics:value=>d.observe(value)});
 const {ws,status}=await f.connect();assert.equal(status,101);
 assert.equal(d.read('alice','device-a').connection.code,'ready');
 assert.equal((await f.connect('B'.repeat(43))).status,409);
 assert.equal(d.read('alice','device-a').connection.code,'ready');
 for(let i=0;i<3;i++)ws.send(Buffer.from([0xf8,0xff,0xfe]));
 await until(()=>d.read('alice','device-a').metrics?.inputPackets===3);
 assert.equal(f.created(),1);
 assert.ok(f.observations.every(value=>value.principal.accountId==='alice'&&value.principal.id==='device-a'));
 assert.doesNotMatch(JSON.stringify(f.observations),/SYNTHETIC|secret|transcript|configuration|Bearer/);
 const closed=once(ws,'close');ws.close();await closed;
 await until(()=>d.read('alice','device-a').connection.active===false);
 assert.equal(d.read('alice','device-a').connection.active,false);
 assert.equal(d.read('alice','device-a').metrics.inputPackets,3);
});

test('synchronous or asynchronous diagnostic failures never change a live protocol exchange',async t=>{
 const f=await fixture(t,{onDiagnostics:value=>{if(value.event==='start')throw new Error('diagnostic unavailable');return Promise.reject(new Error('diagnostic unavailable'));}});
 const {ws,status}=await f.connect();assert.equal(status,101);
 const reply=once(ws,'message');ws.send(JSON.stringify({type:'hello'}));const [data]=await reply;
 assert.equal(JSON.parse(data).type,'hello');assert.equal(f.gateway.snapshot().code,'ready');
 const closed=once(ws,'close');ws.close();await closed;
 await until(()=>f.observations.some(value=>value.event==='end'));
 assert.ok(f.observations.some(value=>value.event==='end'));
});

test('owner/legacy sessions never create ordinary-user observations and old callbacks stay retired',async t=>{
 const own=await fixture(t,{identity:{kind:'panel',id:'owner-device'}});assert.equal((await own.connect()).status,101);assert.deepEqual(own.observations,[]);
 const d=createVoiceDiagnostics(),f=await fixture(t,{onDiagnostics:value=>d.observe(value)});
 const first=await f.connect(),oldReport=f.reports[0],closed=once(first.ws,'close');first.ws.close();await closed;
 assert.equal((await f.connect()).status,101);
 oldReport({code:'provider_error',closed:true,metrics:{inputPackets:999}});
 assert.equal(d.read('alice','device-a').connection.code,'ready');
 assert.equal(d.read('alice','device-a').metrics.inputPackets,0);
 assert.equal(f.gateway.snapshot().metrics.activeSessions,1);
});
