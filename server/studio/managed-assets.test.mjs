import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,readdir,writeFile,symlink,link,rename,realpath,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {installManagedAssets,createManagedAssetBlock,MANAGED_ASSET_PATH,PUBLIC_ASSET_BASE} from './managed-assets.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const asset='public_image_0123456789abcdef',other='public_image_fedcba9876543210';
function input(id=asset,content='// exact synthetic asset\n'){
 return{assetId:id,mode:'append-only',assertProjectCurrent:async()=>{},files:[{path:MANAGED_ASSET_PATH,content:createManagedAssetBlock(id,'#pragma once\n'+content+'/* PUBLIC RESOURCE METADATA\n{"fixture":true}\n*/\n')}]};
}
async function fixture(t){
 const publicPath=process.env.KIBI_PUBLIC_EMBEDDED_ASSETS;
 if(!publicPath){t.skip('Set KIBI_PUBLIC_EMBEDDED_ASSETS to the pinned PUBLIC template header to run stock-bank integration tests.');return null;}
 const base=await readFile(publicPath);assert.equal(base.length,PUBLIC_ASSET_BASE.bytes);assert.equal(hash(base),PUBLIC_ASSET_BASE.sha256);
 const root=await realpath(await mkdtemp('/private/tmp/kibi-public-asset-bank-')),sourceDir=join(root,'firmware');await mkdir(sourceDir);t.after(()=>rm(root,{recursive:true,force:true}));
 const existingFiles=[];
 for(let i=0;i<63;i++){
  const path=i===0?MANAGED_ASSET_PATH:i===1?'project.ino':`stock_${i}.h`,bytes=i===0?base:Buffer.from(i===1?'void setup(){} void loop(){}\n':'#pragma once\n');
  await writeFile(join(sourceDir,path),bytes);existingFiles.push({path,bytes:bytes.length,sha256:hash(bytes)});
 }
 const f={root,sourceDir,base,existingFiles,input:input()};
 f.refresh=async()=>{const bytes=await readFile(join(sourceDir,MANAGED_ASSET_PATH)),entry=existingFiles.find(x=>x.path===MANAGED_ASSET_PATH);entry.bytes=bytes.length;entry.sha256=hash(bytes);return bytes;};
 return f;
}

test('asset block framing is deterministic, hashed and never accepts source-path control',()=>{
 const a=input();assert.equal(MANAGED_ASSET_PATH,'embedded_assets.h');assert.equal(a.files[0].content,input().files[0].content);assert.match(a.files[0].content,/^\/\/ KIBI_ASSET_BEGIN public_image_[a-f0-9]{16} [a-f0-9]{64} [0-9]+\n/);
 assert.throws(()=>createManagedAssetBlock('../app_feature.h','#pragma once\n'),{code:'ASSET_INPUT'});
});
test('63-stock-file project plus two imports stays63 and preserves the public stock prefix exactly',async t=>{
 const f=await fixture(t);if(!f)return;
 const first=await installManagedAssets(f);assert.deepEqual(first.paths,['embedded_assets.h']);assert.equal(first.unchanged,false);let bytes=await f.refresh();assert.equal(hash(bytes),first.hashes[MANAGED_ASSET_PATH]);assert.deepEqual(bytes.subarray(0,f.base.length),f.base);
 f.input=input(other,'// second independent namespace\n');const second=await installManagedAssets(f);bytes=await f.refresh();assert.equal(hash(bytes),second.hashes[MANAGED_ASSET_PATH]);assert.deepEqual(bytes.subarray(0,f.base.length),f.base);
 assert.equal((await readdir(f.sourceDir)).length,63);assert.equal(f.existingFiles.length,63);assert.equal((bytes.toString().match(/KIBI_ASSET_BEGIN/g)||[]).length,2);assert.deepEqual((await readdir(f.root)).sort(),['firmware']);
});
test('identical block is idempotent while a conflicting assetId never overwrites existing content',async t=>{
 const f=await fixture(t);if(!f)return;await installManagedAssets(f);const before=await f.refresh(),info=await lstat(join(f.sourceDir,MANAGED_ASSET_PATH));
 const duplicate=await installManagedAssets(f);assert.equal(duplicate.unchanged,true);assert.equal((await lstat(join(f.sourceDir,MANAGED_ASSET_PATH))).ino,info.ino);assert.deepEqual(await f.refresh(),before);
 f.input=input(asset,'// same identity, different content\n');await assert.rejects(installManagedAssets(f),{code:'ASSET_CONFLICT'});assert.deepEqual(await f.refresh(),before);
});
test('unknown base, unframed tails and corrupted blocks are rejected without changing any original bytes',async t=>{
 const f=await fixture(t);if(!f)return;const path=join(f.sourceDir,MANAGED_ASSET_PATH);
 for(const bytes of [Buffer.alloc(f.base.length,35),Buffer.concat([f.base,Buffer.from('// not generated\n')])]){
  await writeFile(path,bytes);await f.refresh();await assert.rejects(installManagedAssets(f),e=>['ASSET_BASE','ASSET_FORMAT'].includes(e.code));assert.deepEqual(await readFile(path),bytes);
 }
 await writeFile(path,f.base);await f.refresh();await installManagedAssets(f);let bytes=await f.refresh();bytes[bytes.length-10]^=1;await writeFile(path,bytes);await f.refresh();f.input=input(other);await assert.rejects(installManagedAssets(f),{code:'ASSET_FORMAT'});assert.deepEqual(await readFile(path),bytes);
});
test('stale snapshot hashes, missing bank, path overrides and hardlinked/symlinked banks are refused',async t=>{
 const f=await fixture(t);if(!f)return;const path=join(f.sourceDir,MANAGED_ASSET_PATH);
 f.existingFiles[0].sha256='0'.repeat(64);await assert.rejects(installManagedAssets(f),{code:'ASSET_CHANGED'});await f.refresh();
 await assert.rejects(installManagedAssets({...f,existingFiles:f.existingFiles.filter(x=>x.path!==MANAGED_ASSET_PATH)}),{code:'ASSET_SNAPSHOT'});
 const bad=input();bad.files[0].path='app_feature.h';await assert.rejects(installManagedAssets({...f,input:bad}),{code:'ASSET_INPUT'});
 await link(path,join(f.root,'synthetic-hardlink'));await assert.rejects(installManagedAssets(f),{code:'ASSET_BOUNDARY'});await rm(join(f.root,'synthetic-hardlink'));
 await rename(path,join(f.root,'saved-public-base'));await symlink(join(f.root,'saved-public-base'),path);await assert.rejects(installManagedAssets(f),{code:'ASSET_BOUNDARY'});
});
test('revocation after atomic commit restores the previous bank and leaves no staging files in source',async t=>{
 const f=await fixture(t);if(!f)return;await installManagedAssets(f);const before=await f.refresh();f.input=input(other);let calls=0;
 await assert.rejects(installManagedAssets({...f,guard:async()=>{if(++calls===3)throw new Error('revoked after commit');}}),/revoked after commit/);
 assert.deepEqual(await readFile(join(f.sourceDir,MANAGED_ASSET_PATH)),before);assert.equal((await readdir(f.sourceDir)).length,63);assert.deepEqual(await readdir(f.root),['firmware']);
});
test('an awaited-guard source-directory swap cannot write the bank outside the pinned source',async t=>{
 const f=await fixture(t);if(!f)return;const outside=join(f.root,'outside');await mkdir(outside);let checks=0;
 await assert.rejects(installManagedAssets({...f,guard:async()=>{if(++checks===2){await rename(f.sourceDir,join(f.root,'previous-firmware'));await symlink(outside,f.sourceDir);}}}),{code:'ASSET_BOUNDARY'});
 assert.deepEqual(await readdir(outside),[]);assert.deepEqual(await readFile(join(f.root,'previous-firmware',MANAGED_ASSET_PATH)),f.base);assert.equal((await readdir(f.root)).some(x=>x.startsWith('.kibi-assets-')),false);
});
test('a concurrently replaced bank is preserved instead of being overwritten or rolled back blindly',async t=>{
 const f=await fixture(t);if(!f)return;const replacement=Buffer.from('#pragma once\n// unrelated replacement fixture\n');let calls=0;
 await assert.rejects(installManagedAssets({...f,guard:async()=>{if(++calls===2){await rm(join(f.sourceDir,MANAGED_ASSET_PATH));await writeFile(join(f.sourceDir,MANAGED_ASSET_PATH),replacement);}}}),{code:'ASSET_CHANGED'});
 assert.deepEqual(await readFile(join(f.sourceDir,MANAGED_ASSET_PATH)),replacement);
});
test('63 source files,2MiB bank and4MiB total remain enforced',async t=>{
 const f=await fixture(t);if(!f)return;
 await assert.rejects(installManagedAssets({...f,existingFiles:[...f.existingFiles,{path:'extra.h',bytes:0}]}),{code:'ASSET_LIMIT'});
 f.input=input(asset,'//'+ 'x'.repeat(600000)+'\n');await assert.rejects(installManagedAssets(f),{code:'ASSET_LIMIT'});
 const totalFiles=f.existingFiles.map((x,i)=>i===1?{...x,bytes:4*1024*1024}:x);await assert.rejects(installManagedAssets({...f,existingFiles:totalFiles,input:input()}),{code:'ASSET_LIMIT'});
 assert.deepEqual(await readFile(join(f.sourceDir,MANAGED_ASSET_PATH)),f.base);
});
