import test from 'node:test';
import assert from 'node:assert/strict';
import {patchNewProjectProgram,restoreNewProjectProgram} from './new-project-upgrade.mjs';
import {summarizeProjectReadiness} from './project-readiness.mjs';

const source=`import http from 'node:http';
const sha256=s=>'hash:'+s;
export const dynamicTools=[];
const toolsetRevision=sha256(JSON.stringify(dynamicTools));
export function create(developerText){
 const platform={};
 const emit=(type,payload)=>{
  return {type,payload};
 };
 return {revision:toolsetRevision,emit};
}
export async function check({checks,current,previewState,serviceCheck,checkStore,turnGuard,settingsOrServiceBlock,announce,invalidServiceContract,ready,autoIntent,summarizeProjectReadiness}){
   let diagnostics=null;
   if(checks.passed===true){const previousConfigurationRevision=current.configuration.revision,checked=await serviceCheck(checkStore,current,{repair:true,guard:turnGuard});turnGuard();diagnostics=checked.report;current=checked.current;
    if(await settingsOrServiceBlock(checkStore,current,diagnostics)){await announce();return{...checks,passed:false,diagnostics,codeReady:null,nextAction:invalidServiceContract(diagnostics)?'contract':'settings'};}}
   const currentImage=previewState?.sourceHash===current.sourceHash;
   if(checks.passed!==true||!current.implementationRequested||!currentImage){return{...checks,codeReady:null};}
   return{...checks,diagnostics,codeReady:ready.codeReady,nextAction:autoIntent?'automatic':'manual'};
}
`;

test('instruction-only changes produce distinct resumed-thread identities',async()=>{
 const patched=patchNewProjectProgram('src/server.mjs',Buffer.from(source)).toString();
 const js=patched.replace(/import .*?;\n/g,'');
 const module=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
 assert.notEqual(module.create('old instructions').revision,module.create('new instructions').revision);
 assert.equal(module.create('same').revision,module.create('same').revision);
});

test('design checks do not probe configured providers and all results expose native/readiness evidence',()=>{
 const patched=patchNewProjectProgram('src/server.mjs',Buffer.from(source)).toString();
 assert.match(patched,/if\(checks\.passed===true&&current\.implementationRequested\)/);
 assert.match(patched,/const explainCheck=/);
 assert.match(patched,/nativePassed:checks\.passed===true/);
 assert.match(patched,/readiness:summarizeProjectReadiness/);
 assert.equal((patched.match(/return explainCheck\(/g)||[]).length,3);
});

test('new-project patch is idempotent and rejects missing, duplicated or unrelated input',()=>{
 const once=patchNewProjectProgram('src/server.mjs',Buffer.from(source));
 assert.deepEqual(patchNewProjectProgram('src/server.mjs',once),once);
 assert.throws(()=>patchNewProjectProgram('src/server.mjs',Buffer.from(source+source)),{code:'upgrade_anchor_mismatch'});
 assert.throws(()=>patchNewProjectProgram('src/server.mjs',Buffer.from(source.replace('let diagnostics=null;','let changed=null;'))),{code:'upgrade_anchor_mismatch'});
 assert.throws(()=>patchNewProjectProgram('projects/app_feature.h',Buffer.from(source)),{code:'upgrade_unknown_baseline'});
});

test('an offline design runs only native checks; implementation names missing Wi-Fi without hiding native success',async()=>{
 const patched=patchNewProjectProgram('src/server.mjs',Buffer.from(source)).toString().replace(/import .*?;\n/g,'');
 const module=await import('data:text/javascript;base64,'+Buffer.from(patched).toString('base64'));
 let probes=0;
 const current={sourceHash:'current',revision:2,approvedDesignRevision:null,implementationRequested:false,configuration:{revision:1,wifiConfigured:false,apiConfigured:false},project:{requirements:{wifi:true,api:false}}};
 const values={checks:{passed:true,checks:[{id:'native',passed:true}]},current,previewState:{sourceHash:'current'},serviceCheck:async()=>{probes++;return{current,report:{status:'not_required',checks:[],configurationRevision:1,sourceHash:'current'}};},checkStore:{},turnGuard:()=>{},settingsOrServiceBlock:async()=>true,announce:async()=>{},invalidServiceContract:()=>false,ready:{codeReady:{sourceHash:'current'}},autoIntent:null,summarizeProjectReadiness};
 const design=await module.check(values);
 assert.equal(probes,0,'mockup checks must not contact a configured provider');
 assert.equal(design.nativePassed,true);assert.equal(design.readiness.passed,true);
 assert.equal(design.readiness.phase,'design');assert.equal(design.readiness.stages.settings,'pending');
 current.implementationRequested=true;
 const implementation=await module.check(values);
 assert.equal(probes,1);assert.equal(implementation.nativePassed,true);assert.equal(implementation.passed,false);
 assert.ok(implementation.readiness.blockers.some(b=>b.code==='wifi_not_configured'));
 assert.equal(implementation.nextAction,'Добавьте Wi-Fi в настройках проекта.');
 assert.equal(implementation.readiness.stages.design,'passed','explicit implementation request permits the implementation iterations');
});

test('readiness inverse restores all exact legacy return expressions and unrelated UTF-8 bytes',()=>{
 const original=Buffer.from('\ufeff// Независимый публичный текст\n'+source),final=patchNewProjectProgram('src/server.mjs',original);
 assert.deepEqual(restoreNewProjectProgram('src/server.mjs',final),original);
 assert.deepEqual(patchNewProjectProgram('src/server.mjs',restoreNewProjectProgram('src/server.mjs',final)),final);
 assert.throws(()=>restoreNewProjectProgram('src/server.mjs',original),{code:'upgrade_anchor_mismatch'});
 for(const invalid of [Buffer.concat([final,final]),Buffer.from(final.toString().replace('current.implementationRequested){const previousConfigurationRevision=','true){const previousConfigurationRevision=')),Buffer.from(final.toString().replace('return explainCheck({...checks,codeReady:null});','return {...checks,codeReady:null};'))])assert.throws(()=>restoreNewProjectProgram('src/server.mjs',invalid),{code:'upgrade_anchor_mismatch'});
 assert.throws(()=>restoreNewProjectProgram('src/project-store.mjs',final),{code:'upgrade_unknown_baseline'});
});
