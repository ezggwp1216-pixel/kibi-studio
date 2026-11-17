import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rename,rm,mkdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import * as upgrader from './upgrade.mjs';
import {PUBLIC_STUDIO_BASELINES,patchThreadToolsetProgram,upgradePublicProgram} from './upgrade.mjs';
import {restorePortableDesignProgram} from './portable-design-upgrade.mjs';
import {restoreNewProjectProgram} from './new-project-upgrade.mjs';
import {restoreDeviceModuleProgram} from './module-upgrade.mjs';
import {restoreAutomaticBuildProgram} from './automatic-build-upgrade.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const load=source=>import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const storeFixture=`const api={
  getThreadId:()=>state.threadId,
  setThreadId:threadId=>transaction(()=>{state.threadId=threadId;chat.threadId=threadId;}),
};`;
const serverFixture=`export const dynamicTools=[
 ...platformTools,
 {type:'function',name:'kibi_project_context',inputSchema:{type:'object'}}
];
const MIME={};
async function repair(){
 const info=await bridge.send({threadId:buildStore.getThreadId()||undefined,dynamicTools});
 await buildStore.setThreadId(info.threadId);
}
async function send(){
 const info=await bridge.send({threadId:store.getThreadId()||undefined,dynamicTools});
 await store.setThreadId(info.threadId);
}`;

test('toolset migration replaces an obsolete thread once and preserves persisted project state',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kibi-toolset-state-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const stateFile=join(root,'state.json'),original={threadId:'old-thread',messages:[{role:'user',text:'Сохрани приложение'}],sourceHash:'source-kept',sourceRevision:27,configurationRevision:3,approvedDesignHash:'approved-kept',custom:{kept:true}};
 await writeFile(stateFile,JSON.stringify(original));
 const patched=patchThreadToolsetProgram('src/project-store.mjs',Buffer.from(storeFixture)).toString();
 const module=await load(`export function create(state,chat,transaction){${patched}\nreturn api;}`);
 async function reopen(){
  const state=JSON.parse(await readFile(stateFile,'utf8')),chat={threadId:state.threadId};let tail=Promise.resolve();
  const transaction=fn=>{const job=tail.then(async()=>{const result=await fn();const temp=stateFile+'.tmp';await writeFile(temp,JSON.stringify(state));await rename(temp,stateFile);return result;});tail=job.catch(()=>{});return job;};
  return {api:module.create(state,chat,transaction),state,chat};
 }
 let current=await reopen();
 assert.equal(current.api.getThreadId(),'old-thread');
 assert.equal(current.api.getThreadId('tools-v2'),null,'unversioned old state must start a fresh thread');
 assert.deepEqual(JSON.parse(await readFile(stateFile,'utf8')),original,'reading does not erase the old state');
 await current.api.setThreadId('new-thread','tools-v2');
 assert.equal(current.api.getThreadId('tools-v2'),'new-thread');
 assert.equal(current.api.getThreadId('tools-v3'),null);
 assert.equal(current.chat.threadId,'new-thread');
 current=await reopen();
 assert.equal(current.api.getThreadId('tools-v2'),'new-thread','restart resumes the already migrated thread');
 const saved=JSON.parse(await readFile(stateFile,'utf8'));
 assert.deepEqual(saved,{...original,threadId:'new-thread',threadToolsetRevision:'tools-v2'});
 await current.api.setThreadId('legacy-thread');
 assert.equal(current.api.getThreadId(),'legacy-thread','legacy callers retain the unversioned contract');
 assert.equal(current.api.getThreadId('tools-v2'),null,'unversioned replacement cannot inherit an old toolset attestation');
 const legacy=JSON.parse(await readFile(stateFile,'utf8'));
 assert.deepEqual(legacy,{...original,threadId:'legacy-thread'});
});

test('both chat and build-repair sends use the complete current dynamic toolset revision',async()=>{
 const patched=patchThreadToolsetProgram('src/server.mjs',Buffer.from(serverFixture)).toString();
 const source=`export function create({platformTools,sha256,store,buildStore,bridge}){${patched.replace('export const dynamicTools','const dynamicTools')}\nreturn {send,repair,toolsetRevision,dynamicTools};}`;
 const module=await load(source),sends=[],saved=[];let threadId='existing-thread',threadRevision='saved-revision';
 const revisionStore={getThreadId:revision=>revision===threadRevision?threadId:null,setThreadId:async(id,revision)=>{saved.push({id,revision});threadId=id;threadRevision=revision;}};
 const platformTools=[{type:'function',name:'kibi_device_diagnostics',description:'Read only',inputSchema:{type:'object',properties:{deviceId:{type:'string'}},required:['deviceId'],additionalProperties:false}}];
 const app=module.create({platformTools,sha256:hash,store:revisionStore,buildStore:revisionStore,bridge:{send:async input=>{sends.push(input);return{threadId:'fresh-thread'};}}});
 await app.send();await app.repair();
 assert.equal(app.toolsetRevision,hash(JSON.stringify(app.dynamicTools)));
 assert.equal(sends.length,2);assert.equal(sends[0].threadId,undefined);assert.equal(sends[1].threadId,'fresh-thread','build repair resumes the already migrated thread');
 assert.deepEqual(saved,[{id:'fresh-thread',revision:app.toolsetRevision},{id:'fresh-thread',revision:app.toolsetRevision}]);
 const changed=module.create({platformTools:[{...platformTools[0],description:'Changed instructions'}],sha256:hash,store:revisionStore,buildStore:revisionStore,bridge:{}});
 assert.notEqual(changed.toolsetRevision,app.toolsetRevision,'description/schema changes also invalidate a resumed toolset');
});

test('thread patch rejects missing/duplicate anchors and guarded upgrade rejects local edits',()=>{
 assert.throws(()=>patchThreadToolsetProgram('src/project-store.mjs',Buffer.from(storeFixture+storeFixture)),{code:'upgrade_anchor_mismatch'});
 assert.throws(()=>patchThreadToolsetProgram('src/server.mjs',Buffer.from(serverFixture.replace('buildStore.getThreadId()','buildStore.otherMethod()'))),{code:'upgrade_anchor_mismatch'});
 assert.throws(()=>upgradePublicProgram('src/project-store.mjs',Buffer.from(storeFixture)),{code:'upgrade_unknown_baseline'});
 assert.throws(()=>upgradePublicProgram('src/server.mjs',Buffer.from(serverFixture)),{code:'upgrade_unknown_baseline'});
});

test('release lineage includes only the explicitly reviewed standalone program variants',()=>{
 assert.equal(upgrader.REVIEWED_STUDIO_VARIANTS?.['src/server.mjs']?.includes('1c16b5af2dffdf00362b79e7425d184e28efec2b476f579d0e19e7c8dcfee2fe'),true);
 assert.equal(upgrader.REVIEWED_STUDIO_VARIANTS?.['src/project-store.mjs']?.includes('5c86c457748b342d8525eb1de24939e19a516db0ff7e987b2a9e4e4976eda188'),true);
 assert.equal(PUBLIC_STUDIO_BASELINES['src/source-zip.mjs']?.afterSha256,'fd181a3f2cd1e521f07a4439c4f370f07742031a02ab1f9e7cc8a8c799dd5525');
});

const reliabilitySources={
 'src/server.mjs':`import http from 'node:http';
const sha256=JSON.stringify;
export const dynamicTools=[];
const toolsetRevision=sha256(JSON.stringify(dynamicTools));
export function create(developerText){
 const emit=(type,payload)=>{
  return {type,payload};
 };
 const rule='app_view.h is editable for design; app_core.h and app_feature.h require explicit design approval.';
 return {emit,rule};
}
export async function check({checks,current,previewState,serviceCheck,checkStore,turnGuard,settingsOrServiceBlock,announce,invalidServiceContract,ready,autoIntent}){
   let diagnostics=null;
   if(checks.passed===true){const previousConfigurationRevision=current.configuration.revision,checked=await serviceCheck(checkStore,current,{repair:true,guard:turnGuard});turnGuard();diagnostics=checked.report;current=checked.current;
    if(await settingsOrServiceBlock(checkStore,current,diagnostics)){await announce();return{...checks,passed:false,diagnostics,codeReady:null,nextAction:invalidServiceContract(diagnostics)?'contract':'settings'};}}
   const currentImage=previewState?.sourceHash===current.sourceHash;
   if(checks.passed!==true||!current.implementationRequested||!currentImage){return{...checks,codeReady:null};}
   return{...checks,diagnostics,codeReady:ready.codeReady,nextAction:autoIntent?'automatic':'manual'};
}
const witnessedTurn=(target,event,current,version)=>{const witness=readyWitnesses.get(target.projectId);return Boolean(witness&&witness.version>version&&witness.threadId===event?.threadId&&witness.turnId===event?.turnId&&witness.sourceHash===current.sourceHash&&witness.configurationRevision===current.configuration.revision);};
export async function completed(event,eventStore){
 if(event.type==='chat.completed'&&autoIntent&&autoIntent.store===eventStore&&!building&&(!autoIntent.turnId||autoIntent.turnId===event.turnId)){
  const intent=autoIntent;autoIntent=null;const current=await eventStore.getState();
  if(event.status==='completed'&&eventStore===store&&!projectChanging&&intent.epoch===projectEpoch&&current.codeReady&&witnessedTurn(eventStore,event,current,intent.readyVersion)&&current.configuration.revision===intent.configurationRevision)await startBuild(current.revision,{automatic:true,previousTurnId:event.turnId,expectedStore:eventStore,expectedEpoch:intent.epoch});
  else if(!current.workflow||['coding','testing'].includes(current.workflow.status))await workflow(eventStore,current,'blocked','Завершите код и текущие проверки с ИИ.','ask-ai');
  await announce();
 }
}
`,
 'src/project-store.mjs':`import path from 'node:path';
const editableCode=new Set(['app_core.h','app_feature.h']);
const editableDesign=new Set(['app_view.h']);
const rule='app_view.h may be edited for preview; app_core.h and app_feature.h require explicit design approval.';
function view(){return{build:publicJob(state.build)};}
export function agentBuild(){return{build:state.build?{id:state.build.id,status:state.build.status,sourceRevision:state.build.sourceRevision,sourceHash:state.build.sourceHash,configurationRevision:state.build.configurationRevision}:null};}
export function context(f){return approved()&&editableCode.has(f.path);}
export function allowed(name){return approved()&&editableCode.has(name);}
export function write(name){if(!editableDesign.has(name)&&!approved())throw Error('approval');}
export function accepts(files,bytes=0){if(files.length>=63||bytes>4*1024*1024)throw Error('limit');}
export function create(){return{
  installPublicAssets:(input,guard=()=>{})=>transaction(async()=>{}),
};}
`,
 'native/support.mjs':`export function accepts(files,total=0){if(files.length>63||total>4*1024*1024)throw new Error('Public source exceeds 63-file / 4MiB limit');return true;}\n`,
 'src/source-zip.mjs':`export function encodeZip(files,{maxFiles=64,maxBytes=4*1024*1024}={}){return files.length;}\n`,
};
const runtimePayloads=[
 ...['studio-platform.mjs','studio-account.mjs','public-resources.mjs','managed-assets.mjs','leroyd-c309-recipe.json','png-raster.mjs','portable-design-upgrade.mjs','project-readiness.mjs','device-modules.mjs','device-modules.json','device-module-install.mjs','device-variants.mjs'].map(name=>[`studio/${name}`,`src/${name}`]),
 ...['studio-account.js','studio-account.css'].map(name=>[`studio/${name}`,`web/${name}`]),
 ['studio/local-install-source.mjs','web/local-install-source.js'],
 ...['API.md','VOICE.md','HARDWARE.md','SERVICES.md'].map(name=>[`docs/${name}`,`src/platform-guides/${name}`]),
 ...['kibi_xiaozhi_core.h','kibi_xiaozhi_client.h'].map(name=>[`sdk/device/source/${name}`,`src/device-sdk/${name}`]),
];
async function fixtureUpgrader(){
 let source=await readFile(new URL('./upgrade.mjs',import.meta.url),'utf8');
 const pins=Object.fromEntries(Object.entries(reliabilitySources).map(([path,text])=>[path,{beforeSha256:hash(text),afterSha256:hash(text)}]));
 const variants=Object.fromEntries(['src/server.mjs','src/project-store.mjs'].map(path=>[path,[hash(reliabilitySources[path]+'\n// independently reviewed synthetic variant\n')]]));
 const start='// These hashes describe public KibiVirtual-dev program files only.',end='// app-server resumes retain their original dynamic tools.';
 assert.equal(source.split(start).length,2);assert.equal(source.split(end).length,2);
 source=source.slice(0,source.indexOf(start))+`export const PUBLIC_STUDIO_BASELINES=${JSON.stringify(pins)};\nexport const REVIEWED_STUDIO_VARIANTS=${JSON.stringify(variants)};\n\n`+source.slice(source.indexOf(end));
 const rootAnchor="const DEFAULT_SOURCE = fileURLToPath(new URL('../', import.meta.url));",cliAnchor='if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {';
 assert.equal(source.split(rootAnchor).length,2);assert.equal(source.split(cliAnchor).length,2);
 source=source.replace(rootAnchor,"const DEFAULT_SOURCE='/synthetic-public-release';").replace(cliAnchor,'if (false) {');
 source=source.replace(/from '(\.\/[a-z-]+\.mjs)'/g,(_,relative)=>`from '${new URL(relative,import.meta.url).href}'`);
 return import('data:text/javascript;base64,'+Buffer.from(source+'\n//# sourceURL=kibi-upgrader-synthetic.mjs\n').toString('base64'));
}

test('composite authorization accepts exact reviewed legacy roots and only their reversible final programs',async()=>{
 const module=await fixtureUpgrader();
 for(const [path,source] of Object.entries(reliabilitySources)){
  for(const base of [source,...(module.REVIEWED_STUDIO_VARIANTS[path]?[source+'\n// independently reviewed synthetic variant\n']:[])]){
   const input=Buffer.from(base),final=module.upgradePublicProgram(path,input);
   assert.notEqual(hash(final),hash(input),path);assert.deepEqual(module.upgradePublicProgram(path,final),final,path);
   assert.throws(()=>module.upgradePublicProgram(path,Buffer.concat([input,Buffer.from('\n// unknown local edit\n')])),{code:'upgrade_unknown_baseline'});
   assert.throws(()=>module.upgradePublicProgram(path,Buffer.concat([final,Buffer.from('\n// unknown local edit\n')])),{code:'upgrade_unknown_baseline'});
   assert.throws(()=>module.upgradePublicProgram(path,Buffer.from(final.toString().replace('export','exports'))),{code:'upgrade_unknown_baseline'});
  }
 }
});

async function installFixture(t){
 const module=await fixtureUpgrader(),base=await realpath(await mkdtemp(join(tmpdir(),'kibi-r2-install-')));t.after(()=>rm(base,{recursive:true,force:true}));
 const target=join(base,'studio'),release=join(base,'release');await mkdir(target);await mkdir(release);
 for(const [path,source] of Object.entries(reliabilitySources)){await mkdir(dirname(join(target,path)),{recursive:true});await writeFile(join(target,path),source);}
 await mkdir(join(target,'web'));
 for(const [source] of runtimePayloads){await mkdir(dirname(join(release,source)),{recursive:true});await writeFile(join(release,source),source.endsWith('.json')?'{}\n':source.endsWith('.mjs')||source.endsWith('.js')?'export const publicFixture=true;\n':'Public fixture\n');}
 await mkdir(join(target,'.studio'));const canary=join(target,'.studio','private-fixture');await writeFile(canary,'SYNTHETIC PRIVATE CANARY');
 return{module,target,release,canary};
}

test('offline installer creates only explicit runtime payloads, records actual final hashes, and is idempotent',async t=>{
 const {module,target,release,canary}=await installFixture(t);
 const plan=await module.upgradeStudio({root:target,sourceRoot:release});assert.equal(plan.release,'studio-platform-2026-11-17-complete-r3');assert.equal(plan.mode,'dry-run');
 for(const [,path] of runtimePayloads)assert.ok(plan.changes.some(change=>change.path===path),path);
 const applied=await module.upgradeStudio({root:target,sourceRoot:release,apply:true});assert.equal(applied.mode,'applied');
 for(const change of applied.changes)assert.equal(hash(await readFile(join(target,change.path))),change.afterSha256,change.path);
 assert.equal((await module.upgradeStudio({root:target,sourceRoot:release,apply:true})).mode,'already-current');assert.equal(await readFile(canary,'utf8'),'SYNTHETIC PRIVATE CANARY');
 const edited=join(target,'src/server.mjs'),custom=Buffer.concat([await readFile(edited),Buffer.from('\n// unknown customization\n')]);await writeFile(edited,custom);
 await assert.rejects(module.upgradeStudio({root:target,sourceRoot:release,apply:true}),{code:'upgrade_unknown_baseline'});assert.deepEqual(await readFile(edited),custom);assert.equal(await readFile(canary,'utf8'),'SYNTHETIC PRIVATE CANARY');
});

test('failed module-header commit rolls back public programs and new runtime directories without touching private fixtures',async t=>{
 const {module,target,release,canary}=await installFixture(t);let failure;
 try{await module.upgradeStudio({root:target,sourceRoot:release,apply:true,onProgress:({path})=>{if(path==='src/device-sdk/kibi_xiaozhi_client.h')throw Error('injected commit failure');}});}catch(error){failure=error;}
 assert.equal(failure?.code,'upgrade_write_failed');assert.equal(failure.rolledBack,true);
 for(const [path,source] of Object.entries(reliabilitySources))assert.equal(hash(await readFile(join(target,path))),hash(source),path);
 for(const [,path] of runtimePayloads)await assert.rejects(readFile(join(target,path)),{code:'ENOENT'},path);
 await assert.rejects(readFile(join(target,'src/device-sdk')),{code:'ENOENT'});await assert.rejects(readFile(join(target,'src/platform-guides')),{code:'ENOENT'});
 assert.equal(await readFile(canary,'utf8'),'SYNTHETIC PRIVATE CANARY');await assert.rejects(readFile(join(failure.backupDir,'.studio/private-fixture')),{code:'ENOENT'});
});

test('an unknown existing runtime payload is preserved and rejected before any update write',async t=>{
 const {module,target,release,canary}=await installFixture(t),path='src/device-modules.mjs',custom=Buffer.from('export const userCustomization=true;\n');await writeFile(join(target,path),custom);
 await assert.rejects(module.upgradeStudio({root:target,sourceRoot:release,apply:true}),{code:'upgrade_existing_file_conflict',path});
 assert.deepEqual(await readFile(join(target,path)),custom);
 for(const [path,source] of Object.entries(reliabilitySources))assert.equal(hash(await readFile(join(target,path))),hash(source),path);
 await assert.rejects(readFile(join(target,'src/device-sdk')),{code:'ENOENT'});assert.equal(await readFile(canary,'utf8'),'SYNTHETIC PRIVATE CANARY');
});

test('actual named public programs retain reviewed lineage, converge and reject local edits',{skip:!process.env.KIBI_PUBLIC_STUDIO_PROGRAM_ROOT},async()=>{
 const root=process.env.KIBI_PUBLIC_STUDIO_PROGRAM_ROOT;
 for(const path of ['src/server.mjs','src/project-store.mjs','native/support.mjs','src/source-zip.mjs']){
  const input=await readFile(join(root,path)),pins=PUBLIC_STUDIO_BASELINES[path],final=upgradePublicProgram(path,input);
  const legacy=path==='src/server.mjs'?restorePortableDesignProgram(path,restoreNewProjectProgram(path,restoreAutomaticBuildProgram(path,final)))
   :path==='src/project-store.mjs'?restorePortableDesignProgram(path,restoreDeviceModuleProgram(path,final))
    :restoreDeviceModuleProgram(path,final);
  assert.ok([pins.afterSha256,...(upgrader.REVIEWED_STUDIO_VARIANTS[path]??[])].includes(hash(legacy)),`${path}: complete restored program must equal one reviewed lineage root`);
  assert.equal(hash(upgradePublicProgram(path,final)),hash(final),`${path}: final bytes are idempotent`);
  assert.throws(()=>upgradePublicProgram(path,Buffer.concat([final,Buffer.from('\n// local customization\n')])),{code:'upgrade_unknown_baseline'});
  if(!['src/server.mjs','src/project-store.mjs'].includes(path)||hash(legacy)!==pins.afterSha256)continue;
  const previous=Buffer.from(path==='src/server.mjs'
   ?legacy.toString().replace('const toolsetRevision=sha256(JSON.stringify(dynamicTools));\n','').replaceAll('.getThreadId(toolsetRevision)||undefined','.getThreadId()||undefined').replaceAll('.setThreadId(info.threadId,toolsetRevision)','.setThreadId(info.threadId)')
   :legacy.toString().replace('  getThreadId:toolsetRevision=>toolsetRevision===undefined||state.threadToolsetRevision===toolsetRevision?state.threadId:null,','  getThreadId:()=>state.threadId,').replace('  setThreadId:(threadId,toolsetRevision)=>transaction(()=>{state.threadId=threadId;if(toolsetRevision===undefined)delete state.threadToolsetRevision;else state.threadToolsetRevision=toolsetRevision;chat.threadId=threadId;}),','  setThreadId:threadId=>transaction(()=>{state.threadId=threadId;chat.threadId=threadId;}),'));
  assert.equal(hash(previous),pins.previousAfterSha256,'reverse fixture must reproduce the pinned previous baseline exactly');
  const original=path==='src/project-store.mjs'
   ?previous.toString().replace("\nimport {installManagedAssets} from './managed-assets.mjs';",'').replace(/  installPublicAssets:\(input,guard=\(\)=>\{\}\)=>transaction\(async\(\)=>\{\n[\s\S]*?\n  \}\),\n/,'')
   :previous.toString()
    .replace("\nimport {createStudioPlatform,platformTools,platformInstructions} from './studio-platform.mjs';",'')
    .replace('export const dynamicTools=[\n ...platformTools,','export const dynamicTools=[')
    .replace(" const platform=await createStudioPlatform({root,getStore:()=>store,getEpoch:()=>projectEpoch,announce:()=>announce(),mutate:action=>voiceSourceMutation(action)});\n const developerText=(await readFile(path.join(root,'prompts/agent-system.md'),'utf8').catch(()=> 'Use Kibi dynamic tools only. Never request or read credentials.'))+'\\n'+platformInstructions;"," const developerText=await readFile(path.join(root,'prompts/agent-system.md'),'utf8').catch(()=> 'Use Kibi dynamic tools only. Never request or read credentials.');")
    .replace("if(tool==='kibi_project_context')return{...await store.getAgentContext(),...await platform.context(),voiceGateway:voiceService.publicInfo(),preview:previewState};\n  const platformResult=await platform.tool(tool,args,turnGuard);if(platformResult.handled)return platformResult.result;","if(tool==='kibi_project_context')return{...await store.getAgentContext(),voiceGateway:voiceService.publicInfo(),preview:previewState};")
    .replace('   if(await platform.route(request,response,{route,body,send}))return;\n','')
    .replace('shutdown:async()=>{closed=true;await platform.close();virtualService.close();','shutdown:async()=>{closed=true;virtualService.close();')
    .replace("server.on('close',()=>{closed=true;void platform.close();virtualService.close();","server.on('close',()=>{closed=true;virtualService.close();");
  assert.equal(hash(original),pins.beforeSha256,'reverse fixture must reproduce the pinned original baseline exactly');
  const fromOriginal=upgradePublicProgram(path,Buffer.from(original)),fromPrevious=upgradePublicProgram(path,previous);
  assert.equal(hash(fromOriginal),hash(final));assert.equal(hash(fromOriginal),hash(fromPrevious));
  assert.equal(hash(upgradePublicProgram(path,fromOriginal)),hash(fromOriginal),'current programs are idempotent');
  assert.throws(()=>upgradePublicProgram(path,Buffer.concat([previous,Buffer.from('\n// local customization\n')])),{code:'upgrade_unknown_baseline'});
 }
});
