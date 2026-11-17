import http from 'node:http';
import {createStudioPlatform,platformTools,platformInstructions} from './studio-platform.mjs';
import {summarizeProjectReadiness} from './project-readiness.mjs';
import {readFile,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createProjectStore,problem,sha256} from './project-store.mjs';
import {createWorkspace} from './workspace.mjs';
import {createAttachmentStore} from './attachments.mjs';
import {createCodexBridge} from './codex-bridge.mjs';
import {createNativePreview} from './native-preview.mjs';
import {createBuildService} from './build-service.mjs';
import {createRemoteClient} from './remote-client.mjs';
import {createRemoteBuildService} from './remote-build-service.mjs';
import {createRemotePreview} from './remote-preview-service.mjs';
import {encodeZip} from './source-zip.mjs';
import {rgbPng} from './png.mjs';

export const dynamicTools=[
 ...platformTools,
 {type:'function',name:'kibi_project_context',description:'Read the active Kibi board profile, project state, source revisions, edit permissions and configuration flags. Never returns credentials.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {type:'function',name:'kibi_read_source',description:'Read a public firmware source and its SHA256. Protected drivers are readable but cannot be changed.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
 {type:'function',name:'kibi_write_source',description:'Edit an allowed Kibi source with optimistic SHA256 check. app_core.h (portable state/input) and app_view.h are editable for design; app_feature.h requires explicit design approval. Fixed hardware adapters and drivers cannot be modified.',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'},expectedSha256:{type:'string'}},required:['path','content','expectedSha256'],additionalProperties:false}},
 {type:'function',name:'kibi_set_requirements',description:'Declare whether the agreed application needs Wi-Fi or a service API key. Only flags are set; the user enters values in Settings. Do not require these for offline modules.',inputSchema:{type:'object',properties:{wifi:{type:'boolean'},api:{type:'boolean'}},required:['wifi','api'],additionalProperties:false}},
 {type:'function',name:'kibi_preview',description:'Compile and SEE the actual native 240x296 firmware framebuffer. Optional button/tap/swipe input uses the shared application reducer. Returns an image and source hash. Check diagnostics: a retained image is not proof that the attempted source compiled.',inputSchema:{type:'object',properties:{scenario:{type:'string',enum:['ready','loading','offline','stale']},input:{type:'object',properties:{type:{type:'string',enum:['plus','minus','tap','swipe']},x:{type:'integer'},y:{type:'integer'},dx:{type:'integer'},dy:{type:'integer'},durationMs:{type:'integer'}},required:['type'],additionalProperties:false}},additionalProperties:false}},
 {type:'function',name:'kibi_check',description:'Run native compiler, framebuffer guards, hit targets and shared button/action checks for the active Kibi source. This does not emulate hardware peripherals or flash a board.',inputSchema:{type:'object',properties:{},additionalProperties:false}}
];
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.ttf':'font/ttf','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'};
const SCENARIOS=new Set(['ready','loading','offline','stale']);
const artifactNames=new Set(['app.bin','bootloader.bin','partitions.bin','boot_app0.bin']);
const artifactKind=name=>({'app.bin':'app','bootloader.bin':'bootloader','partitions.bin':'partitions','boot_app0.bin':'otadata'})[name];
export async function createStudioServer({root,store,bridge,bridgeFactory=createCodexBridge,preview,builder,remoteClient,mode=process.env.KIBI_STUDIO_MODE||'remote'}={}){
 root=await realpath(path.resolve(root));const workspace=await createWorkspace({root,...(store?{initialProjectId:store.projectId}:{})});store??=await createProjectStore({root,projectId:workspace.activeProjectId()});
 const stores=new Map([[store.projectId,store]]);let projectEpoch=0,projectChanging=false,activeMutations=0,chatStarting=false;
 const attachments=await createAttachmentStore({root});
 const remote=mode==='remote'&&(!preview||!builder||Boolean(remoteClient));
 if(remote){remoteClient??=createRemoteClient();preview??=createRemotePreview({root,client:remoteClient});builder??=createRemoteBuildService({root,client:remoteClient});}
 else{preview??=createNativePreview({root});builder??=createBuildService({root});}
 const token=randomBytes(32).toString('hex'),clients=new Set(),approvals=new Map(),jobs=new Map();
 let checking=false,turnGeneration=0,buildLease=null;const autoIntents=new Map();
 let environment=await builder.environment(),previewState=null,building=false,buildTask=null,lastRevision=(await store.getState()).revision,closed=false;
 const attachmentFailure=(code,status)=>Object.assign(problem(code==='attachment_project_changed'?'Проект изменился. Повторите действие с фото.':'Отправленное фото не найдено в текущем проекте.',status),{code});
 function attachmentScope({projectId,generation}={}){
  const target=store,epoch=projectEpoch;
  const guard=()=>{if(closed||projectChanging||target!==store||epoch!==projectEpoch||projectId!==target.projectId||!Number.isSafeInteger(generation)||generation!==epoch)throw attachmentFailure('attachment_project_changed',409);};
  guard();return{target,projectId,guard};
 }
 async function sentPhotoIds(scope){
  scope.guard();const current=await scope.target.getState();scope.guard();const ids=new Map();
  for(const message of current.messages||[])if(message.role==='user')for(const item of message.attachments||[])if(/^[a-f0-9]{32}$/.test(item.id)){ids.delete(item.id);ids.set(item.id,true);}
  return[...ids.keys()].slice(-32);
 }
 async function readSentPhoto(scope,id){
  scope.guard();let file;
  try{file=await attachments.get({projectId:scope.projectId,id});}catch(error){scope.guard();throw attachmentFailure('attachment_not_found',404);}
  scope.guard();return file;
 }
 async function getAttachmentDescriptors(input){
  const scope=attachmentScope(input),ids=await sentPhotoIds(scope),result=[];scope.guard();
  for(const[index,id]of ids.entries()){const file=await readSentPhoto(scope,id);scope.guard();result.push({id,index:index+1,mime:file.mime,width:file.metadata.width,height:file.metadata.height,sha256:sha256(file.bytes)});}
  scope.guard();return result;
 }
 async function resolveAttachment(input){
  const scope=attachmentScope(input),ids=await sentPhotoIds(scope),id=input.id;scope.guard();
  if(typeof id!=='string'||!ids.includes(id))throw attachmentFailure('attachment_not_found',404);
  const file=await readSentPhoto(scope,id);scope.guard();return{id,mimeType:file.mime,dataBuffer:file.bytes,width:file.metadata.width,height:file.metadata.height};
 }
 const platform=await createStudioPlatform({root,getStore:()=>store,getEpoch:()=>projectEpoch,announce:()=>announce(),mutate:sourceMutation,resolveAttachment,getAttachmentDescriptors});
 const developerText=(await readFile(path.join(root,'prompts/agent-system.md'),'utf8').catch(()=> 'Use Kibi dynamic tools only. Never request or read credentials.'))+'\n'+platformInstructions;
 const toolsetRevision=sha256(JSON.stringify({tools:dynamicTools,instructions:developerText}));
 const emit=(type,payload)=>{
  const encoded=`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for(const client of clients){if(client.destroyed||client.writableLength>512*1024){client.destroy();clients.delete(client);}else client.write(encoded);}
 };

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
 async function state(){const activeStore=store,epoch=projectEpoch,current=await activeStore.getState();if(epoch!==projectEpoch)return state();const projectList=await workspace.list();if(epoch!==projectEpoch)return state();const session=remote?remoteClient.status():null,connected=remote&&(session.connected??session.signedIn)===true,cloud=remote?{mode:'remote',signedIn:session.signedIn===true,connected,sessionMode:'local'}:{mode:'local',signedIn:false,connected:false};
  const visibleEnvironment=remote&&!connected?{...environment,ready:false,issues:environment.issues?.length?environment.issues:['Не удалось подключиться к серверу Киби. Проверьте интернет и повторите подключение.']}:environment;
  return{...current,readiness:readiness(current),workflow:workflow(current),...projectList,activeProjectId:activeStore.projectId,projectEpoch:epoch,chat:{...current.chat,...bridge.getStatus(),threadId:current.chat.threadId,turnId:current.chat.turnId,busy:Boolean(current.chat.busy||bridge.getStatus().busy),approvals:[...approvals.values()].map(a=>({...a,description:activeStore.redact(a.description)}))},environment:visibleEnvironment,cloud,preview:previewState,csrfToken:token};}
 const announce=async()=>{const current=await state();emit('state',current);return current;};
 async function changeProject(input,create=false,expectedProjectId){
  if(expectedProjectId&&expectedProjectId!==store.projectId)throw problem('Активный проект изменился. Обновите страницу.',409);
  if(!input||typeof input!=='object'||Array.isArray(input)||!create&&(Object.keys(input).length!==1||typeof input.projectId!=='string'))throw problem('Укажите проект для открытия.');
  if(projectChanging)throw problem('Проект уже переключается.',409);projectChanging=true;
  try{
   if(activeMutations||building||bridge.getStatus().busy||(await store.getState()).chat.busy||approvals.size)throw problem('Дождитесь завершения текущей операции перед сменой проекта.',409);
   const id=create?await workspace.create(input):input.projectId;
   try{await workspace.get(id);}catch(error){if(error.code==='ENOENT')throw problem('Проект не найден.',404);throw error;}
   let next=stores.get(id);if(!next){next=await createProjectStore({root,projectId:id});stores.set(id,next);}
   await workspace.select(id);store=next;projectEpoch++;turnGeneration++;autoIntents.clear();previewState=null;jobs.clear();lastRevision=(await store.getState()).revision;
   return await announce();
  }finally{projectChanging=false;}
 }
 async function nativeFrame(scenario='ready',input){
  if(!SCENARIOS.has(scenario))throw problem('Неизвестное состояние предпросмотра.');
  const activeStore=store,epoch=projectEpoch,before=await activeStore.getState(),frame=await preview.render({sourceDir:activeStore.sourceDir,scenario,input});
  const current=await activeStore.getState();if(before.sourceHash!==current.sourceHash||before.revision!==current.revision)throw problem('Исходники изменились. Обновите предпросмотр.',409);
  if(epoch!==projectEpoch)throw problem('Проект изменился. Обновите предпросмотр.',409);
  if(!Buffer.isBuffer(frame.rgb)||frame.rgb.length!==213120||frame.width!==240||frame.height!==296)throw problem('Некорректный нативный кадр.',500);
  previewState={sourceHash:frame.sourceHash,scenario,state:frame.state??null,diagnostics:frame.diagnostics||{},action:frame.action||'none',lastInteraction:input?{input,action:frame.action||'none',sourceHash:frame.sourceHash,at:Date.now()}:previewState?.lastInteraction??null};
  return frame;
 }
 async function tools({tool,arguments:args={},projectId,threadId,turnId}){
  const turnGuard=turnGuardFor({projectId,threadId,turnId});turnGuard();
  if(projectChanging||projectId&&projectId!==store.projectId)throw problem('Активный проект изменился.',409);
  if(!args||typeof args!=='object'||Array.isArray(args))throw problem('Некорректные аргументы инструмента.');
  if(tool==='kibi_project_context')return{...await store.getAgentContext(),...await platform.context(),readiness:readiness(await store.getState()),preview:previewState};
  const platformResult=await platform.tool(tool,args,turnGuard);if(platformResult.handled)return platformResult.result;
  if(tool==='kibi_read_source')return store.readSource(args.path);
  if(tool==='kibi_set_requirements'){const project=await sourceMutation(()=>{turnGuard();return store.setRequirements(args,turnGuard);});await announce();return project;}
  if(tool==='kibi_write_source'){
   const result=await sourceMutation(()=>store.writeSource(args,turnGuard));await announce();emit('preview.updated',{revision:result.revision});return result;
  }
  if(tool==='kibi_preview'){
   try{const frame=await nativeFrame(args.scenario||'ready',args.input);emit('preview.updated',{sourceHash:frame.sourceHash});
    return{...previewState,width:240,height:296,__kibiPreviewImage:'data:image/png;base64,'+rgbPng(frame.rgb).toString('base64')};
   }catch(error){
    // Native preview receives public source only, never personalized build inputs.
    previewState={sourceHash:(await store.getState()).sourceHash,diagnostics:{error:store.redact(error.message).slice(0,12000),retainedLastGood:false},rendered:false};
    return{...previewState,width:240,height:296};
   }
  }
  if(tool==='kibi_check')return runChecks({guard:turnGuard,threadId,turnId});
  throw problem('Инструмент запрещён.',403);
 }
 async function chatEvent(event){
  const eventStore=event.projectId?stores.get(event.projectId):store;if(!eventStore)return;
  if(['chat.status','chat.completed','chat.error'].includes(event.type)){const current=await eventStore.getState(),status=bridge.getStatus();if(event.turnId&&(current.chat.turnId&&current.chat.turnId!==event.turnId||eventStore===store&&status.turnId&&status.turnId!==event.turnId))return;if(event.type==='chat.error'&&!event.turnId&&current.chat.turnId)return;}
  const safe={...event};
  if(safe.text)safe.text=eventStore.redact(safe.text);if(safe.error)safe.error=eventStore.redact(safe.error);
  if(event.type==='chat.delta')await eventStore.appendDelta({itemId:event.itemId||event.turnId||'answer',turnId:event.turnId,text:safe.text||''});
  if(event.type==='chat.completed'){
   const current=await eventStore.getState();if(current.chat.turnId&&current.chat.turnId!==event.turnId)return;
   if(safe.text&&!current.messages.some(m=>m.role==='assistant'&&m.turnId===event.turnId))await eventStore.addMessage({role:'assistant',text:safe.text,turnId:event.turnId,status:event.status});
   await eventStore.completeMessages({turnId:event.turnId,status:event.status});await eventStore.setChat({busy:false,turnId:null,error:event.status==='failed'?'Ответ не завершён. Повторите запрос.':null});
  }
  if(event.type==='chat.error'){autoIntents.delete(eventStore.projectId);await eventStore.setChat({busy:false,error:safe.error});}
  if(event.type==='chat.status'){await eventStore.setChat({turnId:event.turnId,busy:true});const intent=autoIntents.get(eventStore.projectId);if(intent&&intent.epoch===projectEpoch&&event.turnId){if(intent.turnId&&intent.turnId!==event.turnId)autoIntents.delete(eventStore.projectId);else Object.assign(intent,{threadId:event.threadId,turnId:event.turnId});}}
  if(eventStore!==store)return;
  if(event.type==='chat.completed'){const intent=autoIntents.get(eventStore.projectId);autoIntents.delete(eventStore.projectId);const current=await eventStore.getState(),ready=current.codeReady;
   if(event.status==='completed'&&intent&&intent.epoch===projectEpoch&&intent.generation===turnGeneration&&intent.threadId===event.threadId&&intent.turnId===event.turnId&&ready&&ready.version>intent.readyVersion&&ready.threadId===event.threadId&&ready.turnId===event.turnId&&matches(ready,current)){try{await startBuild(current.revision,{expectedReadyVersion:ready.version,guard:()=>{const status=bridge.getStatus();if(intent.epoch!==projectEpoch||intent.generation!==turnGeneration||status.busy||status.threadId!==event.threadId||status.turnId!==event.turnId)throw problem('Запрос ИИ изменился. Повторите сборку актуального проекта.',409);}});}catch(error){emit('build.blocked',{message:eventStore.redact(error.message)});}}
  }
  emit(event.type,safe);
  if(event.type==='chat.completed'||event.type==='chat.error')await announce();
 }
 bridge??=bridgeFactory({root,onToolCall:tools,onEvent:event=>chatEvent(event).catch(()=>emit('chat.error',{error:'Не удалось сохранить ответ.'})),onApproval:async request=>{approvals.set(request.requestId,request);emit('approval.request',request);}});
 function headers(response,type='application/json; charset=utf-8'){
  response.setHeader('Content-Type',type);response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 }
 function send(response,data,status=200){headers(response);response.statusCode=status;response.end(JSON.stringify(data));}
 function guard(request){
  const address=server.address(),expectedPort=typeof address==='object'?address?.port:null;
  if(![`127.0.0.1:${expectedPort}`,`localhost:${expectedPort}`].includes(request.headers.host))throw problem('Доступен только локальный редактор.',403);
  const expectedOrigin=`http://${request.headers.host}`;
  if(request.headers.origin&&request.headers.origin!==expectedOrigin)throw problem('Запрос с другого сайта запрещён.',403);
  const topLevelDocument=['GET','HEAD'].includes(request.method)&&['/','/index.html'].includes(request.url.split('?')[0])&&request.headers['sec-fetch-mode']==='navigate'&&request.headers['sec-fetch-dest']==='document';
  if(request.headers['sec-fetch-site']==='cross-site'&&!topLevelDocument)throw problem('Межсайтовый запрос запрещён.',403);
  if(!['GET','HEAD'].includes(request.method)&&request.headers['x-studio-token']!==token)throw problem('Обновите страницу редактора.',403);
 }
 async function body(request){
  if(!String(request.headers['content-type']||'').startsWith('application/json'))throw problem('Ожидается JSON.');
  let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>2*1024*1024)throw problem('Слишком большой запрос.',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw problem('Некорректный JSON.');}
 }
 function findJob(id){const mapped=jobs.get(id),job=mapped||store.getBuild();if(!job||(!mapped&&job.id!==id))throw problem('Сборка не найдена.',404);return job;}
 async function requireCurrentJob(job){const current=await store.getState();if(job.projectId&&job.projectId!==store.projectId)throw problem('Сборка принадлежит другому проекту.',409);if(job.sourceHash!==current.sourceHash||job.sourceRevision!==current.revision||job.configurationRevision!==current.configuration.revision)throw problem('Сборка устарела: исходники или настройки изменились. Соберите прошивку заново.',409);}
 async function artifact(response,job,name){
  await requireCurrentJob(job);
  if(!artifactNames.has(name))throw problem('Файл не найден.',404);
  const file=job.artifacts?.find(f=>f.name===name);if(!file||job.status!=='succeeded')throw problem('Файл сборки недоступен.',404);
  const artifactRoot=path.join(root,'.studio/jobs',job.id,'artifacts'),canonical=await realpath(file.path);
  if(canonical!==path.join(artifactRoot,name)||(await lstat(file.path)).isSymbolicLink())throw problem('Путь файла сборки запрещён.',403);
  const bytes=await readFile(canonical);if(bytes.length!==file.size||sha256(bytes)!==file.sha256)throw problem('Файл сборки изменён. Соберите проект заново.',409);
  headers(response,'application/octet-stream');response.setHeader('Content-Disposition',`attachment; filename="kibi-${name}"`);response.end(bytes);
 }
 async function startBuild(revision,{guard:buildIntentGuard=()=>{},expectedReadyVersion}={}){
  const buildStore=store,epoch=projectEpoch,generation=turnGeneration,bridgeIdentity=bridge.getStatus();let lease=null;
  const prepareGuard=()=>{buildIntentGuard();const status=bridge.getStatus();if(lease&&buildLease!==lease||closed||projectChanging||buildStore!==store||epoch!==projectEpoch||generation!==turnGeneration||checking||chatStarting||status.busy||status.threadId!==bridgeIdentity.threadId||status.turnId!==bridgeIdentity.turnId)throw problem('Проект или запрос ИИ изменился. Дождитесь ответа и повторите сборку.',409);};
  prepareGuard();
  if(building||buildLease)throw problem('Сборка уже выполняется.',409);
  lease={};buildLease=lease;building=true;let handedOff=false;
  const releaseLease=()=>{if(buildLease===lease){buildLease=null;building=false;}};
  try{
  const current=await buildStore.getState();prepareGuard();if(current.chat.busy)throw problem('Дождитесь завершения ответа ИИ перед сборкой.',409);
  if(revision!==current.revision||!current.implementationRequested||!matches(current.codeReady,current)||!readiness(current).passed)throw problem('Нажмите «Проект готов» и завершите актуальные проверки кода.',409);
  if(current.hardwareIssues.length)throw problem('Защищённые драйверы изменены.',409);
  const configuration=await buildStore.getBuildConfiguration();prepareGuard();if(remote){environment=await builder.environment();prepareGuard();}if(!environment.ready)throw problem('Компилятор не готов: '+environment.issues.join('; '),409);
  const proofVersion=expectedReadyVersion??current.codeReady.version;
  const fresh=await buildStore.getState();prepareGuard();if(!matches(identity(current),fresh)||!matches(fresh.codeReady,fresh)||fresh.codeReady.version!==proofVersion)throw problem('Исходники, настройки или итоговая проверка изменились. Повторите проверку.',409);
  const configurationRevision=current.configuration.revision;
  const queued={id:randomUUID(),projectId:buildStore.projectId,status:'queued',sourceRevision:current.revision,sourceHash:current.sourceHash,configurationRevision,createdAt:new Date().toISOString(),artifacts:[],log:''};
  try{await buildStore.setBuild(queued);prepareGuard();const reserved=await buildStore.getState();prepareGuard();if(!matches(identity(current),reserved)||!matches(reserved.codeReady,reserved)||reserved.codeReady.version!==proofVersion)throw problem('Исходники, настройки или итоговая проверка изменились. Повторите проверку.',409);jobs.set(queued.id,queued);}catch(error){try{await buildStore.setBuild({...queued,status:'failed',finishedAt:new Date().toISOString(),error:'Подготовка сборки отменена: проект или запрос изменился.'});}finally{releaseLease();await announce().catch(()=>{});}throw error;}
  buildTask=(async()=>{
   try{
    prepareGuard();const result=await builder.start({projectId:buildStore.projectId,sourceDir:buildStore.sourceDir,sourceRevision:current.revision,sourceHash:current.sourceHash,configuration,
     onProgress:progress=>{void(async()=>{const job={...queued,...progress,configurationRevision};jobs.set(job.id,job);jobs.set(queued.id,job);const visible=await buildStore.setBuild(job);emit('build.progress',{id:job.id,status:job.status,log:visible.log});await announce();})().catch(()=>{});}});
    result.projectId=queued.projectId;result.configurationRevision=configurationRevision;for(const a of result.artifacts||[])a.url=`/api/configurator/jobs/${result.id}/files/${a.name}`;
    jobs.set(result.id,result);jobs.set(queued.id,result);await buildStore.setBuild(result);emit('build.completed',{id:result.id,status:result.status});
   }catch(error){const failed={...queued,status:'failed',finishedAt:new Date().toISOString(),error:buildStore.redact(error.message)};jobs.set(failed.id,failed);await buildStore.setBuild(failed);emit('build.completed',{id:failed.id,status:'failed'});}
   finally{releaseLease();await announce().catch(()=>{});}
  })();
  handedOff=true;
  void buildTask.catch(error=>emit('chat.error',{error:buildStore.redact(error.message)}));
  return announce();
  }finally{if(!handedOff)releaseLease();}
 }
 async function exportZip(response){
  const bytes=encodeZip(await store.exportFiles(),{maxFiles:128,maxBytes:8*1024*1024});
  headers(response,'application/zip');response.setHeader('Content-Disposition',`attachment; filename="${store.projectId}-source.zip"`);response.end(bytes);
 }
 const server=http.createServer(async(request,response)=>{
  let mutationLease=false;
  try{
   guard(request);const url=new URL(request.url,`http://${request.headers.host}`),route=url.pathname;
   if(!['GET','HEAD'].includes(request.method)){
    if(request.headers['x-studio-project']&&request.headers['x-studio-project']!==store.projectId)throw problem('Активный проект изменился. Обновите страницу.',409);
    if(projectChanging)throw problem('Проект переключается. Повторите действие.',409);
    if(!['/api/projects','/api/projects/select'].includes(route)){activeMutations++;mutationLease=true;}
   }
   if(await platform.route(request,response,{route,body,send}))return;
   if(request.method==='GET'&&route==='/api/state')return send(response,await state());
   if(request.method==='POST'&&route==='/api/attachments'){
    const input=await body(request);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['name','mime','dataBase64'].includes(key)))throw problem('Укажите изображение для загрузки.');
    return send(response,await attachments.add({projectId:store.projectId,...input}),201);
   }
   const attachmentRoute=route.match(/^\/api\/attachments\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/([a-f0-9]{32})$/);
   if(request.method==='GET'&&attachmentRoute){
    const epoch=projectEpoch;if(attachmentRoute[1]!==store.projectId)throw problem('Изображение другого проекта недоступно.',404);
    const file=await attachments.get({projectId:attachmentRoute[1],id:attachmentRoute[2]});
    if(epoch!==projectEpoch)throw problem('Проект изменился. Обновите изображение.',409);
    headers(response,file.mime);response.setHeader('Content-Length',file.bytes.length);return response.end(file.bytes);
   }
   if(request.method==='GET'&&route==='/api/projects')return send(response,await workspace.list());
   if(request.method==='POST'&&route==='/api/projects')return send(response,await changeProject(await body(request),true,request.headers['x-studio-project']),201);
   if(request.method==='POST'&&route==='/api/projects/select')return send(response,await changeProject(await body(request),false,request.headers['x-studio-project']));
   if(request.method==='GET'&&route==='/api/cloud/status')return send(response,(await state()).cloud);
   if(request.method==='POST'&&route==='/api/cloud/login')throw problem('Локальная Studio подключается автоматически. Вход в Киби нужен только на сайте.',410);
   if(request.method==='POST'&&route==='/api/cloud/connect'){
    if(!remote)throw problem('Серверный режим не включён.',409);
    const input=await body(request);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw problem('Для подключения Studio не нужны почта, пароль или другие данные.');
    await remoteClient.ensureSession();environment=await builder.environment();return send(response,await announce());
   }
   if(request.method==='POST'&&route==='/api/cloud/logout'){
    if(!remote)throw problem('Серверный режим не включён.',409);
    if(building)throw problem('Дождитесь завершения текущей сборки.',409);
    await remoteClient.logout();environment={...environment,ready:false,issues:['Соединение завершено. Studio подключится автоматически при следующем запросе.']};previewState=null;return send(response,await announce());
   }
   if(request.method==='GET'&&route==='/api/health')return send(response,{ok:true,mode:'local',version:'0.3.0'});
   if(request.method==='GET'&&route==='/api/events'){
    headers(response,'text/event-stream; charset=utf-8');response.setHeader('Connection','keep-alive');response.flushHeaders();clients.add(response);
    response.write(`event: state\ndata: ${JSON.stringify(await state())}\n\n`);request.on('close',()=>clients.delete(response));return;
   }
   if(request.method==='GET'&&route==='/api/source')return send(response,await store.readSource(url.searchParams.get('path')));
   if(request.method==='POST'&&route==='/api/source'){const input=await body(request);const result=await sourceMutation(()=>store.writeSource(input));await announce();emit('preview.updated',result);return send(response,await state());}
   if(request.method==='POST'&&['/api/project/ready','/api/design/approve'].includes(route)){const input=await body(request);await sourceMutation(()=>store.approveDesign(input.revision));const current=await store.getState();autoIntents.set(store.projectId,{epoch:projectEpoch,generation:turnGeneration,readyVersion:current.codeReady?.version||0,pending:true});return send(response,await announce());}
   if(request.method==='POST'&&route==='/api/device/variant'){const input=await body(request);await sourceMutation(()=>store.setDeviceVariant(input));previewState=null;return send(response,await announce());}
   if(request.method==='POST'&&route==='/api/settings'){await store.saveSettings(await body(request));return send(response,await announce());}
   if(request.method==='DELETE'&&route==='/api/settings'){await store.removeSettings(url.searchParams.get('service'));return send(response,await announce());}
   if(request.method==='POST'&&route==='/api/chat'){
    const input=await body(request);if(chatStarting)throw problem('Сообщение уже отправляется.',409);chatStarting=true;
    try{
    if(!input||typeof input!=='object'||Array.isArray(input))throw problem('Введите сообщение или прикрепите изображения.');
    const ids=input.attachments===undefined?[]:input.attachments;
    if(!Array.isArray(ids)||ids.length>4||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))||new Set(ids).size!==ids.length)throw problem('Выберите до четырёх разных изображений текущего проекта.');
    const text=typeof input.text==='string'&&input.text.trim()?store.redact(input.text.trim()):ids.length?'Посмотри приложенные изображения.':'';
    if(!text||text.length>32000)throw problem('Введите сообщение до 32000 знаков или прикрепите изображение.');
    if(bridge.getStatus().busy||(await store.getState()).chat.busy)throw problem('Дождитесь ответа или остановите текущий запрос.',409);
    if(!bridge.getStatus().ready)throw problem(bridge.getStatus().error||'Чат не подключён. Войдите в Codex через ChatGPT и перезапустите редактор.',409);
    const images=ids.length?await attachments.imagesForTurn({projectId:store.projectId,ids}):[];
    const imageMetadata=await Promise.all(ids.map(async id=>(await attachments.get({projectId:store.projectId,id})).metadata));
    const pendingIntent=autoIntents.get(store.projectId);turnGeneration++;if(pendingIntent?.pending){const before=await store.getState();autoIntents.set(store.projectId,{epoch:projectEpoch,generation:turnGeneration,readyVersion:before.codeReady?.version||0,pending:false});}else autoIntents.delete(store.projectId);
    await store.addMessage({role:'user',text,attachments:imageMetadata});await store.setChat({busy:true,error:null});await announce();
    try{
     // Hash the exact trusted image bytes sent to this turn, in input order.
     const currentPhotos=imageMetadata.map((photo,index)=>({index:index+1,id:photo.id,mime:photo.mime,width:photo.width,height:photo.height,sha256:sha256(Buffer.from(images[index].slice(images[index].indexOf(',')+1),'base64'))}));
     const context={...await store.getAgentContext(),...await platform.context(),readiness:readiness(await store.getState()),preview:previewState};
     const instructions=developerText+'\n\nCURRENT KIBI STATE:\n'+JSON.stringify(context)+(currentPhotos.length?'\n\nCURRENT USER PHOTO ATTACHMENTS:\n'+JSON.stringify(currentPhotos):'');
     const info=await bridge.send({projectId:store.projectId,cwd:store.projectDir,threadId:store.getThreadId(toolsetRevision)||undefined,text,...(images.length?{images}:{}),developerInstructions:instructions,dynamicTools});await store.setThreadId(info.threadId,toolsetRevision);const intent=autoIntents.get(store.projectId);if(intent&&!intent.pending){if(intent.turnId&&intent.turnId!==info.turnId)autoIntents.delete(store.projectId);else Object.assign(intent,{threadId:info.threadId,turnId:info.turnId});}const active=Boolean(bridge.getStatus().busy);await store.setChat({busy:active,turnId:active?info.turnId:null});return send(response,{...info,accepted:true},202);}
    catch(error){autoIntents.delete(store.projectId);await store.setChat({busy:false,error:store.redact(error.message)});await announce();throw error;}
    }finally{chatStarting=false;}
   }
   if(request.method==='POST'&&route==='/api/chat/interrupt'){turnGeneration++;autoIntents.delete(store.projectId);const current=await store.getState();if(current.chat.threadId&&current.chat.turnId)await bridge.interrupt({threadId:current.chat.threadId,turnId:current.chat.turnId});return send(response,{ok:true});}
   if(request.method==='POST'&&route==='/api/approvals'){const input=await body(request);if(!approvals.has(input.requestId)||!['accept','decline','cancel'].includes(input.decision))throw problem('Разрешение недоступно.',409);await bridge.replyApproval(input);approvals.delete(input.requestId);return send(response,{ok:true});}
   if(request.method==='GET'&&route==='/api/preview/frame'){
    const frame=await nativeFrame(url.searchParams.get('scenario')||'ready');headers(response,'application/octet-stream');response.setHeader('X-Width','240');response.setHeader('X-Height','296');response.setHeader('X-Source-Hash',frame.sourceHash);response.setHeader('X-Preview-Data-Label','Native application');response.setHeader('X-Preview-State-Reset',frame.diagnostics?.stateReset?'true':'false');response.setHeader('X-Preview-Demo',frame.diagnostics?.demo?'true':'false');response.setHeader('X-Preview-Error',frame.diagnostics?.error?'true':'false');response.end(frame.rgb);return;
   }
   if(request.method==='POST'&&route==='/api/preview/input'){const frame=await nativeFrame('ready',await body(request));emit('preview.updated',previewState);return send(response,{...previewState,action:frame.action});}
   if(request.method==='POST'&&route==='/api/check')return send(response,await runChecks());
   if(request.method==='POST'&&route==='/api/build')return send(response,await startBuild((await body(request)).revision),202);
   const jobRoute=route.match(/^\/api\/build\/([a-zA-Z0-9-]+)(?:\/(app\.bin))?$/);
   if(request.method==='GET'&&jobRoute){const job=findJob(jobRoute[1]);if(jobRoute[2])return await artifact(response,job,'app.bin');const current=await store.getState();return send(response,current.build?.id===job.id?current.build:{id:job.id,status:job.status});}
   const manifestRoute=route.match(/^\/api\/configurator\/jobs\/([a-zA-Z0-9-]+)\/manifest$/);
   if(request.method==='GET'&&manifestRoute){const job=findJob(manifestRoute[1]);await requireCurrentJob(job);if(job.status!=='succeeded')throw problem('Сборка ещё не готова.',409);return send(response,{boardId:'kibi-ds02-s3-16m',chip:'ESP32-S3',chipId:9,flashBytes:16777216,maxAppBytes:2097152,mode:'full',title:(await store.getState()).project.name,version:job.id,dataWarning:'Полная установка заменит приложение и системные разделы. Для штатной платы используйте обновление приложения.',files:job.artifacts.map(a=>({name:a.name,kind:artifactKind(a.name),offset:a.offset,size:a.size,sha256:a.sha256,url:`/api/configurator/jobs/${job.id}/files/${a.name}`}))});}
   const fileRoute=route.match(/^\/api\/configurator\/jobs\/([a-zA-Z0-9-]+)\/files\/([a-zA-Z0-9_.-]+)$/);
   if(request.method==='GET'&&fileRoute)return await artifact(response,findJob(fileRoute[1]),fileRoute[2]);
   if(request.method==='GET'&&route==='/api/export')return await exportZip(response);
   if(request.method==='GET'&&route==='/api/bootstrap-prompt'){headers(response,'text/plain; charset=utf-8');response.end(await readFile(path.join(root,'prompts/bootstrap-ru.md'),'utf8'));return;}
   if(request.method!=='GET'&&request.method!=='HEAD')throw problem('Маршрут не найден.',404);
   const relative=route==='/'?'index.html':decodeURIComponent(route.slice(1));
   if(relative.includes('..')||relative.includes('\\')||relative.split('/').some(x=>x.startsWith('.'))||!MIME[path.extname(relative)])throw problem('Файл не найден.',404);
   const web=path.join(root,'web'),target=path.join(web,relative);let canonical;try{canonical=await realpath(target);}catch{throw problem('Файл не найден.',404);}
   if(!canonical.startsWith(web+path.sep)||(await lstat(target)).isSymbolicLink())throw problem('Файл не найден.',404);
   headers(response,MIME[path.extname(relative)]);response.end(request.method==='HEAD'?undefined:await readFile(canonical));
  }catch(error){if(!response.headersSent)send(response,{error:store.redact(error.message||'Ошибка локального редактора.')},error.status||500);else response.destroy();}
  finally{if(mutationLease)activeMutations--;}
 });
 const watch=setInterval(()=>{if(closed)return;void(async()=>{const current=await store.getState();if(current.revision!==lastRevision){lastRevision=current.revision;await announce();emit('preview.updated',{revision:current.revision,sourceHash:current.sourceHash});}})().catch(error=>emit('chat.error',{error:store.redact(error.message)}));},2000);watch.unref();
 const heartbeat=setInterval(()=>{for(const client of clients)client.write(': heartbeat\n\n');},15000);heartbeat.unref();
 server.on('close',()=>{closed=true;turnGeneration++;autoIntents.clear();void platform.close();clearInterval(watch);clearInterval(heartbeat);for(const client of clients)client.end();clients.clear();void bridge.close();});
 server.studio={get store(){return store;},workspace,bridge,preview,builder,state,tools,
  shutdown:async()=>{closed=true;turnGeneration++;autoIntents.clear();await platform.close();clearInterval(watch);clearInterval(heartbeat);for(const client of clients)client.end();clients.clear();await bridge.close();await buildTask?.catch(()=>{});if(remote)await remoteClient.logout().catch(()=>{});await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();server.closeAllConnections?.();});},
  initialize:async()=>{const status=await bridge.start();await store.setChat(status);await announce();return status;}};
 return server;
}

// KIBI_FRESH_PUBLIC_SERVER_20261117_V1
