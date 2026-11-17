import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createKibiServer} from '../src/server.mjs';

test('public SDK routes deliver the neutral voice headers and current installation guide',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'kibi-module-http-'));
 const server=await createKibiServer({dataDir,adminPassword:'Synthetic-test-password-2026',publicOrigin:'http://127.0.0.1:4391'});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dataDir,{recursive:true,force:true});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 for(const name of ['kibi_xiaozhi_core.h','kibi_xiaozhi_client.h']){
  const response=await fetch(base+'/sdk/device/source/'+name);assert.equal(response.status,200,name);
  assert.equal(await response.text(),await readFile(new URL('../sdk/device/source/'+name,import.meta.url),'utf8'));
 }
 const guide=await fetch(base+'/docs/STUDIO_CONNECTION.md');assert.equal(guide.status,200);assert.match(await guide.text(),/Studio/);
 const activation=await fetch(base+'/xiaozhi-activation.js');assert.equal(activation.status,200,'the browser can import the activation controller');
 assert.match(activation.headers.get('content-type'),/javascript/);assert.equal(await activation.text(),await readFile(new URL('../web/xiaozhi-activation.js',import.meta.url),'utf8'));
 const sdk=await fetch(base+'/api/sdk');assert.equal(sdk.status,200);const info=await sdk.json();assert.equal(info.supportRelease,'2026-11-18-r4');assert.equal(info.links.voiceModule,'sdk/device/source/kibi_xiaozhi_client.h');
 assert.equal((await fetch(base+'/sdk/device/source/../../.data/admin-password')).status,404);
});
