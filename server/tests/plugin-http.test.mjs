import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createKibiServer} from '../src/server.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const moduleText=(version='0.1.0',permissions=[])=>JSON.stringify({format:'kibi-plugin',manifestVersion:2,sdkVersion:'1.1',id:'my-module',version,name:'Мой модуль',description:'Проверка своего модуля',capabilities:['request-handler'],permissions,settings:[],secrets:[],server:{language:'javascript',source:'export async function onDeviceRequest(input) { return input; }'}});
async function fixture(t,{runtime,media}={}){
 const dir=await mkdtemp(join(tmpdir(),'kibi-plugin-http-')),origin='https://kibi.example';
 const server=await createKibiServer({dataDir:dir,adminPassword:'test owner password',publicOrigin:origin,voiceConfig:{enabled:false},pluginRuntime:runtime,pluginMedia:media,fetchImpl:()=>{throw Error('Unexpected external network');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,{method='GET',body,cookie,csrf,token,protocol,requestOrigin=origin}={})=>{
  const response=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(requestOrigin?{Origin:requestOrigin}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(token?{Authorization:`Bearer ${token}`} :{}),...(protocol?{'X-Kibi-Studio-Protocol':protocol}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const bytes=Buffer.from(await response.arrayBuffer()),type=response.headers.get('content-type')||'';
  return{status:response.status,body:type.includes('json')?JSON.parse(bytes):bytes,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
 };
 const register=async email=>{const r=await call('/api/register',{method:'POST',body:{email,password:'test account password'}});assert.equal(r.status,201);return{cookie:r.cookie,csrf:r.body.csrfToken,code:r.body.studioLink.code};};
 const connect=async(user,plugins=true)=>{
  const issued=await call('/api/studio/link-code',{method:'POST',cookie:user.cookie,csrf:user.csrf,body:plugins?{plugins:true}:{}});
  assert.equal(issued.status,201);
  const result=await call('/api/studio/redeem',{method:'POST',protocol:'plugins-v1',body:{code:issued.body.code,label:'Test Studio'}});
  assert.equal(result.status,201);return result.body.token;
 };
 const pair=async token=>{
  const p=await call('/api/pairing/start',{method:'POST',body:{name:'Test Kibi'}});
  const claimed=await call('/api/studio/pairing/claim',{method:'POST',token,body:{code:p.body.code}});assert.equal(claimed.status,200);
  const poll=await call('/api/pairing/poll',{method:'POST',body:{pairingId:p.body.pairingId,pollToken:p.body.pollToken}});assert.equal(poll.body.status,'paired');
  return{id:poll.body.device.id,token:poll.body.token};
 };
 return{call,register,connect,pair};
}

test('a module is published immutably, bound, invoked, updated, disabled and rolled back through account/device APIs',async t=>{
 const runtime={status:()=>({configured:true,available:true}),invoke:async()=>({answer:42}),close:async()=>{}};
 const{call,register,connect,pair}=await fixture(t,{runtime}),user=await register('module-owner@example.test'),token=await connect(user),device=await pair(token);
 const text=moduleText(),publish=await call('/api/studio/plugins',{method:'POST',token,body:{packageText:text,sha256:sha(text)}});
 assert.equal(publish.status,201);assert.equal(publish.body.plugin.id,'my-module');assert.equal(publish.body.plugin.server,undefined);
 const listed=await call('/api/studio/plugins',{token});assert.equal(listed.body.plugins.length,1);assert.equal(listed.body.capabilities.runtime.available,true);
 const path=`/api/studio/devices/${device.id}/plugins/my-module`;
 const bind=await call(path,{method:'POST',token,body:{version:'0.1.0',expectedRevision:0,enabled:true,settings:{}}});
 assert.equal(bind.status,200);assert.equal(bind.body.binding.revision,1);
 const invoke=await call('/api/device/plugins/my-module/invoke',{method:'POST',token:device.token,body:{input:{test:true}}});
 assert.equal(invoke.status,200);assert.deepEqual(invoke.body,{ok:true,result:{answer:42}});
 const text2=moduleText('0.2.0');assert.equal((await call('/api/studio/plugins',{method:'POST',token,body:{packageText:text2,sha256:sha(text2)}})).status,201);
 assert.equal((await call(path,{method:'POST',token,body:{version:'0.2.0',expectedRevision:1,enabled:true,settings:{}}})).body.binding.revision,2);
 assert.equal((await call(path,{method:'POST',token,body:{version:'0.2.0',expectedRevision:2,enabled:false,settings:{}}})).body.binding.revision,3);
 assert.equal((await call('/api/device/plugins/my-module/invoke',{method:'POST',token:device.token,body:{input:{}}})).status,409);
 const rollback=await call(path+'/rollback',{method:'POST',token,body:{toRevision:1,expectedRevision:3}});
 assert.equal(rollback.status,200);assert.equal(rollback.body.binding.version,'0.1.0');assert.equal(rollback.body.binding.revision,4);assert.equal(rollback.body.binding.enabled,true);
 assert.equal((await call(path,{method:'POST',token,body:{version:'0.2.0',expectedRevision:1,enabled:true,settings:{}}})).status,409);
});

test('legacy Studio, foreign accounts, fake device IDs and cookies cannot gain plugin authority',async t=>{
 const{call,register,connect,pair}=await fixture(t),a=await register('a@example.test'),b=await register('b@example.test');
 const token=await connect(a),old=await connect(a,false),other=await connect(b),device=await pair(token),text=moduleText();
 assert.equal((await call('/api/studio/plugins',{token:old})).status,403);
 assert.equal((await call('/api/studio/plugins',{cookie:a.cookie})).status,401);
 assert.equal((await call('/api/studio/plugins',{token,requestOrigin:'https://evil.example'})).status,403);
 assert.equal((await call('/api/studio/plugins',{method:'POST',token,body:{packageText:text,sha256:'0'.repeat(64)}})).status,400);
 assert.equal((await call('/api/studio/plugins',{method:'POST',token,body:{packageText:text,sha256:sha(text)}})).status,201);
 assert.deepEqual((await call('/api/studio/plugins',{token:other})).body.plugins,[]);
 assert.equal((await call(`/api/studio/devices/${device.id}/plugins/my-module`,{method:'POST',token:other,body:{version:'0.1.0',expectedRevision:0,enabled:true,settings:{}}})).status,404);
 assert.equal((await call('/api/device/plugins/my-module/invoke',{method:'POST',token,body:{input:{}}})).status,401);
 assert.equal((await call('/api/plugins',{method:'POST',cookie:a.cookie,body:{packageText:text,sha256:sha(text)}})).status,403);
 assert.equal((await call('/api/plugins',{method:'POST',cookie:a.cookie,csrf:a.csrf,body:{packageText:text,sha256:sha(text)}})).status,201);
});

test('missing isolated runtime fails closed and does not evaluate uploaded JavaScript',async t=>{
 const{call,register,connect,pair}=await fixture(t),user=await register('no-runtime@example.test'),token=await connect(user),device=await pair(token),text=moduleText();
 await call('/api/studio/plugins',{method:'POST',token,body:{packageText:text,sha256:sha(text)}});
 await call(`/api/studio/devices/${device.id}/plugins/my-module`,{method:'POST',token,body:{version:'0.1.0',expectedRevision:0,enabled:true,settings:{}}});
 const response=await call('/api/device/plugins/my-module/invoke',{method:'POST',token:device.token,body:{input:{}}});
 assert.equal(response.status,503);assert.match(response.body.code,/runtime_unavailable/);
});

test('a YouTube effect returns only a validated frame and requires its explicit module permission',async t=>{
 const pixels=Buffer.alloc(142080,0x1f),digest=createHash('sha256').update(pixels).digest('hex');
 const runtime={status:()=>({configured:true,available:true}),invoke:async()=>({youtubeFrame:{videoId:'4t4AQ15yj1M',fit:'contain'}}),close:async()=>{}};
 const media={status:()=>({configured:true,available:true}),frame:async input=>{assert.equal(input.videoId,'4t4AQ15yj1M');return{rgb565:pixels,width:240,height:296,sha256:digest};},close:async()=>{}};
 const{call,register,connect,pair}=await fixture(t,{runtime,media}),user=await register('media@example.test'),token=await connect(user),device=await pair(token);
 const path=`/api/studio/devices/${device.id}/plugins/my-module`;
 let text=moduleText('0.1.0');await call('/api/studio/plugins',{method:'POST',token,body:{packageText:text,sha256:sha(text)}});
 await call(path,{method:'POST',token,body:{version:'0.1.0',expectedRevision:0,enabled:true,settings:{}}});
 assert.equal((await call('/api/device/plugins/my-module/invoke',{method:'POST',token:device.token,body:{input:{}}})).status,403);
 text=moduleText('0.2.0',['media:youtube-frame']);await call('/api/studio/plugins',{method:'POST',token,body:{packageText:text,sha256:sha(text)}});
 await call(path,{method:'POST',token,body:{version:'0.2.0',expectedRevision:1,enabled:true,settings:{}}});
 const result=await call('/api/device/plugins/my-module/invoke',{method:'POST',token:device.token,body:{input:{}}});
 assert.equal(result.status,200);assert.equal(result.headers.get('x-pixel-format'),'rgb565le');assert.equal(result.headers.get('x-content-sha256'),digest);assert.equal(result.body.length,142080);assert.deepEqual(result.body,pixels);
});

test('disabling a module while its worker is pending cancels the lease and rejects late results',async t=>{
 let entered,release;
 const started=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>release=resolve);
 const runtime={status:()=>({configured:true,available:true}),invoke:async()=>{entered();await pending;return{stale:true};},close:async()=>{release?.();}};
 const{call,register,connect,pair}=await fixture(t,{runtime}),user=await register('cancel@example.test'),token=await connect(user),device=await pair(token),text=moduleText();
 await call('/api/studio/plugins',{method:'POST',token,body:{packageText:text,sha256:sha(text)}});
 const path=`/api/studio/devices/${device.id}/plugins/my-module`;
 await call(path,{method:'POST',token,body:{version:'0.1.0',expectedRevision:0,enabled:true,settings:{}}});
 const invocation=call('/api/device/plugins/my-module/invoke',{method:'POST',token:device.token,body:{input:{}}});
 await started;
 assert.equal((await call(path,{method:'POST',token,body:{version:'0.1.0',expectedRevision:1,enabled:false,settings:{}}})).status,200);
 release();const result=await invocation;assert.equal(result.status,409);assert.equal(result.body.result,undefined);
});
