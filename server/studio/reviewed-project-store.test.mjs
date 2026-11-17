import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,lstat,realpath,rm,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {upgradePublicProgram} from './upgrade.mjs';
import moduleManifest from './device-modules.json' with {type:'json'};

// This opt-in integration uses PUBLIC program/template files only. Every store
// instance and all its generated settings/state live under a fresh scratch root.
// It never opens the supplied installation's projects, .studio, auth or settings.
const installation=process.env.KIBI_REVIEWED_STUDIO_ROOT;
const optional={skip:!installation&&'KIBI_REVIEWED_STUDIO_ROOT не задан: нужен проверенный публичный комплект Studio.'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const moduleNames=['kibi_xiaozhi_core.h','kibi_xiaozhi_client.h'];
let reviewedProgram;

async function publicBytes(file,maximum=4*1024*1024){
 const info=await lstat(file);
 assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=maximum,'expected one ordinary bounded public file');
 return readFile(file);
}
async function program(){
 if(reviewedProgram)return reviewedProgram;
 const root=await realpath(resolve(installation));
 const bytes=await publicBytes(join(root,'src/project-store.mjs'));
 // Unknown or locally modified code is rejected by the production updater.
 // No test-only replacement, hash override or unverified program execution.
 const patched=upgradePublicProgram('src/project-store.mjs',bytes).toString('utf8');
 const source=patched.replace(/^import[^\n]+$/gm,line=>line.replace(/(['"])(\.{1,2}\/[^'"]+)\1/,(_,quote,relative)=>{
  const trusted=relative==='./managed-assets.mjs'||relative==='./device-module-install.mjs'
   ?new URL(relative,import.meta.url).href
   :new URL(relative,pathToFileURL(join(root,'src/project-store.mjs'))).href;
  return quote+trusted+quote;
 }));
 reviewedProgram={root,...await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))};
 return reviewedProgram;
}
async function copyPublicTemplate(source,target,depth=0){
 assert.ok(depth<=4,'public template nesting is bounded');
 const info=await lstat(source);assert.ok(info.isDirectory()&&!info.isSymbolicLink());
 await mkdir(target,{recursive:true});
 for(const entry of await readdir(source,{withFileTypes:true})){
  assert.ok(!entry.isSymbolicLink()&&/^[A-Za-z0-9_.-]+$/.test(entry.name),'no public template link or ambiguous name');
  const from=join(source,entry.name),to=join(target,entry.name);
  if(entry.isDirectory())await copyPublicTemplate(from,to,depth+1);
  else await writeFile(to,await publicBytes(from,2*1024*1024));
 }
}
async function fixture(t){
 const loaded=await program();
 const root=await realpath(await mkdtemp('/private/tmp/kibi-reviewed-store-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await copyPublicTemplate(join(loaded.root,'templates/kibi-base'),join(root,'templates/kibi-base'));
 await copyPublicTemplate(join(root,'templates/kibi-base'),join(root,'projects/fixture'));
 await mkdir(join(root,'resources'));
 await writeFile(join(root,'resources/board.json'),await publicBytes(join(loaded.root,'resources/board.json')));
 await writeFile(join(root,'projects/fixture/project.json'),JSON.stringify({schemaVersion:1,id:'fixture',name:'Synthetic reviewed store',boardId:'kibi-ds02-s3-16m',requirements:{wifi:false,api:false}}));
 const store=await loaded.createProjectStore({root,projectId:'fixture'});
 return {root,store,sourceDir:join(root,'projects/fixture/firmware'),reopen:()=>loaded.createProjectStore({root,projectId:'fixture'})};
}
async function evidence(store,{codeReady=false}={}){
 const state=await store.getState(),checkedAt='2026-11-12T00:00:00.000Z';
 await store.setDiagnostics({status:'passed',provider:null,checkedAt,sourceHash:state.sourceHash,configurationRevision:state.configuration.revision,checks:[]});
 await store.setTargetDiagnostics({status:'passed',checkedAt,sourceHash:state.sourceHash,issues:[]});
 await store.setWorkflow({status:'ready',message:'Synthetic test evidence',sourceHash:state.sourceHash,sourceRevision:state.revision,configurationRevision:state.configuration.revision,action:'install',attempt:0});
 if(codeReady)await store.markCodeReady({sourceHash:state.sourceHash,revision:state.revision,configurationRevision:state.configuration.revision,requirements:state.project.requirements});
 await store.setBuild({id:'synthetic-only',status:'succeeded',sourceHash:state.sourceHash,sourceRevision:state.revision,configurationRevision:state.configuration.revision,artifacts:[{name:'synthetic.bin',size:24,sha256:'a'.repeat(64),offset:65536,url:'/synthetic-only'}]});
 return state;
}
async function moduleInput(){
 assert.deepEqual(moduleManifest.files.map(file=>file.path),moduleNames);
 const files=[];
 for(const pin of moduleManifest.files){
  const bytes=await publicBytes(new URL('../sdk/device/source/'+pin.path,import.meta.url));
  assert.equal(bytes.length,pin.bytes);assert.equal(sha(bytes),pin.sha256);
  files.push({path:pin.path,content:bytes.toString('utf8'),sha256:pin.sha256});
 }
 return {id:'xiaozhi',expectedProjectId:'fixture',files,assertProjectCurrent:()=>{}};
}
const file=(state,name)=>state.files.find(item=>item.path===name);
function reviewedTest(name,run){
 test(name,optional,async t=>{
  try{return await run(t);}catch(error){
   // A data-URL stack must not echo the loaded public program into test output.
   if(error&&typeof error.stack==='string')error.stack=error.stack.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[reviewed-public-store]');
   throw error;
  }
 });
}

reviewedTest('reviewed real store edits portable hit targets before approval while keeping hardware lifecycle locked',async t=>{
 const {store}=await fixture(t),initial=await store.getState();
 assert.equal(file(initial,'app_core.h').editable,true);
 assert.equal(file(initial,'app_view.h').editable,true);
 assert.equal(file(initial,'app_feature.h').editable,false);
 const feature=await store.readSource('app_feature.h');
 await assert.rejects(store.writeSource({path:feature.path,content:feature.content+'\n// must stay locked\n',expectedSha256:feature.sha256}),{status:409});
 await evidence(store);
 const core=await store.readSource('app_core.h');
 assert.equal(core.editable,true);
 const anchor='homeModules{24,190,192,44}';
 assert.equal(core.content.split(anchor).length,2,'reviewed neutral template exposes the original narrow target');
 const moved=core.content.replace(anchor,'homeModules{0,0,240,296}');
 await store.writeSource({path:core.path,content:moved,expectedSha256:core.sha256});
 const changed=await store.getState();
 assert.equal(changed.revision,initial.revision+1);assert.notEqual(changed.sourceHash,initial.sourceHash);
 assert.equal(changed.implementationRequested,false);assert.equal(changed.approvedDesignRevision,null);
 assert.equal(changed.diagnostics,null);assert.equal(changed.targetDiagnostics,null);assert.equal(changed.workflow,null);assert.equal(changed.build,null);
 assert.equal(file(changed,'app_feature.h').editable,false);
});

reviewedTest('reviewed real store retains one implementation request across design/code edits and reopening',async t=>{
 const f=await fixture(t),initial=await f.store.getState();
 await f.store.approveDesign(initial.revision);await evidence(f.store,{codeReady:true});
 const view=await f.store.readSource('app_view.h');
 await f.store.writeSource({path:view.path,content:view.content+'\n// synthetic design refinement\n',expectedSha256:view.sha256});
 let state=await f.store.getState();
 assert.equal(state.implementationRequested,true);assert.equal(file(state,'app_feature.h').editable,true);
 assert.equal(state.codeReady,null);assert.equal(state.build,null);assert.equal(state.diagnostics,null);assert.equal(state.targetDiagnostics,null);
 const feature=await f.store.readSource('app_feature.h');assert.equal(feature.editable,true);
 await f.store.writeSource({path:feature.path,content:feature.content+'\n// synthetic lifecycle implementation\n',expectedSha256:feature.sha256});
 const core=await f.store.readSource('app_core.h');
 await f.store.writeSource({path:core.path,content:core.content+'\n// synthetic portable refinement\n',expectedSha256:core.sha256});
 const driver=await f.store.readSource('audio_codec_power.h');assert.equal(driver.editable,false);
 await assert.rejects(f.store.writeSource({path:driver.path,content:driver.content+'\n// forbidden driver change\n',expectedSha256:driver.sha256}),{status:403});
 state=await f.store.getState();assert.deepEqual(state.hardwareIssues,[]);
 const reopened=await f.reopen(),restored=await reopened.getState();
 assert.equal(restored.sourceHash,state.sourceHash);assert.equal(restored.revision,state.revision);
 assert.equal(restored.implementationRequested,true);assert.equal(file(restored,'app_feature.h').editable,true);
 assert.deepEqual(restored.hardwareIssues,[]);
});

reviewedTest('reviewed real store installs the exact public module above the former 63-source limit and persists protection',async t=>{
 const f=await fixture(t),initial=await f.store.getState(),input=await moduleInput();
 assert.equal(initial.files.length,63,'reviewed neutral source count reproduces the old installation boundary');
 for(const dependency of moduleManifest.dependencies)assert.ok(dependency.sha256.includes(file(initial,dependency.path)?.sha256),dependency.path+' must be an exact supported public dependency');
 await f.store.approveDesign(initial.revision);await evidence(f.store,{codeReady:true});
 assert.equal(typeof f.store.installPublicDeviceModule,'function');
 const installed=await f.store.installPublicDeviceModule(input);
 assert.deepEqual(installed.paths,moduleNames);
 let state=await f.store.getState();assert.equal(state.files.length,65);
 assert.equal(state.revision,initial.revision+1);assert.notEqual(state.sourceHash,initial.sourceHash);
 assert.equal(state.codeReady,null);assert.equal(state.build,null);assert.equal(state.diagnostics,null);assert.equal(state.targetDiagnostics,null);
 assert.deepEqual(state.hardwareIssues,[]);
 for(const pin of moduleManifest.files){assert.equal(file(state,pin.path).sha256,pin.sha256);assert.equal(file(state,pin.path).editable,false);}
 const revision=state.revision;
 await f.store.installPublicDeviceModule(input);state=await f.store.getState();
 assert.equal(state.revision,revision,'idempotent installation must not stale another build');
 const altered=join(f.sourceDir,moduleNames[0]),original=await readFile(altered);
 await writeFile(altered,Buffer.concat([original,Buffer.from('\n// synthetic tamper\n')]));
 assert.ok((await f.store.getState()).hardwareIssues.some(issue=>issue.includes(moduleNames[0])),'module hashes are claimed by driver protection');
 await writeFile(altered,original);
 const beforeReopen=await f.store.getState(),reopened=await f.reopen(),restored=await reopened.getState();
 assert.equal(restored.sourceHash,beforeReopen.sourceHash);assert.equal(restored.revision,beforeReopen.revision);
 assert.deepEqual(restored.hardwareIssues,[]);assert.equal(restored.files.length,65);
 for(const pin of moduleManifest.files)assert.equal(file(restored,pin.path).sha256,pin.sha256);
});

reviewedTest('reviewed real store rejects an unpinned module payload without changing synthetic sources',async t=>{
 const f=await fixture(t),initial=await f.store.getState(),input=await moduleInput();
 input.files[0]={...input.files[0],content:input.files[0].content+'\n// not the pinned module\n'};
 await assert.rejects(f.store.installPublicDeviceModule(input),{code:'MODULE_PAYLOAD'});
 const state=await f.store.getState();assert.equal(state.sourceHash,initial.sourceHash);assert.equal(state.revision,initial.revision);
 assert.equal(state.files.length,63);assert.deepEqual(state.hardwareIssues,[]);
});

reviewedTest('reviewed real store hides an old artifact from both public contexts after configuration changes',async t=>{
 const {store}=await fixture(t),initial=await store.getState();
 await store.approveDesign(initial.revision);await evidence(store,{codeReady:true});
 assert.equal((await store.getState()).build.id,'synthetic-only');
 assert.equal((await store.getAgentContext()).build.id,'synthetic-only');
 await store.saveSettings({wifi:{ssid:'DUMMY_TEST_NET',password:'synthetic-only-password'}});
 const state=await store.getState(),context=await store.getAgentContext();
 assert.equal(state.configuration.revision,initial.configuration.revision+1);
 assert.equal(state.sourceHash,initial.sourceHash);
 assert.equal(state.build,null);assert.equal(context.build,null);
});
