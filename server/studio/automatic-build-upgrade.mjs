// Pure reversible diff for a reviewed public program. Authorization remains in
// upgradePublicProgram's SHA and canonical inverse/forward checks.
const fail=code=>Object.assign(new Error(code),{code});
const marker='\n// KIBI_AUTOMATIC_BUILD_CURRENT_WITNESS_V1\n';
const before="if(event.status==='completed'&&eventStore===store&&!projectChanging&&intent.epoch===projectEpoch&&current.codeReady&&witnessedTurn(eventStore,event,current,intent.readyVersion)&&current.configuration.revision===intent.configurationRevision)";
const after="if(event.status==='completed'&&eventStore===store&&!projectChanging&&intent.epoch===projectEpoch&&current.codeReady&&witnessedTurn(eventStore,event,current,intent.readyVersion))";
function decode(path,bytes){
 if(path!=='src/server.mjs')throw fail('upgrade_unknown_baseline');
 try{if(!(bytes instanceof Uint8Array))throw new TypeError();return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw fail('upgrade_invalid_program');}
}
function one(source,from,to){
 if(source.split(from).length!==2)throw fail('upgrade_anchor_mismatch');
 return source.replace(from,to);
}
function apply(source){
 if(source.includes(marker.trim())||source.includes(after))throw fail('upgrade_anchor_mismatch');
 return one(source,before,after)+marker;
}
export function patchAutomaticBuildProgram(path,bytes){
 const source=decode(path,bytes);
 if(source.includes(marker.trim())){restoreAutomaticBuildProgram(path,bytes);return Buffer.from(bytes);}
 return Buffer.from(apply(source));
}
export function restoreAutomaticBuildProgram(path,bytes){
 const source=decode(path,bytes);
 if(!source.endsWith(marker)||source.split(marker.trim()).length!==2||source.includes(before))throw fail('upgrade_anchor_mismatch');
 const restored=one(source.slice(0,-marker.length),after,before);
 if(apply(restored)!==source)throw fail('upgrade_anchor_mismatch');
 return Buffer.from(restored);
}
