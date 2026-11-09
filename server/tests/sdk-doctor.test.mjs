import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {inspectSdk,PUBLIC_SDK_FILES} from '../sdk/device/doctor.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'kibi-doctor-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const board={id:'kibi-ds02-s3-16m',coreVersion:'3.3.12',sdkVersion:'5.5.5',display:{width:240,height:296},capabilities:{wifi:{api:['beginWifi']}}};
 const files=new Map(PUBLIC_SDK_FILES.map(p=>[p,'// reviewed public module\n']));
 files.set('resources/board.json',JSON.stringify(board));files.set('templates/kibi-base/board.json',JSON.stringify(board));
 files.set('templates/kibi-base/firmware/audio_codec_power.h','// preparePlayback()\n');files.set('templates/kibi-base/firmware/README.md','# Kibi Base SDK\n');
 files.set('templates/kibi-base/manifest.json','');
 async function flush(){
  files.set('templates/kibi-base/manifest.json',JSON.stringify({schemaVersion:1,boardId:board.id,files:[...files].filter(([p])=>p.startsWith('templates/kibi-base/')&&!p.endsWith('/manifest.json')).map(([p,b])=>({path:p.slice('templates/kibi-base/'.length),size:Buffer.byteLength(b),sha256:hash(b)}))}));
  for(const [p,b]of files){await mkdir(join(root,p,'..'),{recursive:true});await writeFile(join(root,p),b);}
 }
 await flush();return {root,files,flush};
}
test('SDK inspection checks only a public allowlist and never claims hardware success',async t=>{
 const f=await fixture(t),r=await inspectSdk(f.root);
 assert.equal(r.ok,true);assert.equal(r.hardwareVerified,false);assert.equal(r.wifiFamily,'legacy');assert.ok(r.checkedFiles>8);
});
test('SDK inspector detects manifest drift, board drift, stale instructions and mixed audio',async t=>{
 const f=await fixture(t);
 await writeFile(join(f.root,'templates/kibi-base/firmware/audio_codec_power.h'),'// old driver');
 let r=await inspectSdk(f.root);assert.ok(r.errors.some(e=>e.code==='sdk_hash_mismatch'));assert.ok(r.errors.some(e=>e.code==='audio_prepare_missing'));
 f.files.set('templates/kibi-base/firmware/README.md','# Kibi BTC/USD\nCoinbase');await f.flush();
 r=await inspectSdk(f.root);assert.ok(r.errors.some(e=>e.code==='starter_instructions_stale'));
 f.files.set('resources/board.json','{}');await f.flush();r=await inspectSdk(f.root);assert.ok(r.errors.some(e=>e.code==='board_snapshots_differ'));
});
test('SDK inspector fails closed on links and cannot follow a manifest into private data',async t=>{
 const f=await fixture(t),target=join(f.root,'secret.txt');await writeFile(target,'DO_NOT_READ');
 const file=join(f.root,'templates/kibi-base/firmware/audio_codec_power.h');await rm(file);await symlink(target,file);
 let r=await inspectSdk(f.root);assert.ok(r.errors.some(e=>e.code==='sdk_unsafe_path'));assert.ok(!JSON.stringify(r).includes('DO_NOT_READ'));
 await rm(file);await f.flush();
 const manifestPath=join(f.root,'templates/kibi-base/manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 manifest.files.push({path:'../../secret.txt',size:11,sha256:'0'.repeat(64)});await writeFile(manifestPath,JSON.stringify(manifest));
 r=await inspectSdk(f.root);assert.ok(r.errors.some(e=>e.code==='sdk_manifest_invalid'));assert.equal(await readFile(target,'utf8'),'DO_NOT_READ');
});
