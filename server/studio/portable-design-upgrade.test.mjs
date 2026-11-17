import test from 'node:test';
import assert from 'node:assert/strict';
import {patchPortableDesignProgram,restorePortableDesignProgram} from './portable-design-upgrade.mjs';

const storeSource = `const editableCode=new Set(['app_core.h','app_feature.h']);
const editableDesign=new Set(['app_view.h']);
const rules='app_view.h may be edited for preview; app_core.h and app_feature.h require explicit design approval.';
const state={approvedDesignHash:null,sourceHash:'design-v1',sourceRevision:1,configurationRevision:0,codeReady:null,build:null};
const snap={sourceHash:state.sourceHash};
const publicJob=job=>job?structuredClone(job):null;
function view(){return{build:publicJob(state.build)};}
export function agentBuild(){return{build:state.build?{id:state.build.id,status:state.build.status,sourceRevision:state.build.sourceRevision,sourceHash:state.build.sourceHash,configurationRevision:state.build.configurationRevision}:null};}
export function publicState(){return view();}
export function seedBuild(){state.build={id:'prior-build',status:'succeeded',sourceRevision:state.sourceRevision,sourceHash:snap.sourceHash,configurationRevision:state.configurationRevision,artifacts:[{name:'synthetic.bin'}]};}
export function advanceSource(){state.sourceRevision++;state.sourceHash='changed-source';snap.sourceHash=state.sourceHash;}
export function advanceConfiguration(){state.configurationRevision++;}
export function getBuild(){return state.build;}
const approved=()=>state.approvedDesignHash===state.sourceHash;
export function canEditField(name){return editableDesign.has(name)||(approved()&&editableCode.has(name));}
export function contextField(f){return editableDesign.has(f.path)||(approved()&&editableCode.has(f.path));}
export function writeField(name){if(!editableDesign.has(name)&&!approved())throw Error('design approval required');return name;}
export function requestImplementation(){state.approvedDesignHash=state.sourceHash;state.codeReady=true;state.build='old-build';}
export function changeView(){state.sourceHash='design-v2';state.codeReady=null;state.build=null;}
export function snapshot(){return {...state};}
export function canEdit(name,{approved=false,implementingApprovedDesign=false}={}) {
 return editableDesign.has(name) || ((approved || implementingApprovedDesign) && editableCode.has(name));
}
export {rules};
`;
const serverSource = `export const sourceTool={description:'app_view.h is editable for design; app_core.h and app_feature.h require explicit design approval.'};\n`;
const load = source => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('portable UI input and view can change before approval while device feature remains gated', async () => {
 const patched=patchPortableDesignProgram('src/project-store.mjs',Buffer.from(storeSource));
 const store=await load(patched);
 for(const name of ['app_core.h','app_view.h'])assert.equal(store.canEdit(name),true,name);
 assert.equal(store.canEdit('app_feature.h'),false);
 for(const name of ['Feature.h','project.ino','audio_codec_power.h','../app_core.h']) {
  assert.equal(store.canEdit(name),false,name);
  assert.equal(store.canEdit(name,{approved:true}),false,name);
 }
 assert.equal(store.canEdit('app_feature.h',{approved:true}),true);
 assert.equal(store.canEdit('app_feature.h',{implementingApprovedDesign:true}),true,'existing implementation transition stays supported');
 assert.match(store.rules,/app_core\.h.*portable state\/input/);
 assert.match(store.rules,/app_feature\.h requires explicit design approval/);
 assert.doesNotMatch(store.rules,/app_core\.h and app_feature\.h require/);
});

test('source tool description agrees with portable editing policy', async () => {
 const server=await load(patchPortableDesignProgram('src/server.mjs',Buffer.from(serverSource)));
 assert.match(server.sourceTool.description,/app_core\.h.*portable state\/input/);
 assert.match(server.sourceTool.description,/app_view\.h are editable for design/);
 assert.match(server.sourceTool.description,/app_feature\.h requires explicit design approval/);
});

test('an explicit implementation request keeps the feature editable after a later view edit',async()=>{
 const store=await load(patchPortableDesignProgram('src/project-store.mjs',Buffer.from(storeSource)));
 assert.equal(store.canEditField('app_feature.h'),false);assert.equal(store.contextField({path:'app_feature.h'}),false);
 assert.throws(()=>store.writeField('app_feature.h'),/design approval required/);
 store.requestImplementation();assert.equal(store.canEditField('app_feature.h'),true);
 store.changeView();assert.equal(store.snapshot().approvedDesignHash,'design-v1');assert.equal(store.snapshot().sourceHash,'design-v2');
 assert.equal(store.canEditField('app_feature.h'),true);assert.equal(store.contextField({path:'app_feature.h'}),true);assert.equal(store.writeField('app_feature.h'),'app_feature.h');
 assert.equal(store.snapshot().codeReady,null);assert.equal(store.snapshot().build,null,'source changes still invalidate old checks and builds');
 assert.equal(store.canEditField('audio_codec_power.h'),false);assert.equal(store.contextField({path:'Feature.h'}),false);
});

test('public state and agent context hide stale source/configuration builds while internal ownership history is retained',async()=>{
 for(const change of ['advanceSource','advanceConfiguration']){
  const store=await load(patchPortableDesignProgram('src/project-store.mjs',Buffer.from(storeSource+'\n// '+change)));
  store.seedBuild();assert.equal(store.publicState().build?.id,'prior-build');assert.equal(store.agentBuild().build?.id,'prior-build');
  store[change]();assert.equal(store.publicState().build,null,change);assert.equal(store.agentBuild().build,null,change);
  assert.equal(store.getBuild()?.id,'prior-build');assert.equal(store.getBuild()?.artifacts[0].name,'synthetic.bin','private controller cleanup/history is preserved');
 }
});

test('a complete patched program is idempotent and unrelated code is preserved byte for byte', () => {
 const sentinel='// implementingApprovedDesign and other unrelated code stay unchanged\n';
 for(const [path,source] of [['src/project-store.mjs',storeSource],['src/server.mjs',serverSource]]) {
  const original=Buffer.from(source+sentinel),once=patchPortableDesignProgram(path,original);
  const twice=patchPortableDesignProgram(path,once);
  assert.deepEqual(twice,once);
  assert.equal(once.toString().endsWith(sentinel),true);
  assert.deepEqual(original,Buffer.from(source+sentinel),'does not mutate supplied bytes');
 }
});

test('valid UTF-8 framing outside patch anchors is preserved', () => {
 const source=Buffer.from('\ufeff// Экран Киби\n'+serverSource);
 const patched=patchPortableDesignProgram('src/server.mjs',source);
 assert.equal(patched.toString().startsWith('\ufeff// Экран Киби\n'),true);
 assert.deepEqual(patchPortableDesignProgram('src/server.mjs',patched),patched);
});

test('missing, duplicate, mixed and malformed program anchors are rejected without mutation', () => {
 const cases=[
  ['src/project-store.mjs',storeSource.replace("const editableDesign=new Set(['app_view.h']);",'const changed=true;')],
  ['src/project-store.mjs',storeSource+"\nconst editableCode=new Set(['app_core.h','app_feature.h']);\nconst editableDesign=new Set(['app_view.h']);"],
  ['src/project-store.mjs',storeSource.replace("const editableCode=new Set(['app_core.h','app_feature.h']);\nconst editableDesign=new Set(['app_view.h']);","const editableCode=new Set(['app_feature.h']);\nconst editableDesign=new Set(['app_core.h','app_view.h']);")],
  ['src/server.mjs',serverSource.replace('app_view.h is editable','app_view.h was editable')],
  ['src/server.mjs',serverSource+serverSource],
 ];
 for(const [path,source] of cases) {
  const input=Buffer.from(source),snapshot=Buffer.from(input);
  assert.throws(()=>patchPortableDesignProgram(path,input),{code:'upgrade_anchor_mismatch'});
  assert.deepEqual(input,snapshot);
 }
 assert.throws(()=>patchPortableDesignProgram('src/server.mjs',Buffer.from([0xff])),{code:'upgrade_invalid_program'});
});

test('only the exact two public program paths are supported', () => {
 for(const path of ['prompts/agent-system.md','app_core.h','../src/server.mjs','/tmp/src/server.mjs']) {
  assert.throws(()=>patchPortableDesignProgram(path,Buffer.from(serverSource)),{code:'upgrade_unknown_baseline'});
 }
});

test('portable-design inverse restores the entire exact legacy program and rejects partial final programs',()=>{
 for(const [path,source] of [['src/project-store.mjs',storeSource],['src/server.mjs',serverSource]]){
  const original=Buffer.from('\ufeff// Unrelated public program text\n'+source),final=patchPortableDesignProgram(path,original);
  assert.deepEqual(restorePortableDesignProgram(path,final),original);
  assert.deepEqual(patchPortableDesignProgram(path,restorePortableDesignProgram(path,final)),final);
  assert.throws(()=>restorePortableDesignProgram(path,original),{code:'upgrade_anchor_mismatch'});
  assert.throws(()=>restorePortableDesignProgram(path,Buffer.concat([final,final])),{code:'upgrade_anchor_mismatch'});
 }
 const final=patchPortableDesignProgram('src/project-store.mjs',Buffer.from(storeSource)).toString();
 assert.throws(()=>restorePortableDesignProgram('src/project-store.mjs',Buffer.from(final.replace('Boolean(state.approvedDesignHash)&&editableCode.has(name)','approved()&&editableCode.has(name)'))),{code:'upgrade_anchor_mismatch'});
 assert.throws(()=>restorePortableDesignProgram('projects/source.h',Buffer.from(final)),{code:'upgrade_unknown_baseline'});
});
