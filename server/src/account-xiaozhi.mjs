import {createHash} from 'node:crypto';
import {createOfficialRegistration} from './xiaozhi/official-registration.mjs';

const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const failure=(code,status=409)=>Object.assign(new Error(code),{code,status});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const authorized=check=>{try{return typeof check==='function'&&check()===true;}catch{return false;}};

/** One account's control plane; the shared gateway alone owns TLS/listening.
 * Private registration configuration escapes only through authorize(), never status.
 */
export function createAccountXiaozhi({store,accountId,fetchImpl=globalThis.fetch,serviceStatus=()=>({}),authorizeDevice,deviceExists}={}){
 if(!id(accountId)||accountId==='owner'||!store?.state||['seal','xiaozhi','save','exclusive'].some(name=>typeof store[name]!=='function')||[fetchImpl,serviceStatus,authorizeDevice,deviceExists].some(value=>typeof value!=='function'))throw failure('invalid_account',400);
 let closed=false,epoch=0,record,setup=null,admission=null,resetting=false,personal=store.state.personalVoice?.selected===true;
 const sessions=new Set();
 const hasPersonalMode=()=>personal||store.state.personalVoice?.selected===true;
 const selectedDevice=()=>store.state.personalVoice?.selected===true&&id(store.state.personalVoice.deviceId)?store.state.personalVoice.deviceId:null;
 const exists=deviceId=>{try{return !!deviceId&&deviceExists(deviceId)===true;}catch{return false;}};
 const identity=()=>digest([store.state.personalVoice??null,store.state.xiaozhi??null]);
 function requireAuthority(check){if(closed)throw failure('voice_closed');if(!authorized(check))throw failure('unauthorized',401);}
 function current(value){return !closed&&!resetting&&record===value&&value.epoch===epoch&&!value.life.signal.aborted;}
 function retire(value){value?.life.abort();value?.client.close();}
 function cancelSessions(){for(const session of [...sessions])session.controller.abort();}
 function service(){
  let value;try{value=serviceStatus()||{};}catch{value={};}
  let endpoint=null;
  try{const url=new URL(value.endpoint);if(url.protocol==='wss:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/kibi-xiaozhi/v1')endpoint=url.href;}catch{}
  const error=['tls_required','tls_failed','gateway_unavailable','legacy_unavailable'].includes(value.error)?value.error:null;
  return {enabled:value.enabled===true,tls:value.tls===true,endpoint,error,ready:value.code==='ready'};
 }
 function serviceCode(){const value=service();return closed?'voice_closed':!value.enabled?'disabled':value.error||(!value.tls?'tls_required':null);}
 function registrationUsable(){return current(record)&&record.client.snapshot().configured===true;}
 function studioVoiceEligibility(){
  const code=serviceCode()||(!registrationUsable()?'xiaozhi_not_configured':null);
  return {approved:true,canActivate:code===null,code};
 }
 function reconcile(){
  const expected=identity(),selected=selectedDevice(),unavailable=!!serviceCode()||!registrationUsable();
  for(const session of [...sessions])if(unavailable||session.identity!==expected||session.deviceId!==selected||!exists(session.deviceId))session.controller.abort();
 }
 function makeRegistration(){
  const value={epoch,life:new AbortController(),client:null};
  value.client=createOfficialRegistration({read:()=>store.xiaozhi(),fetchImpl,write:next=>{
   const operation=setup;
   return store.exclusive(async()=>{
    // A disconnect may overtake a write waiting for this account's store lock.
    if(!current(value)||operation?.record!==value)throw failure('xiaozhi_closed');
    requireAuthority(operation.isAuthorized);
    store.state.xiaozhi=store.seal(next);await store.save();reconcile();
    if(!current(value))throw failure('xiaozhi_closed');
   });
  }});
  return value;
 }
 record=makeRegistration();
 async function runSetup(method,{isAuthorized=()=>true}={}){
  requireAuthority(isAuthorized);if(resetting||setup)throw failure('xiaozhi_busy');
  personal=true;
  const value=record,operation={record:value,isAuthorized};setup=operation;
  try{
   await store.exclusive(async()=>{
    if(!current(value))throw failure('xiaozhi_closed');requireAuthority(isAuthorized);
    store.state.personalVoice={selected:true,deviceId:selectedDevice()};await store.save();reconcile();
   });
   if(!current(value))throw failure('xiaozhi_closed');requireAuthority(isAuthorized);
   return await value.client[method]();
  }catch(error){if(!authorized(isAuthorized))throw failure('unauthorized',401);throw error;}
  finally{if(setup===operation)setup=null;}
 }
 const registration={snapshot:()=>record.client.snapshot(),prepare:options=>runSetup('prepare',options),activate:options=>runSetup('activate',options)};
 function status(){
  reconcile();const shared=service(),registrationStatus=registration.snapshot(),selected=selectedDevice(),configured=registrationUsable()&&exists(selected);
  const problem=serviceCode(),activeSessions=sessions.size;
  const state=closed?'closed':!hasPersonalMode()||!shared.enabled?'disabled':problem?'error':!configured?'not_configured':activeSessions?(shared.ready?'active':'connecting'):'listening';
  const code=closed?'closed':state==='disabled'?'disabled':problem||(!configured?'configuration_required':activeSessions?(shared.ready?'ready':'connecting'):'listening');
  return {configured,enabled:shared.enabled,status:state,code,provider:'xiaozhi',providerLocked:true,personal:true,scope:selected?{kind:'panel',id:selected}:null,registration:registrationStatus,model:null,endpoint:shared.endpoint,tls:shared.tls,legacyConfigured:false,legacyReady:false,activeSessions};
 }
 async function selectDevice(deviceId,{isAuthorized=()=>true}={}){
  requireAuthority(isAuthorized);if(!id(deviceId))throw failure('invalid_voice_scope',400);
  const value=record;
  await store.exclusive(async()=>{
   requireAuthority(isAuthorized);if(!current(value))throw failure('xiaozhi_closed');
   if(!exists(deviceId))throw failure('device_not_found',404);
   const eligibility=studioVoiceEligibility();if(!eligibility.canActivate)throw failure(eligibility.code);
   store.state.personalVoice={selected:true,deviceId};await store.save();personal=true;reconcile();
  });return status();
 }
 async function disconnect({isAuthorized=()=>true}={}){
  requireAuthority(isAuthorized);if(resetting)throw failure('xiaozhi_busy');
  resetting=true;personal=true;const version=++epoch;retire(record);cancelSessions();
  try{
   await store.exclusive(async()=>{
    requireAuthority(isAuthorized);if(version!==epoch)throw failure('xiaozhi_closed');
    store.state.xiaozhi=null;store.state.personalVoice={selected:true,deviceId:null};await store.save();
   });
  }finally{if(!closed&&version===epoch)record=makeRegistration();resetting=false;}
  return status();
 }
 async function waitPermission(promise,signal){
  if(signal.aborted)return null;
  let abort;const cancelled=new Promise(resolve=>{abort=()=>resolve(null);signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([Promise.resolve(promise).catch(()=>null),cancelled]);}finally{signal.removeEventListener('abort',abort);}
 }
 async function authorize({token,signal}={}){
  if(closed||resetting||signal?.aborted||typeof token!=='string')return null;
  reconcile();if(sessions.size||admission)return null;
  // Reserve before awaiting device authorization, whose underlying authorizer
  // retires its old permission. A rejected duplicate must never reach it.
  const ticket={};admission=ticket;
  try{
  const observed=await store.exclusive(()=>{
   const deviceId=selectedDevice();if(!hasPersonalMode()||!registrationUsable()||serviceCode()||!exists(deviceId)||signal?.aborted)return null;
   return {record,deviceId,identity:identity()};
  });
  if(!observed||!current(observed.record))return null;
  const pendingSignal=AbortSignal.any([observed.record.life.signal,...(signal?[signal]:[])]);
  const permission=await waitPermission(Promise.resolve().then(()=>pendingSignal.aborted?null:authorizeDevice({token,deviceId:observed.deviceId})),pendingSignal);
  if(!permission||permission.principal?.id!==observed.deviceId||permission.signal?.aborted||pendingSignal.aborted)return null;
  return await store.exclusive(()=>{
   if(!current(observed.record)||pendingSignal.aborted||permission.signal?.aborted||observed.identity!==identity()||selectedDevice()!==observed.deviceId||!exists(observed.deviceId)||serviceCode()||!registrationUsable())return null;
   const controller=new AbortController(),combined=AbortSignal.any([controller.signal,pendingSignal,...(permission.signal?[permission.signal]:[])]);
   if(combined.aborted)return null;
   const session={controller,deviceId:observed.deviceId,identity:observed.identity};sessions.add(session);
   combined.addEventListener('abort',()=>sessions.delete(session),{once:true});
   return {principal:Object.freeze({kind:'account',accountId,id:observed.deviceId}),configuration:Object.freeze({provider:'xiaozhi',...observed.record.client.configuration()}),signal:combined,sessionKey:'account:'+accountId};
  });
  }finally{if(admission===ticket)admission=null;}
 }
 function close(){if(closed)return;closed=true;epoch++;retire(record);cancelSessions();}
 return {registration,hasPersonalMode,status,studioVoiceEligibility,selectDevice,disconnect,authorize,reconcile,close};
}
