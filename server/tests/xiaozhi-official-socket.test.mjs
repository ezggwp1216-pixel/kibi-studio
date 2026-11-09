import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import https from 'node:https';
import {setTimeout as sleep} from 'node:timers/promises';
import WebSocket,{WebSocketServer} from '../resources/xiaozhi/network/ws-8.22.1/wrapper.mjs';
import {createTestTls} from './fixtures/tls.mjs';

const CONFIG={url:'wss://api.tenclass.net/xiaozhi/v1/',token:'PRIVATE_TOKEN_CANARY',deviceId:'02:34:56:78:9a:bc',clientId:'67ab9d9a-6db4-4a26-bf33-7fd329e6ff54'};
const HELLO={type:'hello',transport:'websocket',session_id:'upstream-session',audio_params:{format:'opus',sample_rate:24000,channels:1,frame_duration:60}};
const load=()=>import('../src/xiaozhi/official-socket.mjs');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await sleep(5);}assert.fail('bounded event did not arrive');}
function fakeTransport(){
 const peers=[];
 class Peer extends EventEmitter{
  constructor(url,options){super();this.url=url;this.options=options;this.readyState=0;this.writes=[];this.callbacks=[];this.bufferedAmount=0;this.terminations=0;peers.push(this);}
  open(){this.readyState=1;this.emit('open');}
  message(value,binary=false){this.emit('message',binary?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value)),binary);}
  send(payload,options,done){this.writes.push({payload,options});this.callbacks.push(done);if(!this.holdWrites)queueMicrotask(()=>done());}
  pong(payload,_,done){this.send(payload,{pong:true},done);}
  terminate(){this.terminations++;this.readyState=3;this.emit('close',1006,Buffer.from('PRIVATE_REMOTE_REASON'));}
 }
 return {Peer,peers};
}
async function opening(options={}){const {connectOfficialCloud}=await load(),transport=fakeTransport(),codes=[],events=[];const pending=connectOfficialCloud({configuration:CONFIG,WebSocketImpl:transport.Peer,onClose:code=>codes.push(code),onEvent:event=>events.push(event),...options});const peer=transport.peers[0];return {pending,peer,codes,events};}
async function ready(options={}){const f=await opening(options);f.peer.open();await turn();f.peer.message(HELLO);f.connection=await f.pending;return f;}
function safe(value){assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|Bearer|stack|api_key/);}

test('only official WSS endpoint and bounded header-safe credentials can create a connection',async()=>{
 const {connectOfficialCloud}=await load();const {Peer,peers}=fakeTransport();
 for(const url of ['ws://api.tenclass.net/xiaozhi/v1/','wss://evil.invalid/xiaozhi/v1/','wss://api.tenclass.net.evil.invalid/xiaozhi/v1/','wss://api.tenclass.net:444/xiaozhi/v1/','wss://user@api.tenclass.net/xiaozhi/v1/','wss://api.tenclass.net/xiaozhi/v1/#x','wss://api.tenclass.net/xiaozhi/v1','wss://api.tenclass.net/xiaozhi/%76%31/'])await assert.rejects(connectOfficialCloud({configuration:{...CONFIG,url},WebSocketImpl:Peer}),{code:'unsupported_endpoint'});
 for(const change of [{token:''},{token:'x\r\nInjected: private'},{token:'x'.repeat(4097)},{deviceId:''},{deviceId:'x\n'},{clientId:''},{clientId:'x'.repeat(257)}, {api_key:'PRIVATE_OPENAI_KEY'},{provider:'xiaozhi'}])await assert.rejects(connectOfficialCloud({configuration:{...CONFIG,...change},WebSocketImpl:Peer}),{code:'configuration_required'});
 assert.equal(peers.length,0);
});

test('official WSS queries remain private transport configuration on the fixed TLS destination',async()=>{
 const f=await ready({configuration:{...CONFIG,url:'wss://api.tenclass.net:443/xiaozhi/v1/?token=PRIVATE_QUERY'}});
 assert.equal(f.peer.url,'wss://api.tenclass.net/xiaozhi/v1/?token=PRIVATE_QUERY');
 assert.equal(f.peer.options.rejectUnauthorized,true);assert.equal(f.peer.options.followRedirects,false);safe(f.codes);f.connection.close();
});

test('TLS options, identity headers and v1 hello use official protocol with no API key',async()=>{
 const f=await opening();let resolved=false;f.pending.then(()=>resolved=true);f.peer.open();await turn();assert.equal(resolved,false);
 assert.equal(f.peer.url,CONFIG.url);assert.deepEqual(f.peer.options.headers,{Authorization:'Bearer '+CONFIG.token,'Protocol-Version':'1','Device-Id':CONFIG.deviceId,'Client-Id':CONFIG.clientId});
 assert.equal(f.peer.options.rejectUnauthorized,true);assert.equal(f.peer.options.followRedirects,false);assert.equal(f.peer.options.perMessageDeflate,false);assert.equal(f.peer.options.maxPayload,131072);assert.equal(f.peer.options.handshakeTimeout,10000);
 assert.deepEqual(JSON.parse(f.peer.writes[0].payload),{type:'hello',version:1,transport:'websocket',audio_params:{format:'opus',sample_rate:16000,channels:1,frame_duration:60}});
 f.peer.message(HELLO);const connection=await f.pending;assert.deepEqual(connection.hello,HELLO);assert.deepEqual(f.events,[]);connection.close();assert.deepEqual(f.codes,['closed']);
});

test('ready requires hello transport, audio profile and supported version',async()=>{
 const invalid=[{}, {type:'stt',text:'PRIVATE_TEXT'}, {...HELLO,transport:'mqtt'}, {...HELLO,version:2}, {...HELLO,audio_params:undefined}, ...[{format:'pcm'},{sample_rate:48000},{channels:2},{frame_duration:20}].map(audio=>({...HELLO,audio_params:{...HELLO.audio_params,...audio}})), {...HELLO,session_id:'x'.repeat(257)}];
 for(const hello of invalid){const f=await opening();const rejected=assert.rejects(f.pending,{code:'provider_protocol_invalid'});f.peer.open();f.peer.message(hello);await rejected;assert.deepEqual(f.codes,['provider_protocol_invalid']);assert.equal(f.peer.readyState,3);}
 const f=await ready();assert.equal(f.connection.hello.audio_params.sample_rate,24000);f.connection.close();
 const g=await opening();g.peer.open();g.peer.message({...HELLO,version:1,audio_params:{...HELLO.audio_params,sample_rate:16000}});(await g.pending).close();
});

test('hello response cannot resolve before the outbound hello write completes',async()=>{
 const f=await opening();f.peer.holdWrites=true;let resolved=false;f.pending.then(()=>resolved=true);f.peer.open();await turn();f.peer.message(HELLO);await turn();assert.equal(resolved,false);f.peer.callbacks[0]();const connection=await f.pending;connection.close();
});

test('JSON and raw binary audio events are delivered in order through awaited handlers',async()=>{
 let release;const events=[];let active=0,peak=0;
 const f=await ready({onEvent:async event=>{active++;peak=Math.max(peak,active);events.push(event);if(events.length===1)await new Promise(resolve=>release=resolve);active--;}});
 f.peer.message({type:'tts',state:'start'});f.peer.message(Buffer.from([0xf8,0xff,0xfe]),true);f.peer.message({type:'tts',state:'stop'});await until(()=>events.length===1);assert.equal(peak,1);release();await until(()=>events.length===3);
 assert.deepEqual(events,[{binary:false,payload:{type:'tts',state:'start'}},{binary:true,payload:Buffer.from([0xf8,0xff,0xfe])},{binary:false,payload:{type:'tts',state:'stop'}}]);assert.equal(peak,1);f.connection.close();
});

for(const [name,payload,binary] of [['invalid-json','PRIVATE_{',false],['array-json','[]',false],['missing-type','{}',false],['duplicate-hello',HELLO,false],['empty-audio',Buffer.alloc(0),true],['large-audio',Buffer.alloc(1276),true],['large-json','x'.repeat(131073),false]])test(name+' retires the connection without forwarding payload',async()=>{
 const f=await ready();f.peer.message(payload,binary);await turn();assert.deepEqual(f.events,[]);assert.deepEqual(f.codes,['provider_protocol_invalid']);safe(f.codes);
});

test('async event rejection closes once with a fixed code, and drops late events',async()=>{
 const f=await ready({onEvent:async()=>{throw new Error('PRIVATE_FAILURE');}});f.peer.message({type:'stt',text:'PRIVATE_TEXT'});await until(()=>f.codes.length===1);f.peer.emit('error',new Error('PRIVATE_TOKEN_CANARY'));f.peer.message(Buffer.from([1]),true);f.connection.close();assert.deepEqual(f.codes,['provider_protocol_invalid']);safe(f.codes);
});

test('blocked event handlers have bounded pending event counts',async()=>{
 let release;const f=await ready({onEvent:()=>new Promise(resolve=>release=resolve)});f.peer.message({type:'tts',state:'start'});await turn();for(let i=0;i<1600;i++)f.peer.message(Buffer.from([1]),true);await until(()=>f.codes.length===1);assert.deepEqual(f.codes,['output_backpressure']);release?.();
});

test('blocked event handlers have bounded pending bytes',async()=>{
 let release;const f=await ready({onEvent:()=>new Promise(resolve=>release=resolve)});const value={type:'stt',text:'x'.repeat(120000)};for(let i=0;i<5;i++)f.peer.message(value);await until(()=>f.codes.length===1);assert.deepEqual(f.codes,['output_backpressure']);release?.();
});

test('send methods await actual write callbacks and serialize writes',async()=>{
 const f=await ready();f.peer.holdWrites=true;let done=false;const first=f.connection.sendJson({type:'listen',state:'start'}).then(()=>done=true);const second=f.connection.sendAudio(Buffer.from([0xf8,0xff,0xfe]));await turn();assert.equal(done,false);assert.equal(f.peer.writes.length,2);assert.deepEqual(f.peer.writes[1].options,{binary:false,compress:false});f.peer.callbacks[1]();await first;await turn();assert.equal(f.peer.writes.length,3);assert.deepEqual(f.peer.writes[2].payload,Buffer.from([0xf8,0xff,0xfe]));assert.deepEqual(f.peer.writes[2].options,{binary:true,compress:false});f.peer.callbacks[2]();await second;f.connection.close();
});

test('invalid outgoing messages never write bytes',async()=>{
 const f=await ready();for(const value of [null,[],{},{type:'listen',text:'x'.repeat(131072)}])await assert.rejects(f.connection.sendJson(value),{code:'provider_protocol_invalid'});for(const value of [Buffer.alloc(0),Buffer.alloc(1276),'text'])await assert.rejects(f.connection.sendAudio(value),{code:'provider_protocol_invalid'});assert.equal(f.peer.writes.length,1);f.connection.close();
});

test('pending writes are byte bounded and all reject when transport retires',async()=>{
 const f=await ready();f.peer.holdWrites=true;const jobs=Array.from({length:120},()=>f.connection.sendAudio(Buffer.alloc(1275,1)));const settled=await Promise.allSettled(jobs);assert.ok(settled.every(item=>item.status==='rejected'));assert.deepEqual(f.codes,['input_backpressure']);
});

test('tiny writes are count bounded even below the byte limit',async()=>{
 const f=await ready();f.peer.holdWrites=true;const jobs=Array.from({length:140},()=>f.connection.sendAudio(Buffer.from([1])));assert.ok((await Promise.allSettled(jobs)).every(item=>item.status==='rejected'));assert.deepEqual(f.codes,['input_backpressure']);
});

test('readiness deadline includes TLS, hello and initial write',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await opening();const rejected=assert.rejects(f.pending,{code:'timeout'});t.mock.timers.tick(10000);await rejected;assert.deepEqual(f.codes,['timeout']);f.peer.open();assert.equal(f.peer.readyState,3);assert.equal(f.peer.writes.length,0);
});

test('each transport write has a five second deadline',async t=>{
 const f=await ready();t.mock.timers.enable({apis:['setTimeout']});f.peer.holdWrites=true;const job=f.connection.sendAudio(Buffer.from([1]));const rejected=assert.rejects(job,{code:'timeout'});await turn();t.mock.timers.tick(5000);await rejected;assert.deepEqual(f.codes,['timeout']);f.peer.callbacks.at(-1)();
});

test('abort before construction opens nothing; abort during connect closes late peers',async()=>{
 const {connectOfficialCloud}=await load(),transport=fakeTransport(),controller=new AbortController();controller.abort(new Error('PRIVATE_ABORT'));await assert.rejects(connectOfficialCloud({configuration:CONFIG,signal:controller.signal,WebSocketImpl:transport.Peer}),{code:'cancelled'});assert.equal(transport.peers.length,0);
 const current=new AbortController(),f=await opening({signal:current.signal});const rejected=assert.rejects(f.pending,{code:'cancelled'});current.abort();await rejected;f.peer.open();f.peer.message(HELLO);assert.equal(f.peer.readyState,3);assert.equal(f.peer.writes.length,0);assert.deepEqual(f.codes,['cancelled']);
});

test('abort after ready rejects pending writes and emits a sanitized close once',async()=>{
 const controller=new AbortController(),f=await ready({signal:controller.signal});f.peer.holdWrites=true;const write=f.connection.sendAudio(Buffer.from([1]));const rejected=assert.rejects(write,{code:'cancelled'});controller.abort('PRIVATE_REASON');await rejected;f.connection.close();f.peer.emit('error',new Error('PRIVATE_ERROR'));assert.deepEqual(f.codes,['cancelled']);await assert.rejects(f.connection.sendJson({type:'listen'}),{code:'cancelled'});
});

for(const [status,expected] of [[301,'network_error'],[401,'authentication_required'],[403,'authentication_required'],[429,'quota_or_rate_limit'],[500,'network_error']])test('HTTP '+status+' never redirects and reports only '+expected,async()=>{
 const f=await opening();const rejected=assert.rejects(f.pending,{code:expected});let destroyed=0;f.peer.emit('unexpected-response',{destroy(){destroyed++;}},{statusCode:status,destroy(){destroyed++;}});await rejected;assert.equal(destroyed,2);assert.deepEqual(f.codes,[expected]);safe(f.codes);
});

test('constructor and TLS errors never expose transport exception text',async()=>{
 const {connectOfficialCloud}=await load();await assert.rejects(connectOfficialCloud({configuration:CONFIG,WebSocketImpl:class{constructor(){throw new Error('PRIVATE_CONSTRUCTOR');}}}),{message:'network_error',code:'network_error'});
 const f=await opening();const rejected=assert.rejects(f.pending,{code:'tls_failed'});f.peer.emit('error',Object.assign(new Error('PRIVATE_CERTIFICATE'),{code:'CERT_HAS_EXPIRED'}));await rejected;assert.deepEqual(f.codes,['tls_failed']);
});

async function localTls(t,{trusted=true,redirect=false}={}){
 const tls=createTestTls();let requests=0;const headers=[],received=[],peers=[];const server=https.createServer(tls);const wss=new WebSocketServer({noServer:true,perMessageDeflate:false});server.on('upgrade',(request,socket,head)=>{requests++;headers.push(request.headers);if(redirect){socket.end('HTTP/1.1 302 Found\r\nLocation: wss://evil.invalid/\r\nContent-Length: 0\r\n\r\n');return;}wss.handleUpgrade(request,socket,head,ws=>{peers.push(ws);ws.on('message',(payload,binary)=>{received.push({payload,binary});if(received.length===1)ws.send(JSON.stringify(HELLO));});});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 class LocalWebSocket extends WebSocket{constructor(url,options){assert.equal(url,CONFIG.url);assert.equal(options.rejectUnauthorized,true);super('wss://127.0.0.1:'+server.address().port+'/xiaozhi/v1/',{...options,servername:'localhost',...(trusted?{ca:tls.cert}:{})});}}
 t.after(async()=>{for(const ws of peers)ws.terminate();wss.close();await new Promise(resolve=>server.close(resolve));});return {LocalWebSocket,headers,received,peers,get requests(){return requests;}};
}

test('real local TLS/WebSocket relays authenticated v1 JSON and unwrapped Opus',async t=>{
 const fixture=await localTls(t),{connectOfficialCloud}=await load(),events=[],codes=[];const connection=await connectOfficialCloud({configuration:CONFIG,WebSocketImpl:fixture.LocalWebSocket,onEvent:event=>events.push(event),onClose:code=>codes.push(code)});assert.equal(connection.hello.audio_params.sample_rate,24000);assert.equal(fixture.headers[0].authorization,'Bearer '+CONFIG.token);assert.equal(fixture.headers[0]['protocol-version'],'1');assert.equal(fixture.headers[0]['device-id'],CONFIG.deviceId);assert.equal(fixture.headers[0]['client-id'],CONFIG.clientId);assert.equal(fixture.headers[0]['sec-websocket-extensions'],undefined);
 await connection.sendJson({type:'listen',state:'start',session_id:connection.hello.session_id});await connection.sendAudio(Buffer.from([0xf8,0xff,0xfe]));await until(()=>fixture.received.length===3);assert.equal(fixture.received[2].binary,true);assert.deepEqual(fixture.received[2].payload,Buffer.from([0xf8,0xff,0xfe]));fixture.peers[0].send(JSON.stringify({type:'tts',state:'start'}));fixture.peers[0].send(Buffer.from([0xf8,0xff,0xfe]));await until(()=>events.length===2);assert.equal(events[0].binary,false);assert.equal(events[1].binary,true);connection.close();assert.deepEqual(codes,['closed']);
});

test('real TLS certificate trust is required',async t=>{const fixture=await localTls(t,{trusted:false}),{connectOfficialCloud}=await load();await assert.rejects(connectOfficialCloud({configuration:CONFIG,WebSocketImpl:fixture.LocalWebSocket}),{code:'tls_failed'});assert.equal(fixture.requests,0);});

test('real redirect cannot change the destination',async t=>{const fixture=await localTls(t,{redirect:true}),{connectOfficialCloud}=await load();await assert.rejects(connectOfficialCloud({configuration:CONFIG,WebSocketImpl:fixture.LocalWebSocket}),{code:'network_error'});assert.equal(fixture.requests,1);});

test('real fragmented oversized message is rejected before delivery',async t=>{const fixture=await localTls(t),{connectOfficialCloud}=await load(),events=[],codes=[];const connection=await connectOfficialCloud({configuration:CONFIG,WebSocketImpl:fixture.LocalWebSocket,onEvent:event=>events.push(event),onClose:code=>codes.push(code)});fixture.peers[0].send('x'.repeat(70000),{fin:false,binary:false});fixture.peers[0].send('x'.repeat(70000),{fin:true,binary:false});await until(()=>codes.length===1);assert.deepEqual(events,[]);assert.deepEqual(codes,['provider_protocol_invalid']);connection.close();});

test('coalesced first event waits until the caller has the ready connection',async()=>{
 let callerReady=false;const observed=[];const f=await opening({onEvent:()=>observed.push(callerReady)});f.peer.open();await turn();f.peer.message(HELLO);f.peer.message({type:'tts',state:'start'});f.connection=await f.pending;callerReady=true;await until(()=>observed.length===1);assert.deepEqual(observed,[true]);f.connection.close();
});

test('backlog reported at write completion cannot be mistaken for a successful send',async()=>{
 const f=await ready();f.peer.holdWrites=true;const job=f.connection.sendAudio(Buffer.from([1]));const rejected=assert.rejects(job,{code:'input_backpressure'});f.peer.bufferedAmount=131073;f.peer.callbacks[1]();await rejected;assert.deepEqual(f.codes,['input_backpressure']);
});

test('an event handler that never completes has a finite deadline',async t=>{
 let release;const f=await ready({onEvent:()=>new Promise(resolve=>release=resolve)});t.mock.timers.enable({apis:['setTimeout']});f.peer.message({type:'tts',state:'start'});await turn();t.mock.timers.tick(30000);await turn();assert.deepEqual(f.codes,['timeout']);release?.();
});

test('abort inside construction still terminates the subsequently returned transport',async()=>{
 const {connectOfficialCloud}=await load(),controller=new AbortController(),transport=fakeTransport(),codes=[];class CancellingPeer extends transport.Peer{constructor(...args){super(...args);controller.abort();}}
 await assert.rejects(connectOfficialCloud({configuration:CONFIG,signal:controller.signal,WebSocketImpl:CancellingPeer,onClose:code=>codes.push(code)}),{code:'cancelled'});assert.equal(transport.peers[0].readyState,3);assert.deepEqual(codes,['cancelled']);
});
