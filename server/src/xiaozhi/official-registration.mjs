import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {validateOfficialCloudConfiguration} from './official-socket.mjs';

const OTA='https://api.tenclass.net/xiaozhi/ota/';
const DEADLINE_MS=10_000,MAX_RESPONSE=65_536,MAX_PAIRING_MS=600_000;
const ERROR_CODES=new Set(['xiaozhi_not_configured','xiaozhi_pending','xiaozhi_challenge_expired','xiaozhi_invalid_response','xiaozhi_untrusted_endpoint','xiaozhi_mqtt_unsupported','xiaozhi_provider_failed','xiaozhi_timeout','xiaozhi_closed','xiaozhi_busy','xiaozhi_storage_failed','xiaozhi_storage_invalid']);
const fail=code=>Object.assign(new Error(code),{code});
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const ascii=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&/^[\x21-\x7e]+$/.test(value);
const copy=value=>structuredClone(value);

function softwareIdentity(){
 const mac=randomBytes(6);mac[0]=(mac[0]&0xfc)|2;
 return{deviceId:[...mac].map(byte=>byte.toString(16).padStart(2,'0')).join(':'),clientId:randomUUID(),serialNumber:'KIBI-SW-'+randomBytes(12).toString('hex').toUpperCase(),hmacKey:randomBytes(32).toString('hex')};
}
function validIdentity(value){
 if(!object(value)||!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value.deviceId)||
  (parseInt(value.deviceId.slice(0,2),16)&3)!==2||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.clientId)||
  !/^KIBI-SW-[A-Z0-9]{10,64}$/.test(value.serialNumber)||!/^[0-9a-f]{64}$/.test(value.hmacKey))throw fail('xiaozhi_storage_invalid');
 return{deviceId:value.deviceId,clientId:value.clientId,serialNumber:value.serialNumber,hmacKey:value.hmacKey};
}
function trustedConfiguration(value,identity){
 if(!object(value)||!ascii(value.url,8192))throw fail('xiaozhi_invalid_response');
 if(!ascii(value.token,4096))throw fail('xiaozhi_invalid_response');
 // Share the connector's endpoint policy so configured always means usable by
 // that connector, including an official response's private query parameters.
 try{return validateOfficialCloudConfiguration({url:value.url,token:value.token,deviceId:identity.deviceId,clientId:identity.clientId});}
 catch(error){throw fail(error?.code==='unsupported_endpoint'?'xiaozhi_untrusted_endpoint':'xiaozhi_invalid_response');}
}
function storedActivation(value){
 if(!object(value)||typeof value.pairingCode!=='string'||!/^\d{6}$/.test(value.pairingCode)||!ascii(value.challenge,4096)||
  typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt)))throw fail('xiaozhi_storage_invalid');
 return{challenge:value.challenge,pairingCode:value.pairingCode,expiresAt:new Date(value.expiresAt).toISOString()};
}
function storedState(value){
 if(!object(value)||value.version!==1)throw fail('xiaozhi_storage_invalid');
 const identity=validIdentity(value.identity);
 const activation=value.activation==null?null:storedActivation(value.activation);
 const configuration=value.configuration==null?null:trustedConfiguration(value.configuration,identity);
 if(activation&&configuration)throw fail('xiaozhi_storage_invalid');
 return{version:1,identity,activation,configuration};
}

/** Owner-triggered, server-only registration for one persistent Kibi software client.
 * read() is synchronous; write(privateState) must encrypt/persist atomically and resolve.
 * Only snapshot()/prepare()/activate() results may be exposed to the owner browser.
 * configuration() is an internal trusted-configuration accessor: its clone contains
 * credentials and must NEVER be serialized to HTTP, diagnostics, logs, or events.
 * PC protocol references: huangjunsen0406/py-xiaozhi src/activation/{identity,ota,client}.py.
 * The app/board names identify our own software; no ESP efuse/factory identity is claimed.
 */
export function createOfficialRegistration({read,write,fetchImpl=globalThis.fetch,identityFactory=softwareIdentity,clock=Date.now}={}){
 let state=null,status='not_configured',code='xiaozhi_not_configured',closed=false,current=null,storageInvalid=false;
 try{
  if(typeof read!=='function'||typeof write!=='function'||typeof fetchImpl!=='function'||typeof identityFactory!=='function'||typeof clock!=='function')throw fail('xiaozhi_storage_invalid');
  const stored=read();if(stored!==null&&stored!==undefined)state=storedState(stored);
  if(state?.configuration){status='configured';code=null;}
  else if(state?.activation){status='pending';code='xiaozhi_pending';}
 }catch{storageInvalid=true;status='error';code='xiaozhi_storage_invalid';}

 function expired(){return !!state?.activation&&Date.parse(state.activation.expiresAt)<=clock();}
 function snapshot(){
  const isExpired=expired(),showPairing=!closed&&!isExpired&&!!state?.activation;
  return{configured:!closed&&!!state?.configuration,status:closed?'closed':isExpired?'error':status,
   code:closed?'xiaozhi_closed':isExpired?'xiaozhi_challenge_expired':code,
   pairingCode:showPairing?state.activation.pairingCode:null,expiresAt:showPairing?state.activation.expiresAt:null};
 }
 async function operation(action){
  if(closed)throw fail('xiaozhi_closed');if(current)throw fail('xiaozhi_busy');if(storageInvalid)throw fail('xiaozhi_storage_invalid');
  const controller=new AbortController();let rejectAbort;
  const abortPromise=new Promise((_,reject)=>{rejectAbort=reject;});
  controller.signal.addEventListener('abort',()=>rejectAbort(controller.signal.reason),{once:true});
  const ctx={controller,check(){if(controller.signal.aborted)throw controller.signal.reason;},async wait(promise){const result=await Promise.race([promise,abortPromise]);ctx.check();return result;}};
  const timer=setTimeout(()=>controller.abort(fail('xiaozhi_timeout')),DEADLINE_MS);current=ctx;
  try{await ctx.wait(action(ctx));ctx.check();return snapshot();}
  catch(error){const failure=controller.signal.aborted?controller.signal.reason:ERROR_CODES.has(error?.code)?fail(error.code):fail('xiaozhi_provider_failed');if(!closed){status='error';code=failure.code;}throw failure;}
  finally{clearTimeout(timer);if(current===ctx)current=null;}
 }
 async function persist(ctx,next){
  ctx.check();try{await ctx.wait(write(copy(next)));}catch(error){if(ctx.controller.signal.aborted)throw error;throw fail('xiaozhi_storage_failed');}
  ctx.check();state=next;
 }
 async function ensureIdentity(ctx){
  if(state)return;
  let identity;try{identity=validIdentity(identityFactory());}catch{throw fail('xiaozhi_storage_invalid');}
  await persist(ctx,{version:1,identity,activation:null,configuration:null});
 }
 function headers(activating=false){
  return{'Device-Id':state.identity.deviceId,'Client-Id':state.identity.clientId,'Content-Type':'application/json','Activation-Version':'2',
   ...(!activating?{'User-Agent':'kibi-server-software/kibi-server-1.0.0','Accept-Language':'zh-CN'}:{})};
 }
 async function request(ctx,url,payload,activating=false){
  const response=await ctx.wait(Promise.resolve().then(()=>fetchImpl(url,{method:'POST',headers:headers(activating),body:JSON.stringify(payload),redirect:'manual',signal:ctx.controller.signal})));
  function rejectResponse(code){try{Promise.resolve(response?.body?.cancel()).catch(()=>{});}catch{}throw fail(code);}
  if(!response||response.redirected||response.url&&response.url!==url||response.status!==200&&!(activating&&response.status===202))rejectResponse('xiaozhi_provider_failed');
  const length=response.headers?.get('content-length');if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>MAX_RESPONSE))rejectResponse('xiaozhi_invalid_response');
  if(!response.body)return{status:response.status,text:''};
  if(typeof response.body.getReader!=='function')throw fail('xiaozhi_invalid_response');
  const reader=response.body.getReader();let total=0;const chunks=[];
  const cancel=()=>{Promise.resolve(reader.cancel()).catch(()=>{});};ctx.controller.signal.addEventListener('abort',cancel,{once:true});
  try{
   while(true){const {done,value}=await ctx.wait(reader.read());if(done)break;
    total+=value.byteLength;if(total>MAX_RESPONSE||chunks.length>=1024){cancel();throw fail('xiaozhi_invalid_response');}chunks.push(Buffer.from(value));}
   return{status:response.status,text:Buffer.concat(chunks,total).toString('utf8')};
  }finally{ctx.controller.signal.removeEventListener('abort',cancel);try{reader.releaseLock();}catch{}}
 }
 async function ota(ctx){
  const id=state.identity;
  const result=await request(ctx,OTA,{application:{version:'1.0.0',elf_sha256:id.hmacKey},board:{type:'kibi-server-software',name:'kibi-server',ip:'127.0.0.1',mac:id.deviceId}});
  let data;try{data=JSON.parse(result.text);}catch{throw fail('xiaozhi_invalid_response');}
  if(!object(data))throw fail('xiaozhi_invalid_response');
  // Validate any returned WSS target even while pairing; never retain raw OTA objects.
  const configuration=data.websocket==null?null:trustedConfiguration(data.websocket,id);
  if(data.activation!==undefined){
   const value=data.activation,milliseconds=value?.timeout_ms??300_000;
   if(!object(value)||typeof value.code!=='string'||!/^\d{6}$/.test(value.code)||!ascii(value.challenge,4096)||!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>MAX_PAIRING_MS)throw fail('xiaozhi_invalid_response');
   const activation={challenge:value.challenge,pairingCode:value.code,expiresAt:new Date(clock()+milliseconds).toISOString()};
   await persist(ctx,{...state,activation,configuration:null});status='pending';code='xiaozhi_pending';return;
  }
  if(configuration){await persist(ctx,{...state,activation:null,configuration});status='configured';code=null;return;}
  throw fail(data.mqtt?'xiaozhi_mqtt_unsupported':'xiaozhi_invalid_response');
 }
 return{
  snapshot,
  configuration(){return !closed&&state?.configuration?copy(state.configuration):null;},
  prepare(){return operation(async ctx=>{await ensureIdentity(ctx);await ota(ctx);});},
  activate(){return operation(async ctx=>{
   if(!state?.activation)throw fail('xiaozhi_not_configured');if(expired())throw fail('xiaozhi_challenge_expired');
   const {challenge}=state.activation;
   const result=await request(ctx,OTA+'activate',{Payload:{algorithm:'hmac-sha256',serial_number:state.identity.serialNumber,challenge,hmac:createHmac('sha256',state.identity.hmacKey).update(challenge).digest('hex')}},true);
   if(result.status===202){status='pending';code='xiaozhi_pending';return;}
   // A 200 acknowledgment alone contains no usable cloud transport. Re-fetch OTA.
   await ota(ctx);
  });},
  close(){if(closed)return;closed=true;status='closed';code='xiaozhi_closed';current?.controller.abort(fail('xiaozhi_closed'));state=null;}
 };
}
