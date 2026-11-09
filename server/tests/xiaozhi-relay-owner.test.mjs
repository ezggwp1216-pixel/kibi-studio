import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir,writeFile,chmod,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createCipheriv} from 'node:crypto';
import {once} from 'node:events';
import https from 'node:https';
import {DatabaseSync} from 'node:sqlite';
import WebSocket,{WebSocketServer} from '../resources/xiaozhi/network/ws-8.22.1/wrapper.mjs';
import {createTestTls} from './fixtures/tls.mjs';
import {openStore} from '../src/store.mjs';
import {startVoiceModule} from '../src/voice.mjs';
const token='Q'.repeat(43),hash=v=>createHash('sha256').update(v).digest('hex');
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'kibi-relay-owner-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,store:await openStore(dir)};}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const xiaozhiSelection=kind=>({provider:'xiaozhi',scope:{kind,id:kind==='panel'?'own':'SYNTHETIC_PROJECT_ID'}});
async function voiceFixture(t,{kind='panel',createAdapter}={}){
 const f=await fixture(t),tls=createTestTls(),tlsDir=join(f.dir,'tls');await mkdir(tlsDir,{mode:0o750});
 const keyFile=join(tlsDir,'key'),certFile=join(tlsDir,'cert');await writeFile(keyFile,tls.key,{mode:0o640});await writeFile(certFile,tls.cert,{mode:0o640});
 f.store.state.devices.push({id:'own',tokenHash:hash(token)});f.store.state.ai=f.store.seal({apiKey:'SYNTHETIC_OPENAI_NEVER_LIVE'});
 f.store.state.xiaozhi=f.store.seal({version:1,identity:{deviceId:'02:11:22:33:44:55',clientId:'12345678-1234-4123-8123-123456789abc',serialNumber:'KIBI-SW-1234567890ABCDEF',hmacKey:'a'.repeat(64)},activation:null,configuration:{url:'wss://api.tenclass.net/xiaozhi/v1/',token:'SYNTHETIC_XIAO_PRIVATE',deviceId:'02:11:22:33:44:55',clientId:'12345678-1234-4123-8123-123456789abc'}});
 let legacyDataDir;
 if(kind==='legacy'){
  legacyDataDir=join(await realpath(f.dir),'legacy');await mkdir(legacyDataDir,{mode:0o750});
  const master=Buffer.from(Array.from({length:32},(_,i)=>i)),iv=Buffer.alloc(12,1),generation='1'.repeat(32),device='d'.repeat(32);
  const cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(Buffer.from('kibi-voice/v1:'+generation));
  const encrypted=Buffer.concat([iv,cipher.update(JSON.stringify({api_key:'SYNTHETIC_LEGACY_OPENAI_NEVER_LIVE',api_base_url:'https://api.openai.com/v1',model:'gpt-realtime'})),cipher.final(),cipher.getAuthTag()]).toString('base64');
  await writeFile(join(legacyDataDir,'master.key'),master,{mode:0o640});
  const dbFile=join(legacyDataDir,'voice.sqlite3'),db=new DatabaseSync(dbFile);t.after(()=>db.close());
  db.exec(`PRAGMA journal_mode=DELETE;
   CREATE TABLE voice_devices(id TEXT PRIMARY KEY,project_id TEXT,active_generation_id TEXT,updated_at INTEGER,revoked_at INTEGER);
   CREATE TABLE voice_generations(id TEXT PRIMARY KEY,device_id TEXT,source_hash TEXT,source_revision INTEGER,configuration_revision INTEGER,token_hash TEXT,encrypted_config TEXT,state TEXT,created_at INTEGER,expires_at INTEGER);`);
  db.prepare('INSERT INTO voice_devices VALUES(?,?,?,?,?)').run(device,'SYNTHETIC_PROJECT_ID',generation,1,null);
  db.prepare('INSERT INTO voice_generations VALUES(?,?,?,?,?,?,?,?,?,?)').run(generation,device,'e'.repeat(64),0,0,hash('a'.repeat(64)),encrypted,'active',1,null);await chmod(dbFile,0o640);
 }
 const permissions=[];
 const voice=await startVoiceModule({store:f.store,publicOrigin:'https://kibi.example',config:{enabled:true,keyFile,certFile,port:0,...(legacyDataDir?{legacyDataDir}:{})},...(createAdapter===null?{}:{createAdapter:createAdapter||((options)=>{permissions.push(options);return {receiveDevice(){},close(){}};})})});
 t.after(()=>voice.close());assert.ok(voice.address(),'local TLS gateway must listen');
 function connect(){const ws=new WebSocket(`wss://127.0.0.1:${voice.address().port}/kibi-xiaozhi/v1`,{ca:tls.cert,servername:'localhost',headers:{Authorization:'Bearer '+(kind==='panel'?token:'a'.repeat(64))}});ws.on('error',()=>{});t.after(()=>ws.terminate());return ws;}
 return {...f,voice,tls,connect,permissions};
}
function outcome(ws){return new Promise(resolve=>{ws.once('open',()=>resolve('open'));ws.once('unexpected-response',(_,response)=>{response.resume();resolve(response.statusCode);});ws.once('error',()=>resolve('error'));});}

test('default owner factory reaches the real Xiaozhi adapter and socket with routing metadata removed', {timeout:5000},async t=>{
 const f=await voiceFixture(t,{createAdapter:null}),server=https.createServer(f.tls),peers=[],requests=[];
 const upstream=new WebSocketServer({noServer:true,perMessageDeflate:false});
 server.on('upgrade',(request,socket,head)=>{requests.push(request);upstream.handleUpgrade(request,socket,head,ws=>{peers.push(ws);ws.on('message',()=>ws.send(JSON.stringify({type:'hello',transport:'websocket',audio_params:{format:'opus',sample_rate:16000,channels:1,frame_duration:60}})));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const peer of peers)peer.terminate();upstream.close();await new Promise(resolve=>server.close(resolve));});
 // Route only the fixed official destination to our TLS fixture. Any unexpected
 // provider URL fails before network; the production factory/adapter/socket stay real.
 const request=https.request;
 t.mock.method(https,'request',function(options,...args){
  if(options.host==='127.0.0.1')return request.call(this,options,...args);
  assert.equal(options.host,'api.tenclass.net');assert.equal(options.path,'/xiaozhi/v1/');assert.equal(options.rejectUnauthorized,true);
  return request.call(this,{...options,hostname:'127.0.0.1',host:'127.0.0.1',port:server.address().port,servername:'localhost',ca:f.tls.cert},...args);
 });
 await f.voice.selectProvider(xiaozhiSelection('panel'));const ws=f.connect();await once(ws,'open');
 const result=new Promise(resolve=>{ws.once('message',data=>resolve(JSON.parse(data)));ws.once('close',()=>resolve(null));});
 ws.send(JSON.stringify({type:'hello',version:1,transport:'websocket',audio_params:{format:'opus',sample_rate:16000,channels:1,frame_duration:60}}));
 assert.equal((await result)?.type,'hello');assert.equal(requests.length,1);
 assert.equal(requests[0].headers.authorization,'Bearer SYNTHETIC_XIAO_PRIVATE');assert.equal(f.voice.status().status,'active');
});

for(const kind of ['panel','legacy'])for(const initial of ['openai','xiaozhi'])test(`${kind}: changing ${initial} provider cancels the active permission`,{timeout:5000},async t=>{
 const f=await voiceFixture(t,{kind});if(initial==='xiaozhi')await f.voice.selectProvider(xiaozhiSelection(kind));
 const ws=f.connect();assert.equal(await outcome(ws),'open');await turn();assert.equal(f.permissions.length,1);
 const permission=f.permissions[0];assert.equal(permission.signal.aborted,false);
 await f.voice.selectProvider(initial==='openai'?xiaozhiSelection(kind):{provider:'openai'});
 assert.equal(permission.signal.aborted,true);assert.equal(f.voice.status().activeSessions,0);
});

for(const initial of ['openai','xiaozhi'])test(`panel: queued ${initial} authorization is rejected after provider selection changes`,{timeout:5000},async t=>{
 const f=await voiceFixture(t);if(initial==='xiaozhi')await f.voice.selectProvider(xiaozhiSelection('panel'));
 let release,started;const blocked=f.store.exclusive(()=>new Promise(resolve=>{release=resolve;}));await turn();
 const selection=f.voice.selectProvider(initial==='openai'?xiaozhiSelection('panel'):{provider:'openai'});
 const queued=new Promise(resolve=>{started=resolve;}),exclusive=f.store.exclusive;
 t.mock.method(f.store,'exclusive',fn=>{started();return exclusive(fn);});
 const result=outcome(f.connect());await queued;release();await blocked;await selection;
 assert.equal(await result,401);assert.equal(f.permissions.length,0);
});

for(const initial of ['openai','xiaozhi'])test(`legacy: queued ${initial} authorization is rejected after provider selection changes`,{timeout:5000},async t=>{
 const f=await voiceFixture(t,{kind:'legacy'});if(initial==='xiaozhi')await f.voice.selectProvider(xiaozhiSelection('legacy'));
 let selection;const emit=https.Server.prototype.emit;
 // Queue the selection immediately before the real gateway upgrade handler.
 // Legacy authorization is synchronous, but its owner's await must still fence
 // the selection mutation that runs before that authorization resumes.
 t.mock.method(https.Server.prototype,'emit',function(event,...args){
  if(event==='upgrade'&&args[0].url==='/kibi-xiaozhi/v1')selection=f.voice.selectProvider(initial==='openai'?xiaozhiSelection('legacy'):{provider:'openai'});
  return emit.call(this,event,...args);
 });
 const result=await outcome(f.connect());await selection;assert.equal(result,401);assert.equal(f.permissions.length,0);
});

for(const kind of ['panel','legacy'])test(`${kind}: changing selected Xiaozhi scope or registration cancels active permission`,{timeout:5000},async t=>{
 const f=await voiceFixture(t,{kind});await f.voice.selectProvider(xiaozhiSelection(kind));
 assert.equal(await outcome(f.connect()),'open');await turn();const first=f.permissions[0];
 await f.voice.selectProvider({provider:'xiaozhi',scope:{kind,id:'other'}});assert.equal(first.signal.aborted,true);
 await f.voice.selectProvider(xiaozhiSelection(kind));assert.equal(await outcome(f.connect()),'open');await turn();const second=f.permissions[1];
 await f.store.exclusive(async()=>{const state=f.store.xiaozhi();state.configuration.token='SYNTHETIC_REPLACEMENT';f.store.state.xiaozhi=f.store.seal(state);await f.store.save();f.voice.reconcile();});
 assert.equal(second.signal.aborted,true);
});
test('Xiaozhi credentials are encrypted and reopened, never copied into safe owner state',async t=>{
 const {store,dir}=await fixture(t);store.state.xiaozhi=store.seal({secret:'PRIVATE_XIAO_TOKEN'});await store.save();
 assert.equal(typeof store.xiaozhi,'function');assert.deepEqual(store.xiaozhi(),{secret:'PRIVATE_XIAO_TOKEN'});
 assert.equal((await openStore(dir)).xiaozhi().secret,'PRIVATE_XIAO_TOKEN');
 assert.ok(!(await readFile(join(dir,'state.json'),'utf8')).includes('PRIVATE_XIAO_TOKEN'));
});
test('owner explicitly selects one pilot, selection persists and unconfigured Xiaozhi never uses OpenAI',async t=>{
 const {store}=await fixture(t);store.state.ai=store.seal({apiKey:'sk-SYNTHETIC_MUST_NOT_BE_USED'});
 const voice=await startVoiceModule({store,publicOrigin:'https://kibi.example',config:{enabled:false}});t.after(()=>voice.close());
 assert.equal(typeof voice.selectProvider,'function');
 await voice.selectProvider({provider:'xiaozhi',scope:{kind:'legacy',id:'project-test'}});
 assert.equal(voice.status().provider,'xiaozhi');assert.equal(voice.status().configured,false);assert.equal(voice.status().model,null);
 assert.deepEqual(store.state.voice,{provider:'xiaozhi',scope:{kind:'legacy',id:'project-test'}});
 await assert.rejects(()=>voice.selectProvider({provider:'xiaozhi',scope:{kind:'legacy',id:'../../bad'}}));
 await assert.rejects(()=>voice.selectProvider({provider:'other',scope:{kind:'legacy',id:'x'}}));
 assert.doesNotMatch(JSON.stringify(voice.status()),/SYNTHETIC|api_key/);
});
test('panel authentication for Xiaozhi needs a local token but no OpenAI credential',async t=>{
 const {createPanelVoiceAuthorizer}=await import('../src/voice.mjs');const {store}=await fixture(t);
 store.state.devices.push({id:'own',tokenHash:hash(token)});
 const owner=createPanelVoiceAuthorizer({store,requireCredentials:false});t.after(()=>owner.close());
 const auth=await owner.authorize({token});assert.ok(auth);assert.deepEqual(auth.principal,{kind:'panel',id:'own'});assert.deepEqual(auth.configuration,{});
 assert.equal(await owner.authorize({token:'Z'.repeat(43)}),null);
 store.state.devices=[];owner.reconcile();assert.equal(auth.signal.aborted,true);
});

test('real local TLS scopes Xiaozhi to the selected panel token and revokes on selection change',async t=>{
 const {mkdir,writeFile}=await import('node:fs/promises'),{once}=await import('node:events');
 const {createTestTls}=await import('./fixtures/tls.mjs'),{default:WebSocket}=await import('../resources/xiaozhi/network/ws-8.22.1/wrapper.mjs');
 const {dir,store}=await fixture(t),tls=createTestTls(),tlsDir=join(dir,'tls');await mkdir(tlsDir,{mode:0o750});
 const keyFile=join(tlsDir,'key'),certFile=join(tlsDir,'cert');await writeFile(keyFile,tls.key,{mode:0o640});await writeFile(certFile,tls.cert,{mode:0o640});
 const other='Z'.repeat(43);store.state.devices.push({id:'own',tokenHash:hash(token)},{id:'other',tokenHash:hash(other)});
 store.state.xiaozhi=store.seal({version:1,identity:{deviceId:'02:11:22:33:44:55',clientId:'12345678-1234-4123-8123-123456789abc',serialNumber:'KIBI-SW-1234567890ABCDEF',hmacKey:'a'.repeat(64)},activation:null,configuration:{url:'wss://api.tenclass.net/xiaozhi/v1/',token:'SYNTHETIC_XIAO_PRIVATE',deviceId:'02:11:22:33:44:55',clientId:'12345678-1234-4123-8123-123456789abc'}});
 let received;
 const voice=await startVoiceModule({store,publicOrigin:'https://kibi.example',config:{enabled:true,keyFile,certFile,port:0,provider:'xiaozhi'},createAdapter:options=>{received=options.configuration;return{receiveDevice(){},close(){}};}});t.after(()=>voice.close());
 await voice.selectProvider({provider:'xiaozhi',scope:{kind:'panel',id:'own'}});
 const connect=tok=>{const ws=new WebSocket(`wss://127.0.0.1:${voice.address().port}/kibi-xiaozhi/v1`,{ca:tls.cert,servername:'localhost',headers:{Authorization:'Bearer '+tok}});ws.on('error',()=>{});t.after(()=>ws.terminate());return ws;};
 const wrong=connect(other);const rejected=await new Promise(resolve=>wrong.once('unexpected-response',(_,response)=>{response.resume();resolve(response.statusCode);}));assert.equal(rejected,401);assert.equal(received,undefined);
 const good=connect(token);await once(good,'open');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(received.provider,'xiaozhi');assert.equal(received.token,'SYNTHETIC_XIAO_PRIVATE');assert.equal(received.api_key,undefined);
 assert.doesNotMatch(JSON.stringify(voice.status()),/SYNTHETIC_XIAO_PRIVATE|hmacKey|clientId/);
 const closing=once(good,'close');await voice.selectProvider({provider:'xiaozhi',scope:{kind:'panel',id:'other'}});await closing;
 await assert.rejects(()=>voice.selectProvider({provider:'openai'}));
});
