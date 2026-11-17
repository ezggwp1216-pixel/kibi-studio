// Explicit, hash-pinned migration of the complete public 0.3.0 Studio archive.
// This module transforms public bytes only. It never opens an installation,
// executes an application, reads credentials or accepts marker-only baselines.
import {createHash} from 'node:crypto';
import {patchPortableDesignProgram} from './portable-design-upgrade.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,path,extra={})=>Object.assign(new Error(code),{code,path,...extra});
const marker='\n// KIBI_FRESH_PUBLIC_SERVER_20261117_V1\n';
export const FRESH_SERVER_BASELINES=Object.freeze({
 'src/server.mjs':Object.freeze({beforeSha256:'5188e1012d0c1bcd180a53eec1454d1e02e1a8de3762173ad2aae0752d129784',afterSha256:'12f94f7f4ab8c34496b64a1b544f93bbe1ddfe8688a4517985d9607fbebbe194'}),
 'src/project-store.mjs':Object.freeze({beforeSha256:'fc2e665f1c2a074dc872cb65c6a5bf36aafacebf8dc288c3029d0001a617c84f',afterSha256:'78f9315c754f704b605a504d83d41468fc0f85c3f8479a5d8716e9592b8432cb'}),
 'src/codex-bridge.mjs':Object.freeze({beforeSha256:'63d64c4ca48c843fbb389fae6a4d31e0f095e7e54487912421e1629933d0f298',afterSha256:'33b76a49e155767d1499b61583770fb7391f65f19841b56bd1cbed7e20e4b26e'}),
 'native/support.mjs':Object.freeze({beforeSha256:'73b47f2f4640f4f13899549f7ade4548c67d81552fafbd2397938764b4b9301d',afterSha256:'894827e5403bd4c4b161ae77fcbe5c452cf0b5cf9a5ce57503b9434a3c48e9da'}),
 'src/workspace.mjs':Object.freeze({beforeSha256:'8d71a99522be2da5b220d068339f9ac94ab3120de5911f02c647b9d38d4bbba0',afterSha256:'ff153c88b5378cad96b224c51e33f80235d72ebfae73793444457c769d634fd9'}),
});
function one(source,before,after){if(source.split(before).length!==2)throw fail('upgrade_anchor_mismatch');return source.replace(before,after);}

const storeHelpers=`
 const hasImplementation=()=>state.implementationRequested===true||Boolean(state.approvedDesignHash);
 const sameIdentity=value=>Boolean(value&&value.projectId===projectId&&value.sourceHash===snap.sourceHash&&value.sourceRevision===state.sourceRevision&&value.configurationRevision===state.configurationRevision);
 const currentCodeReady=()=>hasImplementation()&&sameIdentity(state.codeReady)?state.codeReady:null;
 const currentTarget=()=>sameIdentity(state.targetDiagnostics)?state.targetDiagnostics:null;
 const currentChecks=()=>sameIdentity(state.nativeChecks)?state.nativeChecks:null;
 const identity=()=>({projectId,sourceHash:snap.sourceHash,sourceRevision:state.sourceRevision,configurationRevision:state.configurationRevision});
 const invalidateEvidence=()=>{state.codeReady=null;state.targetDiagnostics=null;state.nativeChecks=null;};
 const assertIdentity=value=>{if(!sameIdentity(value))throw problem('Исходники или настройки изменились. Повторите проверку.',409);};
`;
const storeMethods=`
  setDeviceVariant:input=>transaction(async()=>{
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'variant'))throw problem('Выберите вариант Киби.');
   const variant=assertDeviceVariant(input.variant),previous=assertDeviceVariant(meta.deviceVariant),name='kibi_device_config.h',file=snap.files.find(item=>item.path===name),oldHeader=deviceVariantHeader(previous);
   if(!file||!file.content.equals(oldHeader)||state.protectedHashes[name]!==sha256(oldHeader))throw problem('Настройки платы изменены вне штатного выбора. Файл сохранён.',409);
   if(variant===previous)return view();
   const header=deviceVariantHeader(variant);await atomic(path.join(sourceDir,name),header,0o644);
   try{meta.deviceVariant=variant;await atomic(path.join(projectDir,'project.json'),JSON.stringify(meta,null,2)+'\\n',0o644);}catch(error){meta.deviceVariant=previous;await atomic(path.join(sourceDir,name),oldHeader,0o644);throw error;}
   state.protectedHashes[name]=sha256(header);state.configurationRevision++;invalidateEvidence();state.build=null;await refresh();return view();
  }),
  installPublicAssets:(input,guard=()=>{})=>transaction(async()=>{
   await guard();if(input?.expectedProjectId!==projectId)throw problem('Активный проект изменился.',409);
   const installed=await installManagedAssets({sourceDir,existingFiles:snap.files,input,guard});
   await guard();Object.assign(state.protectedHashes,installed.hashes);state.approvedDesignHash=null;state.build=null;invalidateEvidence();await refresh();return{paths:installed.paths};
  }),
  installPublicDeviceModule:(input,guard=()=>{})=>transaction(async()=>{
   await guard();if(input?.expectedProjectId!==projectId)throw problem('Активный проект изменился.',409);
   const installed=await installPublicDeviceModule({sourceDir,existingFiles:snap.files,input,guard});
   await guard();Object.assign(state.protectedHashes,installed.hashes);state.approvedDesignHash=null;state.build=null;invalidateEvidence();await refresh();return installed;
  }),
  setNativeChecks:input=>transaction(()=>{assertIdentity(input);state.nativeChecks={...identity(),passed:input.passed===true};if(input.passed!==true)state.codeReady=null;return view();}),
  setTargetDiagnostics:input=>transaction(()=>{assertIdentity(input);if(!['passed','failed'].includes(input.status))throw problem('Некорректный результат проверки.');state.targetDiagnostics={...identity(),status:input.status};if(input.status!=='passed')state.codeReady=null;return view();}),
  markCodeReady:input=>transaction(()=>{
   assertIdentity(input);if(!hasImplementation()||currentChecks()?.passed!==true||currentTarget()?.status!=='passed'||hardwareIssues().length)throw problem('Завершите актуальные проверки приложения.',409);
   if(meta.requirements.wifi&&!settings.wifi?.ssid||meta.requirements.api&&!settings.api?.key)throw problem('Заполните настройки приложения.',409);
   state.readyVersion=(Number.isSafeInteger(state.readyVersion)?state.readyVersion:0)+1;
   state.codeReady={...identity(),version:state.readyVersion,threadId:typeof input.threadId==='string'?input.threadId:null,turnId:typeof input.turnId==='string'?input.turnId:null};return view();
  }),
`;
function storeProgram(bytes){
 let source=patchPortableDesignProgram('src/project-store.mjs',bytes).toString('utf8');
 source=one(source,"import path from 'node:path';","import path from 'node:path';\nimport {installManagedAssets} from './managed-assets.mjs';\nimport {installPublicDeviceModule} from './device-module-install.mjs';\nimport {assertDeviceVariant,deviceVariantHeader} from './device-variants.mjs';");
 source=one(source,'if(files.length>=63||bytes>4*1024*1024)','if(files.length>=96||bytes>4*1024*1024)');
 source=one(source,'return job&&job.sourceHash===snap.sourceHash','return job&&job.projectId===projectId&&job.sourceHash===snap.sourceHash');
 source=one(source,'const {id,status,sourceRevision,sourceHash,configurationRevision,createdAt,finishedAt}=job;','const {id,projectId,status,sourceRevision,sourceHash,configurationRevision,createdAt,finishedAt}=job;');
 source=one(source,'return{id,status,sourceRevision,sourceHash,configurationRevision,createdAt,finishedAt,log,','return{id,projectId,status,sourceRevision,sourceHash,configurationRevision,createdAt,finishedAt,log,');
 source=one(source,'if(state.sourceHash&&state.sourceHash!==snap.sourceHash)state.sourceRevision++;','if(state.sourceHash&&state.sourceHash!==snap.sourceHash){state.sourceRevision++;invalidateEvidence();}');
 source=one(source,' meta.requirements={wifi:meta.requirements?.wifi===true,api:meta.requirements?.api===true};',' meta.deviceVariant=assertDeviceVariant(meta.deviceVariant??\'basic\');\n meta.requirements={wifi:meta.requirements?.wifi===true,api:meta.requirements?.api===true};');
 source=one(source,'const configuration={wifiConfigured:','const configuration={deviceVariant:meta.deviceVariant,wifiConfigured:');
 source=one(source,'const project={id:projectId,name:meta.name,boardId:meta.boardId,requirements:','const project={id:projectId,name:meta.name,boardId:meta.boardId,deviceVariant:meta.deviceVariant,requirements:');
 source=one(source,' const approved=()=>state.approvedDesignHash===snap.designHash;',storeHelpers+' const approved=()=>state.approvedDesignHash===snap.designHash;');
 source=source.replaceAll('Boolean(state.approvedDesignHash)&&editableCode.has','hasImplementation()&&editableCode.has');
 source=one(source,'if(!editableDesign.has(name)&&!state.approvedDesignHash)','if(!editableDesign.has(name)&&!hasImplementation())');
 source=one(source,'getThreadId:()=>state.threadId,','getThreadId:revision=>revision===undefined||state.threadToolsetRevision===revision?state.threadId:null,');
 source=one(source,'setThreadId:threadId=>transaction(()=>{state.threadId=threadId;chat.threadId=threadId;}),','setThreadId:(threadId,revision)=>transaction(()=>{state.threadId=threadId;state.threadToolsetRevision=revision;chat.threadId=threadId;}),');
 source=one(source,'approvedDesignRevision:approved()?state.sourceRevision:null,\n   messages:','approvedDesignRevision:approved()?state.sourceRevision:null,implementationRequested:hasImplementation(),codeReady:currentCodeReady(),targetDiagnostics:currentTarget(),nativeChecks:currentChecks(),\n   messages:');
 source=one(source,'writeSource:({path:value,content,expectedSha256})=>transaction(async()=>{','writeSource:({path:value,content,expectedSha256},guard=()=>{})=>transaction(async()=>{\n   await guard();');
 source=one(source,'   await atomic(path.join(sourceDir,name),content,0o644);','   await guard();await atomic(path.join(sourceDir,name),content,0o644);');
 source=one(source,'setRequirements:input=>transaction(async()=>{','setRequirements:(input,guard=()=>{})=>transaction(async()=>{\n   await guard();');
 source=one(source,'{meta.requirements={...input};await atomic','{await guard();meta.requirements={...input};await atomic');
 source=one(source,'state.approvedDesignHash=snap.designHash;return view();','state.approvedDesignHash=snap.designHash;state.implementationRequested=true;state.codeReady=null;return view();');
 source=source.replaceAll('state.configurationRevision++;','state.configurationRevision++;invalidateEvidence();');
 source=one(source,'  readSource:value=>transaction(()=>{',storeMethods+'  readSource:value=>transaction(()=>{');
 source=one(source,'approvedDesignRevision:approved()?state.sourceRevision:null,configuration:view().configuration','approvedDesignRevision:approved()?state.sourceRevision:null,implementationRequested:hasImplementation(),codeReady:currentCodeReady(),targetDiagnostics:currentTarget(),configuration:view().configuration');
 return source+marker;
}

const serverHelpers=`
 const identity=current=>({projectId:current.project.id,sourceHash:current.sourceHash,sourceRevision:current.revision,configurationRevision:current.configuration.revision});
 const matches=(proof,current)=>Boolean(proof&&proof.projectId===current.project.id&&proof.sourceHash===current.sourceHash&&proof.sourceRevision===current.revision&&proof.configurationRevision===current.configuration.revision);
 const imageCurrent=current=>Boolean(previewState&&previewState.sourceHash===current.sourceHash&&previewState.rendered!==false&&!previewState.diagnostics?.error&&!previewState.diagnostics?.retainedLastGood);
 function readiness(current){return summarizeProjectReadiness({sourcePassed:matches(current.nativeChecks,current)?current.nativeChecks.passed:undefined,implementationRequested:current.implementationRequested,approved:current.implementationRequested===true||current.approvedDesignRevision===current.revision,currentImage:imageCurrent(current),configuration:current.configuration,requirements:current.project.requirements,diagnostics:{sourceHash:current.sourceHash,configurationRevision:current.configuration.revision,status:current.project.requirements.api?'unsupported':'not_required',checks:[]},targetPassed:matches(current.targetDiagnostics,current)?current.targetDiagnostics.status==='passed':undefined});}
 function workflow(current){const report=readiness(current),ready=matches(current.codeReady,current)&&report.passed===true;
  return{phase:building?'building':checking?'checking':current.build?.status==='succeeded'?'succeeded':ready?'ready':current.implementationRequested?'implementation':'design',canBuild:ready&&!building&&!checking&&!current.chat.busy&&!bridge.getStatus().busy,blockers:report.blockers,readiness:report,codeReady:ready?current.codeReady:null};
 }
 async function sourceMutation(action){if(projectChanging||building||checking)throw problem('Дождитесь завершения текущей операции.',409);activeMutations++;try{return await action();}finally{activeMutations--;}}
 function turnGuardFor({projectId,threadId,turnId}={}){
  const activeStore=store,epoch=projectEpoch,generation=turnGeneration;
  return()=>{if(closed||projectChanging||activeStore!==store||epoch!==projectEpoch||generation!==turnGeneration||projectId&&projectId!==store.projectId)throw problem('Проект или запрос изменился. Повторите действие.',409);
   const status=bridge.getStatus();if(threadId&&(status.threadId!==threadId||!status.busy)||turnId&&(status.turnId!==turnId||!status.busy))throw problem('Ответ ИИ уже завершён или отменён.',409);
  };
 }
 async function runChecks({guard=()=>{},threadId,turnId}={}){
  if(checking||building)throw problem('Проверка или сборка уже выполняется.',409);guard();checking=true;activeMutations++;
  const checkStore=store,epoch=projectEpoch;let proof;
  const stillCurrent=async()=>{guard();const current=await checkStore.getState();if(checkStore!==store||epoch!==projectEpoch||!matches(proof,current))throw problem('Исходники или настройки изменились. Повторите проверку.',409);return current;};
  try{
   proof=identity(await checkStore.getState());const checks=await preview.check({sourceDir:checkStore.sourceDir});await stillCurrent();await checkStore.setNativeChecks({...proof,passed:checks.passed===true});let current=await stillCurrent();
   const configured=(!current.project.requirements.wifi||current.configuration.wifiConfigured)&&(!current.project.requirements.api||current.configuration.apiConfigured);
   if(checks.passed===true&&current.implementationRequested&&imageCurrent(current)&&configured&&current.targetDiagnostics?.status!=='passed'){
    let passed=false;
    try{const available=await builder.environment();await stillCurrent();if(available.ready){
      const requirements=current.project.requirements,configuration={wifi_ssid:requirements.wifi?'Kibi-Diagnostic':'',wifi_password:requirements.wifi?'test-only-123':'',...(requirements.api?{api_key:'kibi-diagnostic-key',api_base_url:''}:{})};
      const diagnostic=await builder.start({projectId:checkStore.projectId,sourceDir:checkStore.sourceDir,sourceRevision:current.revision,sourceHash:current.sourceHash,configuration,purpose:'diagnostic',onProgress:()=>{}});
      await stillCurrent();passed=diagnostic?.status==='succeeded'&&diagnostic.sourceHash===current.sourceHash&&diagnostic.sourceRevision===current.revision;
    }}catch(error){await stillCurrent();}
    await checkStore.setTargetDiagnostics({...proof,status:passed?'passed':'failed'});current=await stillCurrent();
   }
   let report=readiness(current);
   if(current.implementationRequested&&report.passed){await checkStore.markCodeReady({...proof,threadId,turnId});current=await stillCurrent();report=readiness(current);}
   await announce();return{...checks,passed:checks.passed===true&&report.passed,nativePassed:checks.passed===true,readiness:report,codeReady:current.codeReady,diagnostics:{status:current.project.requirements.api?'unsupported':'not_required',sourceHash:current.sourceHash,configurationRevision:current.configuration.revision,checks:[]},nextAction:report.blockers[0]?.message||null};
  }finally{checking=false;activeMutations--;await announce().catch(()=>{});}
 }
`;
function serverProgram(bytes){
 let source=patchPortableDesignProgram('src/server.mjs',bytes).toString('utf8');
 source=one(source,"import http from 'node:http';","import http from 'node:http';\nimport {createStudioPlatform,platformTools,platformInstructions} from './studio-platform.mjs';\nimport {summarizeProjectReadiness} from './project-readiness.mjs';");
 source=one(source,'export const dynamicTools=[','export const dynamicTools=[\n ...platformTools,');
 source=one(source,'createStudioServer({root,store,bridge,preview,builder,remoteClient,mode=','createStudioServer({root,store,bridge,bridgeFactory=createCodexBridge,preview,builder,remoteClient,mode=');
 source=one(source,'let environment=await builder.environment(),previewState=null,building=false,buildTask=null,','let checking=false,turnGeneration=0,buildLease=null;const autoIntents=new Map();\n let environment=await builder.environment(),previewState=null,building=false,buildTask=null,');
 source=one(source," const developerText=await readFile(path.join(root,'prompts/agent-system.md'),'utf8').catch(()=> 'Use Kibi dynamic tools only. Never request or read credentials.');"," const platform=await createStudioPlatform({root,getStore:()=>store,getEpoch:()=>projectEpoch,announce:()=>announce(),mutate:sourceMutation});\n const developerText=(await readFile(path.join(root,'prompts/agent-system.md'),'utf8').catch(()=> 'Use Kibi dynamic tools only. Never request or read credentials.'))+'\\n'+platformInstructions;\n const toolsetRevision=sha256(JSON.stringify({tools:dynamicTools,instructions:developerText}));");
 source=one(source,' async function state(){',serverHelpers+' async function state(){');
 source=one(source,'return{...current,...projectList,activeProjectId:','return{...current,readiness:readiness(current),workflow:workflow(current),...projectList,activeProjectId:');
 source=one(source,'await workspace.select(id);store=next;projectEpoch++;previewState=null;','await workspace.select(id);store=next;projectEpoch++;turnGeneration++;autoIntents.clear();previewState=null;');
 source=one(source,"const activeStore=store,epoch=projectEpoch,frame=await preview.render({sourceDir:activeStore.sourceDir,scenario,input});","const activeStore=store,epoch=projectEpoch,before=await activeStore.getState(),frame=await preview.render({sourceDir:activeStore.sourceDir,scenario,input});\n  const current=await activeStore.getState();if(before.sourceHash!==current.sourceHash||before.revision!==current.revision)throw problem('Исходники изменились. Обновите предпросмотр.',409);");
 source=one(source,'async function tools({tool,arguments:args={},projectId}){','async function tools({tool,arguments:args={},projectId,threadId,turnId}){\n  const turnGuard=turnGuardFor({projectId,threadId,turnId});turnGuard();');
 source=one(source,"if(tool==='kibi_project_context')return{...await store.getAgentContext(),preview:previewState};","if(tool==='kibi_project_context')return{...await store.getAgentContext(),...await platform.context(),readiness:readiness(await store.getState()),preview:previewState};\n  const platformResult=await platform.tool(tool,args,turnGuard);if(platformResult.handled)return platformResult.result;");
 source=one(source,'const project=await store.setRequirements(args);','const project=await sourceMutation(()=>{turnGuard();return store.setRequirements(args,turnGuard);});');
 source=one(source,'const result=await store.writeSource(args);','const result=await sourceMutation(()=>store.writeSource(args,turnGuard));');
 source=one(source,"if(tool==='kibi_check')return preview.check({sourceDir:store.sourceDir});","if(tool==='kibi_check')return runChecks({guard:turnGuard,threadId,turnId});");
 source=one(source,"  const safe={...event};","  if(['chat.status','chat.completed','chat.error'].includes(event.type)){const current=await eventStore.getState(),status=bridge.getStatus();if(event.turnId&&(current.chat.turnId&&current.chat.turnId!==event.turnId||eventStore===store&&status.turnId&&status.turnId!==event.turnId))return;if(event.type==='chat.error'&&!event.turnId&&current.chat.turnId)return;}\n  const safe={...event};");
 source=one(source,"  if(event.type==='chat.completed'){\n   const current=await eventStore.getState();","  if(event.type==='chat.completed'){\n   const current=await eventStore.getState();if(current.chat.turnId&&current.chat.turnId!==event.turnId)return;");
 source=one(source,"if(event.type==='chat.error')await eventStore.setChat({busy:false,error:safe.error});","if(event.type==='chat.error'){autoIntents.delete(eventStore.projectId);await eventStore.setChat({busy:false,error:safe.error});}");
 source=one(source,"if(event.type==='chat.status')await eventStore.setChat({turnId:event.turnId,busy:true});","if(event.type==='chat.status'){await eventStore.setChat({turnId:event.turnId,busy:true});const intent=autoIntents.get(eventStore.projectId);if(intent&&intent.epoch===projectEpoch&&event.turnId){if(intent.turnId&&intent.turnId!==event.turnId)autoIntents.delete(eventStore.projectId);else Object.assign(intent,{threadId:event.threadId,turnId:event.turnId});}}");
 source=one(source,"  if(eventStore!==store)return;\n  emit(event.type,safe);","  if(eventStore!==store)return;\n  if(event.type==='chat.completed'){const intent=autoIntents.get(eventStore.projectId);autoIntents.delete(eventStore.projectId);const current=await eventStore.getState(),ready=current.codeReady;\n   if(event.status==='completed'&&intent&&intent.epoch===projectEpoch&&intent.generation===turnGeneration&&intent.threadId===event.threadId&&intent.turnId===event.turnId&&ready&&ready.version>intent.readyVersion&&ready.threadId===event.threadId&&ready.turnId===event.turnId&&matches(ready,current)){try{await startBuild(current.revision,{expectedReadyVersion:ready.version,guard:()=>{const status=bridge.getStatus();if(intent.epoch!==projectEpoch||intent.generation!==turnGeneration||status.busy||status.threadId!==event.threadId||status.turnId!==event.turnId)throw problem('Запрос ИИ изменился. Повторите сборку актуального проекта.',409);}});}catch(error){emit('build.blocked',{message:eventStore.redact(error.message)});}}\n  }\n  emit(event.type,safe);");
 source=one(source,'bridge??=createCodexBridge({root,onToolCall:tools,onEvent:event=>{void chatEvent(event).catch(()=>emit(\'chat.error\',{error:\'Не удалось сохранить ответ.\'}));},','bridge??=bridgeFactory({root,onToolCall:tools,onEvent:event=>chatEvent(event).catch(()=>emit(\'chat.error\',{error:\'Не удалось сохранить ответ.\'})),');
 source=one(source,'async function startBuild(revision){','async function startBuild(revision,{guard:buildIntentGuard=()=>{},expectedReadyVersion}={}){');
 source=one(source,"  const buildStore=store;\n  if(building)","  const buildStore=store,epoch=projectEpoch,generation=turnGeneration,bridgeIdentity=bridge.getStatus();let lease=null;\n  const prepareGuard=()=>{buildIntentGuard();const status=bridge.getStatus();if(lease&&buildLease!==lease||closed||projectChanging||buildStore!==store||epoch!==projectEpoch||generation!==turnGeneration||checking||chatStarting||status.busy||status.threadId!==bridgeIdentity.threadId||status.turnId!==bridgeIdentity.turnId)throw problem('Проект или запрос ИИ изменился. Дождитесь ответа и повторите сборку.',409);};\n  prepareGuard();\n  if(building||buildLease)");
 source=one(source,"if(building||buildLease)throw problem('Сборка уже выполняется.',409);","if(building||buildLease)throw problem('Сборка уже выполняется.',409);\n  lease={};buildLease=lease;building=true;let handedOff=false;\n  const releaseLease=()=>{if(buildLease===lease){buildLease=null;building=false;}};\n  try{");
 source=one(source,'  const current=await buildStore.getState();','  const current=await buildStore.getState();prepareGuard();if(current.chat.busy)throw problem(\'Дождитесь завершения ответа ИИ перед сборкой.\',409);');
 source=one(source,"if(revision!==current.revision||current.approvedDesignRevision!==current.revision)throw problem('Сначала утвердите актуальный макет.',409);","if(revision!==current.revision||!current.implementationRequested||!matches(current.codeReady,current)||!readiness(current).passed)throw problem('Нажмите «Проект готов» и завершите актуальные проверки кода.',409);");
 source=one(source,'const configuration=await buildStore.getBuildConfiguration();if(remote)environment=await builder.environment();','const configuration=await buildStore.getBuildConfiguration();prepareGuard();if(remote){environment=await builder.environment();prepareGuard();}');
 source=one(source,'  const configurationRevision=current.configuration.revision;','  const proofVersion=expectedReadyVersion??current.codeReady.version;\n  const fresh=await buildStore.getState();prepareGuard();if(!matches(identity(current),fresh)||!matches(fresh.codeReady,fresh)||fresh.codeReady.version!==proofVersion)throw problem(\'Исходники, настройки или итоговая проверка изменились. Повторите проверку.\',409);\n  const configurationRevision=current.configuration.revision;');
 source=one(source,'building=true;await buildStore.setBuild(queued);jobs.set(queued.id,queued);',"try{await buildStore.setBuild(queued);prepareGuard();const reserved=await buildStore.getState();prepareGuard();if(!matches(identity(current),reserved)||!matches(reserved.codeReady,reserved)||reserved.codeReady.version!==proofVersion)throw problem('Исходники, настройки или итоговая проверка изменились. Повторите проверку.',409);jobs.set(queued.id,queued);}catch(error){try{await buildStore.setBuild({...queued,status:'failed',finishedAt:new Date().toISOString(),error:'Подготовка сборки отменена: проект или запрос изменился.'});}finally{releaseLease();await announce().catch(()=>{});}throw error;}");
 source=one(source,'   try{\n    const result=await builder.start','   try{\n    prepareGuard();const result=await builder.start');
 source=one(source,'finally{building=false;await announce().catch(()=>{});}','finally{releaseLease();await announce().catch(()=>{});}');
 source=one(source,'  void buildTask.catch(error=>','  handedOff=true;\n  void buildTask.catch(error=>');
 source=one(source,'  return announce();\n }\n async function exportZip(response){','  return announce();\n  }finally{if(!handedOff)releaseLease();}\n }\n async function exportZip(response){');
 source=one(source,"   if(request.method==='GET'&&route==='/api/state')", "   if(await platform.route(request,response,{route,body,send}))return;\n   if(request.method==='GET'&&route==='/api/state')");
 source=one(source,"await store.writeSource(await body(request));","await sourceMutation(()=>store.writeSource(input));");
 // The source route must parse JSON before entering the serialized mutation.
 source=one(source,"if(request.method==='POST'&&route==='/api/source'){const result=", "if(request.method==='POST'&&route==='/api/source'){const input=await body(request);const result=");
 source=one(source,"if(request.method==='POST'&&route==='/api/design/approve'){await store.approveDesign((await body(request)).revision);return send(response,await announce());}","if(request.method==='POST'&&['/api/project/ready','/api/design/approve'].includes(route)){const input=await body(request);await sourceMutation(()=>store.approveDesign(input.revision));const current=await store.getState();autoIntents.set(store.projectId,{epoch:projectEpoch,generation:turnGeneration,readyVersion:current.codeReady?.version||0,pending:true});return send(response,await announce());}");
 source=one(source,"if(request.method==='POST'&&route==='/api/settings'){", "if(request.method==='POST'&&route==='/api/device/variant'){const input=await body(request);await sourceMutation(()=>store.setDeviceVariant(input));previewState=null;return send(response,await announce());}\n   if(request.method==='POST'&&route==='/api/settings'){");
 source=one(source,"await store.addMessage({role:'user',text,attachments:imageMetadata});","const pendingIntent=autoIntents.get(store.projectId);turnGeneration++;if(pendingIntent?.pending){const before=await store.getState();autoIntents.set(store.projectId,{epoch:projectEpoch,generation:turnGeneration,readyVersion:before.codeReady?.version||0,pending:false});}else autoIntents.delete(store.projectId);\n    await store.addMessage({role:'user',text,attachments:imageMetadata});");
 source=one(source,"const context={...await store.getAgentContext(),preview:previewState};","const context={...await store.getAgentContext(),...await platform.context(),readiness:readiness(await store.getState()),preview:previewState};");
 source=one(source,'store.getThreadId()||undefined','store.getThreadId(toolsetRevision)||undefined');
 source=one(source,'await store.setThreadId(info.threadId);','await store.setThreadId(info.threadId,toolsetRevision);const intent=autoIntents.get(store.projectId);if(intent&&!intent.pending){if(intent.turnId&&intent.turnId!==info.turnId)autoIntents.delete(store.projectId);else Object.assign(intent,{threadId:info.threadId,turnId:info.turnId});}');
 source=one(source,"catch(error){await store.setChat({busy:false,error:store.redact(error.message)});","catch(error){autoIntents.delete(store.projectId);await store.setChat({busy:false,error:store.redact(error.message)});");
 source=one(source,"if(request.method==='POST'&&route==='/api/chat/interrupt'){const current=", "if(request.method==='POST'&&route==='/api/chat/interrupt'){turnGeneration++;autoIntents.delete(store.projectId);const current=");
 source=one(source,"if(request.method==='POST'&&route==='/api/check'){const epoch=projectEpoch,result=await preview.check({sourceDir:store.sourceDir});if(epoch!==projectEpoch)throw problem('Проект изменился. Повторите проверку.',409);return send(response,result);}","if(request.method==='POST'&&route==='/api/check')return send(response,await runChecks());");
 source=one(source,"server.on('close',()=>{closed=true;", "server.on('close',()=>{closed=true;turnGeneration++;autoIntents.clear();void platform.close();");
 source=one(source,"shutdown:async()=>{closed=true;", "shutdown:async()=>{closed=true;turnGeneration++;autoIntents.clear();await platform.close();");
 return source+marker;
}

function transform(path,bytes){
 if(path==='src/server.mjs')return Buffer.from(serverProgram(bytes));
 if(path==='src/project-store.mjs')return Buffer.from(storeProgram(bytes));
 let source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 if(path==='src/codex-bridge.mjs'){
  source=one(source,"import { spawn } from 'node:child_process';","import { spawn } from 'node:child_process';\nimport {platformTools} from './studio-platform.mjs';");
  source=one(source,'const TOOL_NAMES = new Set([','const TOOL_NAMES = new Set([...platformTools.map(tool=>tool.name),');
  source=one(source,'Sign in to Codex with a ChatGPT account to use Studio chat. API-key accounts are not supported.','Откройте «Запустить Киби Studio.command» в папке Studio и завершите официальный вход в свой ChatGPT. Для чата Studio нужен аккаунт ChatGPT; API-ключ не подходит.');
 }else if(path==='native/support.mjs'){
  source=one(source,'if(files.length>63||total>4*1024*1024)','if(files.length>96||total>4*1024*1024)');
  source=one(source,'Public source exceeds 63-file / 4MiB limit','Public source exceeds 96-file / 4MiB limit');
 }else if(path==='src/workspace.mjs'){
  source=one(source,'manifest.files.length>66','manifest.files.length>100');
 }else throw fail('upgrade_unknown_baseline',path);
 return Buffer.from(source+marker);
}

export function upgradeFreshServerProgram(path,bytes){
 const pin=FRESH_SERVER_BASELINES[path];
 if(!pin||!(bytes instanceof Uint8Array))throw fail('upgrade_unknown_baseline',path);
 const actual=digest(bytes);if(actual===pin.afterSha256)return Buffer.from(bytes);
 if(actual!==pin.beforeSha256)throw fail('upgrade_unknown_baseline',path);
 const output=transform(path,Buffer.from(bytes));
 if(digest(output)!==pin.afterSha256)throw fail('upgrade_transform_mismatch',path,{actualSha256:digest(output)});
 return output;
}
