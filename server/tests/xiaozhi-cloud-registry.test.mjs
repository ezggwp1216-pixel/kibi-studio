import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, linkSync, realpathSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, createCipheriv} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as sleep} from 'node:timers/promises';

// Public, deliberately synthetic secrets. These never connect to any provider.
const TOKEN='a'.repeat(64), OTHER_TOKEN='b'.repeat(64), DEVICE='d'.repeat(32), GENERATION='1'.repeat(32);
const CONFIG={api_key:'SYNTHETIC_PROVIDER_KEY_NEVER_LIVE',api_base_url:'https://api.openai.com/v1',model:'gpt-realtime'};
const MASTER=Buffer.from(Array.from({length:32},(_,i)=>i));
const digest=value=>createHash('sha256').update(value).digest('hex');
function encrypt(configuration, generation=GENERATION, master=MASTER){
 const iv=Buffer.from(Array.from({length:12},(_,i)=>i));
 const cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(Buffer.from('kibi-voice/v1:'+generation));
 const plain=typeof configuration==='string'?configuration:JSON.stringify(configuration);
 return Buffer.concat([iv,cipher.update(plain,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');
}
async function moduleUnderTest(){return import('../src/xiaozhi/cloud-registry.mjs');}
function fixture(t){
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'kibi-voice-registry-test-'));chmodSync(dir,0o750);
 const dbFile=join(dir,'voice.sqlite3'),keyFile=join(dir,'master.key');writeFileSync(keyFile,MASTER,{mode:0o640});
 const db=new DatabaseSync(dbFile);db.exec(`PRAGMA journal_mode=DELETE;
 CREATE TABLE voice_devices(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL,owner_token_hash TEXT NOT NULL,project_id TEXT NOT NULL,active_generation_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revoked_at INTEGER);
 CREATE TABLE voice_generations(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES voice_devices(id),source_hash TEXT NOT NULL,source_revision INTEGER NOT NULL,configuration_revision INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,encrypted_config TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER);`);
 const now=Math.floor(Date.now()/1000);
 db.prepare('INSERT INTO voice_devices VALUES(?,?,?,?,?,?,?,?)').run(DEVICE,'SYNTHETIC_OWNER_SCOPE','SYNTHETIC_OWNER_HASH','SYNTHETIC_PROJECT_ID',GENERATION,now,now,null);
 db.prepare('INSERT INTO voice_generations VALUES(?,?,?,?,?,?,?,?,?,?)').run(GENERATION,DEVICE,'e'.repeat(64),0,0,digest(TOKEN),encrypt(CONFIG),'active',now,null);
 chmodSync(dbFile,0o640);
 const handles=[];t.after(()=>{for(const handle of handles)handle.close();db.close();rmSync(dir,{recursive:true,force:true});});
 return{dir,db,dbFile,keyFile,handles,async authorizer(options={}){const {createCloudVoiceAuthorizer}=await moduleUnderTest();const a=createCloudVoiceAuthorizer({dataDir:dir,pollMs:25,...options});handles.push(a);return a;}};
}
function assertSafe(value){assert.doesNotMatch(JSON.stringify(value),/SYNTHETIC_|api_key|api_base_url|openai\.com|[ab]{64}|[de]{32}|master\.key|voice\.sqlite3/);}
async function until(predicate,ms=1500){const end=Date.now()+ms;while(Date.now()<end){if(predicate())return;await sleep(5);}assert.fail('expected bounded revocation');}

test('cloud authorizer factory exists',async()=>{
 const value=await moduleUnderTest().catch(()=>({}));assert.equal(typeof value.createCloudVoiceAuthorizer,'function');
});
test('real SQLite active token decrypts exact server configuration and status stays private',async t=>{
 const f=fixture(t),a=await f.authorizer(),permission=await a.authorize({token:TOKEN});
 assert.deepEqual(permission.configuration,CONFIG);assert.equal(permission.signal.aborted,false);
 assert.deepEqual(a.snapshot().metrics,{authorized:1,denied:0,revoked:0,activeScopes:1,pollers:1});assertSafe(a.snapshot());
 const first=a.snapshot();first.metrics.authorized=999;assert.equal(a.snapshot().metrics.authorized,1);
});
test('Python AES-GCM vector decrypts in Node with the versioned generation AAD',async t=>{
 const f=fixture(t);
 // Produced independently by backend.voice_registry using cryptography AESGCM.
 const ciphertext='AAECAwQFBgcICQoLPCC3a6y6qX70Y62pwoJVHvq481yVDzYfFQSK62kbYdF1PdqZ3LU/9xrIBsC4txgI3mlQvWrmk+oduwh4aIqqjJFPoyWmo0pDJnbCGpv/fdIXpagSH008GJiT/6VWk9bg5I5oxIhjpXX6eVKQcldGD85KEM6CqVHzIJp1sGoYsOFlCHOLLCVUpRglAPU=';
 f.db.prepare('UPDATE voice_generations SET encrypted_config=?').run(ciphertext);
 const a=await f.authorizer(),permission=await a.authorize({token:TOKEN});
 assert.deepEqual(permission.configuration,{api_key:'sk-synthetic-contract-test-only-000000000000',api_base_url:'https://api.openai.com/v1',model:'gpt-realtime'});
});
test('malformed and unknown capabilities fail closed without replacing a valid scope',async t=>{
 const f=fixture(t),a=await f.authorizer(),permission=await a.authorize({token:TOKEN});
 for(const token of [undefined,null,'',OTHER_TOKEN,TOKEN.toUpperCase(),TOKEN+'0',"' OR 1=1 --",Buffer.from(TOKEN)])assert.equal(await a.authorize({token}),null);
 assert.equal(permission.signal.aborted,false);assert.equal(a.snapshot().metrics.activeScopes,1);assert.equal(a.snapshot().metrics.pollers,1);assertSafe(a.snapshot());
});
test('prepared, superseded, revoked, and expired generations cannot authorize',async t=>{
 const f=fixture(t),a=await f.authorizer();
 for(const sql of ["UPDATE voice_generations SET state='prepared'", "UPDATE voice_generations SET state='active'; UPDATE voice_devices SET active_generation_id=NULL", "UPDATE voice_devices SET active_generation_id='"+GENERATION+"',revoked_at=1", "UPDATE voice_devices SET revoked_at=NULL; UPDATE voice_generations SET expires_at=1"]){
  f.db.exec(sql);assert.equal(await a.authorize({token:TOKEN}),null);
 }
 assert.equal(a.snapshot().metrics.activeScopes,0);assertSafe(a.snapshot());
});
test('malformed persisted source metadata cannot authorize by implicit type coercion',async t=>{
 const f=fixture(t),a=await f.authorizer();
 f.db.prepare('UPDATE voice_generations SET source_hash=?').run(Buffer.from('e'.repeat(64)));
 assert.equal(await a.authorize({token:TOKEN}),null);assertSafe(a.snapshot());
});
test('exact official endpoint and bounded header/model shape are required after decrypting',async t=>{
 const f=fixture(t),a=await f.authorizer();
 const bad=[{...CONFIG,api_base_url:'https://api.openai.com.evil.invalid/v1'},{...CONFIG,api_base_url:'https://api.openai.com/v1/'},{...CONFIG,api_base_url:'http://api.openai.com/v1'},{...CONFIG,api_key:'bad\r\nAuthorization: leak'},{...CONFIG,api_key:'x'.repeat(4097)},{...CONFIG,api_key:''},{...CONFIG,model:'other-model'},{...CONFIG,extra:'UNTRUSTED'},{api_key:CONFIG.api_key},[],null,'not-json'];
 for(const config of bad){f.db.prepare('UPDATE voice_generations SET encrypted_config=?').run(encrypt(config));assert.equal(await a.authorize({token:TOKEN}),null);}
 assertSafe(a.snapshot());
});
test('tampered encryption, wrong master, wrong generation AAD and noncanonical base64 all fail closed',async t=>{
 const f=fixture(t);writeFileSync(f.keyFile,Buffer.alloc(32,99));const wrong=await f.authorizer();assert.equal(await wrong.authorize({token:TOKEN}),null);wrong.close();writeFileSync(f.keyFile,MASTER);
 const a=await f.authorizer(),bytes=Buffer.from(encrypt(CONFIG),'base64');bytes[15]^=1;
 for(const value of [bytes.toString('base64'),encrypt(CONFIG,'2'.repeat(32)),encrypt(CONFIG)+'\n','AAAA','x'.repeat(20000)]){
  f.db.prepare('UPDATE voice_generations SET encrypted_config=?').run(value);assert.equal(await a.authorize({token:TOKEN}),null);
 }
 assertSafe(a.snapshot());
});
test('revocation and source/configuration identity changes abort a live scope on one bounded poller',async t=>{
 const f=fixture(t),a=await f.authorizer();
 for(const sql of ["UPDATE voice_devices SET revoked_at=1",'UPDATE voice_generations SET source_revision=1','UPDATE voice_generations SET configuration_revision=1',"UPDATE voice_generations SET state='prepared'"]){
  f.db.exec("UPDATE voice_devices SET revoked_at=NULL; UPDATE voice_generations SET state='active',source_revision=0,configuration_revision=0");
  const permission=await a.authorize({token:TOKEN});f.db.exec(sql);await until(()=>permission.signal.aborted);assert.equal(a.snapshot().metrics.activeScopes,0);assert.equal(a.snapshot().metrics.pollers,0);
 }
 assert.equal(a.snapshot().metrics.revoked,4);assertSafe(a.snapshot());
});
test('preparing a replacement keeps the old active generation live until successful activation',async t=>{
 const f=fixture(t),a=await f.authorizer(),permission=await a.authorize({token:TOKEN});
 const now=Math.floor(Date.now()/1000);
 f.db.prepare('INSERT INTO voice_generations VALUES(?,?,?,?,?,?,?,?,?,?)').run('2'.repeat(32),DEVICE,'f'.repeat(64),1,1,digest(OTHER_TOKEN),encrypt(CONFIG,'2'.repeat(32)),'prepared',now,now+60);
 f.db.exec('UPDATE voice_devices SET updated_at=updated_at+1');
 await sleep(80);assert.equal(permission.signal.aborted,false);assert.equal(a.snapshot().metrics.activeScopes,1);
 assert.equal(await a.authorize({token:OTHER_TOKEN}),null);assert.equal(permission.signal.aborted,false);
 f.db.exec("BEGIN; UPDATE voice_generations SET state='active' WHERE id='"+'2'.repeat(32)+"'; UPDATE voice_devices SET active_generation_id='"+'2'.repeat(32)+"',updated_at=updated_at+1; COMMIT");
 await until(()=>permission.signal.aborted);assert.equal(await a.authorize({token:TOKEN}),null);assert.deepEqual((await a.authorize({token:OTHER_TOKEN})).configuration,CONFIG);
});
test('a live expiring generation is cancelled after its absolute expiry without database writes',async t=>{
 const f=fixture(t);f.db.prepare('UPDATE voice_generations SET expires_at=?').run(Math.floor(Date.now()/1000)+1);
 const a=await f.authorizer(),permission=await a.authorize({token:TOKEN});assert.ok(permission);
 t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(2000);
 await until(()=>permission.signal.aborted);t.mock.timers.reset();assertSafe(a.snapshot());
});
test('valid replacement aborts previous scope and repeated authorization never accumulates controllers/timers',async t=>{
 const f=fixture(t),a=await f.authorizer();let old;
 for(let i=0;i<50;i++){const next=await a.authorize({token:TOKEN});if(old)assert.equal(old.signal.aborted,true);old=next;assert.equal(a.snapshot().metrics.activeScopes,1);assert.equal(a.snapshot().metrics.pollers,1);}
 a.close();assert.equal(old.signal.aborted,true);assert.equal(a.snapshot().metrics.pollers,0);assert.equal(await a.authorize({token:TOKEN}),null);a.close();assertSafe(a.snapshot());
});
test('authorizer restarts from persisted active identity without modifying the read-only registry',async t=>{
 const f=fixture(t),before=readFileSync(f.dbFile),mtime=statSync(f.dbFile).mtimeMs;chmodSync(f.dbFile,0o440);
 const first=await f.authorizer(),one=await first.authorize({token:TOKEN});assert.ok(one);first.close();
 const second=await f.authorizer(),two=await second.authorize({token:TOKEN});assert.ok(two);assert.equal(one.signal.aborted,true);assert.deepEqual(readFileSync(f.dbFile),before);assert.equal(statSync(f.dbFile).mtimeMs,mtime);
});
test('missing/unsafe file boundaries report one fixed error without filenames or secret values',async t=>{
 const f=fixture(t),{createCloudVoiceAuthorizer}=await moduleUnderTest();
 function rejected(options={}){assert.throws(()=>createCloudVoiceAuthorizer({dataDir:f.dir,...options}),error=>error.code==='cloud_voice_unavailable'&&error.message==='cloud_voice_unavailable');}
 chmodSync(f.dir,0o2770);rejected();chmodSync(f.dir,0o2750);
 const good=await f.authorizer();good.close();
 for(const mode of [0o644,0o660,0o777]){chmodSync(f.keyFile,mode);rejected();}chmodSync(f.keyFile,0o640);
 writeFileSync(f.keyFile,Buffer.alloc(31));rejected();writeFileSync(f.keyFile,MASTER);
 const linked=join(f.dir,'linked.key');linkSync(f.keyFile,linked);rejected();rmSync(linked);
 rmSync(f.keyFile);symlinkSync(join(f.dir,'elsewhere.key'),f.keyFile);rejected();rmSync(f.keyFile);writeFileSync(f.keyFile,MASTER,{mode:0o640});
 chmodSync(f.dbFile,0o666);rejected();chmodSync(f.dbFile,0o640);
 const linkDir=join(f.dir,'symlinked');symlinkSync(f.dir,linkDir);rejected({dataDir:linkDir});
});
test('schema failure closes authorization and an unavailable registry aborts existing permission',async t=>{
 const f=fixture(t),a=await f.authorizer(),permission=await a.authorize({token:TOKEN});f.db.exec('DROP TABLE voice_generations');await until(()=>permission.signal.aborted);assert.equal(await a.authorize({token:TOKEN}),null);assertSafe(a.snapshot());
});
test('group-writable database permissions revoke an existing scope and never authorize',async t=>{
 const f=fixture(t),a=await f.authorizer(),permission=await a.authorize({token:TOKEN});chmodSync(f.dbFile,0o660);
 await until(()=>permission.signal.aborted);assert.equal(await a.authorize({token:TOKEN}),null);assertSafe(a.snapshot());
});
test('WAL registries are rejected instead of creating side files in a read-only volume',async t=>{
 const f=fixture(t);f.db.exec('PRAGMA journal_mode=WAL');const {createCloudVoiceAuthorizer}=await moduleUnderTest();
 assert.throws(()=>createCloudVoiceAuthorizer({dataDir:f.dir}),/^Error: cloud_voice_unavailable$/);
});
