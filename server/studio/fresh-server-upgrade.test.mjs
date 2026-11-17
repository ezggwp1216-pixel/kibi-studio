import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const sourceRoot=process.env.KIBI_PUBLIC_FRESH_STUDIO_ROOT;
const repo=fileURLToPath(new URL('../',import.meta.url));
const migration=await import('./fresh-server-upgrade.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const programs=['src/server.mjs','src/project-store.mjs','src/codex-bridge.mjs','native/support.mjs','src/workspace.mjs'];
const source=path=>readFile(join(sourceRoot,path));

test('fresh public programs gain the current platform without accepting arbitrary edits',{skip:!sourceRoot},async()=>{
 assert.equal(typeof migration.upgradeFreshServerProgram,'function','the fresh public lineage needs its own verified migration');
 for(const path of programs){
  const before=await source(path),after=migration.upgradeFreshServerProgram(path,before),pins=migration.FRESH_SERVER_BASELINES[path];
  assert.equal(hash(before),pins.beforeSha256,path);
  assert.equal(hash(after),pins.afterSha256,path);
  assert.notDeepEqual(after,before,path);
  assert.deepEqual(migration.upgradeFreshServerProgram(path,after),after);
  assert.throws(()=>migration.upgradeFreshServerProgram(path,Buffer.concat([after,Buffer.from('\n// unknown edit\n')])),{code:'upgrade_unknown_baseline'});
 }
 assert.throws(()=>migration.upgradeFreshServerProgram('projects/private.h',Buffer.from('anything')),{code:'upgrade_unknown_baseline'});
 const server=migration.upgradeFreshServerProgram('src/server.mjs',await source('src/server.mjs')).toString();
 for(const publicContract of ['createStudioPlatform','summarizeProjectReadiness','/api/project/ready','implementationRequested','targetDiagnostics','codeReady'])assert.ok(server.includes(publicContract),publicContract);
 assert.doesNotMatch(server,/voiceService|virtualService/,'fresh public Studio must not depend on absent private services');
});

test('the fresh ChatGPT sign-in instruction is Russian and preserves its exact public auth condition',{skip:!sourceRoot},async()=>{
 const before=await source('src/codex-bridge.mjs'),after=migration.upgradeFreshServerProgram('src/codex-bridge.mjs',before).toString();
 const oldMessage='Sign in to Codex with a ChatGPT account to use Studio chat. API-key accounts are not supported.';
 const message='Откройте «Запустить Киби Studio.command» в папке Studio и завершите официальный вход в свой ChatGPT. Для чата Studio нужен аккаунт ChatGPT; API-ключ не подходит.';
 assert.ok(after.includes("if (!status.authenticated) status.error = '"+message+"';"));assert.equal(after.includes(oldMessage),false);
 let restored=after.replace("import {platformTools} from './studio-platform.mjs';\n",'').replace('const TOOL_NAMES = new Set([...platformTools.map(tool=>tool.name),','const TOOL_NAMES = new Set([').replace(message,oldMessage);
 restored=restored.replace(/\n\/\/ KIBI_FRESH_PUBLIC_SERVER_20261117_V1\n$/,'');assert.equal(restored,before.toString(),'localization must not change auth/protocol behavior');
});

async function fixture(t,{remote=false}={}){
 assert.equal(typeof migration.upgradeFreshServerProgram,'function');
 const root=await realpath(await mkdtemp(join(tmpdir(),'kibi-public-fresh-')));
 let activeServer;
 t.after(async()=>{await activeServer?.studio.shutdown();await rm(root,{recursive:true,force:true});});
 const dependencyPaths=['src/attachments.mjs','src/native-preview.mjs','src/build-service.mjs','src/remote-client.mjs','src/remote-build-service.mjs','src/remote-preview-service.mjs','src/source-zip.mjs','src/png.mjs','native/host-process.mjs','native/resources.mjs'];
 for(const path of [...programs,...dependencyPaths]){await mkdir(dirname(join(root,path)),{recursive:true});const bytes=await source(path);await writeFile(join(root,path),programs.includes(path)?migration.upgradeFreshServerProgram(path,bytes):bytes);}
 for(const name of ['studio-platform.mjs','project-readiness.mjs','managed-assets.mjs','device-module-install.mjs','device-variants.mjs'])await writeFile(join(root,'src',name),`export * from ${JSON.stringify(pathToFileURL(join(repo,'studio',name)).href)};\n`);
 const {deviceVariantHeader}=await import('./device-variants.mjs');
 const meta={id:'kibi-base',name:'Synthetic public project',boardId:'kibi-ds02-s3-16m',requirements:{wifi:false,api:false}};
 for(const dir of ['projects/kibi-base/firmware','templates/kibi-base/firmware','resources','prompts'])await mkdir(join(root,dir),{recursive:true});
 for(const prefix of ['projects/kibi-base','templates/kibi-base']){
  await writeFile(join(root,prefix,'project.json'),JSON.stringify(meta));
  await writeFile(join(root,prefix,'board.json'),JSON.stringify({id:meta.boardId}));
  await writeFile(join(root,prefix,'AGENTS.md'),'Synthetic source only.');
  for(const name of ['project.ino','app_core.h','app_view.h','app_feature.h'])await writeFile(join(root,prefix,'firmware',name),'// synthetic '+name+'\n');
  await writeFile(join(root,prefix,'firmware/kibi_device_config.h'),deviceVariantHeader('basic'));
 }
 await writeFile(join(root,'resources/board.json'),JSON.stringify({id:meta.boardId}));
 await writeFile(join(root,'prompts/agent-system.md'),'Synthetic instructions.');
 const storeModule=await import(pathToFileURL(join(root,'src/project-store.mjs')).href);
 const store=await storeModule.createProjectStore({root});
 const serverModule=await import(pathToFileURL(join(root,'src/server.mjs')).href);
 let callbacks,status={ready:true,authenticated:true,busy:false},counter=0;
 const bridgeFactory=input=>{callbacks=input;return{getStatus:()=>({...status}),start:async()=>({...status}),close:async()=>{},send:async()=>{status={...status,busy:true,threadId:'synthetic-thread',turnId:'synthetic-turn-'+(++counter)};await input.onEvent({type:'chat.status',projectId:store.projectId,threadId:status.threadId,turnId:status.turnId});return{threadId:status.threadId,turnId:status.turnId};},interrupt:async()=>{status.busy=false;},replyApproval:async()=>{}};};
 const builds=[];
 const builder={environment:async()=>({ready:true,issues:[]}),start:async input=>{builds.push(input);return{id:'synthetic-job-'+builds.length,status:'succeeded',sourceRevision:input.sourceRevision,sourceHash:input.sourceHash,artifacts:[]};}};
 const preview={render:async()=>({rgb:Buffer.alloc(213120),width:240,height:296,sourceHash:(await store.getState()).sourceHash,state:{page:'home'},action:'none',diagnostics:{}}),check:async()=>({passed:true,checks:[{name:'synthetic native transport',passed:true}]})};
 const remoteClient=remote?{status:()=>({signedIn:true,connected:true}),logout:async()=>{}}:undefined;
 const server=await serverModule.createStudioServer({root,store,builder,preview,bridgeFactory,remoteClient,mode:remote?'remote':'local'});activeServer=server;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 async function api(route,body,method=body===undefined?'GET':'POST'){
  const state=await server.studio.state();
  const response=await fetch(origin+route,{method,headers:{Origin:origin,'Content-Type':'application/json','X-Studio-Token':state.csrfToken,'X-Studio-Project':state.project.id},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{status:response.status,body:await response.json()};
 }
 return{root,store,server,api,builds,preview,builder,bridge:()=>callbacks,status:()=>status,finish:async(event={})=>{const current={...status};status.busy=false;await callbacks.onEvent({type:'chat.completed',projectId:store.projectId,threadId:current.threadId,turnId:current.turnId,status:'completed',...event});}};
}

test('a fresh offline design edits shared input, then earns build readiness through real injected checks',{skip:!sourceRoot},async t=>{
 const f=await fixture(t),initial=await f.store.getState();
 assert.equal(initial.implementationRequested,false);
 const core=await f.store.readSource('app_core.h');
 await f.store.writeSource({path:core.path,expectedSha256:core.sha256,content:core.content+'// moved hit region\n'});
 const feature=await f.store.readSource('app_feature.h');
 await assert.rejects(f.store.writeSource({path:feature.path,expectedSha256:feature.sha256,content:'// hardware implementation\n'}),{status:409});
 const image=await f.api('/api/preview/input',{type:'tap',x:20,y:20});assert.equal(image.status,200);
 const design=await f.api('/api/check',{});assert.equal(design.status,200);assert.equal(design.body.nativePassed,true);assert.equal(design.body.readiness.phase,'design');assert.equal(f.builds.length,0);
 const approved=await f.api('/api/project/ready',{revision:(await f.store.getState()).revision});assert.equal(approved.status,200);assert.equal(approved.body.implementationRequested,true);
 await f.store.writeSource({path:feature.path,expectedSha256:feature.sha256,content:'// implemented hardware\n'});
 await f.api('/api/preview/input',{type:'tap',x:20,y:20});
 const checked=await f.api('/api/check',{});assert.equal(checked.status,200);assert.equal(checked.body.passed,true);assert.equal(checked.body.readiness.stages.target,'passed');assert.equal(f.builds.length,1);assert.equal(f.builds[0].purpose,'diagnostic');
 let state=await f.server.studio.state();assert.equal(state.workflow.canBuild,true);assert.ok(state.codeReady);
 await f.store.setRequirements({wifi:true,api:false});
 state=await f.server.studio.state();assert.equal(state.workflow.canBuild,false);assert.equal(state.codeReady,null);
 assert.equal((await f.api('/api/build',{revision:state.revision})).status,409);
});

test('the current public platform is available locally without provider requests or weaker mutation guards',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);
 const context=await f.server.studio.tools({tool:'kibi_project_context'});
 assert.equal(context.platform.publicResources,true);assert.equal(context.platform.deviceModules.modules[0].id,'xiaozhi');assert.equal(context.account.connected,false);
 const status=await f.api('/api/account');assert.equal(status.status,200);assert.equal(status.body.connected,false);
 const origin='http://127.0.0.1:'+f.server.address().port;
 const bad=await fetch(origin+'/api/account/disconnect',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{}'});
 assert.equal(bad.status,403);assert.equal(f.builds.length,0);
});

test('target failure cannot expose the build action and never publishes compiler text',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);f.builder.start=async()=>({status:'failed',log:'DO_NOT_RELAY_CONFIGURED_COMPILER_TEXT'});
 await f.api('/api/project/ready',{revision:(await f.store.getState()).revision});await f.api('/api/preview/input',{type:'tap',x:1,y:1});
 const result=await f.api('/api/check',{});assert.equal(result.status,200);assert.equal(result.body.nativePassed,true);assert.equal(result.body.passed,false);assert.equal(result.body.readiness.stages.target,'blocked');assert.equal(result.body.codeReady,null);assert.equal(JSON.stringify(result).includes('DO_NOT_RELAY'),false);
 assert.equal((await f.server.studio.state()).workflow.canBuild,false);
});

test('configuration changes while a target diagnostic is pending cannot earn a stale witness',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);await f.api('/api/project/ready',{revision:(await f.store.getState()).revision});await f.api('/api/preview/input',{type:'tap',x:1,y:1});
 let release,started;const waiting=new Promise(resolve=>{started=resolve;});
 f.builder.start=async input=>{started();await new Promise(resolve=>{release=resolve;});return{status:'succeeded',sourceHash:input.sourceHash,sourceRevision:input.sourceRevision};};
 const pending=f.api('/api/check',{});await waiting;
 await f.store.saveSettings({wifi:{ssid:'synthetic-wifi',password:'test-only-pass'}});release();
 const result=await pending;assert.equal(result.status,409);assert.equal((await f.store.getState()).codeReady,null);assert.equal((await f.server.studio.state()).workflow.canBuild,false);
});

test('saving Wi-Fi during an authorized turn permits its fresh final witness and one automatic final build',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);await f.store.setRequirements({wifi:true,api:false});
 await f.api('/api/project/ready',{revision:(await f.store.getState()).revision});
 assert.equal((await f.api('/api/chat',{text:'Create and check the agreed application.'})).status,202);
 await f.api('/api/settings',{wifi:{ssid:'synthetic-network',password:'test-private-pass'}});
 const ids={projectId:f.store.projectId,threadId:f.status().threadId,turnId:f.status().turnId};
 const feature=await f.store.readSource('app_feature.h');
 await f.bridge().onToolCall({...ids,tool:'kibi_write_source',arguments:{path:feature.path,expectedSha256:feature.sha256,content:feature.content+'// final implementation\n'}});
 await f.bridge().onToolCall({...ids,tool:'kibi_preview',arguments:{}});
 const check=await f.bridge().onToolCall({...ids,tool:'kibi_check',arguments:{}});assert.equal(check.passed,true);assert.equal(f.builds.length,1);assert.equal(f.builds[0].purpose,'diagnostic');assert.equal(f.builds[0].configuration.wifi_ssid,'Kibi-Diagnostic');
 assert.equal((await f.server.studio.state()).workflow.canBuild,false,'a running turn cannot expose its not-yet-final implementation');
 await f.finish();assert.equal(f.builds.length,2);assert.equal(f.builds[1].configuration.wifi_ssid,'synthetic-network');
 for(let i=0;i<15&&(await f.store.getState()).build?.status!=='succeeded';i++)await new Promise(resolve=>setTimeout(resolve,5));
 const state=await f.server.studio.state();assert.equal(state.build.status,'succeeded');assert.equal(state.build.projectId,f.store.projectId);assert.equal(JSON.stringify(state).includes('test-private-pass'),false);
 await assert.rejects(f.bridge().onToolCall({...ids,tool:'kibi_set_requirements',arguments:{wifi:false,api:false}}),{status:409});
});

test('an edit after the last successful check prevents completion from auto-building old code',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);await f.api('/api/project/ready',{revision:(await f.store.getState()).revision});await f.api('/api/chat',{text:'Create the application.'});
 const ids={projectId:f.store.projectId,threadId:f.status().threadId,turnId:f.status().turnId};
 await f.bridge().onToolCall({...ids,tool:'kibi_preview',arguments:{}});await f.bridge().onToolCall({...ids,tool:'kibi_check',arguments:{}});
 const source=await f.store.readSource('app_view.h');await f.bridge().onToolCall({...ids,tool:'kibi_write_source',arguments:{path:source.path,expectedSha256:source.sha256,content:source.content+'// unverified later edit\n'}});
 await f.finish();assert.equal(f.builds.length,1);assert.equal((await f.store.getState()).codeReady,null);
});

test('a build belonging to another project is never shown even when source/configuration identities coincide',{skip:!sourceRoot},async t=>{
 const f=await fixture(t),state=await f.store.getState();
 await f.store.setBuild({id:'other-project-job',projectId:'another-project',sourceHash:state.sourceHash,sourceRevision:state.revision,configurationRevision:state.configuration.revision,status:'succeeded',artifacts:[]});
 assert.equal((await f.store.getState()).build,null);
});

test('interrupting a queued model mutation prevents the stale requirements write',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);await f.api('/api/chat',{text:'Discuss requirements.'});
 let started,release;const waiting=new Promise(resolve=>{started=resolve;});const original=f.store.setRequirements;
 f.store.setRequirements=async(...args)=>{started();await new Promise(resolve=>{release=resolve;});return original(...args);};
 const ids={projectId:f.store.projectId,threadId:f.status().threadId,turnId:f.status().turnId};
 const change=f.bridge().onToolCall({...ids,tool:'kibi_set_requirements',arguments:{wifi:true,api:false}});
 await waiting;await f.api('/api/chat/interrupt',{});release();
 await assert.rejects(change,{status:409});assert.equal((await f.store.getState()).project.requirements.wifi,false);
});

test('a delayed error from a prior turn cannot overwrite the current conversation status',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);await f.api('/api/chat',{text:'First discussion.'});const previous={...f.status()};await f.finish();
 await f.api('/api/chat',{text:'Second discussion.'});const active={...f.status()};
 await f.bridge().onEvent({type:'chat.error',projectId:f.store.projectId,threadId:previous.threadId,turnId:previous.turnId,error:'stale failure'});
 const state=await f.store.getState();assert.equal(state.chat.error,null);assert.equal(state.chat.turnId,active.turnId);assert.equal(state.chat.busy,true);
});

test('both public source readers accept exactly 96 files and reject the next one',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);
 for(let i=5;i<96;i++)await writeFile(join(f.store.sourceDir,'synthetic_'+i+'.h'),'// synthetic\n');
 const support=await import(pathToFileURL(join(f.root,'native/support.mjs')).href);
 assert.equal((await f.store.getState()).files.length,96);assert.equal((await support.readSource({root:f.root,sourceDir:f.store.sourceDir})).files.length,96);
 await writeFile(join(f.store.sourceDir,'synthetic_96.h'),'// over limit\n');
 await assert.rejects(f.store.getState(),/лимит/);await assert.rejects(support.readSource({root:f.root,sourceDir:f.store.sourceDir}),/96-file/);
});

test('the trusted basic/speaker selector updates its protected macro and invalidates current proofs',{skip:!sourceRoot},async t=>{
 const f=await fixture(t),before=await f.store.getState();
 assert.equal(before.project.deviceVariant,'basic');assert.equal(before.configuration.deviceVariant,'basic');
 await f.api('/api/project/ready',{revision:before.revision});await f.api('/api/preview/input',{type:'tap',x:1,y:1});await f.api('/api/check',{});
 assert.equal((await f.server.studio.state()).workflow.canBuild,true);
 const ready=await f.store.getState(),response=await f.api('/api/device/variant',{variant:'speaker'});assert.equal(response.status,200);
 const current=await f.store.getState();assert.equal(current.project.deviceVariant,'speaker');assert.equal(current.configuration.deviceVariant,'speaker');assert.equal(current.configuration.revision,ready.configuration.revision+1);assert.equal(current.revision,ready.revision+1);assert.equal(current.codeReady,null);assert.equal(current.targetDiagnostics,null);assert.deepEqual(current.hardwareIssues,[]);
 const header=await f.store.readSource('kibi_device_config.h');assert.match(header.content,/#define KIBI_DEVICE_HAS_SPEAKER 1/);assert.equal(header.editable,false);
 await assert.rejects(f.store.writeSource({path:header.path,expectedSha256:header.sha256,content:'// model may not change board variant\n'}),{status:403});
 const repeated=await f.api('/api/device/variant',{variant:'speaker'});assert.equal(repeated.status,200);assert.equal((await f.store.getState()).configuration.revision,current.configuration.revision);
 for(const input of [{variant:'other'},{variant:'basic',owner:'another'},{},null])assert.equal((await f.api('/api/device/variant',input)).status,400);
});

test('the variant selector preserves an unknown public header instead of overwriting it',{skip:!sourceRoot},async t=>{
 const f=await fixture(t),file=join(f.store.sourceDir,'kibi_device_config.h'),unknown='// unknown user edit\n';await writeFile(file,unknown);
 const response=await f.api('/api/device/variant',{variant:'speaker'});assert.equal(response.status,409);assert.equal(await readFile(file,'utf8'),unknown);assert.equal((await f.store.getState()).project.deviceVariant,'basic');
});

test('a neutral 67-file template creates a fresh project with the managed basic variant',{skip:!sourceRoot},async t=>{
 const f=await fixture(t),template=join(f.root,'templates/kibi-base');
 const names=['project.json','board.json','AGENTS.md','firmware/project.ino','firmware/app_core.h','firmware/app_view.h','firmware/app_feature.h','firmware/kibi_device_config.h'];
 for(let i=names.length;i<67;i++){const name='firmware/template_'+i+'.h';await writeFile(join(template,name),'// synthetic template source\n');names.push(name);}
 const files=await Promise.all(names.map(async path=>{const content=await readFile(join(template,path));return{path,size:content.length,sha256:hash(content)};}));
 await writeFile(join(template,'manifest.json'),JSON.stringify({schemaVersion:1,boardId:'kibi-ds02-s3-16m',files}));
 const result=await f.api('/api/projects',{name:'New synthetic project'});assert.equal(result.status,201);
 assert.notEqual(result.body.project.id,'kibi-base');assert.equal(result.body.project.name,'New synthetic project');assert.equal(result.body.project.deviceVariant,'basic');assert.equal(result.body.implementationRequested,false);assert.equal(result.body.configuration.wifiConfigured,false);assert.equal(result.body.build,null);
});

async function readyModelTurn(f){
 await f.api('/api/project/ready',{revision:(await f.store.getState()).revision});await f.api('/api/chat',{text:'Implement and check the application.'});
 const ids={projectId:f.store.projectId,threadId:f.status().threadId,turnId:f.status().turnId};
 await f.bridge().onToolCall({...ids,tool:'kibi_preview',arguments:{}});await f.bridge().onToolCall({...ids,tool:'kibi_check',arguments:{}});
 assert.equal(f.builds.length,1);return ids;
}
const settleBuild=async f=>{for(let i=0;i<30&&['queued','building'].includes((await f.store.getState()).build?.status);i++)await new Promise(resolve=>setTimeout(resolve,5));};

test('automatic build preparation cannot outlive its completed turn while configuration is awaited',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);await readyModelTurn(f);
 let entered,release;const started=new Promise(resolve=>{entered=resolve;}),original=f.store.getBuildConfiguration;
 f.store.getBuildConfiguration=async()=>{entered();await new Promise(resolve=>{release=resolve;});return original();};
 const completion=f.finish();await started;
 assert.equal((await f.api('/api/chat',{text:'Change the agreed design.'})).status,202);
 release();await completion;await settleBuild(f);assert.equal(f.builds.length,1,'an older turn must not start its final build during the new turn');
});

test('automatic build preparation rechecks its generation after awaiting remote compiler readiness',{skip:!sourceRoot},async t=>{
 const f=await fixture(t,{remote:true});await readyModelTurn(f);
 let entered,release;const started=new Promise(resolve=>{entered=resolve;});
 f.builder.environment=async()=>{entered();await new Promise(resolve=>{release=resolve;});return{ready:true,issues:[]};};
 const completion=f.finish();await started;
 assert.equal((await f.api('/api/chat',{text:'Start a new discussion.'})).status,202);
 release();await completion;await settleBuild(f);assert.equal(f.builds.length,1);
});

test('manual build refuses a busy conversation even if its previous code witness still matches',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);await f.api('/api/project/ready',{revision:(await f.store.getState()).revision});await f.api('/api/preview/input',{type:'tap',x:1,y:1});await f.api('/api/check',{});
 await f.api('/api/chat',{text:'Discuss another improvement.'});assert.equal((await f.server.studio.state()).workflow.canBuild,false);
 const result=await f.api('/api/build',{revision:(await f.store.getState()).revision});await settleBuild(f);assert.equal(result.status,409);assert.equal(f.builds.length,1);
});

test('a queued automatic build rechecks the intent before invoking the actual compiler',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);await readyModelTurn(f);
 let entered,release;const started=new Promise(resolve=>{entered=resolve;}),original=f.store.setBuild;
 f.store.setBuild=async job=>{if(job?.status==='queued'){entered();await new Promise(resolve=>{release=resolve;});}return original(job);};
 const completion=f.finish();await started;
 assert.equal((await f.api('/api/chat',{text:'Change the current project.'})).status,202);
 release();await completion;await settleBuild(f);assert.equal(f.builds.length,1);
});

test('parallel manual requests reserve one preparation and invoke the compiler only once',{skip:!sourceRoot},async t=>{
 const f=await fixture(t);await f.api('/api/project/ready',{revision:(await f.store.getState()).revision});await f.api('/api/preview/input',{type:'tap',x:1,y:1});await f.api('/api/check',{});
 let entered,duplicate,releaseConfig,releaseBuild;const started=new Promise(resolve=>{entered=resolve;}),duplicateEntered=new Promise(resolve=>{duplicate=resolve;}),configGate=new Promise(resolve=>{releaseConfig=resolve;}),buildGate=new Promise(resolve=>{releaseBuild=resolve;});
 const originalConfig=f.store.getBuildConfiguration,originalBuild=f.builder.start,calls=[];let preparationCalls=0;
 f.store.getBuildConfiguration=async()=>{preparationCalls++;if(preparationCalls===1)entered();else duplicate();await configGate;return originalConfig();};
 f.builder.start=async input=>{calls.push(input);await buildGate;return originalBuild(input);};
 const revision=(await f.store.getState()).revision,first=f.api('/api/build',{revision});await started;const second=f.api('/api/build',{revision});
 await Promise.race([second,duplicateEntered]);releaseConfig();
 const responses=await Promise.all([first,second]);const compilerCalls=calls.length;releaseBuild();await settleBuild(f);
 assert.deepEqual(responses.map(item=>item.status).sort(),[202,409]);assert.equal(preparationCalls,1);assert.equal(compilerCalls,1);
});
