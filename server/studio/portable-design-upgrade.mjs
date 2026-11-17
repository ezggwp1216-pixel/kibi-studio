// This transforms only public program text. The trusted updater must verify its
// complete known program hash before calling; anchors are not authorization.
const patches = {
 'src/project-store.mjs': [
  ["const editableCode=new Set(['app_core.h','app_feature.h']);\nconst editableDesign=new Set(['app_view.h']);", "const editableCode=new Set(['app_feature.h']);\nconst editableDesign=new Set(['app_core.h','app_view.h']);"],
  ['app_view.h may be edited for preview; app_core.h and app_feature.h require explicit design approval.', 'app_core.h (portable state/input) and app_view.h may be edited for preview; app_feature.h requires explicit design approval.'],
  ['approved()&&editableCode.has(f.path)','Boolean(state.approvedDesignHash)&&editableCode.has(f.path)'],
  ['approved()&&editableCode.has(name)','Boolean(state.approvedDesignHash)&&editableCode.has(name)'],
  ['if(!editableDesign.has(name)&&!approved())','if(!editableDesign.has(name)&&!state.approvedDesignHash)'],
  ['function view(){','const currentBuild=()=>{const job=state.build;return job&&job.sourceHash===snap.sourceHash&&job.sourceRevision===state.sourceRevision&&job.configurationRevision===state.configurationRevision?job:null;};\n function view(){'],
  ['build:publicJob(state.build)','build:publicJob(currentBuild())'],
  ['build:state.build?{id:state.build.id,status:state.build.status,sourceRevision:state.build.sourceRevision,sourceHash:state.build.sourceHash,configurationRevision:state.build.configurationRevision}:null','build:currentBuild()?{id:state.build.id,status:state.build.status,sourceRevision:state.build.sourceRevision,sourceHash:state.build.sourceHash,configurationRevision:state.build.configurationRevision}:null'],
 ],
 'src/server.mjs': [
  ['app_view.h is editable for design; app_core.h and app_feature.h require explicit design approval.', 'app_core.h (portable state/input) and app_view.h are editable for design; app_feature.h requires explicit design approval.'],
 ],
};
const failure = (code, path) => Object.assign(new Error(code), {code, path});
const count = (source, anchor) => source.split(anchor).length - 1;

export const PORTABLE_DESIGN_INSTRUCTIONS = `During design, app_core.h (portable state/input) and app_view.h are editable. Keep UI hit regions and state transitions aligned with the rendered controls and test them in native preview. app_feature.h requires explicit design approval. The explicit implementation request remains valid after later application source edits, while those edits still invalidate previous checks and builds. Portable preview must not start hardware, network or audio work; simulated states are not evidence of a live service. Protected SDK/adapters, credentials, build and USB installation retain their existing controls.`;

export function patchPortableDesignProgram(path, bytes) {
 if (!Object.hasOwn(patches, path)) throw failure('upgrade_unknown_baseline', path);
 let source;
 try {
  if (!(bytes instanceof Uint8Array)) throw new TypeError();
  source = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(bytes);
 } catch { throw failure('upgrade_invalid_program', path); }
 const rules=patches[path];
 const before=rules.every(([oldText,newText])=>count(source,oldText)===1 && count(source,newText)===0);
 const after=rules.every(([oldText,newText])=>count(source,oldText)===count(newText,oldText) && count(source,newText)===1);
 if (!before && !after) throw failure('upgrade_anchor_mismatch', path);
 if (before) for (const [oldText,newText] of rules) source=source.replace(oldText,newText);
 return Buffer.from(source);
}

export function restorePortableDesignProgram(path,bytes){
 if (!Object.hasOwn(patches,path)) throw failure('upgrade_unknown_baseline',path);
 let source;
 try{if(!(bytes instanceof Uint8Array))throw new TypeError();source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw failure('upgrade_invalid_program',path);}
 const original=source,rules=patches[path];
 if(!rules.every(([oldText,newText])=>count(source,oldText)===count(newText,oldText) && count(source,newText)===1))throw failure('upgrade_anchor_mismatch',path);
 for(const [oldText,newText] of [...rules].reverse())source=source.replace(newText,oldText);
 const restored=Buffer.from(source);
 if(!patchPortableDesignProgram(path,restored).equals(Buffer.from(original)))throw failure('upgrade_anchor_mismatch',path);
 return restored;
}
