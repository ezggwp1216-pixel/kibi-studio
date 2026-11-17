import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
test('disable acknowledgement waits for an already started notification commit',async()=>{
const nativeRename=fs.rename;
let block=false,entered,release;
const atSave=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
fs.rename=async(from,to)=>{if(block&&to.endsWith('/state.json')){block=false;entered();await gate;}return nativeRename(from,to);};
syncBuiltinESMExports();
const {createKibiServer}=await import('../src/server.mjs');
const dir=await fs.mkdtemp('/private/tmp/kibi-review-race-'),origin='https://review.invalid';
const runtime={status:()=>({configured:true,available:true}),invoke:async()=>({notifications:[{title:'Stale effect',message:'Fixture'}]}),close:async()=>{}};
const media={status:()=>({configured:false,available:false}),close:async()=>{}};
const server=await createKibiServer({dataDir:dir,adminPassword:'review owner password',publicOrigin:origin,voiceConfig:{enabled:false},pluginRuntime:runtime,pluginMedia:media,fetchImpl:()=>{throw Error('No external network');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
let cookie,csrf;
const call=async(path,{body,token}={})=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();return {status:response.status,value,headers:response.headers};};
try{
 const reg=await call('/api/register',{body:{email:'review@example.invalid',password:'review account password'}});cookie=reg.headers.get('set-cookie').split(';')[0];csrf=reg.value.csrfToken;
 const device=(await call('/api/devices',{body:{name:'Review device'}})).value;
 const packageText=JSON.stringify({format:'kibi-plugin',manifestVersion:2,sdkVersion:'1.1',id:'test.notify',version:'1.0.0',name:'Notify',description:'',capabilities:['request-handler'],permissions:['notifications:create'],settings:[],secrets:[],server:{language:'javascript',source:'throw new Error("NEVER RUN")'}});
 await call('/api/plugins',{body:{packageText,sha256:createHash('sha256').update(packageText).digest('hex')}});
 const path='/api/devices/'+device.device.id+'/plugins/test.notify';
 await call(path,{body:{version:'1.0.0',expectedRevision:0,enabled:true,settings:{}}});
 block=true;const invocation=call('/api/device/plugins/test.notify/invoke',{body:{input:{}},token:device.token});
 await atSave;
 let acknowledged=false;
 const disabling=call(path,{body:{version:'1.0.0',expectedRevision:1,enabled:false,settings:{}}}).then(value=>{acknowledged=true;return value;});
 await Promise.race([disabling,new Promise(resolve=>setTimeout(resolve,75))]);
 const overtookCommit=acknowledged;
 release();const result=await invocation;const disabled=await disabling;
 const inbox=await call('/api/device/messages',{token:device.token});
 assert.equal(overtookCommit,false,'disable acknowledged while old notification persistence was unfinished');
 assert.equal(disabled.status,200);assert.equal(inbox.value.messages.length,1);
 assert.equal((await call('/api/device/plugins/test.notify/invoke',{body:{input:{}},token:device.token})).status,409);
}finally{release();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await fs.rm(dir,{recursive:true,force:true});fs.rename=nativeRename;syncBuiltinESMExports();}

});
