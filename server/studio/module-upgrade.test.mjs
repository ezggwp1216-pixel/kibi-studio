import test from 'node:test';
import assert from 'node:assert/strict';
import {patchDeviceModuleProgram,restoreDeviceModuleProgram} from './module-upgrade.mjs';
const load=bytes=>import('data:text/javascript;base64,'+Buffer.from(bytes).toString('base64'));
const sources={
 'src/project-store.mjs':`import path from 'node:path';
export function accepts(files,bytes=0){if(files.length>=63||bytes>4*1024*1024)throw Error('limit');return true;}
export function create({transaction,projectId,sourceDir,snap,state,refresh,installPublicDeviceModule}){return{
  installPublicAssets:(input,guard=()=>{})=>transaction(async()=>{}),
};}
`,
 'native/support.mjs':`export function accepts(files,total=0){if(files.length>63||total>4*1024*1024)throw new Error('Public source exceeds 63-file / 4MiB limit');return true;}`,
 'src/source-zip.mjs':`export function encodeZip(files,{maxFiles=64,maxBytes=4*1024*1024}={}){if(files.length>maxFiles)throw Error('limit');return files.length;}`,
};
test('two module headers fit beside the stock source set while byte and file bounds remain finite',async()=>{
 for(const path of Object.keys(sources)){
  const transformed=patchDeviceModuleProgram(path,Buffer.from(sources[path])).toString().replace(/import .*?;\n/g,'');
  const module=await load(transformed);
  const accept=path.endsWith('source-zip.mjs')?module.encodeZip:module.accepts;
  assert.doesNotThrow(()=>accept(Array(65)));
  assert.throws(()=>accept(Array(97)),/limit/);
  if(module.accepts)assert.throws(()=>accept([],4*1024*1024+1),/limit/);
 }
});
test('module installation joins the project transaction, protects headers and invalidates prior artifacts',async()=>{
 const transformed=patchDeviceModuleProgram('src/project-store.mjs',Buffer.from(sources['src/project-store.mjs'])).toString().replace(/import .*?;\n/g,'');
 const module=await load(transformed),calls=[],state={protectedHashes:{stock:'kept'},approvedDesignHash:'old',codeReady:{},build:{}};
 const store=module.create({transaction:fn=>fn(),projectId:'fixture',sourceDir:'/synthetic',snap:{files:[]},state,refresh:async()=>calls.push('refresh'),installPublicDeviceModule:async()=>{calls.push('install');return{hashes:{'kibi_xiaozhi_core.h':'hash'},paths:['kibi_xiaozhi_core.h'],changed:true};}});
 await store.installPublicDeviceModule({expectedProjectId:'fixture'});
 assert.deepEqual(calls,['install','refresh']);assert.equal(state.protectedHashes.stock,'kept');assert.equal(state.protectedHashes['kibi_xiaozhi_core.h'],'hash');
 assert.equal(state.approvedDesignHash,null);assert.equal(state.codeReady,null);assert.equal(state.build,null);
 await assert.rejects(store.installPublicDeviceModule({expectedProjectId:'other'}));
});
test('module program transformations are idempotent and refuse missing or duplicated anchors',()=>{
 for(const path of Object.keys(sources)){
  const once=patchDeviceModuleProgram(path,Buffer.from(sources[path]));assert.deepEqual(patchDeviceModuleProgram(path,once),once);
  assert.throws(()=>patchDeviceModuleProgram(path,Buffer.from(sources[path]+sources[path])),{code:'upgrade_anchor_mismatch'});
 }
 assert.throws(()=>patchDeviceModuleProgram('projects/firmware.h',Buffer.from('')), {code:'upgrade_unknown_baseline'});
});

test('module inverse restores exact legacy bytes for store, native and ZIP and rejects partial markers',()=>{
 for(const [path,source] of Object.entries(sources)){
  const original=Buffer.from('\ufeff// Public boundary\n'+source),final=patchDeviceModuleProgram(path,original);
  assert.deepEqual(restoreDeviceModuleProgram(path,final),original);
  assert.deepEqual(patchDeviceModuleProgram(path,restoreDeviceModuleProgram(path,final)),final);
  assert.throws(()=>restoreDeviceModuleProgram(path,original),{code:'upgrade_anchor_mismatch'});
  assert.throws(()=>restoreDeviceModuleProgram(path,Buffer.concat([final,final])),{code:'upgrade_anchor_mismatch'});
  assert.throws(()=>restoreDeviceModuleProgram(path,Buffer.from(final.toString().replace('// KIBI_DEVICE_MODULE_DELIVERY_V1','// Missing marker'))),{code:'upgrade_anchor_mismatch'});
 }
 const final=patchDeviceModuleProgram('src/project-store.mjs',Buffer.from(sources['src/project-store.mjs'])).toString();
 assert.throws(()=>restoreDeviceModuleProgram('src/project-store.mjs',Buffer.from(final.replace('if(files.length>=96||bytes>4*1024*1024)','if(files.length>=63||bytes>4*1024*1024)'))),{code:'upgrade_anchor_mismatch'});
});
