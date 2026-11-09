import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createKibiServer} from '../src/server.mjs';

const origin='http://localhost:4391',password='a strong test password';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'kibi-accounts-http-'));let server,base;
 const start=async()=>{server=await createKibiServer({dataDir:dir,adminPassword:password,publicOrigin:origin,voiceConfig:{enabled:false}});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;};
 const stop=()=>new Promise(r=>{server.close(r);server.closeAllConnections();});
 await start();t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
 const call=async(path,{method='GET',body,session,token,headers={}}={})=>{
  const response=await fetch(base+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Origin:origin,Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...(token?{Authorization:`Bearer ${token}`} : {}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const text=await response.text();let json;try{json=JSON.parse(text);}catch{}
  return {status:response.status,headers:response.headers,json,text};
 };
 const auth=async(email,path='/api/register')=>{
  const r=await call(path,{method:'POST',body:{...(email?{email}:{}),password},headers:{Origin:origin}});assert.ok([200,201].includes(r.status),JSON.stringify(r.json));
  return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.json.csrfToken,user:r.json.user};
 };
 return {dir,call,auth,restart:async()=>{await stop();await start();}};
}

test('email accounts isolate devices, events, messages, integrations and owner pilot',async t=>{
 const f=await fixture(t),a=await f.auth('alice@example.test'),b=await f.auth('bob@example.test'),owner=await f.auth(null,'/api/login');
 assert.equal(a.user.role,'user');assert.equal(owner.user.role,'owner');
 const da=(await f.call('/api/devices',{method:'POST',session:a,body:{name:'Alice'}})).json;
 const db=(await f.call('/api/devices',{method:'POST',session:b,body:{name:'Bob'}})).json;
 await f.call('/api/device/events',{method:'POST',token:da.token,body:{title:'Alice event',message:'private'}});
 const overviewA=(await f.call('/api/overview',{session:a})).json,overviewB=(await f.call('/api/overview',{session:b})).json;
 assert.deepEqual(overviewA.devices.map(x=>x.name),['Alice']);assert.deepEqual(overviewB.devices.map(x=>x.name),['Bob']);assert.deepEqual(overviewB.events,[]);
 assert.deepEqual((await f.call('/api/overview',{session:owner})).json.devices,[]);
 for(const method of ['DELETE','POST'])assert.equal((await f.call(`/api/devices/${da.device.id}${method==='POST'?'/messages':''}`,{method,session:b,...(method==='POST'?{body:{title:'attack',message:''}}:{})})).status,404);
 await f.call(`/api/devices/${da.device.id}/messages`,{method:'POST',session:a,body:{title:'Private reply',message:''}});
 assert.deepEqual((await f.call('/api/device/messages',{token:db.token})).json.messages,[]);
 const apiKey='sk-test-private-account-key';
 assert.equal((await f.call('/api/settings/ai',{method:'POST',session:a,body:{apiKey,model:'gpt-5-mini',systemPrompt:'Private instructions',enabled:true}})).status,200);
 const settingsB=(await f.call('/api/settings',{session:b})).json;
 assert.equal(settingsB.ai.configured,false);assert.equal(settingsB.voice.code,'tenant_voice_unavailable');assert.ok(!JSON.stringify(settingsB).includes('Private'));
 assert.equal((await f.call('/api/settings/voice',{method:'POST',session:a,body:{provider:'xiaozhi',scope:{kind:'legacy',id:'anything'}}})).status,409);
 assert.equal((await f.call('/api/settings/xiaozhi',{session:b})).status,409);
 await f.restart();
 assert.equal((await f.call('/api/overview',{session:a})).status,401);
 const again=await f.auth('alice@example.test','/api/login');assert.equal(again.user.id,a.user.id);
 assert.equal((await f.call('/api/device/messages',{token:da.token})).json.messages.length,1);
 assert.equal((await f.call('/api/settings',{session:again})).json.ai.configured,true);
 const disk=await readFile(join(f.dir,'accounts',a.user.id,'state.json'),'utf8');assert.ok(!disk.includes(apiKey));assert.ok(!disk.includes(da.token));
});

test('pairing code attaches to claiming account and polling releases token only to device',async t=>{
 const f=await fixture(t),a=await f.auth('alice@example.test'),b=await f.auth('bob@example.test');
 const start=(await f.call('/api/pairing/start',{method:'POST',body:{name:'Living room'}})).json;
 assert.equal((await f.call('/api/pairing/claim',{method:'POST',body:{code:start.code}})).status,401);
 assert.equal((await f.call('/api/pairing/claim',{method:'POST',session:a,body:{code:start.code},headers:{'X-CSRF-Token':'wrong'}})).status,403);
 const claim=await f.call('/api/pairing/claim',{method:'POST',session:a,body:{code:start.code}});assert.equal(claim.status,200);assert.equal(claim.json.token,undefined);
 assert.equal((await f.call('/api/pairing/claim',{method:'POST',session:b,body:{code:start.code}})).status,409);
 const poll=await f.call('/api/pairing/poll',{method:'POST',body:{pairingId:start.pairingId,pollToken:start.pollToken}});assert.equal(poll.status,200);assert.equal(poll.json.status,'paired');
 assert.equal((await f.call('/api/pairing/poll',{method:'POST',body:{pairingId:start.pairingId,pollToken:start.pollToken}})).status,410);
 assert.equal((await f.call('/api/device/messages',{token:poll.json.token})).status,200);
 assert.equal((await f.call('/api/overview',{session:a})).json.devices[0].id,claim.json.device.id);
 assert.deepEqual((await f.call('/api/overview',{session:b})).json.devices,[]);
 await f.call(`/api/devices/${claim.json.device.id}`,{method:'DELETE',session:a});
 assert.equal((await f.call('/api/device/messages',{token:poll.json.token})).status,401);
});

test('auth protections, cookie isolation, logout and SDK validation are real',async t=>{
 const f=await fixture(t);
 assert.equal((await f.call('/api/register',{method:'POST',body:{email:'a@example.test',password}})).status,403);
 assert.equal((await f.call('/api/register',{method:'POST',body:{email:'a@example.test',password:'short'},headers:{Origin:origin}})).status,400);
 const a=await f.auth('a@example.test');
 const session=await f.call('/api/session',{session:a});assert.equal(session.json.user.email,'a@example.test');
 assert.equal((await f.call('/api/login',{method:'POST',body:{email:'a@example.test',password:'wrong'},headers:{Origin:origin}})).status,401);
 assert.equal((await f.call('/api/sdk/validate',{method:'POST',body:{package:{}}})).status,401);
 const validation=await f.call('/api/sdk/validate',{method:'POST',session:a,body:{package:{}}});assert.equal(validation.status,200);assert.equal(validation.json.valid,false);assert.equal(validation.json.runtimeSupported,false);
 assert.equal((await f.call('/api/sdk')).json.execution,false);
 for(const path of ['/docs/API.md','/docs/MODULES.md','/docs/VOICE.md','/docs/SDK.md','/docs/LOCAL_STUDIO.md','/sdk/index.mjs','/sdk/client.mjs','/sdk/manifest.mjs','/sdk/validate.mjs','/sdk/kibiplugin.schema.json','/examples/server-plugin/local-notification.kibiplugin','/examples/server-plugin/future-handler.kibiplugin']){
  const asset=await f.call(path);assert.equal(asset.status,200,path);assert.ok(asset.text.length>10,path);
 }
 await f.call('/api/logout',{method:'POST',session:a});assert.deepEqual((await f.call('/api/session',{session:a})).json,{authenticated:false});
 assert.equal((await f.call('/api/devices',{method:'POST',session:a,body:{name:'old session'}})).status,401);
});
