import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readFile,writeFile,rm,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {decodeReleaseZip} from '../../server/studio/full-release.mjs';

const overlay=fileURLToPath(new URL('../',import.meta.url));
const fixture=process.env.KIBI_STUDIO_PUBLIC_FIXTURE;
const baseline=JSON.parse(await readFile(new URL('../manifests/baselines.json',import.meta.url),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(...args)=>spawnSync(process.execPath,[join(overlay,'scripts/update.mjs'),...args],{encoding:'utf8'});
async function target(t){
  const root=await mkdtemp(join(tmpdir(),'kibi-module-updater-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const name of Object.keys(baseline.files)){
    const path=join(root,name);await mkdir(dirname(path),{recursive:true});await copyFile(join(fixture,name),path);
  }
  return root;
}
const integration={skip:!fixture};

test('checking a pinned public Studio validates the plan without changing any file',integration,async t=>{
  const root=await target(t),before=await readFile(join(root,'web/app.js'));
  const result=run('--studio',root,'--check');
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.mode,'check');assert.equal(output.baseline,'studio-0.3.1-complete-r3');
  assert.ok(output.changes.includes('src/studio-plugins.mjs'));
  assert.deepEqual(await readFile(join(root,'web/app.js')),before);
});


test('applying installs usable tools and routes, preserves guard files, and is idempotent',integration,async t=>{
  const root=await target(t);
  const before=await readFile(join(root,'src/project-store.mjs'));
  await mkdir(join(root,'.studio'),{mode:0o700});await writeFile(join(root,'.studio/do-not-open'),'synthetic untouched');
  await mkdir(join(root,'projects'));await writeFile(join(root,'projects/do-not-open'),'synthetic untouched');
  const result=run('--studio',root,'--apply');assert.equal(result.status,0,result.stderr);
  assert.deepEqual(await readFile(join(root,'src/project-store.mjs')),before);
  assert.deepEqual(await readFile(join(root,'src/server.mjs')),await readFile(join(overlay,'src/server.mjs')));
  assert.deepEqual(await readFile(join(root,'src/attachment-assets.mjs')),await readFile(join(overlay,'src/attachment-assets.mjs')));
  assert.equal(await readFile(join(root,'.studio/do-not-open'),'utf8'),'synthetic untouched');
  assert.equal(await readFile(join(root,'projects/do-not-open'),'utf8'),'synthetic untouched');
  const {platformTools,createStudioPlatform}=await import(pathToFileURL(join(root,'src/studio-platform.mjs')));
  assert.ok(platformTools.some(tool=>tool.name==='kibi_publish_server_module'));
  const store={projectId:'fixture'};
  const platform=await createStudioPlatform({root,getStore:()=>store,getEpoch:()=>1});
  t.after(()=>platform.close());
  const disconnected=await platform.tool('kibi_server_modules',{});
  assert.equal(disconnected.result.code,'account_not_connected');
  await assert.rejects(()=>platform.route({method:'GET'},{},{route:'/api/account/plugins',send:()=>{}}),error=>error.code==='account_not_connected');
  const ui=await import(pathToFileURL(join(root,'web/server-modules.js')));
  assert.equal(typeof ui.initServerModulesUI,'function');
  const app=await import(pathToFileURL(join(root,'web/app.js')));
  assert.equal(typeof app.createStudioClient,'function');
  const again=run('--studio',root,'--apply');assert.equal(again.status,0,again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).changes,[]);
});

for(const name of ['src/server.mjs','src/project-store.mjs','src/build-service.mjs','web/app.js']){
  test('an unknown '+name+' preimage prevents every replacement',integration,async t=>{
    const root=await target(t),before=await readFile(join(root,'src/studio-account.mjs'));
    await writeFile(join(root,name),'// modified public program');
    const result=run('--studio',root,'--apply');assert.equal(result.status,1);
    assert.equal(JSON.parse(result.stderr).code,'studio_baseline_mismatch');
    assert.deepEqual(await readFile(join(root,'src/studio-account.mjs')),before);
    await assert.rejects(()=>readFile(join(root,'src/studio-plugins.mjs')),{code:'ENOENT'});
  });
}

for(const name of ['src/studio-plugins.mjs','src/attachment-assets.mjs','docs/CHAT_PHOTOS.md'])test('an unknown existing '+name+' is not overwritten',integration,async t=>{
  const root=await target(t);await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),'// user extension');
  const result=run('--studio',root,'--apply');assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stderr).code,'studio_baseline_mismatch');
  assert.equal(await readFile(join(root,name),'utf8'),'// user extension');
});

for(const kind of ['symlink','hardlink'])test(kind+' at a public target path fails closed',integration,async t=>{
  const root=await target(t),name=join(root,'src/studio-account.mjs'),other=join(root,'original-account.mjs');
  await copyFile(name,other);await rm(name);
  if(kind==='symlink')await symlink(other,name);else await link(other,name);
  const result=run('--studio',root,'--apply');assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stderr).code,'studio_path_unsafe');
});

test('payload corruption is detected before writing even when target baseline is valid',integration,async t=>{
  const root=await target(t),bundle=await mkdtemp(join(tmpdir(),'kibi-module-bundle-'));
  t.after(()=>rm(bundle,{recursive:true,force:true}));
  const names=['scripts/update.mjs','manifests/baselines.json','manifests/previous-releases.json','release.json','src/studio-account.mjs','src/studio-platform.mjs','src/studio-plugins.mjs','src/server.mjs','src/attachment-assets.mjs','web/app.js','web/index.html','web/server-modules.js','web/server-modules.css',...guideTargets,'docs/CHAT_PHOTOS.md'];
  for(const name of names){await mkdir(dirname(join(bundle,name)),{recursive:true});await copyFile(join(overlay,name),join(bundle,name));}
  await writeFile(join(bundle,'src/studio-plugins.mjs'),'// corrupted');
  const result=spawnSync(process.execPath,[join(bundle,'scripts/update.mjs'),'--studio',root,'--apply'],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr).code,'studio_payload_mismatch');
  assert.equal(sha(await readFile(join(root,'src/studio-account.mjs'))),baseline.files['src/studio-account.mjs']);
});

test('the updater requires an explicit check or apply mode',()=>{
  const result=run('--studio','/not-a-studio');assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stderr).code,'studio_update_usage');
});


test('packager makes a deterministic allowlisted archive with a verifiable digest',async t=>{
  const out=await mkdtemp(join(tmpdir(),'kibi-module-pack-'));t.after(()=>rm(out,{recursive:true,force:true}));
  const r1='kibi-studio-server-modules-20261117-r1.tar.gz',publishedR1=await readFile(join(overlay,'dist',r1));
  assert.equal(sha(publishedR1),'0265ec18124013c1cc3ce55425d5becb594ebd9f6586523e4976c2fdf65d9643');
  await writeFile(join(out,r1),publishedR1);
  const packageScript=join(overlay,'scripts/package.mjs');
  const build=()=>spawnSync(process.execPath,[packageScript,'--out',out],{encoding:'utf8'});
  const first=build();assert.equal(first.status,0,first.stderr);
  const metadata=JSON.parse(first.stdout),archive=await readFile(join(out,metadata.archive));
  assert.equal(metadata.release,'studio-server-modules-2026-11-18-r2');assert.equal(metadata.archive,'kibi-studio-server-modules-20261118-r2.tar.gz');
  assert.deepEqual(await readFile(join(out,r1)),publishedR1);
  assert.equal(sha(archive),metadata.sha256);
  const second=build();assert.equal(second.status,0,second.stderr);
  assert.equal(JSON.parse(second.stdout).sha256,metadata.sha256);
  const listing=spawnSync('tar',['-tzf',join(out,metadata.archive)],{encoding:'utf8'});
  assert.equal(listing.status,0,listing.stderr);
  const names=listing.stdout.trim().split('\n');
  assert.ok(names.includes('kibi-studio-server-modules/scripts/update.mjs'));
  assert.ok(names.includes('kibi-studio-server-modules/src/studio-plugins.mjs'));
  assert.ok(names.includes('kibi-studio-server-modules/src/server.mjs'));assert.ok(names.includes('kibi-studio-server-modules/src/attachment-assets.mjs'));assert.ok(names.includes('kibi-studio-server-modules/docs/CHAT_PHOTOS.md'));
  assert.ok(names.every(name=>!name.includes('/.studio/')&&!name.includes('/projects/')&&!name.includes('/tests/')&&!name.includes('auth.json')));
  if(fixture){
    const unpacked=spawnSync('tar',['-xzf',join(out,metadata.archive),'-C',out],{encoding:'utf8'});assert.equal(unpacked.status,0,unpacked.stderr);
    const root=await target(t);
    const checked=spawnSync(process.execPath,[join(out,'kibi-studio-server-modules/scripts/update.mjs'),'--studio',root,'--check'],{encoding:'utf8'});
    assert.equal(checked.status,0,checked.stderr);assert.equal(JSON.parse(checked.stdout).changes.length,17);
  }
});

test('packager refuses to overwrite an existing same-name r2 archive with different bytes',async t=>{
  const out=await mkdtemp(join(tmpdir(),'kibi-r2-immutable-'));t.after(()=>rm(out,{recursive:true,force:true}));
  const filename=join(out,'kibi-studio-server-modules-20261118-r2.tar.gz'),published=Buffer.from('existing immutable public artifact');
  await writeFile(filename,published);
  const result=spawnSync(process.execPath,[join(overlay,'scripts/package.mjs'),'--out',out],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/Refusing to replace an existing immutable overlay archive/);assert.deepEqual(await readFile(filename),published);
});


test('a symlink supplied as Studio root cannot redirect an update',integration,async t=>{
  const root=await target(t),container=await mkdtemp(join(tmpdir(),'kibi-module-root-link-'));
  t.after(()=>rm(container,{recursive:true,force:true}));
  const alias=join(container,'studio');await symlink(root,alias);
  const result=run('--studio',alias,'--apply');assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stderr).code,'studio_path_unsafe');
  assert.equal(sha(await readFile(join(root,'src/studio-account.mjs'))),baseline.files['src/studio-account.mjs']);
});


test('a pinned previously shipped server-modules candidate can receive instruction fixes without touching projects', {skip:!fixture||!process.env.KIBI_STUDIO_PREVIOUS_RELEASE},async t=>{
  const root=await target(t),releaseRoot=process.env.KIBI_STUDIO_PREVIOUS_RELEASE;
  const previous=decodeReleaseZip({archive:await readFile(join(releaseRoot,'kibi-studio-local.zip')),manifest:JSON.parse(await readFile(join(releaseRoot,'kibi-studio-local.manifest.json'),'utf8')),release:JSON.parse(await readFile(join(releaseRoot,'release.json'),'utf8'))});
  const published=JSON.parse(await readFile(new URL('../manifests/previous-releases.json',import.meta.url),'utf8'));
  for(const[name,hash]of Object.entries(published.releases[0].files)){
    const bytes=previous.get(name);assert.equal(sha(bytes),hash,name);await writeFile(join(root,name),bytes);
  }
  await mkdir(join(root,'projects'));await writeFile(join(root,'projects/untouched'),'synthetic preserved project');
  await mkdir(join(root,'.studio'));await writeFile(join(root,'.studio/untouched'),'synthetic preserved state');
  const checked=run('--studio',root,'--check');assert.equal(checked.status,0,checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout).changes,['src/studio-platform.mjs','web/server-modules.js','src/server.mjs','src/attachment-assets.mjs',...guideTargets,'docs/CHAT_PHOTOS.md']);
  const applied=run('--studio',root,'--apply');assert.equal(applied.status,0,applied.stderr);
  assert.deepEqual(JSON.parse(run('--studio',root,'--check').stdout).changes,[]);
  assert.equal(await readFile(join(root,'projects/untouched'),'utf8'),'synthetic preserved project');
  assert.equal(await readFile(join(root,'.studio/untouched'),'utf8'),'synthetic preserved state');
});


test('editing accepted previous hashes cannot bypass the pinned upgrade provenance',integration,async t=>{
  const root=await target(t),bundle=await mkdtemp(join(tmpdir(),'kibi-module-pinned-history-'));
  t.after(()=>rm(bundle,{recursive:true,force:true}));
  const names=['scripts/update.mjs','manifests/baselines.json','manifests/previous-releases.json','release.json','src/studio-account.mjs','src/studio-platform.mjs','src/studio-plugins.mjs','src/server.mjs','src/attachment-assets.mjs','web/app.js','web/index.html','web/server-modules.js','web/server-modules.css',...guideTargets,'docs/CHAT_PHOTOS.md'];
  for(const name of names){await mkdir(dirname(join(bundle,name)),{recursive:true});await copyFile(join(overlay,name),join(bundle,name));}
  const previous=JSON.parse(await readFile(join(bundle,'manifests/previous-releases.json'),'utf8'));
  previous.releases[0].files['src/studio-platform.mjs']='f'.repeat(64);
  await writeFile(join(bundle,'manifests/previous-releases.json'),JSON.stringify(previous));
  const result=spawnSync(process.execPath,[join(bundle,'scripts/update.mjs'),'--studio',root,'--apply'],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr).code,'studio_previous_release_manifest_mismatch');
  assert.equal(sha(await readFile(join(root,'src/studio-account.mjs'))),baseline.files['src/studio-account.mjs']);
  await assert.rejects(()=>readFile(join(root,'src/studio-plugins.mjs')),{code:'ENOENT'});
});

const guideTargets=['docs/API.md','docs/SDK.md','docs/LOCAL_STUDIO.md','docs/SERVER_MODULES.md','docs/SERVER_MODULES_DEPLOY.md','docs/YOUTUBE_MODULE.md','src/platform-guides/API.md'];

test('published r1 archive and its exact fourteen target hashes remain accepted',async()=>{
  const archive=await readFile(join(overlay,'dist/kibi-studio-server-modules-20261117-r1.tar.gz'));
  assert.equal(sha(archive),'0265ec18124013c1cc3ce55425d5becb594ebd9f6586523e4976c2fdf65d9643');
  const previous=JSON.parse(await readFile(join(overlay,'manifests/previous-releases.json')));
  const published=previous.releases.find(row=>row.archiveSha256==='0265ec18124013c1cc3ce55425d5becb594ebd9f6586523e4976c2fdf65d9643');
  assert.ok(published);assert.equal(Object.keys(published.files).length,14);
  for(const name of guideTargets)assert.equal(sha(await readFile(join(overlay,name))),published.files[name],name);
});

test('the exact published r1 cohort upgrades only the photo targets and is idempotent',integration,async t=>{
  const root=await target(t),bundle=await mkdtemp(join(tmpdir(),'kibi-r1-public-'));
  t.after(()=>rm(bundle,{recursive:true,force:true}));
  const archive=join(overlay,'dist/kibi-studio-server-modules-20261117-r1.tar.gz');
  assert.equal(sha(await readFile(archive)),'0265ec18124013c1cc3ce55425d5becb594ebd9f6586523e4976c2fdf65d9643');
  const unpacked=spawnSync('tar',['-xzf',archive,'-C',bundle],{encoding:'utf8'});assert.equal(unpacked.status,0,unpacked.stderr);
  const r1=join(bundle,'kibi-studio-server-modules'),release=JSON.parse(await readFile(join(r1,'release.json')));
  assert.equal(Object.keys(release.files).length,14);
  for(const[name,hash]of Object.entries(release.files)){
    const bytes=await readFile(join(r1,name));assert.equal(sha(bytes),hash,name);await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),bytes);
  }
  const checked=run('--studio',root,'--check');assert.equal(checked.status,0,checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout).changes,['src/studio-platform.mjs','src/server.mjs','src/attachment-assets.mjs','docs/CHAT_PHOTOS.md']);
  const applied=run('--studio',root,'--apply');assert.equal(applied.status,0,applied.stderr);
  assert.deepEqual(JSON.parse(run('--studio',root,'--check').stdout).changes,[]);
});
async function seedGuides(root){
  const baseRoot=process.env.KIBI_STUDIO_PUBLIC_RELEASE;
  const files=decodeReleaseZip({archive:await readFile(join(baseRoot,'kibi-studio-local.zip')),manifest:JSON.parse(await readFile(join(baseRoot,'kibi-studio-local.manifest.json'),'utf8')),release:JSON.parse(await readFile(join(baseRoot,'release.json'),'utf8'))});
  for(const name of guideTargets){await mkdir(dirname(join(root,name)),{recursive:true});if(files.has(name))await writeFile(join(root,name),files.get(name));}
}
test('named canonical guides upgrade from public preimages alongside the program payload',integration,async t=>{
  const root=await target(t);await seedGuides(root);
  const result=run('--studio',root,'--apply');assert.equal(result.status,0,result.stderr);
  for(const name of guideTargets){
    const canonical=await readFile(join(overlay,'../server/docs',name.split('/').at(-1)));
    assert.deepEqual(await readFile(join(root,name)),canonical,name);
  }
  assert.deepEqual(JSON.parse(run('--studio',root,'--check').stdout).changes,[]);
});
for(const name of ['docs/API.md','src/platform-guides/API.md','docs/SERVER_MODULES.md']){
  test('an unknown '+name+' preimage prevents all program replacements',integration,async t=>{
    const root=await target(t);await seedGuides(root);const before=await readFile(join(root,'src/studio-account.mjs'));
    await writeFile(join(root,name),'local documentation change');
    const result=run('--studio',root,'--apply');assert.equal(result.status,1);
    assert.equal(JSON.parse(result.stderr).code,'studio_baseline_mismatch');
    assert.deepEqual(await readFile(join(root,'src/studio-account.mjs')),before);
  });
}
for(const kind of ['symlink','hardlink'])test(kind+' at a public guide target fails before any replacement',integration,async t=>{
  const root=await target(t);await seedGuides(root);const before=await readFile(join(root,'src/studio-account.mjs'));
  const name=join(root,'docs/API.md'),other=join(root,'original-guide.md');await copyFile(name,other);await rm(name);
  if(kind==='symlink')await symlink(other,name);else await link(other,name);
  const result=run('--studio',root,'--apply');assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stderr).code,'studio_path_unsafe');
  assert.deepEqual(await readFile(join(root,'src/studio-account.mjs')),before);
});
test('the exact installed 8f56 public full cohort upgrades safely and idempotently',{skip:!fixture||!process.env.KIBI_STUDIO_CURRENT_RELEASE},async t=>{
  const root=await target(t);await seedGuides(root);const releaseRoot=process.env.KIBI_STUDIO_CURRENT_RELEASE;
  const archive=await readFile(join(releaseRoot,'kibi-studio-local.zip'));
  assert.equal(sha(archive),'8f5685a39b963f39cd5f79f8a023ed4a3d8951cb711c9de4d9c04173b78e8ee0');
  const previous=decodeReleaseZip({archive,manifest:JSON.parse(await readFile(join(releaseRoot,'kibi-studio-local.manifest.json'),'utf8')),release:JSON.parse(await readFile(join(releaseRoot,'release.json'),'utf8'))});
  for(const name of ['src/studio-account.mjs','src/studio-platform.mjs','src/studio-plugins.mjs','web/app.js','web/index.html','web/server-modules.js','web/server-modules.css'])await writeFile(join(root,name),previous.get(name));
  const checked=run('--studio',root,'--check');assert.equal(checked.status,0,checked.stderr);
  const applied=run('--studio',root,'--apply');assert.equal(applied.status,0,applied.stderr);
  assert.deepEqual(JSON.parse(run('--studio',root,'--check').stdout).changes,[]);
});
