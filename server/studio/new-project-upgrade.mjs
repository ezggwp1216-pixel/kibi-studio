// Pure diff for a hash-pinned public Studio program. The installer, rather than
// these text anchors, authorizes the input. Never run it against arbitrary code.
const fail=code=>Object.assign(new Error(code),{code});
const marker='// KIBI_NEW_PROJECT_READINESS_V1';
const revision=" const toolsetRevision=sha256(JSON.stringify({tools:dynamicTools,instructions:developerText}));\n";
const explain=`   const explainCheck=result=>{
    const image=previewState?.sourceHash===current.sourceHash&&previewState.rendered!==false&&!previewState.diagnostics?.error&&!previewState.diagnostics?.retainedLastGood;
    const report={...result,nativePassed:checks.passed===true,readiness:summarizeProjectReadiness({sourcePassed:checks.passed===true,implementationRequested:current.implementationRequested===true,approved:current.implementationRequested===true||current.approvedDesignRevision===current.revision,currentImage:Boolean(image),configuration:current.configuration,requirements:current.project.requirements,diagnostics:diagnostics?.sourceHash===current.sourceHash?diagnostics:null,targetPassed:current.targetDiagnostics?.status==='passed'?true:current.targetDiagnostics?.status==='failed'?false:undefined})};
    const setting=report.readiness.blockers.find(item=>item.stage==='settings'||item.stage==='service');
    return setting?{...report,nextAction:setting.message}:report;
   };\n`;
function one(source,before,after){
 if(source.split(before).length!==2)throw fail('upgrade_anchor_mismatch');
 return source.replace(before,after);
}
function replaceOnce(source,pattern,replacement){
 const matches=[...source.matchAll(pattern)];
 if(matches.length!==1)throw fail('upgrade_anchor_mismatch');
 return source.replace(pattern,replacement);
}
const rules=[
 ["import http from 'node:http';","import http from 'node:http';\nimport {summarizeProjectReadiness} from './project-readiness.mjs';"],
 [' const emit=(type,payload)=>{',revision+' const emit=(type,payload)=>{'],
 ['   let diagnostics=null;','   '+marker+'\n   let diagnostics=null;\n'+explain],
 ['if(checks.passed===true){const previousConfigurationRevision=','if(checks.passed===true&&current.implementationRequested){const previousConfigurationRevision='],
];
function decode(path,bytes){
 if(path!=='src/server.mjs')throw fail('upgrade_unknown_baseline');
 try{if(!(bytes instanceof Uint8Array))throw new TypeError();return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw fail('upgrade_invalid_program');}
}
function apply(source){
 if(source.includes(marker)||source.includes('return explainCheck(')||source.includes('const explainCheck=')||rules.some(([,after])=>source.includes(after)))throw fail('upgrade_anchor_mismatch');
 for(const[before,after]of rules)source=one(source,before,after);
 source=replaceOnce(source,/return(\{\.\.\.checks,passed:false,diagnostics,codeReady:null,nextAction:[^\n]+\});}}/g,'return explainCheck($1);}}');
 source=replaceOnce(source,/return(\{\.\.\.checks,codeReady:null(?:,[^\n]+)?\});}/g,'return explainCheck($1);}');
 source=replaceOnce(source,/return(\{\.\.\.checks,diagnostics,codeReady:ready\.codeReady,nextAction:[^\n]+\});/g,'return explainCheck($1);');
 return source;
}
export function patchNewProjectProgram(path,bytes){
 const source=decode(path,bytes);
 if(source.includes(marker)){restoreNewProjectProgram(path,bytes);return Buffer.from(bytes);}
 return Buffer.from(apply(source));
}
export function restoreNewProjectProgram(path,bytes){
 const source=decode(path,bytes);
 if(source.split(marker).length!==2||(source.match(/return explainCheck\(/g)||[]).length!==3)throw fail('upgrade_anchor_mismatch');
 let restored=source;
 restored=replaceOnce(restored,/return explainCheck\((\{\.\.\.checks,passed:false,diagnostics,codeReady:null,nextAction:[^\n]+\})\);}}/g,'return$1;}}');
 restored=replaceOnce(restored,/return explainCheck\((\{\.\.\.checks,codeReady:null(?:,[^\n]+)?\})\);}/g,'return$1;}');
 restored=replaceOnce(restored,/return explainCheck\((\{\.\.\.checks,diagnostics,codeReady:ready\.codeReady,nextAction:[^\n]+\})\);/g,'return$1;');
 for(const[before,after]of [...rules].reverse())restored=one(restored,after,before);
 if(apply(restored)!==source)throw fail('upgrade_anchor_mismatch');
 return Buffer.from(restored);
}
