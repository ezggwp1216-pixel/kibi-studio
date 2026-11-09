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

/** Private server-only authorizer. It retains cancellation identity, never a key or transcript. */
export function createPanelVoiceAuthorizer({store,requireCredentials=true}={}){
 let current=null,closed=false;
 const identity=device=>hash(JSON.stringify([device.id,device.tokenHash,requireCredentials?store.state.ai:null]));
 function retire(){const old=current;current=null;old?.controller.abort();}
 return {
  async authorize({token}={}){
   if(closed||typeof token!=='string'||!ownToken.test(token))return null;
   return store.exclusive(async()=>{
    if(closed)return null;
    const tokenHash=hash(token),device=store.state.devices.find(value=>equal(value.tokenHash,tokenHash));
    const credentials=store.ai();
    if(!device||requireCredentials&&!credentials?.apiKey)return null;
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
export async function startVoiceModule({store,publicOrigin,config=voiceConfigFromEnv(),createAdapter,registrationFetch=fetch}={}){
 const enabled=config.enabled===true,endpoint=new URL('/kibi-xiaozhi/v1',publicOrigin);endpoint.protocol='wss:';
 const panel=createPanelVoiceAuthorizer({store}),localPanel=createPanelVoiceAuthorizer({store,requireCredentials:false});
 if(config.provider!==undefined&&!['openai','xiaozhi'].includes(config.provider))throw new Error('invalid_voice_provider');
 const registration=createOfficialRegistration({read:()=>store.xiaozhi(),write:value=>store.exclusive(async()=>{store.state.xiaozhi=store.seal(value);await store.save();reconcile();}),fetchImpl:registrationFetch});
 const relayScopes=new Set();
 const provider=()=>config.provider||store.state.voice?.provider||'openai';
 const selectionIdentity=()=>hash(JSON.stringify([provider(),store.state.voice,store.state.xiaozhi]));
 function reconcile(){panel.reconcile();localPanel.reconcile();for(const scope of relayScopes)if(scope.identity!==selectionIdentity()){scope.controller.abort();relayScopes.delete(scope);}}
 async function selectProvider(value){
  if(!value||!['openai','xiaozhi'].includes(value.provider)||config.provider&&config.provider!==value.provider)throw Object.assign(new Error('invalid_voice_provider'),{status:400,code:'invalid_voice_provider'});
  const scope=value.scope;
  if(value.provider==='xiaozhi'&&(!scope||!['panel','legacy'].includes(scope.kind)||typeof scope.id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(scope.id)))throw Object.assign(new Error('invalid_voice_scope'),{status:400,code:'invalid_voice_scope'});
  await store.exclusive(async()=>{store.state.voice={provider:value.provider,...(value.provider==='xiaozhi'?{scope:{kind:scope.kind,id:scope.id}}:{})};await store.save();reconcile();});return status();
 }
 async function authorize(request){
  const selected=provider(),identity=selectionIdentity();
  const permission=await (ownToken.test(request.token)?(selected==='xiaozhi'?localPanel:panel).authorize(request):/^[0-9a-f]{64}$/.test(request.token)?legacy?.authorize(request)||null:null);
  // Authorization can wait behind a saved selection, including the synchronous
  // legacy result's await. Never admit credentials for the earlier selection.
  if(!permission||closed||identity!==selectionIdentity()||permission.signal?.aborted)return null;
  let configuration=permission.configuration;
  if(selected==='xiaozhi'){
   const target=store.state.voice?.scope;configuration=registration.configuration();
   if(!configuration||!target||target.kind!==permission.principal?.kind||target.id!==permission.principal?.id)return null;
   configuration=Object.freeze({provider:'xiaozhi',...configuration});
  }
  const controller=new AbortController(),scope={controller,identity};relayScopes.add(scope);
  const signal=AbortSignal.any([controller.signal,...(permission.signal?[permission.signal]:[])]);
  signal.addEventListener('abort',()=>relayScopes.delete(scope),{once:true});
  return {...permission,configuration,signal};
 }
 let gateway=null,legacy=null,closed=false,tlsReady=false,errorCode=null;
 const status=()=>{
  const snapshot=gateway?.snapshot(),activeSessions=snapshot?.metrics.activeSessions||0,configured=provider()==='xiaozhi'?!!registration.configuration()&&!!store.state.voice?.scope:!!store.ai()||!!legacy;
  let code=errorCode||snapshot?.code||(enabled?'configuration_required':'disabled');
  let state=!enabled?'disabled':errorCode?'error':!configured?'not_configured':activeSessions?(code==='ready'?'active':'connecting'):'listening';
  if(closed){state='closed';code='closed';}
  return {configured,enabled,status:state,code,provider:provider(),providerLocked:!!config.provider,scope:store.state.voice?.scope||null,registration:registration.snapshot(),model:provider()==='xiaozhi'?null:VOICE_MODEL,endpoint:endpoint.href,tls:tlsReady,legacyConfigured:!!config.legacyDataDir,legacyReady:!!legacy,activeSessions};
 };
 const close=async()=>{if(closed)return;closed=true;panel.close();localPanel.close();registration.close();for(const scope of relayScopes)scope.controller.abort();relayScopes.clear();legacy?.close();await gateway?.close();};
 const runtime={status,address:()=>gateway?.address()||null,reconcile,registration,selectProvider,close};
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
