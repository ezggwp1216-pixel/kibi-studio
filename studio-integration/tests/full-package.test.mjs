import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {decodeReleaseZip} from '../../server/studio/full-release.mjs';

const overlay=fileURLToPath(new URL('../',import.meta.url));
const base=process.env.KIBI_STUDIO_PUBLIC_RELEASE;
const lineage='5c82a27e8ca72658ace8d0cd3e7aff2494072ad3';
const fixedBootstrap=fileURLToPath(new URL('../../bootstrap.mjs',import.meta.url));
const fixedBootstrapSha='adfc7eb70bdea022b70b95c8e733e29e51e6dc423e4c0fe3069bf8eb834615f7';
const payload=['src/studio-account.mjs','src/studio-platform.mjs','src/studio-plugins.mjs','web/app.js','web/index.html','web/server-modules.js','web/server-modules.css','src/server.mjs','src/attachment-assets.mjs','docs/API.md','docs/SDK.md','docs/LOCAL_STUDIO.md','docs/SERVER_MODULES.md','docs/SERVER_MODULES_DEPLOY.md','docs/YOUTUBE_MODULE.md','src/platform-guides/API.md','docs/CHAT_PHOTOS.md'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(...args)=>spawnSync(process.execPath,[join(overlay,'scripts/package-full.mjs'),...args],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
async function scratch(t){const dir=await mkdtemp(join(tmpdir(),'kibi-modules-full-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function decoded(root){return decodeReleaseZip({archive:await readFile(join(root,'kibi-studio-local.zip')),manifest:JSON.parse(await readFile(join(root,'kibi-studio-local.manifest.json'),'utf8')),release:JSON.parse(await readFile(join(root,'release.json'),'utf8'))});}

test('full candidate includes only named program, guide and pinned bootstrap changes plus metadata and preserves the public neutral starter', {skip:!base},async t=>{
  const dir=await scratch(t),out=join(dir,'candidate');
  const result=run('--base-dir',base,'--out',out);assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout),release=JSON.parse(await readFile(join(out,'release.json'),'utf8'));
  assert.equal(release.release,'studio-full-2026-11-18-r2');assert.equal(release.version,'0.3.1');
  assert.equal(release.bootstrapNodeSha256,fixedBootstrapSha);
  assert.deepEqual(await readFile(join(out,'bootstrap.mjs')),await readFile(fixedBootstrap));
  assert.equal(release.sourceCommit,lineage);assert.equal(release.baseCommit,lineage);assert.equal(release.published,false);
  assert.equal(report.baselinesCompared,26);assert.equal(report.bootstrapVerified,true);assert.equal(report.roundtripVerified,true);
  assert.deepEqual(report.updaterCheck.changes,[]);assert.equal(report.updaterCheck.mode,'check');
  const publication=JSON.parse(await readFile(join(out,'publication.json'),'utf8'));
  const names=['kibi-studio-local.zip','kibi-studio-local.zip.sha256','kibi-studio-local.manifest.json','release.json','bootstrap.sh','bootstrap.mjs','bootstrap.py','runtime-lock.json'];
  assert.deepEqual(Object.keys(publication.files).sort(),names.sort());assert.equal(publication.published,false);assert.equal(publication.requiresNewGitCommit,true);
  for(const[name,file]of Object.entries(publication.files)){const bytes=await readFile(join(out,name));assert.equal(file.sha256,sha(bytes),name);assert.equal(file.bytes,bytes.length,name);}
  const instructions=await readFile(join(out,'PUBLISH.md'),'utf8');assert.match(instructions,/--commit/);assert.match(instructions,/--install-only/);assert.match(instructions,/projects/);
  const before=await decoded(base),after=await decoded(out),changed=[];
  for(const[name,bytes]of before){assert.ok(after.has(name),name);if(!after.get(name).equals(bytes))changed.push(name);}
  assert.deepEqual(changed.sort(),[...payload.filter(name=>before.has(name)),'scripts/bootstrap.mjs'].sort());
  for(const name of payload)assert.deepEqual(after.get(name),await readFile(join(overlay,name)));
  for(const name of payload.filter(name=>name!=='docs/CHAT_PHOTOS.md'&&(name.startsWith('docs/')||name.startsWith('src/platform-guides/'))))assert.deepEqual(after.get(name),await readFile(join(overlay,'../server/docs',name.split('/').at(-1))),name);
  const publishedR1=JSON.parse(await readFile(join(overlay,'manifests/previous-releases.json'))).releases.find(row=>row.archiveSha256==='0265ec18124013c1cc3ce55425d5becb594ebd9f6586523e4976c2fdf65d9643');
  for(const name of payload.filter(name=>name!=='docs/CHAT_PHOTOS.md'&&(name.startsWith('docs/')||name.startsWith('src/platform-guides/'))))assert.equal(sha(after.get(name)),publishedR1.files[name],name);
  assert.deepEqual([...after.keys()].filter(name=>!before.has(name)).sort(),[...payload.filter(name=>!before.has(name)),'resources/server-modules-release.json'].sort());
  const neutral=[...before].filter(([name])=>name.startsWith('projects/kibi-base/')||name.startsWith('templates/'));
  assert.equal(neutral.length,135);for(const[name,bytes]of neutral)assert.deepEqual(after.get(name),bytes,name);
  assert.equal(JSON.parse(after.get('package.json')).version,'0.3.1');
  const metadata=JSON.parse(after.get('resources/server-modules-release.json'));
  assert.equal(metadata.published,false);assert.equal(metadata.sourceCommit,lineage);
  assert.equal(metadata.overlayRelease,'studio-server-modules-2026-11-18-r2');assert.equal(Object.keys(metadata.files).length,17);
  for(const[name,key]of [['bootstrap.sh','bootstrapShellSha256'],['bootstrap.mjs','bootstrapNodeSha256'],['bootstrap.py','bootstrapSha256'],['runtime-lock.json','runtimeLockSha256']]){
    const bytes=await readFile(join(out,name));
    assert.deepEqual(bytes,await readFile(name==='bootstrap.mjs'?fixedBootstrap:join(base,name)));
    assert.deepEqual(after.get('scripts/'+name),bytes);assert.equal(sha(bytes),release[key]);
  }
  const again=run('--base-dir',base,'--out',join(dir,'candidate-two'));assert.equal(again.status,0,again.stderr);
  assert.equal(JSON.parse(again.stdout).archiveSha256,report.archiveSha256);
});

test('a changed public base manifest is rejected before an output candidate is created',{skip:!base},async t=>{
  const dir=await scratch(t),seed=join(dir,'seed'),out=join(dir,'candidate');await mkdir(seed);
  for(const name of ['release.json','kibi-studio-local.manifest.json','kibi-studio-local.zip'])await copyFile(join(base,name),join(seed,name));
  await writeFile(join(seed,'kibi-studio-local.manifest.json'),'{}\n');
  const result=run('--base-dir',seed,'--out',out);assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stderr).code,'full_package_unknown_base');
  await assert.rejects(()=>readFile(join(out,'release.json')),{code:'ENOENT'});
});

test('an unpinned helper or bootstrap is rejected without importing its code',{skip:!base},async t=>{
  const dir=await scratch(t),helper=join(dir,'helper.mjs'),sentinel=join(dir,'must-not-exist');
  await writeFile(helper,'import {writeFileSync} from "node:fs";writeFileSync('+JSON.stringify(sentinel)+',"executed");');
  const result=run('--base-dir',base,'--out',join(dir,'candidate'),'--helper-file',helper);
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr).code,'full_package_helper_mismatch');
  await assert.rejects(()=>readFile(sentinel),{code:'ENOENT'});
  const bootstrapResult=run('--base-dir',base,'--out',join(dir,'bootstrap-candidate'),'--bootstrap-node-file',helper);
  assert.equal(bootstrapResult.status,1);assert.equal(JSON.parse(bootstrapResult.stderr).code,'full_package_bootstrap_mismatch');
  await assert.rejects(()=>readFile(sentinel),{code:'ENOENT'});
  await assert.rejects(()=>readFile(join(dir,'bootstrap-candidate/release.json')),{code:'ENOENT'});
});
