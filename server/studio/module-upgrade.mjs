const fail=code=>Object.assign(new Error(code),{code});
const marker='// KIBI_DEVICE_MODULE_DELIVERY_V1';
const method=`  installPublicDeviceModule:(input,guard=()=>{})=>transaction(async()=>{
   await guard();if(input?.expectedProjectId!==projectId)throw problem('Активный проект изменился.',409);
   const installed=await installPublicDeviceModule({sourceDir,existingFiles:snap.files,input,guard});
   Object.assign(state.protectedHashes,installed.hashes);state.approvedDesignHash=null;state.codeReady=null;state.build=null;await refresh();
   return installed;
  }),
`;
const patches={
 'src/project-store.mjs':[
  ["import path from 'node:path';","import path from 'node:path';\nimport {installPublicDeviceModule} from './device-module-install.mjs';"],
  ['if(files.length>=63||bytes>4*1024*1024)','if(files.length>=96||bytes>4*1024*1024)'],
  ['  installPublicAssets:(input,guard=()=>{})=>transaction(async()=>{',method+'  installPublicAssets:(input,guard=()=>{})=>transaction(async()=>{'],
 ],
 'native/support.mjs':[
  ['if(files.length>63||total>4*1024*1024)','if(files.length>96||total>4*1024*1024)'],
  ['Public source exceeds 63-file / 4MiB limit','Public source exceeds 96-file / 4MiB limit'],
 ],
 'src/source-zip.mjs':[['maxFiles=64,maxBytes=4*1024*1024','maxFiles=96,maxBytes=4*1024*1024']],
};
function decode(path,bytes){
 if(!Object.hasOwn(patches,path))throw fail('upgrade_unknown_baseline');
 try{if(!(bytes instanceof Uint8Array))throw new TypeError();return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw fail('upgrade_invalid_program');}
}
function apply(path,source){
 const rules=patches[path];
 if(source.includes(marker)||rules.some(([,after])=>source.includes(after)))throw fail('upgrade_anchor_mismatch');
 for(const [before,after]of rules){if(source.split(before).length!==2)throw fail('upgrade_anchor_mismatch');source=source.replace(before,after);}
 return source+'\n'+marker+'\n';
}
export function patchDeviceModuleProgram(path,bytes){
 const source=decode(path,bytes);
 if(source.includes(marker)){restoreDeviceModuleProgram(path,bytes);return Buffer.from(bytes);}
 return Buffer.from(apply(path,source));
}
export function restoreDeviceModuleProgram(path,bytes){
 const source=decode(path,bytes),suffix='\n'+marker+'\n';
 if(source.split(marker).length!==2||!source.endsWith(suffix))throw fail('upgrade_anchor_mismatch');
 let restored=source.slice(0,-suffix.length);
 for(const [before,after] of [...patches[path]].reverse()){
  if(restored.split(after).length!==2)throw fail('upgrade_anchor_mismatch');
  restored=restored.replace(after,before);
 }
 if(apply(path,restored)!==source)throw fail('upgrade_anchor_mismatch');
 return Buffer.from(restored);
}
