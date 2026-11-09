import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash,createPrivateKey,timingSafeEqual,X509Certificate} from 'node:crypto';
import {createOfficialRegistration} from './xiaozhi/official-registration.mjs';
import {createOfficialXiaozhiAdapter} from './xiaozhi/official-adapter.mjs';
import {createXiaozhiOpenAIAdapter} from './xiaozhi/adapter.mjs';
import {unlinkedPath} from './private-files.mjs';

export const VOICE_MODEL='gpt-realtime';
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));
const ownToken=/^[A-Za-z0-9_-]{43}$/;
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const validDelegation=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===2&&safeId(value.accountId)&&value.accountId!=='owner'&&safeId(value.deviceId);
const unavailableVoice=()=>({configured:false,enabled:false,status:'disabled',code:'tenant_voice_unavailable',model:null,endpoint:null,tls:false,legacyConfigured:false,legacyReady:false,activeSessions:0});

/** Private server-only authorizer. It retains cancellation identity, never a key or transcript. */
export function createPanelVoiceAuthorizer({store,requireCredentials=true}={}){
 let current=null,closed=false;
 const identity=device=>hash(JSON.stringify([device.id,device.tokenHash,requireCredentials?store.state.ai:null]));
 function retire(){const old=current;current=null;old?.controller.abort();}
 return {
  async authorize({token,deviceId:expectedDeviceId}={}){
   if(closed||typeof token!=='string'||!ownToken.test(token))return null;
   return store.exclusive(async()=>{
    if(closed)return null;
    const tokenHash=hash(token),device=store.state.devices.find(value=>equal(value.tokenHash,tokenHash));
    const credentials=requireCredentials?store.ai():null;
    if(!device||expectedDeviceId!==undefined&&device.id!==expectedDeviceId||requireCredentials&&!credentials?.apiKey)return null;
    device.lastSeenAt=new Date().toISOString();await store.save();
    if(closed)return null;
    retire();const controller=new AbortController();current={deviceId:device.id,identity:identity(device),controller};
    return {principal:Object.freeze({kind:'panel',id:device.id}),configuration:Object.freeze(requireCredentials?{api_key:credentials.apiKey,api_base_url:'https://api.openai.com/v1',model:VOICE_MODEL,
     ...(credentials.systemPrompt?{instructions:credentials.systemPrompt}:{})}:{}),signal:controller.signal};
   });
  },
  reconcile(){
   if(!current)return;
   const device=store.state.devices.find(value=>value.id===current.deviceId);
   if(!device||requireCredentials&&!store.state.ai||identity(device)!==current.identity)retire();
  },
  close(){if(closed)return;closed=true;retire();}
 };
}

export function voiceConfigFromEnv(env=process.env){
 return {enabled:env.KIBI_VOICE_ENABLED==='1',host:env.KIBI_VOICE_HOST||'127.0.0.1',port:Number(env.KIBI_VOICE_PORT||9444),
  keyFile:env.KIBI_VOICE_TLS_KEY_FILE,certFile:env.KIBI_VOICE_TLS_CERT_FILE,legacyDataDir:env.KIBI_VOICE_LEGACY_DATA_DIR,provider:env.KIBI_VOICE_PROVIDER||undefined};
}

async function readTlsFile(input){
 const path=await unlinkedPath(input),parent=await lstat(await unlinkedPath(dirname(path)));
 const directoryMode=parent.mode&0o7777;
 if(!parent.isDirectory()||![0o700,0o750,0o500,0o550,0o2700,0o2750,0o2500,0o2550].includes(directoryMode))throw new Error('unsafe_tls');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await file.stat(),mode=stat.mode&0o7777,uid=process.getuid?.(),groups=new Set([process.getgid?.(),...(process.getgroups?.()||[])]);
  if(!stat.isFile()||stat.nlink!==1||![0o600,0o640,0o440].includes(mode)||stat.uid!==0&&stat.uid!==uid||stat.size<1||stat.size>65536||
   mode&0o040&&uid!==0&&stat.uid!==uid&&!groups.has(stat.gid))throw new Error('unsafe_tls');
  return await file.readFile();
 }finally{await file.close();}
}

/** One pilot TLS gateway, owned by the same process as the panel and encrypted store.
 * All config/dependencies are trusted process values, never accepted from HTTP/device JSON.
 */
export async function startVoiceModule({store,publicOrigin,config=voiceConfigFromEnv(),createAdapter,registrationFetch=fetch,authorizeDelegatedDevice,delegatedDeviceExists=()=>false,studioAccountExists=()=>false}={}){
 const enabled=config.enabled===true,endpoint=new URL('/kibi-xiaozhi/v1',publicOrigin);endpoint.protocol='wss:';
 const panel=createPanelVoiceAuthorizer({store}),localPanel=createPanelVoiceAuthorizer({store,requireCredentials:false});
 if(config.provider!==undefined&&!['openai','xiaozhi'].includes(config.provider))throw new Error('invalid_voice_provider');
 const registration=createOfficialRegistration({read:()=>store.xiaozhi(),write:value=>store.exclusive(async()=>{store.state.xiaozhi=store.seal(value);await persistSelection();}),fetchImpl:registrationFetch});
 const relayScopes=new Set();
 const provider=()=>config.provider||store.state.voice?.provider||'openai';
 const hasDelegation=()=>store.state.voice?.delegation!==undefined&&store.state.voice?.delegation!==null;
 const delegation=()=>validDelegation(store.state.voice?.delegation)?{accountId:store.state.voice.delegation.accountId,deviceId:store.state.voice.delegation.deviceId}:null;
 const targetExists=grant=>!!grant&&delegatedDeviceExists(grant)===true;
 const studioAccountId=()=>safeId(store.state.voice?.studioAccountId)&&store.state.voice.studioAccountId!=='owner'?store.state.voice.studioAccountId:null;
 const approvedAccount=id=>!!id&&studioAccountId()===id&&studioAccountExists(id)===true;
 const grantAllowed=grant=>targetExists(grant)&&(store.state.voice?.delegationSource==null||store.state.voice.delegationSource==='studio'&&approvedAccount(grant.accountId));
 // Approval changes affect only grants issued through that approval. A separately
 // issued manual grant retains its own lifetime and authorization identity.
 const selectionIdentity=()=>hash(JSON.stringify([provider(),store.state.voice?.scope,store.state.voice?.delegation,store.state.voice?.delegationSource,store.state.voice?.delegationSource==='studio'?store.state.voice?.studioAccountId:null,store.state.xiaozhi]));
 function reconcile(){panel.reconcile();localPanel.reconcile();for(const scope of relayScopes)if(scope.identity!==selectionIdentity()||scope.delegation&&!grantAllowed(scope.delegation)){scope.controller.abort();relayScopes.delete(scope);}}
 async function persistSelection(){try{await store.save();}finally{reconcile();}}
 function requireAuthority(isAuthorized){
  if(closed)throw Object.assign(new Error('voice_closed'),{status:409,code:'voice_closed'});
  if(!isAuthorized())throw Object.assign(new Error('unauthorized'),{status:401,code:'unauthorized'});
 }
 function studioVoiceEligibility(accountId){
  const approved=approvedAccount(accountId),code=closed?'voice_closed':!approved?'studio_voice_not_approved':provider()!=='xiaozhi'?'studio_voice_xiaozhi_required':!registration.configuration()?'xiaozhi_not_configured':null;
  return {approved,canActivate:code===null,code};
 }
 async function allowStudioAccount(accountId,{isAuthorized=()=>true}={}){
  if(accountId!==null&&(!safeId(accountId)||accountId==='owner'||studioAccountExists(accountId)!==true))throw Object.assign(new Error('invalid_studio_voice_account'),{status:400,code:'invalid_studio_voice_account'});
  await store.exclusive(async()=>{
   requireAuthority(isAuthorized);
   if(accountId!==null&&studioAccountExists(accountId)!==true)throw Object.assign(new Error('invalid_studio_voice_account'),{status:400,code:'invalid_studio_voice_account'});
   store.state.voice={...(store.state.voice||{provider:provider()})};
   if(store.state.voice.delegationSource==='studio'&&store.state.voice.delegation?.accountId!==accountId){delete store.state.voice.delegation;delete store.state.voice.delegationSource;}
   if(accountId===null)delete store.state.voice.studioAccountId;else store.state.voice.studioAccountId=accountId;
   await persistSelection();
  });return status();
 }
 async function activateStudioDevice(value,{isAuthorized=()=>true}={}){
  if(!validDelegation(value))throw Object.assign(new Error('invalid_voice_delegation'),{status:400,code:'invalid_voice_delegation'});
  await store.exclusive(async()=>{
   requireAuthority(isAuthorized);
   const eligibility=studioVoiceEligibility(value.accountId);
   if(!eligibility.canActivate)throw Object.assign(new Error(eligibility.code),{status:eligibility.approved?409:403,code:eligibility.code});
   if(!targetExists(value))throw Object.assign(new Error('invalid_voice_delegation'),{status:400,code:'invalid_voice_delegation'});
   store.state.voice={...(store.state.voice||{provider:provider()}),delegation:{accountId:value.accountId,deviceId:value.deviceId},delegationSource:'studio'};
   await persistSelection();
  });return delegatedStatus(value.accountId);
 }
 async function setDelegation(value,{isAuthorized=()=>true}={}){
  if(value!==null&&(!validDelegation(value)||!targetExists(value)))throw Object.assign(new Error('invalid_voice_delegation'),{status:400,code:'invalid_voice_delegation'});
  await store.exclusive(async()=>{
   requireAuthority(isAuthorized);
   if(value!==null&&!targetExists(value))throw Object.assign(new Error('invalid_voice_delegation'),{status:400,code:'invalid_voice_delegation'});
   store.state.voice={...(store.state.voice||{provider:provider()})};
   if(value===null)delete store.state.voice.delegation;else store.state.voice.delegation={accountId:value.accountId,deviceId:value.deviceId};
   delete store.state.voice.delegationSource;
   await persistSelection();
  });return status();
 }
 async function selectProvider(value){
  if(!value||!['openai','xiaozhi'].includes(value.provider)||config.provider&&config.provider!==value.provider)throw Object.assign(new Error('invalid_voice_provider'),{status:400,code:'invalid_voice_provider'});
  const scope=value.scope;
  if(value.provider==='xiaozhi'&&(!scope||!['panel','legacy'].includes(scope.kind)||typeof scope.id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(scope.id)))throw Object.assign(new Error('invalid_voice_scope'),{status:400,code:'invalid_voice_scope'});
  await store.exclusive(async()=>{store.state.voice={...(store.state.voice||{}),provider:value.provider};if(value.provider==='xiaozhi')store.state.voice.scope={kind:scope.kind,id:scope.id};else delete store.state.voice.scope;await persistSelection();});return status();
 }
 async function authorize(request){
  const observedIdentity=selectionIdentity();
  // Store state is mutated before save() commits and can roll back on failure.
  // Take the selection only after preceding owner writes have settled.
  const selection=await store.exclusive(()=>closed||observedIdentity!==selectionIdentity()?null:{selected:provider(),identity:observedIdentity,grant:delegation(),delegated:hasDelegation()});
  if(!selection)return null;
  const {selected,identity,grant,delegated}=selection;
  if(delegated&&(selected!=='xiaozhi'||!grantAllowed(grant)||typeof authorizeDelegatedDevice!=='function'||!ownToken.test(request.token)))return null;
  // Authorizers may use this same owner's queue. Never await them while holding it.
  const permission=await (delegated?authorizeDelegatedDevice({token:request.token,delegation:grant}):ownToken.test(request.token)?(selected==='xiaozhi'?localPanel:panel).authorize(request):/^[0-9a-f]{64}$/.test(request.token)?legacy?.authorize(request)||null:null);
  // A grant/provider/registration write may have started during device authorization.
  // Its commit or rollback must finish before any upstream configuration escapes.
  return store.exclusive(()=>{
   if(!permission||closed||identity!==selectionIdentity()||permission.signal?.aborted||delegated&&(!grantAllowed(grant)||permission.principal?.kind!=='account'||permission.principal.accountId!==grant.accountId||permission.principal.id!==grant.deviceId))return null;
   let configuration=permission.configuration;
   if(selected==='xiaozhi'){
    const target=store.state.voice?.scope;configuration=registration.configuration();
    if(!configuration||!delegated&&(!target||target.kind!==permission.principal?.kind||target.id!==permission.principal?.id))return null;
    configuration=Object.freeze({provider:'xiaozhi',...configuration});
   }
   const controller=new AbortController(),scope={controller,identity,...(delegated?{delegation:grant}:{})};relayScopes.add(scope);
   const signal=AbortSignal.any([controller.signal,...(permission.signal?[permission.signal]:[])]);
   signal.addEventListener('abort',()=>relayScopes.delete(scope),{once:true});
   return {...permission,configuration,signal};
  });
 }
 let gateway=null,legacy=null,closed=false,tlsReady=false,errorCode=null;
 const status=()=>{
  const snapshot=gateway?.snapshot(),activeSessions=snapshot?.metrics.activeSessions||0,grant=delegation(),delegated=hasDelegation(),configured=delegated?provider()==='xiaozhi'&&grantAllowed(grant)&&!!registration.configuration():provider()==='xiaozhi'?!!registration.configuration()&&!!store.state.voice?.scope:!!store.ai()||!!legacy;
  let code=errorCode||snapshot?.code||(enabled?'configuration_required':'disabled');
  let state=!enabled?'disabled':errorCode?'error':!configured?'not_configured':activeSessions?(code==='ready'?'active':'connecting'):'listening';
  if(closed){state='closed';code='closed';}
  if(delegated&&!configured&&!errorCode&&enabled&&!closed)code=!grant?'invalid_voice_delegation':provider()!=='xiaozhi'?'delegated_xiaozhi_required':!targetExists(grant)?'delegated_device_unavailable':'configuration_required';
  return {configured,enabled,status:state,code,provider:provider(),providerLocked:!!config.provider,scope:store.state.voice?.scope||null,delegation:grant,delegationSource:store.state.voice?.delegationSource==='studio'?'studio':null,studioAccountId:studioAccountId(),registration:registration.snapshot(),model:provider()==='xiaozhi'?null:VOICE_MODEL,endpoint:endpoint.href,tls:tlsReady,legacyConfigured:!!config.legacyDataDir,legacyReady:!!legacy,activeSessions};
 };
 const delegatedStatus=accountId=>{
  const studioVoice=studioVoiceEligibility(accountId),grant=delegation();if(!grant||grant.accountId!==accountId)return {...unavailableVoice(),studioVoice};
  const profile=status(),ownSession=profile.activeSessions>0&&[...relayScopes].some(scope=>scope.delegation?.accountId===accountId&&scope.delegation.deviceId===grant.deviceId&&!scope.controller.signal.aborted);
  const state=ownSession||['disabled','error','closed','not_configured'].includes(profile.status)?profile.status:'listening';
  const code=state==='listening'?'listening':profile.code;
  return {configured:profile.configured,enabled:profile.enabled,status:state,code,provider:'xiaozhi',providerLocked:true,delegated:true,scope:{kind:'panel',id:grant.deviceId},studioVoice,model:null,endpoint:profile.endpoint,tls:profile.tls,legacyConfigured:false,legacyReady:false,activeSessions:ownSession?profile.activeSessions:0};
 };
 const close=async()=>{if(closed)return;closed=true;panel.close();localPanel.close();registration.close();for(const scope of relayScopes)scope.controller.abort();relayScopes.clear();legacy?.close();await gateway?.close();};
 const runtime={status,delegatedStatus,studioVoiceEligibility,allowStudioAccount,activateStudioDevice,address:()=>gateway?.address()||null,reconcile,registration,selectProvider,setDelegation,close};
 if(!enabled)return runtime;
 if(!config.keyFile||!config.certFile){errorCode='tls_required';return runtime;}
 let tls;
 try{
  const [key,cert]=await Promise.all([readTlsFile(config.keyFile),readTlsFile(config.certFile)]);
  const certificate=new X509Certificate(cert),now=Date.now();
  if(!certificate.checkPrivateKey(createPrivateKey(key))||Date.parse(certificate.validFrom)>now||Date.parse(certificate.validTo)<=now)throw new Error('invalid_tls');
  tls={key,cert};tlsReady=true;
 }catch{errorCode='tls_failed';return runtime;}
 if(config.legacyDataDir){
  try{const {createCloudVoiceAuthorizer}=await import('./xiaozhi/cloud-registry.mjs');legacy=createCloudVoiceAuthorizer({dataDir:config.legacyDataDir});}
  catch{errorCode='legacy_unavailable';return runtime;}
 }
 try{
  const {createXiaozhiGateway}=await import('./xiaozhi/gateway.mjs');
  gateway=createXiaozhiGateway({tls,host:config.host||'127.0.0.1',port:config.port??9444,
   authorize,
   createAdapter:createAdapter||((options)=>{
    if(options.configuration.provider!=='xiaozhi')return createXiaozhiOpenAIAdapter(options);
    // Only our routing marker is removed; the official validator must still
    // reject every other unexpected transport option.
    const {provider:_,...configuration}=options.configuration;
    return createOfficialXiaozhiAdapter({...options,configuration});
   })});
  await gateway.listen();
 }catch{errorCode='gateway_unavailable';await gateway?.close();gateway=null;legacy?.close();legacy=null;}
 return runtime;
}
