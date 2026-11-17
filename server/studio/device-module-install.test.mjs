import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {installPublicDeviceModule as installRaw} from './device-module-install.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const files=['kibi_xiaozhi_core.h','kibi_xiaozhi_client.h'].map((path,i)=>({path,content:`#pragma once\nnamespace Test${i} {}\n`})).map(f=>({...f,sha256:sha(f.content)}));
const dependencies=['wifi.h','http_json.h','audio_codec_power.h','server_transport.h','power_management.h'].map(path=>({path,bytes:1,sha256:'a'.repeat(64)}));
const manifest={schemaVersion:1,id:'xiaozhi',files:files.map(f=>({path:f.path,bytes:Buffer.byteLength(f.content),sha256:f.sha256})),dependencies:dependencies.map(f=>({path:f.path,sha256:[f.sha256]}))};
const installPublicDeviceModule=options=>installRaw({...options,existingFiles:[...dependencies,...options.existingFiles]});
async function fixture(t){const parent=await realpath(await mkdtemp(join(tmpdir(),'kibi-module-install-'))),sourceDir=join(parent,'firmware');await mkdir(sourceDir);t.after(()=>rm(parent,{recursive:true,force:true}));return{parent,sourceDir};}
const input=()=>({id:'xiaozhi',files:structuredClone(files),assertProjectCurrent:()=>{}});

test('verified module installs atomically and returns protection hashes; repeating keeps exact files',async t=>{
 const {sourceDir}=await fixture(t);
 const result=await installPublicDeviceModule({sourceDir,existingFiles:[],input:input(),manifest});
 assert.equal(result.changed,true);assert.deepEqual(result.paths,files.map(f=>f.path));
 for(const f of files){assert.equal(await readFile(join(sourceDir,f.path),'utf8'),f.content);assert.equal(result.hashes[f.path],f.sha256);}
 const again=await installPublicDeviceModule({sourceDir,existingFiles:files.map(f=>({...f,bytes:Buffer.byteLength(f.content)})),input:input(),manifest});
 assert.equal(again.changed,false);
});
test('unknown project code or modified payload is preserved and rejected',async t=>{
 const {sourceDir}=await fixture(t);await writeFile(join(sourceDir,files[0].path),'// user modification');
 await assert.rejects(installPublicDeviceModule({sourceDir,existingFiles:[{path:files[0].path,bytes:20,sha256:sha('// user modification')}],input:input(),manifest}),{code:'MODULE_CONFLICT'});
 assert.equal(await readFile(join(sourceDir,files[0].path),'utf8'),'// user modification');
 const changed=input();changed.files[1].content+='\n// changed';
 await assert.rejects(installPublicDeviceModule({sourceDir,existingFiles:[],input:changed,manifest}),{code:'MODULE_PAYLOAD'});
});
test('project cancellation rolls back only newly committed module files',async t=>{
 const {sourceDir,parent}=await fixture(t);let calls=0;const value=input();
 value.assertProjectCurrent=async()=>{if(++calls===4)throw Object.assign(new Error('changed'),{code:'PROJECT_CHANGED'});};
 await assert.rejects(installPublicDeviceModule({sourceDir,existingFiles:[],input:value,manifest}),{code:'PROJECT_CHANGED'});
 assert.deepEqual(await readdir(sourceDir),[]);assert.deepEqual(await readdir(parent),['firmware']);
});
test('symlink destination and aggregate limits are rejected without installation',async t=>{
 const {sourceDir,parent}=await fixture(t),outside=join(parent,'outside');await writeFile(outside,'kept');await symlink(outside,join(sourceDir,files[0].path));
 await assert.rejects(installPublicDeviceModule({sourceDir,existingFiles:[],input:input(),manifest}),{code:'MODULE_BOUNDARY'});
 assert.equal(await readFile(outside,'utf8'),'kept');
 await assert.rejects(installPublicDeviceModule({sourceDir,existingFiles:Array.from({length:96},(_,i)=>({path:`p${i}.h`,bytes:1,sha256:'a'.repeat(64)})),input:input(),manifest}),{code:'MODULE_LIMIT'});
});

test('the transaction rechecks SDK dependency hashes before installing the reviewed module',async t=>{
 const {sourceDir}=await fixture(t),incompatible=structuredClone(manifest);incompatible.dependencies[0].sha256=['b'.repeat(64)];
 await assert.rejects(installPublicDeviceModule({sourceDir,existingFiles:[],input:input(),manifest:incompatible}),{code:'MODULE_SDK_INCOMPATIBLE'});
 assert.deepEqual(await readdir(sourceDir),[]);
});
