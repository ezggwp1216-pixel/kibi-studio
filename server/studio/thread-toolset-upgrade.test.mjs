import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PUBLIC_STUDIO_BASELINES,patchThreadToolsetProgram,upgradePublicProgram} from './upgrade.mjs';

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

test('exact public previous and original baselines converge to the same pinned current programs',{skip:!process.env.KIBI_PUBLIC_STUDIO_PROGRAM_ROOT},async()=>{
 const root=process.env.KIBI_PUBLIC_STUDIO_PROGRAM_ROOT;
 for(const path of ['src/server.mjs','src/project-store.mjs']){
  let previous=await readFile(join(root,path));const pins=PUBLIC_STUDIO_BASELINES[path];
  assert.ok([pins.beforeSha256,pins.previousAfterSha256,pins.afterSha256].includes(hash(previous)),'fixture must be one exact named public program');
  if(hash(previous)===pins.beforeSha256)previous=upgradePublicProgram(path,previous);
  if(hash(previous)===pins.afterSha256)previous=Buffer.from(path==='src/server.mjs'
   ?previous.toString().replace('const toolsetRevision=sha256(JSON.stringify(dynamicTools));\n','').replaceAll('.getThreadId(toolsetRevision)||undefined','.getThreadId()||undefined').replaceAll('.setThreadId(info.threadId,toolsetRevision)','.setThreadId(info.threadId)')
   :previous.toString().replace('  getThreadId:toolsetRevision=>toolsetRevision===undefined||state.threadToolsetRevision===toolsetRevision?state.threadId:null,','  getThreadId:()=>state.threadId,').replace('  setThreadId:(threadId,toolsetRevision)=>transaction(()=>{state.threadId=threadId;if(toolsetRevision===undefined)delete state.threadToolsetRevision;else state.threadToolsetRevision=toolsetRevision;chat.threadId=threadId;}),','  setThreadId:threadId=>transaction(()=>{state.threadId=threadId;chat.threadId=threadId;}),'));
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
  assert.equal(hash(fromOriginal),pins.afterSha256);assert.deepEqual(fromOriginal,fromPrevious);
  assert.deepEqual(upgradePublicProgram(path,fromOriginal),fromOriginal,'current programs are idempotent');
  assert.throws(()=>upgradePublicProgram(path,Buffer.concat([previous,Buffer.from('\n// local customization\n')])),{code:'upgrade_unknown_baseline'});
 }
});
