import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import https from 'node:https';
import {openStore} from '../src/store.mjs';
import {startVoiceModule,createPanelVoiceAuthorizer} from '../src/voice.mjs';
import {createKibiServer} from '../src/server.mjs';
import WebSocket from '../resources/xiaozhi/network/ws-8.22.1/wrapper.mjs';
import {createTestTls} from './fixtures/tls.mjs';

const origin='http://localhost:4391',password='a strong test password',hash=value=>createHash('sha256').update(value).digest('hex');
const ownerToken='O'.repeat(43),aToken='A'.repeat(43),secondToken='S'.repeat(43),bToken='B'.repeat(43);
const registration={version:1,identity:{deviceId:'02:11:22:33:44:55',clientId:'12345678-1234-4123-8123-123456789abc',serialNumber:'KIBI-SW-1234567890ABCDEF',hmacKey:'a'.repeat(64)},activation:null,configuration:{url:'wss://api.tenclass.net/xiaozhi/v1/',token:'SYNTHETIC_PRIVATE_XIAOZHI',deviceId:'02:11:22:33:44:55',clientId:'12345678-1234-4123-8123-123456789abc'}};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const outcome=ws=>new Promise(resolve=>{ws.once('open',()=>resolve('open'));ws.once('unexpected-response',(_,response)=>{response.resume();resolve(response.statusCode);});ws.once('error',()=>resolve('error'));});

async function voiceFixture(t,{configured=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'kibi-delegated-voice-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await openStore(join(dir,'owner')),a=await openStore(join(dir,'a')),b=await openStore(join(dir,'b'));
 store.state.devices.push({id:'owner-device',tokenHash:hash(ownerToken)});
 store.state.voice={provider:'xiaozhi',scope:{kind:'panel',id:'owner-device'}};
 store.state.ai=store.seal({apiKey:'SYNTHETIC_OPENAI_MUST_NOT_BE_USED'});if(configured)store.state.xiaozhi=store.seal(registration);await store.save();
 a.state.devices.push({id:'a-device',tokenHash:hash(aToken)},{id:'a-second',tokenHash:hash(secondToken)});await a.save();
 b.state.devices.push({id:'b-device',tokenHash:hash(bToken)});await b.save();
 const aa=createPanelVoiceAuthorizer({store:a,requireCredentials:false}),ba=createPanelVoiceAuthorizer({store:b,requireCredentials:false});
 t.after(()=>{aa.close();ba.close();});
 const tls=createTestTls(),tlsDir=join(dir,'tls');await mkdir(tlsDir,{mode:0o750});
 const keyFile=join(tlsDir,'key'),certFile=join(tlsDir,'cert');await writeFile(keyFile,tls.key,{mode:0o640});await writeFile(certFile,tls.cert,{mode:0o640});
 const permissions=[];let externalCalls=0;
 const voice=await startVoiceModule({store,publicOrigin:'https://kibi.example',config:{enabled:true,keyFile,certFile,port:0},registrationFetch:()=>{externalCalls++;throw new Error('external network forbidden');},
  studioAccountExists:id=>['alice','bob'].includes(id),
  delegatedDeviceExists:grant=>({alice:a,bob:b}[grant.accountId]?.state.devices.some(device=>device.id===grant.deviceId))===true,
  authorizeDelegatedDevice:async({token,delegation})=>{
   const authorizer={alice:aa,bob:ba}[delegation.accountId];if(!authorizer)return null;
   const permission=await authorizer.authorize({token,deviceId:delegation.deviceId});
   return permission?{...permission,principal:{kind:'account',accountId:delegation.accountId,id:permission.principal.id}}:null;
  },createAdapter:options=>{permissions.push(options);return{receiveDevice(){},close(){}};}});
 t.after(()=>voice.close());
 const connect=token=>{const ws=new WebSocket(`wss://127.0.0.1:${voice.address().port}/kibi-xiaozhi/v1`,{ca:tls.cert,servername:'localhost',headers:{Authorization:`Bearer ${token}`}});ws.on('error',()=>{});t.after(()=>ws.terminate());return ws;};
 return{dir,store,a,b,aa,ba,voice,permissions,connect,externalCalls:()=>externalCalls};
}

test('delegation permits exactly one account/device and restores the preserved owner scope on revoke',async t=>{
 const f=await voiceFixture(t);await f.voice.setDelegation({accountId:'alice',deviceId:'a-device'});
 assert.deepEqual(f.store.state.voice.scope,{kind:'panel',id:'owner-device'});
 for(const token of [ownerToken,secondToken,bToken,'Z'.repeat(43),'a'.repeat(64)])assert.equal(await outcome(f.connect(token)),401);
 const ws=f.connect(aToken);assert.equal(await outcome(ws),'open');await turn();
 assert.equal(f.permissions.length,1);assert.equal(f.permissions[0].configuration.provider,'xiaozhi');assert.equal(f.permissions[0].configuration.token,registration.configuration.token);assert.equal(f.permissions[0].configuration.api_key,undefined);
 const tenant=f.voice.delegatedStatus('alice');assert.equal(tenant.delegated,true);assert.equal(tenant.activeSessions,1);assert.equal(tenant.scope.id,'a-device');assert.equal(tenant.registration,undefined);assert.equal(tenant.legacyConfigured,false);
 assert.equal(f.voice.delegatedStatus('bob').code,'tenant_voice_unavailable');
 assert.doesNotMatch(JSON.stringify(tenant),/SYNTHETIC|owner-device|hmacKey|clientId|pairingCode|alice|bob/);
 const closed=once(ws,'close');await f.voice.setDelegation(null);await closed;assert.equal(f.permissions[0].signal.aborted,true);
 assert.deepEqual(f.store.state.voice.scope,{kind:'panel',id:'owner-device'});assert.equal(await outcome(f.connect(aToken)),401);
 assert.equal(await outcome(f.connect(ownerToken)),'open');assert.equal(f.externalCalls(),0);
});

test('queued grant mutation rechecks owner authority before changing persisted access',async t=>{
 const f=await voiceFixture(t);let release,authorized=true;
 const blocked=f.store.exclusive(()=>new Promise(resolve=>{release=resolve;}));await turn();
 const changing=f.voice.setDelegation({accountId:'alice',deviceId:'a-device'},{isAuthorized:()=>authorized});authorized=false;release();await blocked;
 await assert.rejects(changing,error=>error.status===401&&error.code==='unauthorized');assert.equal(f.store.state.voice.delegation,undefined);
});

test('Studio activation requires explicit approval and selects only the approved account own device',async t=>{
 const f=await voiceFixture(t),grant={accountId:'alice',deviceId:'a-device'};
 assert.deepEqual(f.voice.studioVoiceEligibility('alice'),{approved:false,canActivate:false,code:'studio_voice_not_approved'});
 await assert.rejects(f.voice.activateStudioDevice(grant),error=>error.status===403&&error.code==='studio_voice_not_approved');
 await assert.rejects(f.voice.allowStudioAccount('unknown'),error=>error.status===400);
 await f.voice.allowStudioAccount('alice');
 assert.deepEqual(f.voice.delegatedStatus('alice').studioVoice,{approved:true,canActivate:true,code:null});assert.equal(f.store.state.voice.delegation,undefined);
 await assert.rejects(f.voice.activateStudioDevice({accountId:'bob',deviceId:'b-device'}),error=>error.status===403);
 await assert.rejects(f.voice.activateStudioDevice({accountId:'alice',deviceId:'b-device'}),error=>error.status===400);
 const profile=await f.voice.activateStudioDevice(grant);assert.equal(profile.delegated,true);assert.equal(profile.registration,undefined);assert.equal(profile.scope.id,'a-device');
 assert.deepEqual(f.store.state.voice.scope,{kind:'panel',id:'owner-device'});assert.equal(f.store.state.voice.delegationSource,'studio');
 const ws=f.connect(aToken);assert.equal(await outcome(ws),'open');await turn();const closed=once(ws,'close');
 await f.voice.allowStudioAccount('bob');await closed;assert.equal(f.permissions[0].signal.aborted,true);assert.equal(f.store.state.voice.delegation,undefined);
 assert.equal(f.voice.studioVoiceEligibility('alice').approved,false);assert.equal(f.voice.studioVoiceEligibility('bob').approved,true);
 assert.equal(await outcome(f.connect(ownerToken)),'open');assert.equal(f.externalCalls(),0);
});

test('approval revocation preserves a separately issued manual grant and its active session',async t=>{
 const f=await voiceFixture(t);await f.voice.allowStudioAccount('alice');await f.voice.activateStudioDevice({accountId:'alice',deviceId:'a-device'});
 await f.voice.setDelegation({accountId:'alice',deviceId:'a-device'});assert.equal(f.store.state.voice.delegationSource,undefined);
 const ws=f.connect(aToken);assert.equal(await outcome(ws),'open');await turn();
 await f.voice.allowStudioAccount(null);assert.equal(f.permissions[0].signal.aborted,false);assert.deepEqual(f.store.state.voice.delegation,{accountId:'alice',deviceId:'a-device'});
 assert.equal(f.voice.studioVoiceEligibility('alice').approved,false);assert.equal(f.voice.delegatedStatus('alice').activeSessions,1);
});

test('Studio activation requires Xiaozhi configuration and never changes to OpenAI',async t=>{
 const f=await voiceFixture(t);await f.voice.allowStudioAccount('alice');await f.voice.selectProvider({provider:'openai'});
 assert.deepEqual(f.voice.studioVoiceEligibility('alice'),{approved:true,canActivate:false,code:'studio_voice_xiaozhi_required'});
 await assert.rejects(f.voice.activateStudioDevice({accountId:'alice',deviceId:'a-device'}),error=>error.status===409&&error.code==='studio_voice_xiaozhi_required');
 assert.equal(f.store.state.voice.delegation,undefined);assert.equal(f.store.state.voice.studioAccountId,'alice');assert.equal(f.permissions.length,0);
 const unconfigured=await voiceFixture(t,{configured:false});await unconfigured.voice.allowStudioAccount('alice');
 assert.equal(unconfigured.voice.studioVoiceEligibility('alice').code,'xiaozhi_not_configured');
 await assert.rejects(unconfigured.voice.activateStudioDevice({accountId:'alice',deviceId:'a-device'}),error=>error.status===409&&error.code==='xiaozhi_not_configured');
 assert.equal(unconfigured.permissions.length,0);assert.equal(f.externalCalls()+unconfigured.externalCalls(),0);
});

test('queued Studio activation rechecks approval and the caller authority at commit time',async t=>{
 const f=await voiceFixture(t);await f.voice.allowStudioAccount('alice');let release;
 const blocked=f.store.exclusive(()=>new Promise(resolve=>{release=resolve;}));await turn();
 const revoke=f.voice.allowStudioAccount(null),activate=f.voice.activateStudioDevice({accountId:'alice',deviceId:'a-device'});activate.catch(()=>{});
 release();await blocked;await revoke;await assert.rejects(activate,error=>error.code==='studio_voice_not_approved');
 await f.voice.allowStudioAccount('alice');await assert.rejects(f.voice.activateStudioDevice({accountId:'alice',deviceId:'a-device'},{isAuthorized:()=>false}),error=>error.status===401);
 assert.equal(f.store.state.voice.delegation,undefined);
});

test('revoking Studio approval cancels a device authorization already waiting in its account store',async t=>{
 const f=await voiceFixture(t);await f.voice.allowStudioAccount('alice');await f.voice.activateStudioDevice({accountId:'alice',deviceId:'a-device'});
 let release,entered;const blocked=f.a.exclusive(()=>new Promise(resolve=>{release=resolve;}));await turn();
 const attempted=new Promise(resolve=>{entered=resolve;}),exclusive=f.a.exclusive;t.mock.method(f.a,'exclusive',fn=>{entered();return exclusive(fn);});
 const result=outcome(f.connect(aToken));await attempted;await f.voice.allowStudioAccount(null);release();await blocked;
 assert.equal(await result,401);assert.equal(f.permissions.length,0);assert.deepEqual(f.store.state.voice.scope,{kind:'panel',id:'owner-device'});
});

test('a failed approval save cannot authorize a queued Studio activation',async t=>{
 const f=await voiceFixture(t),statePath=join(f.dir,'owner','state.json'),backup=statePath+'.saved';await rename(statePath,backup);await mkdir(statePath,{mode:0o700});
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),saving=new Promise(resolve=>{entered=resolve;}),save=f.store.save;
 t.mock.method(f.store,'save',async()=>{entered();await gate;return save();});
 const approval=f.voice.allowStudioAccount('alice');approval.catch(()=>{});await saving;
 const activation=f.voice.activateStudioDevice({accountId:'alice',deviceId:'a-device'});activation.catch(()=>{});
 release();await assert.rejects(approval);await assert.rejects(activation,error=>error.code==='studio_voice_not_approved');await rm(statePath,{recursive:true});await rename(backup,statePath);
 assert.equal(f.store.state.voice.studioAccountId,undefined);assert.equal(f.store.state.voice.delegation,undefined);assert.equal(f.permissions.length,0);
});

for(const replacing of [false,true])test(`uncommitted ${replacing?'replacement':'new'} grant cannot admit a device when persistence fails`,{timeout:5000},async t=>{
 const f=await voiceFixture(t);
 if(replacing)await f.voice.setDelegation({accountId:'alice',deviceId:'a-device'});
 const grant=replacing?{accountId:'bob',deviceId:'b-device'}:{accountId:'alice',deviceId:'a-device'},token=replacing?bToken:aToken;
 const target=replacing?f.b:f.a,statePath=join(f.dir,'owner','state.json'),backup=statePath+'.saved';
 // Force the real store.save() rename to fail so its own committed-graph rollback runs.
 await rename(statePath,backup);await mkdir(statePath,{mode:0o700});
 let release,started,entered,armed=false;
 const gate=new Promise(resolve=>{release=resolve;}),saving=new Promise(resolve=>{started=resolve;}),attempted=new Promise(resolve=>{entered=resolve;});
 const save=f.store.save,ownerExclusive=f.store.exclusive,targetExclusive=target.exclusive;
 t.mock.method(f.store,'save',async()=>{started();await gate;return save();});
 t.mock.method(f.store,'exclusive',fn=>{if(armed)entered();return ownerExclusive(fn);});
 t.mock.method(target,'exclusive',fn=>{if(armed)entered();return targetExclusive(fn);});
 t.mock.method(target,'save',async()=>{});
 const changing=f.voice.setDelegation(grant);changing.catch(()=>{});await saving;armed=true;
 const result=outcome(f.connect(token));
 try{await attempted;await turn();assert.equal(f.permissions.length,0,'no adapter may receive provider configuration before the grant commits');}
 finally{release();await assert.rejects(changing);await rm(statePath,{recursive:true});await rename(backup,statePath);}
 assert.equal(await result,401);assert.equal(f.permissions.length,0);
 assert.deepEqual(f.store.state.voice.delegation,replacing?{accountId:'alice',deviceId:'a-device'}:undefined);
 assert.equal(f.externalCalls(),0);
});

test('a pending successful grant admits its device only after the owner save commits',{timeout:5000},async t=>{
 const f=await voiceFixture(t);let release,started,entered,armed=false;
 const gate=new Promise(resolve=>{release=resolve;}),saving=new Promise(resolve=>{started=resolve;}),attempted=new Promise(resolve=>{entered=resolve;});
 const save=f.store.save,ownerExclusive=f.store.exclusive,targetExclusive=f.a.exclusive;
 t.mock.method(f.store,'save',async()=>{started();await gate;return save();});
 t.mock.method(f.store,'exclusive',fn=>{if(armed)entered();return ownerExclusive(fn);});
 t.mock.method(f.a,'exclusive',fn=>{if(armed)entered();return targetExclusive(fn);});
 t.mock.method(f.a,'save',async()=>{});
 const changing=f.voice.setDelegation({accountId:'alice',deviceId:'a-device'});await saving;armed=true;
 const result=outcome(f.connect(aToken));
 try{await attempted;await turn();assert.equal(f.permissions.length,0);}
 finally{release();await changing;}
 assert.equal(await result,'open');await turn();assert.equal(f.permissions.length,1);assert.equal(f.externalCalls(),0);
});

test('delegated status cannot borrow an earlier owner session while the grant is being saved',async t=>{
 const f=await voiceFixture(t),ws=f.connect(ownerToken);assert.equal(await outcome(ws),'open');await turn();
 let release,started;const saving=new Promise(resolve=>{started=resolve;}),save=f.store.save;
 t.mock.method(f.store,'save',()=>new Promise(resolve=>{release=async()=>{await save();resolve();};started();}));
 const changing=f.voice.setDelegation({accountId:'alice',deviceId:'a-device'});await saving;
 const profile=f.voice.delegatedStatus('alice');assert.equal(profile.activeSessions,0);assert.equal(profile.status,'listening');assert.equal(profile.code,'listening');
 await release();await changing;
});

for(const change of ['replace','delete','provider','registration','shutdown'])test(`delegated active permission is cancelled by ${change}`,async t=>{
 const f=await voiceFixture(t);await f.voice.setDelegation({accountId:'alice',deviceId:'a-device'});
 const ws=f.connect(aToken);assert.equal(await outcome(ws),'open');await turn();const closed=once(ws,'close');
 if(change==='replace')await f.voice.setDelegation({accountId:'bob',deviceId:'b-device'});
 if(change==='delete'){await f.a.exclusive(async()=>{f.a.state.devices.splice(0,1);await f.a.save();f.aa.reconcile();});f.voice.reconcile();}
 if(change==='provider')await f.voice.selectProvider({provider:'openai'});
 if(change==='registration')await f.store.exclusive(async()=>{f.store.state.xiaozhi=f.store.seal({...registration,configuration:{...registration.configuration,token:'SYNTHETIC_REPLACED'}});await f.store.save();f.voice.reconcile();});
 if(change==='shutdown')await f.voice.close();
 await closed;assert.equal(f.permissions[0].signal.aborted,true);
 if(change==='shutdown')assert.equal(f.voice.delegatedStatus('alice').code,'closed');
 if(change==='provider'){assert.deepEqual(f.store.state.voice.delegation,{accountId:'alice',deviceId:'a-device'});assert.equal(await outcome(f.connect(aToken)),401);assert.equal(await outcome(f.connect(ownerToken)),401);}
 assert.equal(f.externalCalls(),0);
});

for(const change of ['revoke','replace','delete','provider','registration','shutdown'])test(`queued delegated authorization cannot survive ${change}`,async t=>{
 const f=await voiceFixture(t);await f.voice.setDelegation({accountId:'alice',deviceId:'a-device'});
 let release;const blocked=f.a.exclusive(()=>new Promise(resolve=>{release=resolve;}));await turn();
 let started;const entered=new Promise(resolve=>{started=resolve;}),exclusive=f.a.exclusive;
 t.mock.method(f.a,'exclusive',fn=>{started();return exclusive(fn);});
 const result=outcome(f.connect(aToken));await entered;
 if(change==='revoke')await f.voice.setDelegation(null);
 if(change==='replace')await f.voice.setDelegation({accountId:'bob',deviceId:'b-device'});
 if(change==='delete'){f.a.state.devices.splice(0,1);f.aa.reconcile();f.voice.reconcile();}
 if(change==='provider')await f.voice.selectProvider({provider:'openai'});
 if(change==='registration')await f.store.exclusive(async()=>{f.store.state.xiaozhi=f.store.seal({...registration,configuration:{...registration.configuration,token:'SYNTHETIC_REPLACED'}});await f.store.save();f.voice.reconcile();});
 const closing=change==='shutdown'?f.voice.close():null;release();await blocked;await closing;
 assert.ok([401,'error'].includes(await result));assert.equal(f.permissions.length,0);assert.equal(f.externalCalls(),0);
});

test('owner-only delegation resolves email/device ownership, protects mutations and survives restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kibi-delegation-http-'));let server,base;let externalCalls=0;
 const start=async()=>{server=await createKibiServer({dataDir:dir,adminPassword:password,publicOrigin:origin,voiceConfig:{enabled:false},fetchImpl:()=>{externalCalls++;throw new Error('external network forbidden');}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;};
 const stop=()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await start();t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
 const call=async(path,{method='GET',body,session,headers={}}={})=>{const response=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(session?{Origin:origin,Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,headers:response.headers,json:await response.json()};};
 const auth=async(email,login=false)=>{const r=await call(login?'/api/login':'/api/register',{method:'POST',body:{...(email?{email}:{}),password},headers:{Origin:origin}});assert.ok([200,201].includes(r.status));return{cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.json.csrfToken,user:r.json.user};};
 const owner=await auth(null,true),a=await auth('alice@example.test'),b=await auth('bob@example.test');
 const pending=(await call('/api/pairing/start',{method:'POST',body:{name:'Alice paired device'}})).json;
 const device=(await call('/api/pairing/claim',{method:'POST',session:a,body:{code:pending.code}})).json.device;
 const poll=(await call('/api/pairing/poll',{method:'POST',body:{pairingId:pending.pairingId,pollToken:pending.pollToken}})).json;assert.equal(poll.status,'paired');
 const grant={email:' ALICE@EXAMPLE.TEST ',deviceId:device.id};
 assert.equal((await call('/api/settings/voice/studio-account',{method:'POST',session:a,body:{email:a.user.email}})).status,403);
 assert.equal((await call('/api/settings/voice/studio-account',{method:'POST',session:owner,body:{email:a.user.email},headers:{'X-CSRF-Token':'wrong'}})).status,403);
 assert.equal((await call('/api/settings/voice/studio-account',{method:'POST',session:owner,body:{email:a.user.email},headers:{Origin:'https://other.example'}})).status,403);
 for(const invalid of [{email:'missing@example.test'},{email:a.user.email,accountId:a.user.id}])assert.equal((await call('/api/settings/voice/studio-account',{method:'POST',session:owner,body:invalid})).status,400);
 const approval=await call('/api/settings/voice/studio-account',{method:'POST',session:owner,body:{email:' ALICE@EXAMPLE.TEST '}});assert.equal(approval.status,200);assert.equal(approval.json.voice.studioAccountId,a.user.id);
 const approvedProfile=(await call('/api/settings',{session:a})).json.voice;assert.equal(approvedProfile.studioVoice.approved,true);assert.equal(approvedProfile.delegated,undefined);
 assert.equal((await call('/api/settings',{session:b})).json.voice.studioVoice.approved,false);
 assert.equal((await call('/api/settings/voice/delegation',{method:'POST',session:a,body:grant})).status,403);
 assert.equal((await call('/api/settings/voice/delegation',{method:'POST',session:owner,body:grant,headers:{Origin:'https://other.example'}})).status,403);
 assert.equal((await call('/api/settings/voice/delegation',{method:'POST',session:owner,body:grant,headers:{'X-CSRF-Token':'wrong'}})).status,403);
 for(const invalid of [{email:'missing@example.test',deviceId:device.id},{email:'bob@example.test',deviceId:device.id},{email:'alice@example.test',deviceId:'unknown'},{email:'alice@example.test',deviceId:device.id,accountId:b.user.id}])assert.equal((await call('/api/settings/voice/delegation',{method:'POST',session:owner,body:invalid})).status,400);
 const granted=await call('/api/settings/voice/delegation',{method:'POST',session:owner,body:grant});assert.equal(granted.status,200);assert.deepEqual(granted.json.voice.delegation,{accountId:a.user.id,deviceId:device.id});
 const own=(await call('/api/settings',{session:a})).json.voice;assert.equal(own.delegated,true);assert.equal(own.scope.id,device.id);assert.equal(own.registration,undefined);assert.equal(own.activeSessions,0);
 assert.equal((await call('/api/settings',{session:b})).json.voice.code,'tenant_voice_unavailable');assert.equal((await call('/api/settings/xiaozhi',{session:a})).status,409);
 assert.equal((await call('/api/settings/voice',{method:'POST',session:a,body:{provider:'openai'}})).status,409);
 assert.equal(a.user.role,'user');await stop();await start();
 const again=await auth('alice@example.test',true),ownerAgain=await auth(null,true);assert.equal(again.user.role,'user');assert.equal((await call('/api/settings',{session:again})).json.voice.delegated,true);
 assert.equal((await call('/api/settings',{session:again})).json.voice.studioVoice.approved,true);
 assert.equal((await call('/api/settings/voice/studio-account',{method:'DELETE',session:ownerAgain})).status,200);
 const afterApprovalRevoke=(await call('/api/settings',{session:again})).json.voice;assert.equal(afterApprovalRevoke.studioVoice.approved,false);assert.equal(afterApprovalRevoke.delegated,true);
 const disk=await readFile(join(dir,'accounts',a.user.id,'state.json'),'utf8');assert.ok(!disk.includes(poll.token));assert.ok(!disk.includes('delegation'));
 assert.equal((await call('/api/settings/voice/delegation',{method:'DELETE',session:ownerAgain})).status,200);assert.equal((await call('/api/settings',{session:again})).json.voice.code,'tenant_voice_unavailable');assert.equal(externalCalls,0);
});

test('standalone paired account token reaches the shared TLS gateway through the trusted account index',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kibi-delegation-paired-tls-')),tls=createTestTls(),tlsDir=join(dir,'tls');await mkdir(tlsDir,{mode:0o750});
 const keyFile=join(tlsDir,'key'),certFile=join(tlsDir,'cert');await writeFile(keyFile,tls.key,{mode:0o640});await writeFile(certFile,tls.cert,{mode:0o640});
 const store=await openStore(join(dir,'data'));store.state.voice={provider:'xiaozhi',scope:{kind:'panel',id:'owner-device'}};store.state.xiaozhi=store.seal(registration);store.state.devices.push({id:'owner-device',tokenHash:hash(ownerToken)});await store.save();
 let voiceServer,externalRequests=0;const listen=https.Server.prototype.listen,request=https.request;
 t.mock.method(https.Server.prototype,'listen',function(...args){voiceServer=this;return listen.apply(this,args);});
 t.mock.method(https,'request',function(options,...args){if(options.host!=='127.0.0.1'){externalRequests++;throw new Error('external network forbidden');}return request.call(this,options,...args);});
 const server=await createKibiServer({dataDir:join(dir,'data'),adminPassword:password,publicOrigin:origin,voiceConfig:{enabled:true,keyFile,certFile,port:0},fetchImpl:()=>{externalRequests++;throw new Error('external network forbidden');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`,call=async(path,{method='GET',body,session}={})=>{const response=await fetch(base+path,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,headers:response.headers,json:await response.json()};};
 const auth=async(email)=>{const r=await call(email?'/api/register':'/api/login',{method:'POST',body:{...(email?{email}:{}),password}});assert.ok([200,201].includes(r.status));return{cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.json.csrfToken,user:r.json.user};};
 const owner=await auth(null),a=await auth('alice@example.test'),b=await auth('bob@example.test');
 const pending=(await call('/api/pairing/start',{method:'POST',body:{name:'Paired Kibi'}})).json;
 const claim=(await call('/api/pairing/claim',{method:'POST',session:a,body:{code:pending.code}})).json;
 const paired=(await call('/api/pairing/poll',{method:'POST',body:{pairingId:pending.pairingId,pollToken:pending.pollToken}})).json;
 const second=(await call('/api/devices',{method:'POST',session:a,body:{name:'Other Alice device'}})).json;
 const other=(await call('/api/devices',{method:'POST',session:b,body:{name:'Bob device'}})).json;
 assert.equal((await call('/api/settings/voice/delegation',{method:'POST',session:owner,body:{email:a.user.email,deviceId:claim.device.id}})).status,200);
 const connect=token=>{const ws=new WebSocket(`wss://127.0.0.1:${voiceServer.address().port}/kibi-xiaozhi/v1`,{ca:tls.cert,servername:'localhost',headers:{Authorization:`Bearer ${token}`}});ws.on('error',()=>{});t.after(()=>ws.terminate());return ws;};
 for(const token of [ownerToken,second.token,other.token])assert.equal(await outcome(connect(token)),401);
 const ws=connect(paired.token);assert.equal(await outcome(ws),'open');
 const profile=(await call('/api/settings',{session:a})).json.voice;assert.equal(profile.configured,true);assert.equal(profile.activeSessions,1);assert.equal(profile.scope.id,claim.device.id);assert.equal(profile.registration,undefined);
 assert.equal((await call('/api/settings',{session:b})).json.voice.activeSessions,0);
 assert.equal(await outcome(connect(paired.token)),409);
 const closed=once(ws,'close');assert.equal((await call(`/api/devices/${claim.device.id}`,{method:'DELETE',session:a})).status,200);await closed;
 assert.equal(await outcome(connect(paired.token)),401);assert.equal((await call('/api/settings',{session:a})).json.voice.configured,false);
 assert.equal((await call('/api/settings/voice/delegation',{method:'DELETE',session:owner})).status,200);assert.equal(await outcome(connect(ownerToken)),'open');
 assert.deepEqual((await call('/api/overview',{session:a})).json.devices.map(device=>device.id),[second.device.id]);assert.equal(a.user.role,'user');assert.equal(externalRequests,0);
});
