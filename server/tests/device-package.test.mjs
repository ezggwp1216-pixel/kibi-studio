import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,writeFile,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {packageDeviceSupport} from '../scripts/package-device-support.mjs';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
test('public support package is reproducible, roundtrips with system tar and contains only manifested public files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kibi-support-tar-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=await packageDeviceSupport(),second=await packageDeviceSupport();assert.deepEqual(first.archive,second.archive);
 const archive=join(root,'kit.tar.gz');await writeFile(archive,first.archive);await mkdir(join(root,'extract'));
 await run('tar',['-xzf',archive,'-C',join(root,'extract')],{timeout:10000});
 const kit=join(root,'extract/kibi-device-support'),manifest=JSON.parse(await readFile(join(kit,'manifest.json'),'utf8'));
 for(const file of manifest.files){assert.ok(!/\.studio|^projects\/|settings\.json|auth\.json|\.bin$/.test(file.path),file.path);const bytes=await readFile(join(kit,file.path));assert.equal(bytes.length,file.size);assert.equal(sha(bytes),file.sha256);}
 assert.equal(sha(await readFile(join(kit,'manifest.json'))),first.release.manifestSha256);
 assert.equal((await lstat(join(kit,'overlays/files'))).mode&0o777,0o755);
 const plan=await run(process.execPath,[join(kit,'update.mjs')],{timeout:5000}).catch(e=>e);assert.equal(JSON.parse(plan.stdout).code,'studio_root_required');
});
test('delivery includes the canonical optional voice module while keeping the neutral template unchanged',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kibi-optional-module-kit-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const result=await packageDeviceSupport(),archive=join(root,'kit.tar.gz');await writeFile(archive,result.archive);
 await run('tar',['-xzf',archive,'-C',root],{timeout:10000});
 const kit=join(root,'kibi-device-support'),manifest=JSON.parse(await readFile(join(kit,'manifest.json'),'utf8'));
 for(const name of ['kibi_xiaozhi_client.h','kibi_xiaozhi_core.h']){
  const item=manifest.files.find(f=>f.path===`source/${name}`);assert.ok(item,`optional module source ${name} missing`);
  assert.deepEqual(await readFile(join(kit,item.path)),await readFile(fileURLToPath(new URL(`../sdk/device/source/${name}`,import.meta.url))));
 }
 const profiles=JSON.parse(await readFile(join(kit,'overlays/profiles.json'),'utf8'));
 const canonicalContract=await readFile(join(kit,'contract.json'));
 const instructions=await readFile(join(kit,'instructions.md'),'utf8');
 for(const profile of profiles.profiles){
  assert.ok(!profile.files.some(f=>/kibi_xiaozhi_(?:client|core)\.h$/.test(f.path)),`${profile.id} must not inject optional headers`);
  const payload=path=>readFile(join(kit,'overlays/files',profile.files.find(f=>f.path===path).after+'.txt'));
  assert.deepEqual(await payload('resources/device-contract.json'),canonicalContract,`${profile.id} must deliver the advertised contract`);
  const prompt=(await payload('prompts/agent-system.md')).toString('utf8'),marker='# Kibi development reliability — authoritative addendum';
  assert.equal(prompt.slice(prompt.indexOf(marker)),instructions,`${profile.id} must deliver the canonical AI instructions`);
  const template=JSON.parse((await payload('templates/kibi-base/manifest.json')).toString('utf8'));
  assert.ok(!template.files.some(f=>/kibi_xiaozhi_(?:client|core)\.h$/.test(f.path)));
  for(const item of profile.files.filter(f=>f.path.startsWith('templates/kibi-base/')&&!f.path.endsWith('/manifest.json'))){
   const entry=template.files.find(f=>'templates/kibi-base/'+f.path===item.path),bytes=await payload(item.path);
   assert.ok(entry,`${profile.id} manifest entry missing for ${item.path}`);
   assert.equal(entry.sha256,sha(bytes));assert.equal(entry.size,bytes.length);
  }
 }
 assert.equal(manifest.release,'2026-11-18-r4');
 assert.equal(manifest.contractRelease,profiles.release);
 assert.equal(JSON.parse(canonicalContract).release.id,manifest.contractRelease);
 assert.ok(result.release.archive.path.endsWith('kibi-device-support-20261118.tar.gz'));
});
test('original and installed-r1 upgrade profiles retain only previously reviewed input hashes',async()=>{
 const previous=fileURLToPath(new URL('../sdk/device/kibi-device-support-20261109.tar.gz',import.meta.url));
 const result=await run('tar',['-xOzf',previous,'kibi-device-support/overlays/profiles.json'],{timeout:10000});
 const before=JSON.parse(result.stdout),after=JSON.parse(await readFile(fileURLToPath(new URL('../sdk/device/overlays/profiles.json',import.meta.url)),'utf8'));
 assert.equal(after.profiles.length,before.profiles.length*2+2);
 const fresh=after.profiles.find(profile=>profile.id==='public-main-43d47afb-legacy-r2');assert.ok(fresh);assert.ok(fresh.files.some(file=>file.path==='templates/kibi-base/firmware/kibi_device_config.h'&&file.before===null));
 for(const known of before.profiles){
  const original=after.profiles.find(p=>p.id===known.id),r1=after.profiles.find(p=>p.id===known.id+'-r1');assert.ok(original&&r1);
  assert.deepEqual(original.files.map(f=>({path:f.path,before:f.before})),known.files.map(f=>({path:f.path,before:f.before})));
  assert.deepEqual(r1.files.map(f=>({path:f.path,before:f.before})),known.files.map(f=>({path:f.path,before:f.after})));
  assert.deepEqual(original.files.map(f=>({path:f.path,after:f.after})),r1.files.map(f=>({path:f.path,after:f.after})));
 }
 const standard=after.profiles.find(p=>p.id==='installed-reviewed-r1'),measured=after.profiles.find(p=>p.id==='installed-reviewed-measured-r1');
 assert.ok(measured);
 assert.deepEqual(measured.files,standard.files.map(f=>({...f,before:f.path==='prompts/agent-system.md'?'66ee249467dddaa3037a3b20fcac7df703b0e8ce872208cb225429b9a91f75f9':f.before})));
});
test('published support archive and release metadata match the reproducible canonical inputs',async()=>{
 const expected=await packageDeviceSupport(),published=JSON.parse(await readFile(fileURLToPath(new URL('../sdk/device/release.json',import.meta.url)),'utf8'));
 assert.deepEqual(published,expected.release);
 assert.deepEqual(await readFile(fileURLToPath(new URL('../'+published.archive.path,import.meta.url))),expected.archive);
});

// Removing a canonical guide or changing reviewed hardware/profile payloads must
// fail the actual delivered archive, rather than only a metadata text assertion.
test('r4 ships current v2 guides while retaining every non-document r3 payload and the immutable r3 archive',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kibi-docs-support-r4-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const previous=fileURLToPath(new URL('../sdk/device/kibi-device-support-20261117.tar.gz',import.meta.url));
 assert.equal(sha(await readFile(previous)),'36001607c633b6535adbadf01514c966b81abc33199ad7170faf5f4a20d5da36');
 const result=await packageDeviceSupport(),archive=join(root,'r4.tar.gz');await writeFile(archive,result.archive);
 await mkdir(join(root,'old'));await mkdir(join(root,'new'));
 await run('tar',['-xzf',previous,'-C',join(root,'old')],{timeout:10000});
 await run('tar',['-xzf',archive,'-C',join(root,'new')],{timeout:10000});
 const before=join(root,'old/kibi-device-support'),after=join(root,'new/kibi-device-support');
 const oldManifest=JSON.parse(await readFile(join(before,'manifest.json'),'utf8'));
 const newManifest=JSON.parse(await readFile(join(after,'manifest.json'),'utf8'));
 assert.equal(result.release.release,'2026-11-18-r4');assert.equal(result.release.contractRelease,'2026-11-17-r3');
 assert.equal(newManifest.contractRelease,'2026-11-17-r3');
 for(const item of oldManifest.files.filter(item=>!item.path.startsWith('docs/')))
  assert.deepEqual(await readFile(join(after,item.path)),await readFile(join(before,item.path)),item.path);
 for(const name of ['API.md','SDK.md','LOCAL_STUDIO.md','SERVER_MODULES.md','SERVER_MODULES_DEPLOY.md','YOUTUBE_MODULE.md']){
  assert.ok(newManifest.files.some(item=>item.path==='docs/'+name),name+' missing from delivered support');
  assert.deepEqual(await readFile(join(after,'docs',name)),await readFile(fileURLToPath(new URL('../docs/'+name,import.meta.url))),name+' differs from canonical guide');
 }
});
