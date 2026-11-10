import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createKibiServer} from '../src/server.mjs';
import {createIdentityServer} from '../src/identity.mjs';

const origin='https://kibi.example',password='test diagnostics password';
const empty={schemaVersion:'1.0',source:'server',retentionSeconds:3600,observed:false,updatedAt:null,connection:null,metrics:null,events:[]};
const snapshot=packets=>({schemaVersion:'1.0',source:'server',retentionSeconds:3600,observed:true,updatedAt:'2026-11-10T00:00:00.000Z',connection:{state:'ready',code:'ready',active:true},metrics:{inputPackets:packets},events:[{at:'2026-11-10T00:00:00.000Z',state:'ready',code:'ready'}]});

async function fixture(t,{synthetic=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'kibi-diagnostics-api-')),tenants=new Map(),records=new Map(),reads=[];
 let externalCalls=0;
 const options={dataDir:dir,adminPassword:password,publicOrigin:origin,voiceConfig:{enabled:false},fetchImpl:()=>{externalCalls++;throw new Error('external network forbidden');}};
 // Only the HTTP identity boundary is substituted here: real accounts, sessions
 // and Studio bearer registry stay in use. This permits impossible-by-UUID
 // duplicate IDs and a deterministic asynchronous tenant resolution window.
 const createTenant=async opts=>{
  const tenant=new EventEmitter(),id=opts.ordinaryUser?opts.dataDir.split('/').at(-1):'owner',devices=new Set(['collision']);
  tenant.kibiContext={tokenHashes:()=>[],hasDevice:deviceId=>devices.has(deviceId),listDevices:()=>[...devices].map(id=>({id})),close:async()=>{},voice:opts.ordinaryUser?{diagnosticsFor:deviceId=>opts.tenantVoiceDiagnostics(deviceId)}:{reconcile(){},diagnosticsFor(accountId,deviceId){reads.push([accountId,deviceId]);return records.get(`${accountId}/${deviceId}`)||empty;}}};
  tenant.on('request',(_req,res)=>{res.writeHead(404,{'Content-Type':'application/json'});res.end('{"ok":false,"code":"not_found"}');});
  tenants.set(id,{tenant,devices});return tenant;
 };
 const server=synthetic?await createIdentityServer(options,createTenant):await createKibiServer(options);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const releases=new Set();
 t.after(async()=>{for(const release of releases)release();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(dir,{recursive:true,force:true});assert.equal(externalCalls,0,'diagnostic reads must never call providers or Telegram');});
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,{method='GET',body,session,token,requestOrigin=origin}={})=>{
  const response=await fetch(base+path,{method,headers:{...(requestOrigin?{Origin:requestOrigin}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return{status:response.status,body:await response.json(),headers:response.headers};
 };
 const auth=async(email)=>{const response=await call(email?'/api/register':'/api/login',{method:'POST',body:{...(email?{email}:{}),password}});assert.equal(response.status,email?201:200);return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:response.body.csrfToken,user:response.body.user,link:response.body.studioLink};};
 const studio=async session=>{const response=await call('/api/studio/redeem',{method:'POST',body:{code:session.link.code,label:'Diagnostics test'},requestOrigin:null});assert.equal(response.status,201);assert.deepEqual(response.body.scopes,['pairing.claim','devices.list','voice.status','voice.activate','catalog.read']);return response.body;};
 const device=async session=>{const response=await call('/api/devices',{method:'POST',session,body:{name:'Own Kibi'}});assert.equal(response.status,200);return response.body;};
 const pauseTenant=id=>{
  const {tenant}=tenants.get(id);let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  releases.add(release);
  tenant.then=(resolve,reject)=>{delete tenant.then;entered();gate.then(()=>resolve(tenant),reject);};
  return{started,release:()=>{releases.delete(release);release();}};
 };
 return{call,auth,studio,device,tenants,records,reads,pauseTenant};
}

test('panel diagnostics return only the ordinary session own device and real empty state',async t=>{
 const f=await fixture(t),alice=await f.auth('alice@example.test'),bob=await f.auth('bob@example.test'),owner=await f.auth();
 const a=await f.device(alice),b=await f.device(bob),o=await f.device(owner),path=id=>`/api/devices/${id}/voice-diagnostics`;
 assert.equal((await f.call(path(a.device.id))).status,401);
 assert.equal((await f.call(path(a.device.id),{token:a.token})).status,401);
 const own=await f.call(path(a.device.id),{session:alice});assert.equal(own.status,200);assert.deepEqual(own.body,empty);assert.equal(own.headers.get('cache-control'),'no-store');
 assert.deepEqual((await f.call(path(b.device.id),{session:bob})).body,empty);
 for(const id of [a.device.id,b.device.id,o.device.id,'unknown'])assert.deepEqual((await f.call(path(id),{session:owner})).body,{ok:false,code:'user_diagnostics_only'});
 for(const [session,id] of [[bob,a.device.id],[alice,b.device.id],[alice,o.device.id],[alice,'unknown']]){
  const denied=await f.call(path(id),{session});assert.equal(denied.status,404);assert.equal(denied.body.code,'device_not_found');
 }
 assert.deepEqual((await f.call(path(a.device.id)+`?ownerId=${bob.user.id}&accountId=owner`,{session:alice})).body,empty);
 assert.equal((await f.call(path(a.device.id),{method:'POST',session:alice,body:{ownerId:bob.user.id}})).status,404);
 assert.equal((await f.call(`/api/devices/${a.device.id}`,{method:'DELETE',session:alice})).status,200);
 assert.equal((await f.call(path(a.device.id),{session:alice})).status,404);
 assert.equal((await f.call('/api/device/messages',{token:a.token})).status,401);
 assert.equal((await f.call('/api/logout',{method:'POST',session:bob})).status,200);
 assert.equal((await f.call(path(b.device.id),{session:bob})).status,401);
 assert.deepEqual((await f.call('/api/overview',{session:alice})).body.events,[]);
});

test('Studio diagnostics reuse voice.status bearer authority, reject foreign devices and revoked connections',async t=>{
 const f=await fixture(t),alice=await f.auth('alice@example.test'),bob=await f.auth('bob@example.test');
 const a=await f.device(alice),b=await f.device(bob),sa=await f.studio(alice),sb=await f.studio(bob),path=id=>`/api/studio/devices/${id}/voice-diagnostics`;
 for(const options of [{},{session:alice},{token:a.token}])assert.equal((await f.call(path(a.device.id),options)).status,401);
 const own=await f.call(path(a.device.id),{token:sa.token,requestOrigin:null});assert.equal(own.status,200);assert.deepEqual(own.body,empty);
 assert.equal((await f.call(path(a.device.id),{token:sa.token,requestOrigin:'https://evil.example'})).status,403);
 assert.equal((await f.call(`/api/devices/${a.device.id}/voice-diagnostics`,{token:sa.token})).status,401);
 for(const [token,id] of [[sb.token,a.device.id],[sa.token,b.device.id],[sa.token,'unknown']]){
  const denied=await f.call(path(id),{token});assert.equal(denied.status,404);assert.equal(denied.body.code,'device_not_found');
 }
 assert.deepEqual((await f.call(path(a.device.id)+`?accountId=${bob.user.id}`,{token:sa.token})).body,empty);
 assert.equal((await f.call(`/api/devices/${a.device.id}`,{method:'DELETE',session:alice})).status,200);
 assert.equal((await f.call(path(a.device.id),{token:sa.token})).status,404);
 assert.equal((await f.call(`/api/studio/connections/${sa.connection.id}`,{method:'DELETE',session:alice})).status,200);
 assert.equal((await f.call(path(a.device.id),{token:sa.token})).status,401);
 assert.equal((await f.call('/api/studio/session',{method:'DELETE',token:sb.token})).status,200);
 assert.equal((await f.call(path(b.device.id),{token:sb.token})).status,401);
});

test('colliding device IDs and forged account selectors remain bound to each trusted principal',async t=>{
 const f=await fixture(t,{synthetic:true}),alice=await f.auth('alice@example.test'),bob=await f.auth('bob@example.test'),owner=await f.auth(),sa=await f.studio(alice),sb=await f.studio(bob);
 f.records.set(`${alice.user.id}/collision`,snapshot(7));f.records.set(`${bob.user.id}/collision`,snapshot(19));f.records.set('owner/collision',snapshot(99));
 for(const [options,want] of [[{session:alice},7],[{session:bob},19],[{token:sa.token},7],[{token:sb.token},19]]){
  const prefix=options.token?'/api/studio':'/api',response=await f.call(`${prefix}/devices/collision/voice-diagnostics?accountId=owner&ownerId=${bob.user.id}`,options);
  assert.equal(response.status,200);assert.deepEqual(response.body,snapshot(want));
 }
 assert.equal((await f.call('/api/devices/collision/voice-diagnostics',{session:owner})).status,403);
 assert.deepEqual(f.reads,[[alice.user.id,'collision'],[bob.user.id,'collision'],[alice.user.id,'collision'],[bob.user.id,'collision']]);
});

test('logout while resolving a panel tenant prevents a delayed diagnostic read',async t=>{
 const f=await fixture(t,{synthetic:true}),alice=await f.auth('alice@example.test'),pause=f.pauseTenant(alice.user.id);
 const pending=f.call('/api/devices/collision/voice-diagnostics',{session:alice});await pause.started;
 assert.equal((await f.call('/api/logout',{method:'POST',session:alice})).status,200);pause.release();
 const response=await pending;assert.equal(response.status,401);assert.equal(response.body.code,'unauthorized');assert.deepEqual(f.reads,[]);
});

test('device removal while resolving a tenant prevents a delayed Studio diagnostic read',async t=>{
 const f=await fixture(t,{synthetic:true}),alice=await f.auth('alice@example.test'),sa=await f.studio(alice),pause=f.pauseTenant(alice.user.id);
 const pending=f.call('/api/studio/devices/collision/voice-diagnostics',{token:sa.token});await pause.started;
 f.tenants.get(alice.user.id).devices.delete('collision');pause.release();
 const response=await pending;assert.equal(response.status,404);assert.equal(response.body.code,'device_not_found');assert.deepEqual(f.reads,[]);
});

for(const studio of [false,true])test(`${studio?'Studio bearer':'panel session'} expiry during tenant resolution prevents a diagnostic read`,async t=>{
 let time=Date.now();t.mock.method(Date,'now',()=>time);
 const f=await fixture(t,{synthetic:true}),alice=await f.auth('alice@example.test'),credential=studio?await f.studio(alice):null,pause=f.pauseTenant(alice.user.id);
 const pending=f.call(`${studio?'/api/studio':'/api'}/devices/collision/voice-diagnostics`,studio?{token:credential.token}:{session:alice});await pause.started;
 time+=(studio?91:1)*24*60*60*1000;pause.release();
 const response=await pending;assert.equal(response.status,401);assert.equal(response.body.code,studio?'studio_unauthorized':'unauthorized');assert.deepEqual(f.reads,[]);
});
