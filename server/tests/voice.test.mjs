import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, chmod, rm, symlink, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createCipheriv} from 'node:crypto';
import {openStore} from '../src/store.mjs';
import WebSocket from '../resources/xiaozhi/network/ws-8.22.1/wrapper.mjs';
import {once} from 'node:events';
import {createTestTls} from './fixtures/tls.mjs';

const token='Q'.repeat(43), apiKey='sk-SYNTHETIC_NEVER_LIVE_1234567890';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'kibi-server-voice-'));
 const store=await openStore(join(dir,'data'));
 store.state.devices.push({id:'test-device',tokenHash:hash(token),lastSeenAt:null});
 store.state.ai=store.seal({apiKey,enabled:false,model:'gpt-5-mini',systemPrompt:''});
 await store.save();
 t.after(()=>rm(dir,{recursive:true,force:true}));
 return {dir,store};
}

test('panel token authorizes fixed realtime model, rejects unknown tokens and actively revokes metadata changes',async t=>{
 const {createPanelVoiceAuthorizer}=await import('../src/voice.mjs').catch(()=>({}));
 assert.equal(typeof createPanelVoiceAuthorizer,'function');
 const {store}=await fixture(t), owner=createPanelVoiceAuthorizer({store});t.after(()=>owner.close());
 const first=await owner.authorize({token});
 assert.deepEqual(first.configuration,{api_key:apiKey,api_base_url:'https://api.openai.com/v1',model:'gpt-realtime'});
 assert.equal(first.signal.aborted,false);
 assert.ok(Date.parse(store.state.devices[0].lastSeenAt)>0);
 assert.equal(await owner.authorize({token:'Z'.repeat(43)}),null);
 assert.equal(first.signal.aborted,false);
 store.state.devices=[];owner.reconcile();assert.equal(first.signal.aborted,true);
 assert.equal(await owner.authorize({token}),null);
 store.state.devices.push({id:'replacement',tokenHash:hash(token)});
 const second=await owner.authorize({token});
 store.state.ai=store.seal({apiKey,enabled:false,model:'gpt-5-mini',systemPrompt:'Говори как любопытная Киби.'});owner.reconcile();
 assert.equal((await owner.authorize({token})).configuration.instructions,'Говори как любопытная Киби.');
 store.state.ai=store.seal({apiKey:apiKey+'replacement',model:'gpt-5-mini',enabled:true});
 owner.reconcile();assert.equal(second.signal.aborted,true);
 const third=await owner.authorize({token});store.state.ai=null;owner.reconcile();assert.equal(third.signal.aborted,true);
 assert.equal(await owner.authorize({token}),null);
});

test('voice defaults off, enabled without TLS reports failure and does not open a plaintext fallback',async t=>{
 const {startVoiceModule}=await import('../src/voice.mjs').catch(()=>({}));
 assert.equal(typeof startVoiceModule,'function');
 const {store}=await fixture(t);
 const disabled=await startVoiceModule({store,publicOrigin:'https://kibi.example',config:{enabled:false}});t.after(()=>disabled.close());
 assert.equal(disabled.status().status,'disabled');assert.equal(disabled.address(),null);
 const missing=await startVoiceModule({store,publicOrigin:'https://kibi.example',config:{enabled:true}});t.after(()=>missing.close());
 assert.equal(missing.status().status,'error');assert.equal(missing.status().code,'tls_required');assert.equal(missing.address(),null);
 assert.doesNotMatch(JSON.stringify(missing.status()),/SYNTHETIC|api_key|tokenHash|\.key/);
});

test('TLS reads reject public permissions, hardlinks and symlinks before listener startup',async t=>{
 const {startVoiceModule}=await import('../src/voice.mjs').catch(()=>({}));assert.equal(typeof startVoiceModule,'function');
 const {dir,store}=await fixture(t), tlsDir=join(dir,'tls');
 const {mkdir,link}=await import('node:fs/promises');await mkdir(tlsDir,{mode:0o750});
 const key=join(tlsDir,'key.pem'),cert=join(tlsDir,'cert.pem');await writeFile(key,'SYNTHETIC',{mode:0o644});await writeFile(cert,'SYNTHETIC',{mode:0o640});
 const attempt=async keyFile=>{const runtime=await startVoiceModule({store,publicOrigin:'https://kibi.example',config:{enabled:true,keyFile,certFile:cert,port:0}});assert.equal(runtime.status().status,'error');assert.equal(runtime.status().code,'tls_failed');assert.equal(runtime.address(),null);await runtime.close();};
 await attempt(key);await chmod(key,0o640);const linked=join(tlsDir,'linked');await symlink(key,linked);await attempt(linked);
 await rm(linked);await link(key,linked);await attempt(key);
});

test('panel mounted below a prefix resolves assets and API relative to its module URL',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kibi-server-prefix-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {createKibiServer}=await import('../src/server.mjs');
 const server=await createKibiServer({dataDir:dir,adminPassword:'long test admin password',publicOrigin:'https://kibi.example',cookiePath:'/server/',voiceConfig:{enabled:false}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const html=await (await fetch(base)).text();
 assert.match(html,/type="module"[^>]*src="\.\/app\.js"/);assert.match(html,/href="\.\/styles\.css"/);
 const js=await (await fetch(base+'/app.js')).text();assert.match(js,/new URL\([^\n]*import\.meta\.url/);
 assert.equal(new URL('api/session',new URL('./','https://kibi.example/server/app.js')).pathname,'/server/api/session');
 const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:'https://kibi.example','Content-Type':'application/json'},body:JSON.stringify({password:'long test admin password'})});
 assert.match(login.headers.get('set-cookie'),/Path=\/server\//);
});

test('real verified TLS admits own token without exposing key, revocation disconnects it and shutdown closes its port',async t=>{
 const {startVoiceModule}=await import('../src/voice.mjs');
 const {dir,store}=await fixture(t),tlsDir=join(dir,'tls');
 const {mkdir}=await import('node:fs/promises');await mkdir(tlsDir,{mode:0o750});
 const tls=createTestTls();
 const keyFile=join(tlsDir,'backend.key'),certFile=join(tlsDir,'backend.crt');
 await writeFile(keyFile,tls.key,{mode:0o640});await writeFile(certFile,tls.cert,{mode:0o640});
 const runtime=await startVoiceModule({store,publicOrigin:'https://kibi.example',config:{enabled:true,keyFile,certFile,port:0}});t.after(()=>runtime.close());
 assert.equal(runtime.status().status,'listening');assert.equal(runtime.status().tls,true);
 const client=new WebSocket(`wss://127.0.0.1:${runtime.address().port}/kibi-xiaozhi/v1`,{ca:tls.cert,servername:'localhost',headers:{Authorization:`Bearer ${token}`}});
 client.on('error',()=>{});t.after(()=>client.terminate());await once(client,'open');
 assert.equal(runtime.status().activeSessions,1);
 assert.doesNotMatch(JSON.stringify(runtime.status()),new RegExp(`${apiKey}|${token}|api_key|tokenHash`));
 const closed=once(client,'close');store.state.devices=[];runtime.reconcile();await closed;
 assert.equal(runtime.status().activeSessions,0);
 await runtime.close();assert.equal(runtime.address(),null);
});

test('same TLS runtime accepts a Python-compatible legacy capability and cancellation follows registry revocation',async t=>{
 const {startVoiceModule}=await import('../src/voice.mjs'),{DatabaseSync}=await import('node:sqlite');
 const {dir,store}=await fixture(t),{mkdir}=await import('node:fs/promises'),tlsDir=join(dir,'tls'),legacyDir=join(await realpath(dir),'legacy');
 await mkdir(tlsDir,{mode:0o750});await mkdir(legacyDir,{mode:0o750});
 const tls=createTestTls();
 const keyFile=join(tlsDir,'backend.key'),certFile=join(tlsDir,'backend.crt');
 await writeFile(keyFile,tls.key,{mode:0o640});await writeFile(certFile,tls.cert,{mode:0o640});
 const master=Buffer.alloc(32,7),iv=Buffer.alloc(12,8),generation='1'.repeat(32),legacyToken='a'.repeat(64),device='d'.repeat(32);
 await writeFile(join(legacyDir,'master.key'),master,{mode:0o640});
 const cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(Buffer.from('kibi-voice/v1:'+generation));
 const encrypted=Buffer.concat([iv,cipher.update(JSON.stringify({api_key:apiKey,api_base_url:'https://api.openai.com/v1',model:'gpt-realtime'})),cipher.final(),cipher.getAuthTag()]).toString('base64');
 const dbFile=join(legacyDir,'voice.sqlite3'),db=new DatabaseSync(dbFile);t.after(()=>db.close());
 db.exec(`PRAGMA journal_mode=DELETE;
 CREATE TABLE voice_devices(id TEXT PRIMARY KEY,active_generation_id TEXT,revoked_at INTEGER,updated_at INTEGER);
 CREATE TABLE voice_generations(id TEXT PRIMARY KEY,device_id TEXT,source_hash TEXT,source_revision INTEGER,configuration_revision INTEGER,token_hash TEXT,encrypted_config TEXT,state TEXT,created_at INTEGER,expires_at INTEGER);`);
 db.prepare('INSERT INTO voice_devices VALUES(?,?,NULL,1)').run(device,generation);
 db.prepare('INSERT INTO voice_generations VALUES(?,?,?,?,?,?,?,\'active\',1,NULL)').run(generation,device,'e'.repeat(64),0,0,hash(legacyToken),encrypted);
 await chmod(dbFile,0o640);
 const runtime=await startVoiceModule({store,publicOrigin:'https://kibi.example',config:{enabled:true,keyFile,certFile,port:0,legacyDataDir:legacyDir}});t.after(()=>runtime.close());
 assert.equal(runtime.status().legacyReady,true);assert.equal(runtime.status().status,'listening');
 const client=new WebSocket(`wss://127.0.0.1:${runtime.address().port}/kibi-xiaozhi/v1`,{ca:tls.cert,servername:'localhost',headers:{Authorization:`Bearer ${legacyToken}`}});
 client.on('error',()=>{});t.after(()=>client.terminate());await once(client,'open');
 const closed=once(client,'close');db.exec('UPDATE voice_devices SET revoked_at=1');await closed;
 assert.equal(runtime.status().activeSessions,0);assert.doesNotMatch(JSON.stringify(runtime.status()),/SYNTHETIC|api_key|[a]{64}|master\.key|voice\.sqlite3/);
 await runtime.close();
});
