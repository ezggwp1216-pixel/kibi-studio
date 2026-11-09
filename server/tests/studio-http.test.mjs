import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createKibiServer} from '../src/server.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'kibi-studio-http-')),origin='https://kibi.example';
 const server=await createKibiServer({dataDir:dir,adminPassword:'test owner password',publicOrigin:origin,cookiePath:'/server/',voiceConfig:{enabled:false},fetchImpl:()=>{throw new Error('no external network');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections();});await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,{method='GET',body,cookie,csrf,token,requestOrigin=origin}={})=>{
  const headers={...(requestOrigin?{Origin:requestOrigin}:{}),...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(token?{Authorization:`Bearer ${token}`}:{})};
  const r=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
 };
 const register=async email=>{const r=await call('/api/register',{method:'POST',body:{email,password:'test account password'}});assert.equal(r.status,201);return{...r,cookie:r.cookie,csrf:r.body.csrfToken};};
 return{dir,call,register};
}

test('registration issues one-time Studio link; redemption returns only scoped credential and own profile',async t=>{
 const {dir,call,register}=await fixture(t),a=await register('alice@example.test'),b=await register('bob@example.test');
 assert.match(a.body.studioLink.code,/^kibi_link_/);
 const redeemed=await call('/api/studio/redeem',{method:'POST',requestOrigin:null,body:{code:a.body.studioLink.code,label:'My Mac'}});
 assert.equal(redeemed.status,201);assert.match(redeemed.body.token,/^kibi_studio_/);assert.equal(redeemed.body.account.id,a.body.user.id);assert.equal(redeemed.body.apiBase,'https://kibi.example/server/');
 const token=redeemed.body.token;
 assert.equal((await call('/api/studio/redeem',{method:'POST',body:{code:a.body.studioLink.code,label:'Again'}})).status,410);
 const profile=await call('/api/studio/profile',{token});assert.equal(profile.status,200);assert.equal(profile.body.account.email,'alice@example.test');assert.equal(profile.body.voiceEligibility.approved,false);
 const serialized=JSON.stringify(profile.body);assert.equal(serialized.includes(token),false);assert.equal(serialized.includes(b.body.user.id),false);
 assert.deepEqual((await call('/api/studio/devices',{token})).body,{devices:[]});
 for(const path of ['/api/settings','/api/overview','/api/studio/connections'])assert.equal((await call(path,{token})).status,401);
 const disk=await readFile(join(dir,'studio-links.json'),'utf8');assert.equal(disk.includes(token),false);assert.equal(disk.includes(a.body.studioLink.code),false);
});

test('browser issuance requires Origin/CSRF; reissue and revocation are scoped to account',async t=>{
 const {call,register}=await fixture(t),a=await register('alice@example.test'),b=await register('bob@example.test');
 const opts={method:'POST',cookie:a.cookie,csrf:a.csrf,body:{}};
 assert.equal((await call('/api/studio/link-code',{...opts,csrf:null})).status,403);
 assert.equal((await call('/api/studio/link-code',{...opts,requestOrigin:'https://evil.example'})).status,403);
 const issue=await call('/api/studio/link-code',opts);assert.equal(issue.status,201);
 assert.equal((await call('/api/studio/redeem',{method:'POST',body:{code:a.body.studioLink.code,label:'Old'}})).status,410);
 const r=await call('/api/studio/redeem',{method:'POST',body:{code:issue.body.code,label:'Mac'}}),id=r.body.connection.id,token=r.body.token;
 assert.equal((await call(`/api/studio/connections/${id}`,{method:'DELETE',cookie:b.cookie,csrf:b.csrf})).status,404);
 assert.equal((await call('/api/studio/profile',{token})).status,200);
 assert.equal((await call(`/api/studio/connections/${id}`,{method:'DELETE',cookie:a.cookie,csrf:a.csrf})).status,200);
 assert.equal((await call('/api/studio/profile',{token})).status,401);
});

test('Studio claims device for its authenticated account, cannot retrieve device token or activate without approval',async t=>{
 const {call,register}=await fixture(t),a=await register('alice@example.test'),b=await register('bob@example.test');
 const token=(await call('/api/studio/redeem',{method:'POST',body:{code:a.body.studioLink.code,label:'Mac'}})).body.token;
 const pair=await call('/api/pairing/start',{method:'POST',body:{name:'Kibi'}});
 const claim=await call('/api/studio/pairing/claim',{method:'POST',token,body:{code:pair.body.code,accountId:b.body.user.id}});assert.equal(claim.status,400);
 const good=await call('/api/studio/pairing/claim',{method:'POST',token,body:{code:pair.body.code}});assert.equal(good.status,200);assert.equal(good.body.token,undefined);
 const devices=await call('/api/studio/devices',{token});assert.equal(devices.body.devices.length,1);assert.equal(devices.body.devices[0].id,good.body.device.id);assert.equal(devices.body.devices[0].tokenHash,undefined);
 assert.equal((await call('/api/overview',{cookie:b.cookie})).body.devices.length,0);
 const activation=await call('/api/studio/voice/activate',{method:'POST',token,body:{deviceId:good.body.device.id}});assert.equal(activation.status,403);assert.equal(activation.body.code,'studio_voice_not_approved');
 const poll=await call('/api/pairing/poll',{method:'POST',body:{pairingId:pair.body.pairingId,pollToken:pair.body.pollToken}});assert.equal(poll.body.status,'paired');assert.ok(poll.body.token);
 assert.equal((await call('/api/studio/session',{method:'DELETE',token})).status,200);assert.equal((await call('/api/studio/profile',{token})).status,401);
});

test('Studio token routes reject cross-origin browser use and cookie-only bearer mutations',async t=>{
 const {call,register}=await fixture(t),a=await register('alice@example.test');
 assert.equal((await call('/api/studio/redeem',{method:'POST',requestOrigin:'https://evil.example',body:{code:a.body.studioLink.code,label:'Bad'}})).status,403);
 const token=(await call('/api/studio/redeem',{method:'POST',body:{code:a.body.studioLink.code,label:'Mac'}})).body.token;
 assert.equal((await call('/api/studio/profile',{token,requestOrigin:'https://evil.example'})).status,403);
 assert.equal((await call('/api/studio/session',{method:'DELETE',cookie:a.cookie,csrf:a.csrf})).status,401);
});
