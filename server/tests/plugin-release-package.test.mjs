import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,link,realpath,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const releaseName='server-modules-20261117-rc1';
const roots=['package.json','README.md','START_HERE.md','bootstrap-prompt.txt','Dockerfile','.dockerignore','compose.yaml','compose.https.yaml','compose.plugins.yaml','Caddyfile','AGENTS.md'];
const scripts=['init.mjs','package-device-support.mjs','package-studio-full.mjs','package-studio-platform.mjs','register-fresh-sdk-profile.mjs','retire-plugin-links.mjs','package-modules-release.mjs'];
async function fixture(t){
 const base=await mkdtemp(join(await realpath(tmpdir()),'kibi-release-test-'));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const sourceRoot=join(base,'source');await mkdir(sourceRoot);
 for(const name of roots)await writeFile(join(sourceRoot,name),name==='package.json'?'{}\n':name+'\n');
 for(const dir of ['src','web','sdk','studio','resources','examples','workers','docs','scripts']){
  await mkdir(join(sourceRoot,dir));
  if(dir!=='scripts')await writeFile(join(sourceRoot,dir,'public.txt'),'публичный '+dir+'\n');
 }
 for(const name of scripts)await writeFile(join(sourceRoot,'scripts',name),'// '+name+'\n');
 await writeFile(join(sourceRoot,'docs','SERVER_MODULES_DEPLOY.md'),'# Установка и откат\n');
 return{base,sourceRoot,outputDir:join(base,'release')};
}
async function pack(options){return(await import('../scripts/package-modules-release.mjs')).packageModulesRelease(options);}
function untar(bytes){
 const tar=gunzipSync(bytes),files=new Map();let offset=0;
 while(offset+512<=tar.length){
  const h=tar.subarray(offset,offset+512);if(h.every(b=>b===0))break;
  const str=(a,b)=>h.subarray(a,b).toString().split('\0')[0];
  const path=[str(345,500),str(0,100)].filter(Boolean).join('/'),size=parseInt(str(124,136),8);
  let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:h[i];
  assert.equal(parseInt(str(148,156),8),sum,'tar checksum');
  assert.equal(str(156,157),'0');assert.equal(parseInt(str(108,116),8),0);assert.equal(parseInt(str(116,124),8),0);assert.equal(parseInt(str(136,148),8),0);
  assert.equal(str(265,297),'');assert.equal(str(297,329),'');assert.equal(parseInt(str(100,108),8),0o644);
  assert.ok(!files.has(path),'no duplicate archive path');
  files.set(path,Buffer.from(tar.subarray(offset+512,offset+512+size)));
  offset+=512+Math.ceil(size/512)*512;
 }
 assert.ok(tar.subarray(offset).every(b=>b===0),'only tar EOF padding');return files;
}

// These catch a packager opening private/linked input before validating its inventory.
for(const forbidden of ['.data/state.json','.studio/profile.json','.git/config','.env','auth.json','settings.json','encryption.key','admin-password','logs/runtime.log','tests/payload.mjs','temp/scratch']){
 test('refuses protected input before reading: '+forbidden,async t=>{
  const options=await fixture(t),path=join(options.sourceRoot,'src',forbidden);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,'PRIVATE');
  let readPhase=false;await assert.rejects(pack({...options,onPhase:phase=>{if(phase==='inventory-validated')readPhase=true;}}),{code:'unsafe_release_path'});
  assert.equal(readPhase,false);assert.deepEqual(await readdir(options.base),['source']);
 });
}
for(const kind of ['symbolic','hard'])test('refuses '+kind+' links before reading',async t=>{
 const options=await fixture(t),outside=join(options.base,'secret');await writeFile(outside,'PRIVATE');
 if(kind==='symbolic')await symlink(outside,join(options.sourceRoot,'src','linked.txt'));else await link(outside,join(options.sourceRoot,'src','linked.txt'));
 let readPhase=false;await assert.rejects(pack({...options,onPhase:p=>{if(p==='inventory-validated')readPhase=true;}}),{code:'unsafe_release_input'});assert.equal(readPhase,false);
 await assert.rejects(readFile(join(options.outputDir,releaseName+'.tar.gz')),{code:'ENOENT'});
});
test('roundtrips archive, manifest and checksum companions without root private/runtime inputs',async t=>{
 const options=await fixture(t);
 for(const name of ['.data','.studio','.git','tests','temp']){await mkdir(join(options.sourceRoot,name));await writeFile(join(options.sourceRoot,name,'do-not-read'),'PRIVATE');}
 await writeFile(join(options.sourceRoot,'.env'),'PRIVATE');await writeFile(join(options.sourceRoot,'scripts','unlisted.mjs'),'EXCLUDED');
 const report=await pack(options),archiveName=releaseName+'.tar.gz',manifestName=releaseName+'.manifest.json';
 const archive=await readFile(join(options.outputDir,archiveName)),manifestBytes=await readFile(join(options.outputDir,manifestName)),manifest=JSON.parse(manifestBytes),files=untar(archive);
 assert.equal(report.releaseName,releaseName);assert.equal(report.privateFilesIncluded,false);assert.equal(report.published,false);
 assert.equal(manifest.privateFilesIncluded,false);assert.equal(manifest.releaseName,releaseName);assert.equal(manifest.fileCount,manifest.files.length);
 assert.equal(report.archiveSha256,digest(archive));assert.equal(report.manifestSha256,digest(manifestBytes));
 assert.equal(await readFile(join(options.outputDir,archiveName+'.sha256'),'utf8'),digest(archive)+'  '+archiveName+'\n');
 assert.equal(await readFile(join(options.outputDir,manifestName+'.sha256'),'utf8'),digest(manifestBytes)+'  '+manifestName+'\n');
 assert.deepEqual([...files.keys()],manifest.files.map(f=>releaseName+'/'+f.path));
 let total=0;for(const file of manifest.files){const content=files.get(releaseName+'/'+file.path);assert.equal(content.length,file.bytes);assert.equal(digest(content),file.sha256);total+=file.bytes;}
 assert.equal(total,manifest.totalBytes);assert.equal(files.get(releaseName+'/src/public.txt').toString(),'публичный src\n');
 assert.ok(files.has(releaseName+'/scripts/retire-plugin-links.mjs'));assert.ok(files.has(releaseName+'/docs/SERVER_MODULES_DEPLOY.md'));
 assert.equal(manifest.sourceWitnessSha256,digest(Buffer.from(manifest.files.map(f=>`${f.path}\0${f.bytes}\0${f.sha256}\n`).join(''))));
 assert.equal(archive.readUInt32LE(4),0,'gzip mtime is zero');
 assert.equal(manifest.runtimeGates.dockerImages,'not_verified');assert.equal(manifest.runtimeGates.youtube,'not_verified');assert.equal(manifest.runtimeGates.physicalBoard,'not_verified');
});
test('archive and manifest are deterministic across source mtimes and destination',async t=>{
 const options=await fixture(t);await pack(options);await utimes(join(options.sourceRoot,'src','public.txt'),1700000000,1700000000);
 const other=join(options.base,'repeat');await pack({...options,outputDir:other});
 for(const name of await readdir(options.outputDir))assert.deepEqual(await readFile(join(options.outputDir,name)),await readFile(join(other,name)),name);
});
test('rechecks source bytes before publishing and leaves no candidate on drift',async t=>{
 const options=await fixture(t);
 await assert.rejects(pack({...options,onPhase:async phase=>{if(phase==='before-publication')await writeFile(join(options.sourceRoot,'src','public.txt'),'changed');}}),{code:'changing_release_source'});
 assert.deepEqual(await readdir(options.base),['source']);
});
test('rechecks inventory before publishing, including newly introduced forbidden paths',async t=>{
 const options=await fixture(t);
 await assert.rejects(pack({...options,onPhase:async phase=>{if(phase==='before-publication')await writeFile(join(options.sourceRoot,'src','auth.json'),'PRIVATE');}}),{code:'unsafe_release_path'});
 assert.deepEqual(await readdir(options.base),['source']);
});
test('refuses existing destination without overwriting it',async t=>{
 const options=await fixture(t);await mkdir(options.outputDir);await writeFile(join(options.outputDir,'keep'),'old');
 await assert.rejects(pack(options),{code:'release_destination_exists'});assert.equal(await readFile(join(options.outputDir,'keep'),'utf8'),'old');
});
test('enforces file and total byte limits before reading payloads',async t=>{
 const options=await fixture(t);const {truncate}=await import('node:fs/promises');await truncate(join(options.sourceRoot,'src','public.txt'),65*1024*1024);
 let readPhase=false;await assert.rejects(pack({...options,onPhase:p=>{if(p==='inventory-validated')readPhase=true;}}),{code:'release_limits_exceeded'});assert.equal(readPhase,false);
});
test('enforces aggregate byte limit when every file is individually within its limit',async t=>{
 const options=await fixture(t);const {truncate}=await import('node:fs/promises');
 for(const name of ['first.bin','second.bin']){const path=join(options.sourceRoot,'src',name);await writeFile(path,'');await truncate(path,64*1024*1024);}
 let readPhase=false;await assert.rejects(pack({...options,onPhase:p=>{if(p==='inventory-validated')readPhase=true;}}),{code:'release_limits_exceeded'});assert.equal(readPhase,false);
});
test('enforces file count limit before reading payloads',async t=>{
 const options=await fixture(t);for(let i=0;i<4096;i++)await writeFile(join(options.sourceRoot,'src','item-'+i),'');
 let readPhase=false;await assert.rejects(pack({...options,onPhase:p=>{if(p==='inventory-validated')readPhase=true;}}),{code:'release_limits_exceeded'});assert.equal(readPhase,false);
});
test('rejects a symlinked scripts parent before reading payloads',async t=>{
 const options=await fixture(t);const {rename}=await import('node:fs/promises');await rename(join(options.sourceRoot,'scripts'),join(options.base,'scripts'));
 await symlink(join(options.base,'scripts'),join(options.sourceRoot,'scripts'));
 let readPhase=false;await assert.rejects(pack({...options,onPhase:p=>{if(p==='inventory-validated')readPhase=true;}}),{code:'unsafe_release_input'});assert.equal(readPhase,false);
});
test('requires the rollback instructions referenced by its manifest',async t=>{
 const options=await fixture(t);await rm(join(options.sourceRoot,'docs','SERVER_MODULES_DEPLOY.md'));
 await assert.rejects(pack(options),{code:'missing_release_payload'});
});
test('allows public sources and output under the standard /tmp parent on Linux and macOS',async t=>{
 const options=await fixture(t),base=await mkdtemp(join(await realpath('/tmp'),'kibi-public-release-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const {rename}=await import('node:fs/promises');await rename(options.sourceRoot,join(base,'source'));
 const report=await pack({sourceRoot:join(base,'source'),outputDir:join(base,'release')});assert.equal(report.ok,true);
});
