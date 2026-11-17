import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,symlink,link,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const names=['kibi_xiaozhi_core.h','kibi_xiaozhi_client.h'];
const dependencyNames=['wifi.h','http_json.h','audio_codec_power.h','server_transport.h','power_management.h'];
const contents=['#pragma once\n// public portable state\n','#pragma once\n// public device adapter\n'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const dependencyFiles=dependencyNames.map(path=>({path,sha256:hash('reviewed public '+path)}));
const payloadManifest={schemaVersion:1,id:'xiaozhi',release:'test-public-r1',files:names.map((path,i)=>({path,bytes:Buffer.byteLength(contents[i]),sha256:hash(contents[i])})),dependencies:dependencyFiles.map(file=>({path:file.path,sha256:[file.sha256]}))};
const program=await readFile(new URL('./device-modules.mjs',import.meta.url),'utf8');
const importAnchor="import manifest from './device-modules.json' with {type:'json'};";
async function load(manifest=payloadManifest){
 assert.equal(program.split(importAnchor).length,2,'fixture substitutes only trusted JSON data; module logic is unchanged');
 return import('data:text/javascript;base64,'+Buffer.from(program.replace(importAnchor,`const manifest=${JSON.stringify(manifest)};`)).toString('base64'));
}
async function fixture(t,{snapshot={projectId:'project-test',files:[]},install,manifest=payloadManifest,withDependencies=true}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'kibi-device-modules-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'src/device-sdk');await mkdir(directory,{recursive:true});
 for(let i=0;i<names.length;i++)await writeFile(join(directory,names[i]),contents[i]);
 let current=structuredClone(snapshot),snapshotReads=0;const calls=[];
 if(withDependencies && current && !Array.isArray(current) && Array.isArray(current.files))current.files=[...dependencyFiles.filter(dependency=>!current.files.some(file=>file.path===dependency.path)),...current.files];
 const {createDeviceModuleService}=await load(manifest);
 const service=createDeviceModuleService({root,getProjectFiles:async()=>{snapshotReads++;return structuredClone(current);},installModule:async input=>{
  calls.push(input);if(install)return install(input,{setSnapshot:next=>{current=next;},getSnapshot:()=>structuredClone(current)});
  await input.assertProjectCurrent();current={projectId:input.expectedProjectId,files:[...current.files.filter(file=>!names.includes(file.path)),...input.files.map(({path,sha256})=>({path,sha256}))]};
  return{changed:true,paths:[...names]};
 }});
 return{root,directory,service,calls,snapshotReads:()=>snapshotReads,setSnapshot:next=>{current=next;}};
}

test('catalog reports only verified public metadata and honest unverified application/hardware status',async t=>{
 const f=await fixture(t);const result=await f.service.status();assert.equal(result.modules.length,1);const module=result.modules[0];
 assert.equal(module.id,'xiaozhi');assert.equal(module.available,true);assert.equal(module.compatible,true);assert.equal(module.installed,false);assert.equal(module.conflict,false);assert.equal(module.code,null);
 assert.ok(module.capabilities.includes('account_pairing'));assert.ok(module.capabilities.includes('xiaozhi_voice'));
 assert.deepEqual(module.provenance,{kind:'bundled_public_sdk',release:'test-public-r1',sha256Verified:true});
 assert.deepEqual(module.evidence,{compiled:'unknown',hardware:'unknown',provider:'unknown',application:'unknown'});
 const serialized=JSON.stringify(result);assert.equal(serialized.includes(contents[0]),false);assert.equal(serialized.includes(f.root),false);assert.equal(f.calls.length,0);
});

test('enable delivers exactly two known UTF-8 headers to the current project through the trusted installer',async t=>{
 const f=await fixture(t);let guards=0;const result=await f.service.enable('xiaozhi',{guard:()=>{guards++;}});
 assert.equal(f.calls.length,1);const input=f.calls[0];assert.equal(input.id,'xiaozhi');assert.equal(input.expectedProjectId,'project-test');assert.equal(typeof input.assertProjectCurrent,'function');
 assert.deepEqual(input.files,names.map((path,i)=>({path,content:contents[i],sha256:hash(contents[i])})));
 assert.equal(result.installed,true);assert.equal(result.changed,true);assert.deepEqual(result.paths,names);assert.ok(guards>=2);
 assert.equal(JSON.stringify(result).includes(contents[0]),false);assert.equal((await f.service.status()).modules[0].installed,true);
});

test('an already-installed exact module is idempotent and requires no install mutation',async t=>{
 const files=payloadManifest.files.map(({path,sha256})=>({path,sha256}));const f=await fixture(t,{snapshot:{projectId:'project-test',files}});
 assert.equal((await f.service.status()).modules[0].installed,true);
 const result=await f.service.enable('xiaozhi',{guard:()=>{}});assert.equal(result.installed,true);assert.equal(result.changed,false);assert.equal(f.calls.length,0);
});

test('a known partial installation can add its missing header without replacing unrelated files',async t=>{
 const f=await fixture(t,{snapshot:{projectId:'project-test',files:[{path:names[0],sha256:payloadManifest.files[0].sha256},{path:'app_view.h',sha256:'a'.repeat(64)}]}});
 const result=await f.service.enable('xiaozhi',{guard:()=>{}});assert.equal(result.installed,true);assert.equal(f.calls.length,1);
});

test('unknown existing module files are never overwritten or admitted as installed',async t=>{
 for(const sha256 of ['b'.repeat(64),undefined]){
  const f=await fixture(t,{snapshot:{projectId:'project-test',files:[{path:names[0],sha256}]}});
  const module=(await f.service.status()).modules[0];assert.equal(module.installed,false);assert.equal(module.conflict,true);assert.equal(module.code,'module_file_conflict');
  await assert.rejects(f.service.enable('xiaozhi',{guard:()=>{}}),{code:'module_file_conflict'});assert.equal(f.calls.length,0);
 }
});

test('missing, changed, oversized and linked public payloads fail closed before installer calls',async t=>{
 const mutations=[
  async f=>rm(join(f.directory,names[0])),
  async f=>writeFile(join(f.directory,names[0]),'changed public file'),
  async f=>writeFile(join(f.directory,names[0]),Buffer.alloc(300*1024)),
  async f=>{const outside=join(f.root,'outside.h');await writeFile(outside,contents[0]);await rm(join(f.directory,names[0]));await symlink(outside,join(f.directory,names[0]));},
  async f=>link(join(f.directory,names[0]),join(f.root,'hardlink.h')),
  async f=>{const elsewhere=join(f.root,'elsewhere');await rename(f.directory,elsewhere);await symlink(elsewhere,f.directory);},
 ];
 for(const mutate of mutations){const f=await fixture(t);await mutate(f);const module=(await f.service.status()).modules[0];assert.equal(module.available,false);assert.equal(module.provenance.sha256Verified,false);await assert.rejects(f.service.enable('xiaozhi',{guard:()=>{}}),{code:'module_payload_unavailable'});assert.equal(f.calls.length,0);}
});

test('invalid catalog paths, dimensions and payload hashes cannot authorize other source reads',async t=>{
 for(const mutate of [m=>{m.files[0].path='../private.h';},m=>{m.files.push(m.files[0]);},m=>{m.files[0].bytes=0;},m=>{m.files[0].sha256='invalid';},m=>{m.id='different';}]){
  const manifest=structuredClone(payloadManifest);mutate(manifest);const f=await fixture(t,{manifest});assert.equal((await f.service.status()).modules[0].available,false);await assert.rejects(f.service.enable('xiaozhi',{guard:()=>{}}),{code:'module_payload_unavailable'});assert.equal(f.calls.length,0);
 }
});

test('unknown module IDs are rejected without taking a project snapshot or calling the installer',async t=>{
 const f=await fixture(t);for(const id of ['other','../xiaozhi',null])await assert.rejects(f.service.enable(id,{guard:()=>{}}),{code:'module_unknown'});assert.equal(f.calls.length,0);assert.equal(f.snapshotReads(),0);
});

test('guard revocation prevents delivery and is available inside the host transaction',async t=>{
 const f=await fixture(t);await assert.rejects(f.service.enable('xiaozhi',{guard:()=>{throw Object.assign(Error('revoked'),{code:'revoked'});}}),{code:'revoked'});assert.equal(f.calls.length,0);
 let active=true;const g=await fixture(t,{install:async input=>{active=false;await input.assertProjectCurrent();return{changed:true,paths:names};}});
 await assert.rejects(g.service.enable('xiaozhi',{guard:()=>{if(!active)throw Object.assign(Error('revoked'),{code:'revoked'});}}),{code:'revoked'});
});

test('a project switch or module conflict before installation prevents commit to the wrong project',async t=>{
 const f=await fixture(t);let count=0;await assert.rejects(f.service.enable('xiaozhi',{guard:()=>{if(++count===2)f.setSnapshot({projectId:'project-other',files:[]});}}),{code:'module_project_changed'});assert.equal(f.calls.length,0);
 const g=await fixture(t);let conflicts=0;await assert.rejects(g.service.enable('xiaozhi',{guard:()=>{if(++conflicts===2)g.setSnapshot({projectId:'project-test',files:[{path:names[0],sha256:'c'.repeat(64)}]});}}),{code:'module_file_conflict'});assert.equal(g.calls.length,0);
});

test('unconfirmed installer results and absent installed hashes never produce installed true',async t=>{
 for(const install of [async()=>undefined,async()=>({changed:true,paths:names}),async(input,{setSnapshot})=>{setSnapshot({projectId:input.expectedProjectId,files:[...dependencyFiles,...input.files.map(({path,sha256})=>({path,sha256}))]});return{changed:true,paths:['app_feature.h']};}]){
  const f=await fixture(t,{install});const result=await f.service.enable('xiaozhi',{guard:()=>{}});assert.equal(result.installed,false);assert.equal(result.code,'module_install_unconfirmed');
 }
});

test('a project switch after a callback is reported rather than claiming installation in another project',async t=>{
 const f=await fixture(t,{install:async(input,{setSnapshot})=>{setSnapshot({projectId:'project-other',files:input.files.map(({path,sha256})=>({path,sha256}))});return{changed:true,paths:names};}});
 await assert.rejects(f.service.enable('xiaozhi',{guard:()=>{}}),{code:'module_project_changed'});
});

test('malformed snapshots cannot become a current writable project',async t=>{
 for(const snapshot of [null,[],{files:[]},{projectId:'project-test',files:[{path:names[0],sha256:payloadManifest.files[0].sha256},{path:names[0],sha256:payloadManifest.files[0].sha256}]}]){
  const f=await fixture(t,{snapshot});const module=(await f.service.status()).modules[0];assert.equal(module.installed,false);assert.equal(module.code,'module_project_unavailable');await assert.rejects(f.service.enable('xiaozhi',{guard:()=>{}}),{code:'module_project_unavailable'});assert.equal(f.calls.length,0);
 }
});

test('every required public SDK header must be present at one reviewed exact hash',async t=>{
 for(const dependency of dependencyFiles){
  for(const broken of ['missing','unknown']){
   const files=dependencyFiles.filter(file=>file.path!==dependency.path);if(broken==='unknown')files.push({path:dependency.path,sha256:'e'.repeat(64)});
   const f=await fixture(t,{snapshot:{projectId:'project-test',files},withDependencies:false});
   const module=(await f.service.status()).modules[0];assert.equal(module.available,true);assert.equal(module.compatible,false);assert.equal(module.code,'module_sdk_incompatible');
   await assert.rejects(f.service.enable('xiaozhi',{guard:()=>{}}),{code:'module_sdk_incompatible'});assert.equal(f.calls.length,0);
  }
 }
});

test('a declared alternative reviewed dependency hash is compatible without reading SDK source files',async t=>{
 const manifest=structuredClone(payloadManifest),alternate=hash('second reviewed wifi generation');manifest.dependencies[0].sha256.push(alternate);
 const files=dependencyFiles.map(file=>file.path==='wifi.h' ? {...file,sha256:alternate} : file);
 const f=await fixture(t,{manifest,snapshot:{projectId:'project-test',files},withDependencies:false});
 assert.equal((await f.service.status()).modules[0].compatible,true);assert.equal((await f.service.enable('xiaozhi',{guard:()=>{}})).installed,true);
 for(const path of dependencyNames)await assert.rejects(readFile(join(f.directory,path)),{code:'ENOENT'},'no SDK file is needed by the service: compatibility uses only supplied public hashes');
});

test('the trusted manifest cannot omit, duplicate or rename a required SDK dependency',async t=>{
 for(const mutate of [m=>m.dependencies.pop(),m=>{m.dependencies[0]=m.dependencies[1];},m=>{m.dependencies[0].path='../private.h';},m=>{m.dependencies[0].sha256=[];},m=>{m.dependencies[0].sha256=['not-a-hash'];}]){
  const manifest=structuredClone(payloadManifest);mutate(manifest);const f=await fixture(t,{manifest});
  const module=(await f.service.status()).modules[0];assert.equal(module.available,false);assert.equal(module.compatible,false);
  await assert.rejects(f.service.enable('xiaozhi',{guard:()=>{}}),{code:'module_payload_unavailable'});assert.equal(f.calls.length,0);
 }
});

test('SDK metadata is rechecked after an asynchronous payload read before installation',async t=>{
 const f=await fixture(t);let guards=0;
 await assert.rejects(f.service.enable('xiaozhi',{guard:()=>{if(++guards===2)f.setSnapshot({projectId:'project-test',files:dependencyFiles.map(file=>file.path==='wifi.h' ? {...file,sha256:'f'.repeat(64)} : file)});}}),{code:'module_sdk_incompatible'});
 assert.equal(f.calls.length,0);
});
