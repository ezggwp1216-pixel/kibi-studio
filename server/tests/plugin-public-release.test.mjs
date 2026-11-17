import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createKibiServer} from '../src/server.mjs';

test('public module instructions, example and exact updater remain downloadable without exposing private state',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'kibi-plugin-public-'));
 const server=await createKibiServer({dataDir,adminPassword:'temporary owner password',publicOrigin:'https://kibi.example',voiceConfig:{enabled:false},fetchImpl:()=>{throw Error('unexpected_external_request');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(dataDir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 const sdk=await(await fetch(base+'/api/sdk')).json();
 assert.equal(sdk.execution,false);
 assert.equal(sdk.links.serverModules,'docs/SERVER_MODULES.md');
 assert.equal(sdk.links.studioModules,'studio/modules/release.json');
 for(const route of ['/docs/SERVER_MODULES.md','/docs/SERVER_MODULES_DEPLOY.md','/docs/YOUTUBE_MODULE.md','/plugins.js','/server-modules.js','/server-modules.css','/plugins.css']){
  const response=await fetch(base+route);assert.equal(response.status,200,route);assert.ok((await response.arrayBuffer()).byteLength>0);
 }
 const example=await fetch(base+'/examples/server-plugin/youtube-live.kibiplugin');
 assert.equal(example.status,200);assert.deepEqual(await example.json(),JSON.parse(await readFile(new URL('../examples/server-plugin/youtube-live.kibiplugin',import.meta.url),'utf8')));
 const release=await(await fetch(base+'/'+sdk.links.studioModules)).json();
 const archive=await fetch(base+'/studio/modules/'+release.archive);
 assert.equal(archive.status,200);const bytes=Buffer.from(await archive.arrayBuffer());
 assert.equal(bytes.length,release.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),release.sha256);
 const checksum=await fetch(base+'/studio/modules/'+release.archive+'.sha256');assert.equal(checksum.status,200);assert.match(await checksum.text(),new RegExp('^'+release.sha256+'  '));
 for(const route of ['/.data/accounts.json','/.data/state.json','/.data/admin-password','/auth.json','/studio/modules/../auth.json'])assert.notEqual((await fetch(base+route)).status,200,route);
});
