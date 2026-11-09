import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createOfficialRegistration} from '../src/xiaozhi/official-registration.mjs';
import {validateOfficialCloudConfiguration} from '../src/xiaozhi/official-socket.mjs';

const OTA='https://api.tenclass.net/xiaozhi/ota/';
const identity={deviceId:'02:12:34:56:78:90',clientId:'c51eb468-ff3b-4499-9a92-200029a734cf',serialNumber:'KIBI-SW-1234567890',hmacKey:'a'.repeat(64)};
const activation={activation:{code:'123456',challenge:'private-challenge',timeout_ms:60_000}};
const ready={websocket:{url:'wss://api.tenclass.net/xiaozhi/v1/?secret=query',token:'private-token'}};
const response=(body,status=200)=>new Response(body===undefined?null:JSON.stringify(body),{status});
function harness(sequence=[],stored=null){
 let value=stored,now=1_800_000_000_000;const requests=[],writes=[];
 const registration=createOfficialRegistration({read:()=>value,write:async next=>{value=structuredClone(next);writes.push(value);},identityFactory:()=>structuredClone(identity),clock:()=>now,
  fetchImpl:async(url,options)=>{requests.push({url,options});const next=sequence.shift();if(next instanceof Error)throw next;return typeof next==='function'?next(url,options):next;}});
 return{registration,requests,writes,stored:()=>value,advance:ms=>{now+=ms;}};
}
function safe(snapshot){
 assert.deepEqual(Object.keys(snapshot).sort(),['code','configured','expiresAt','pairingCode','status']);
 for(const secret of ['private-token','private-challenge',identity.deviceId,identity.clientId,identity.hmacKey,'secret=query'])assert.ok(!JSON.stringify(snapshot).includes(secret));
}

test('real registration output with a private query is accepted by the official socket validator',async()=>{
 for(const url of ['wss://api.tenclass.net/xiaozhi/v1/?secret=query','wss://api.tenclass.net:443/xiaozhi/v1/?secret=query']){
  const h=harness([response({websocket:{...ready.websocket,url}})]);
  try{
   assert.equal((await h.registration.prepare()).configured,true);
   const configuration=validateOfficialCloudConfiguration(h.registration.configuration());
   assert.equal(configuration.url,'wss://api.tenclass.net/xiaozhi/v1/?secret=query');
   assert.equal(configuration.token,'private-token');safe(h.registration.snapshot());
  }finally{h.registration.close();}
 }
});

test('owner prepare persists one software identity and exposes only temporary pairing information',async()=>{
 const h=harness([response(activation),response(activation)]);safe(h.registration.snapshot());assert.equal(h.requests.length,0);
 const result=await h.registration.prepare();safe(result);assert.equal(result.status,'pending');assert.equal(result.pairingCode,'123456');
 assert.equal(result.expiresAt,'2027-01-15T08:01:00.000Z');
 const request=h.requests[0];assert.equal(request.url,OTA);assert.equal(request.options.method,'POST');assert.equal(request.options.redirect,'manual');
 assert.equal(request.options.headers['Device-Id'],identity.deviceId);assert.equal(request.options.headers['Client-Id'],identity.clientId);
 assert.equal(request.options.headers['Activation-Version'],'2');
 const payload=JSON.parse(request.options.body);assert.equal(payload.application.elf_sha256,identity.hmacKey);assert.equal(payload.board.name,'kibi-server');assert.equal(payload.board.type,'kibi-server-software');assert.equal(payload.board.mac,identity.deviceId);
 assert.ok(!('efuse' in payload));assert.ok(!('mac_address' in payload));assert.equal(h.stored().identity.hmacKey,identity.hmacKey);
 await h.registration.prepare();assert.equal(h.requests[1].options.headers['Client-Id'],identity.clientId);h.registration.close();
});

test('activation uses nested PC software HMAC, 202 stays pending and 200 refreshes OTA credentials',async()=>{
 const h=harness([response(activation),response({status:'pending'},202),response(undefined),response(ready)]);
 await h.registration.prepare();assert.equal((await h.registration.activate()).status,'pending');assert.equal(h.registration.configuration(),null);
 const sent=JSON.parse(h.requests[1].options.body);assert.deepEqual(sent,{Payload:{algorithm:'hmac-sha256',serial_number:identity.serialNumber,challenge:'private-challenge',hmac:createHmac('sha256',identity.hmacKey).update('private-challenge').digest('hex')}});
 assert.equal(h.requests[1].url,OTA+'activate');assert.equal(h.requests[1].options.headers['Activation-Version'],'2');
 const result=await h.registration.activate();safe(result);assert.deepEqual(result,{configured:true,status:'configured',code:null,pairingCode:null,expiresAt:null});
 assert.equal(h.requests[3].url,OTA);assert.equal(h.registration.configuration().token,'private-token');
 const clone=h.registration.configuration();clone.token='changed';assert.equal(h.registration.configuration().token,'private-token');assert.equal(h.stored().activation,null);h.registration.close();
});

test('expired pairing code is hidden and cannot send an activation proof',async()=>{
 const h=harness([response(activation)]);await h.registration.prepare();h.advance(60_000);
 assert.equal(h.registration.snapshot().pairingCode,null);assert.equal(h.registration.snapshot().expiresAt,null);
 await assert.rejects(h.registration.activate(),{code:'xiaozhi_challenge_expired'});assert.equal(h.requests.length,1);h.registration.close();
});

test('persisted configuration loads without network and identity creation uses distinct software identities',async()=>{
 const h=harness([response(ready)]);await h.registration.prepare();
 const restored=harness([],h.stored());assert.equal(restored.registration.snapshot().configured,true);assert.equal(restored.requests.length,0);safe(restored.registration.snapshot());
 const generated=[];
 for(let i=0;i<2;i++){
  let privateData;const r=createOfficialRegistration({read:()=>null,write:async value=>{privateData=value;},fetchImpl:async()=>response(activation)});
  await r.prepare();generated.push(privateData.identity);assert.match(privateData.identity.deviceId,/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/);assert.equal(parseInt(privateData.identity.deviceId.slice(0,2),16)&3,2);assert.match(privateData.identity.serialNumber,/^KIBI-SW-/);r.close();
 }
 assert.notEqual(generated[0].deviceId,generated[1].deviceId);assert.notEqual(generated[0].hmacKey,generated[1].hmacKey);h.registration.close();restored.registration.close();
});

test('OTA cannot introduce arbitrary websocket targets, credentials or header injection',async t=>{
 for(const url of ['ws://api.tenclass.net/xiaozhi/v1/','wss://localhost/xiaozhi/v1/','wss://api.tenclass.net.evil.test/xiaozhi/v1/','wss://api.tenclass.net:444/xiaozhi/v1/','wss://api.tenclass.net/other','wss://u:p@api.tenclass.net/xiaozhi/v1/','wss://api.tenclass.net/xiaozhi/v1/#secret','wss://api.xiaozhi.me/v1/'])await t.test(url,async()=>{
  const h=harness([response({websocket:{url,token:'private-token'}})]);await assert.rejects(h.registration.prepare(),{code:'xiaozhi_untrusted_endpoint'});assert.equal(h.registration.configuration(),null);safe(h.registration.snapshot());h.registration.close();
 });
 const h=harness([response({websocket:{url:ready.websocket.url,token:'a\r\nsecret'}})]);await assert.rejects(h.registration.prepare(),{code:'xiaozhi_invalid_response'});h.registration.close();
});

test('MQTT-only and incomplete OTA replies never become configured',async()=>{
 for(const [body,code] of [[{mqtt:{endpoint:'private-mqtt',password:'secret'}},'xiaozhi_mqtt_unsupported'],[{},'xiaozhi_invalid_response'],[{websocket:{url:ready.websocket.url}},'xiaozhi_invalid_response'],[{activation:{code:'123456',challenge:''}},'xiaozhi_invalid_response'],[{activation:{code:'not-six',challenge:'secret'}},'xiaozhi_invalid_response'],[{activation:{code:123456,challenge:'secret'}},'xiaozhi_invalid_response'],[{activation:{code:'123456',challenge:'secret',timeout_ms:0}},'xiaozhi_invalid_response'],[{activation:{code:'123456',challenge:'secret',timeout_ms:600001}},'xiaozhi_invalid_response']]){
  const h=harness([response(body)]);await assert.rejects(h.registration.prepare(),{code});assert.equal(h.registration.configuration(),null);safe(h.registration.snapshot());h.registration.close();
 }
});

test('rejected HTTP responses cancel their unused body instead of keeping provider resources open',async()=>{
 let cancelled=false;const stream=new ReadableStream({cancel(){cancelled=true;}});
 const h=harness([new Response(stream,{status:403})]);await assert.rejects(h.registration.prepare(),{code:'xiaozhi_provider_failed'});assert.equal(cancelled,true);h.registration.close();
});

test('response chunk count is bounded even when all chunks are empty',async()=>{
 const stream=new ReadableStream({start(controller){for(let i=0;i<1025;i++)controller.enqueue(new Uint8Array());controller.enqueue(Buffer.from(JSON.stringify(ready)));controller.close();}});
 const h=harness([new Response(stream)]);await assert.rejects(h.registration.prepare(),{code:'xiaozhi_invalid_response'});h.registration.close();
});

test('redirects, rejected transports, invalid JSON and oversized replies produce fixed safe errors',async()=>{
 for(const reply of [new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}}),new Error('private-token/private-challenge'),new Response('not JSON'),new Response('x'.repeat(65537)),new Response('{}',{headers:{'content-length':'65537'}})]){
  const h=harness([reply]);await assert.rejects(h.registration.prepare(),error=>{assert.match(error.code,/^xiaozhi_/);assert.equal(error.message,error.code);return true;});assert.equal(h.requests.length,1);safe(h.registration.snapshot());h.registration.close();
 }
});

test('close aborts in-flight fetch even when transport ignores AbortSignal and prevents private write',async()=>{
 let release;const h=harness([()=>new Promise(resolve=>{release=resolve;})]);const operation=h.registration.prepare();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.requests.length,1);h.registration.close();await assert.rejects(operation,{code:'xiaozhi_closed'});assert.equal(h.requests[0].options.signal.aborted,true);
 release(response(ready));await new Promise(resolve=>setImmediate(resolve));assert.equal(h.stored().configuration,null);assert.deepEqual(h.registration.snapshot(),{configured:false,status:'closed',code:'xiaozhi_closed',pairingCode:null,expiresAt:null});await assert.rejects(h.registration.prepare(),{code:'xiaozhi_closed'});
});

test('operation deadline covers a stalled response body and concurrent setup is refused',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness([new Response(new ReadableStream({start(){}}))]);const operation=h.registration.prepare();
 await new Promise(resolve=>setImmediate(resolve));await assert.rejects(h.registration.prepare(),{code:'xiaozhi_busy'});
 const rejected=assert.rejects(operation,{code:'xiaozhi_timeout'});t.mock.timers.tick(10_000);await rejected;assert.equal(h.requests[0].options.signal.aborted,true);h.registration.close();
});

test('invalid private storage and write failure are fixed errors without provider traffic or credential exposure',async()=>{
 const corrupt=harness([],{version:1,identity:{...identity,hmacKey:''}});await assert.rejects(corrupt.registration.prepare(),{code:'xiaozhi_storage_invalid'});assert.equal(corrupt.requests.length,0);corrupt.registration.close();
 const r=createOfficialRegistration({read:()=>null,write:async()=>{throw new Error('private-store-path');},identityFactory:()=>identity,fetchImpl:async()=>assert.fail('must persist identity before provider request')});
 await assert.rejects(r.prepare(),{code:'xiaozhi_storage_failed',message:'xiaozhi_storage_failed'});safe(r.snapshot());r.close();
});
