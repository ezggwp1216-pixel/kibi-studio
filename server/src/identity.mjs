import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {openAccounts} from './accounts.mjs';
import {createPairings} from './pairing.mjs';
import {openStudioLinks,STUDIO_SCOPES} from './studio-links.mjs';
import {validatePlugin} from '../sdk/manifest.mjs';

const derive=promisify(scrypt), sha=value=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const TTL=12*60*60*1000;
const PUBLIC=new Map([
 ['/docs/API.md',['../docs/API.md','text/plain; charset=utf-8']],
 ['/docs/MODULES.md',['../docs/MODULES.md','text/plain; charset=utf-8']],
 ['/docs/HARDWARE.md',['../docs/HARDWARE.md','text/plain; charset=utf-8']],
 ['/docs/SERVICES.md',['../docs/SERVICES.md','text/plain; charset=utf-8']],
 ['/docs/SDK_UPDATE.md',['../docs/SDK_UPDATE.md','text/plain; charset=utf-8']],
 ['/docs/VOICE.md',['../docs/VOICE.md','text/plain; charset=utf-8']],
 ['/docs/SDK.md',['../docs/SDK.md','text/plain; charset=utf-8']],
 ['/docs/LOCAL_STUDIO.md',['../docs/LOCAL_STUDIO.md','text/plain; charset=utf-8']],
 ['/docs/STUDIO_CONNECTION.md',['../docs/STUDIO_CONNECTION.md','text/plain; charset=utf-8']],
 ['/sdk/index.mjs',['../sdk/index.mjs','text/javascript; charset=utf-8']],
 ['/sdk/client.mjs',['../sdk/client.mjs','text/javascript; charset=utf-8']],
 ['/sdk/manifest.mjs',['../sdk/manifest.mjs','text/javascript; charset=utf-8']],
 ['/sdk/validate.mjs',['../sdk/validate.mjs','text/javascript; charset=utf-8']],
 ['/sdk/device/contract.json',['../sdk/device/contract.json','application/json; charset=utf-8']],
 ['/sdk/device/release.json',['../sdk/device/release.json','application/json; charset=utf-8']],
 ['/sdk/device/doctor.mjs',['../sdk/device/doctor.mjs','text/javascript; charset=utf-8']],
 ['/sdk/device/update.mjs',['../sdk/device/update.mjs','text/javascript; charset=utf-8']],
 ['/sdk/device/README.md',['../sdk/device/README.md','text/plain; charset=utf-8']],
 ['/sdk/device/kibi-device-support-20261109.tar.gz',['../sdk/device/kibi-device-support-20261109.tar.gz','application/gzip']],
 ['/sdk/kibiplugin.schema.json',['../sdk/kibiplugin.schema.json','application/json; charset=utf-8']],
 ['/examples/server-plugin/local-notification.kibiplugin',['../examples/server-plugin/local-notification.kibiplugin','application/json; charset=utf-8']],
 ['/examples/server-plugin/future-handler.kibiplugin',['../examples/server-plugin/future-handler.kibiplugin','application/json; charset=utf-8']],
]);

async function bodyOf(req,max=16384){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw fail(415,'json_required');
 let size=0;const chunks=[];
 for await(const chunk of req){size+=chunk.length;if(size>max)throw fail(413,'body_too_large');chunks.push(chunk);}
 try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
 catch{throw fail(400,'invalid_json');}
}

// Each tenant uses an independent instance of the existing API handler and store.
// These handlers have no listening HTTP socket and receive identity only here.
export async function createIdentityServer(options,createTenant){
 const {dataDir,adminPassword,publicOrigin,cookiePath=process.env.KIBI_COOKIE_PATH||'/'}=options;
 let origin;
 try{origin=new URL(publicOrigin);}catch{throw new Error('invalid_public_origin');}
 if(!['http:','https:'].includes(origin.protocol)||origin.origin!==publicOrigin)throw new Error('invalid_public_origin');
 if(typeof dataDir!=='string'||typeof adminPassword!=='string'||adminPassword.trim().length<12||adminPassword.length>1024)throw new Error('invalid_configuration');
 if(!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(cookiePath))throw new Error('invalid_cookie_path');
 const sessions=new Map(),bound=new WeakMap(),tenants=new Map(),rates=new Map(),deviceOwners=new Map();
 const salt=randomBytes(16),ownerHash=await derive(adminPassword,salt,32);
 let ownerKdfs=0,closed=false;
 const rate=(key,limit)=>{
  const now=Date.now();for(const [k,v]of rates)if(v.until<=now)rates.delete(k);
  let bucket=rates.get(key);if(!bucket){if(rates.size>=2048)throw fail(429,'rate_limited');bucket={count:0,until:now+60000};rates.set(key,bucket);}
  if(++bucket.count>limit)throw fail(429,'rate_limited');
 };
 const sessionOf=req=>{
  for(const [key,s]of sessions)if(s.expires<=Date.now())sessions.delete(key);
  const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('kibi_session='));
  return cookie?sessions.get(sha(cookie.slice(13)))||null:null;
 };
 const resolver=req=>{const s=bound.get(req);return s&&sessions.get(s.key)===s&&s.expires>Date.now()?s:null;};
 const requireOrigin=req=>{if(req.headers.origin!==publicOrigin)throw fail(403,'origin_forbidden');};
 const authorize=(req,mutation=false)=>{
  const s=sessionOf(req);if(!s)throw fail(401,'unauthorized');
  if(mutation){requireOrigin(req);if(typeof req.headers['x-csrf-token']!=='string'||!timingSafeEqual(Buffer.from(sha(req.headers['x-csrf-token']),'hex'),Buffer.from(sha(s.csrf),'hex')))throw fail(403,'csrf_forbidden');}
  rate(`session:${s.key}`,240);return s;
 };
 const setCookie=(res,value,age)=>res.setHeader('Set-Cookie',`kibi_session=${value}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${age}${origin.protocol==='https:'?'; Secure':''}`);
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 const signIn=(req,res,user,status,extra={})=>{
  const previous=sessionOf(req);if(previous)sessions.delete(previous.key);
  const own=[...sessions.values()].filter(s=>s.user.id===user.id);if(own.length>=8)sessions.delete(own[0].key);
  if(sessions.size>=1024)throw fail(503,'server_busy');
  const token=secret(),s={key:sha(token),csrf:secret(),expires:Date.now()+TTL,user};
  sessions.set(s.key,s);setCookie(res,token,TTL/1000);json(res,status,{ok:true,csrfToken:s.csrf,user,...extra});
 };
 const coreOptions={...options,adminPassword:'unused delegated authentication',sessionResolver:resolver};
 let owner=null,accounts;
 const indexTokens=(id,hashes)=>{for(const [hash,ownerId]of deviceOwners)if(ownerId===id)deviceOwners.delete(hash);for(const hash of hashes)deviceOwners.set(hash,id);owner?.kibiContext.voice.reconcile();};
 const delegatedDeviceExists=grant=>!closed&&grant?.accountId!=='owner'&&tenants.get(grant?.accountId)?.kibiContext?.hasDevice(grant.deviceId)===true;
 const studioAccountExists=id=>!closed&&id!=='owner'&&!!accounts?.get(id);
 const authorizeDelegatedDevice=async({token,delegation})=>{
  if(closed||!delegatedDeviceExists(delegation)||deviceOwners.get(sha(token))!==delegation.accountId)return null;
  const tenant=tenants.get(delegation.accountId),permission=await tenant.kibiContext.authorizeVoice({token,deviceId:delegation.deviceId});
  if(closed||!permission||!delegatedDeviceExists(delegation)||deviceOwners.get(sha(token))!==delegation.accountId||permission.signal.aborted)return null;
  return {...permission,principal:Object.freeze({kind:'account',accountId:delegation.accountId,id:permission.principal.id})};
 };
 const tenantOptions=(id,extra={})=>({...coreOptions,...extra,onDevicesChanged:hashes=>indexTokens(id,hashes),...(id==='owner'?{authorizeDelegatedDevice,delegatedDeviceExists,studioAccountExists}:{tenantVoiceStatus:()=>owner.kibiContext.voice.delegatedStatus(id)})});
 owner=await createTenant(tenantOptions('owner'));tenants.set('owner',owner);indexTokens('owner',owner.kibiContext.tokenHashes());
 try{
  accounts=await openAccounts(dataDir);
  for(const user of accounts.list()){
   const tenant=await createTenant(tenantOptions(user.id,{dataDir:accounts.dataDirFor(user.id),ordinaryUser:true,voiceConfig:{enabled:false}}));
   tenants.set(user.id,tenant);indexTokens(user.id,tenant.kibiContext.tokenHashes());
  }
 }catch(error){await Promise.all([...tenants.values()].map(t=>t.kibiContext.close()));throw error;}
 const tenantOf=async id=>{
  let tenant=tenants.get(id);if(tenant)return tenant;
  if(!accounts.get(id)||closed)throw fail(401,'unauthorized');
  // Registration is serialized by the account directory. Context construction is
  // also serialized so simultaneous first logins cannot open the same store twice.
  const creating=createTenant(tenantOptions(id,{dataDir:accounts.dataDirFor(id),ordinaryUser:true,voiceConfig:{enabled:false}}));
  tenants.set(id,{creating});
  try{tenant=await creating;tenants.set(id,tenant);indexTokens(id,tenant.kibiContext.tokenHashes());return tenant;}catch(error){tenants.delete(id);throw error;}
 };
 const readyTenant=async id=>{const t=tenants.get(id);return t?.creating?await t.creating:tenantOf(id);};
 const apiBase=new URL(cookiePath,publicOrigin).href;
 let studioLinks;
 try{studioLinks=await openStudioLinks(dataDir,{accountExists:studioAccountExists});}
 catch(error){await Promise.all([...tenants.values()].map(t=>t.kibiContext.close()));throw error;}
 const pairings=createPairings({apiBase,issueDevice:async(ownerId,name)=>(await readyTenant(ownerId)).kibiContext.createDevice(name)});
 const exactBody=(value,keys)=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
 // Bearer calls are server-to-server. If a browser sends Origin, it must be ours;
 // cookies never authenticate these routes. Tokens cannot authorize panel APIs.
 const studioOrigin=req=>{if(req.headers.origin!==undefined)requireOrigin(req);};
 const studioBearer=req=>{studioOrigin(req);const match=/^Bearer (kibi_studio_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');if(!match)throw fail(401,'studio_unauthorized');return match[1];};
 const studioProfile=(principal)=>({account:accounts.get(principal.accountId),connection:studioLinks.list(principal.accountId).find(c=>c.id===principal.connectionId),scopes:[...principal.scopes],voice:owner.kibiContext.voice.delegatedStatus(principal.accountId),voiceEligibility:owner.kibiContext.voice.studioVoiceEligibility(principal.accountId)});
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  try{
   const path=new URL(req.url,publicOrigin).pathname,method=req.method;
   const address=req.socket.remoteAddress||'unknown';
   if(method==='GET'&&path==='/api/session'){
    const s=sessionOf(req);return json(res,200,s?{authenticated:true,csrfToken:s.csrf,user:s.user}:{authenticated:false});
   }
   if(method==='POST'&&(path==='/api/login'||path==='/api/register')){
    requireOrigin(req);rate(`login:${address}`,10);const body=await bodyOf(req);
    if(path==='/api/register'){
     const user=await accounts.register(body.email,body.password);await readyTenant(user.id);
     let studioLink;try{studioLink=await studioLinks.issue(user.id);}catch{studioLink={code:null,error:'studio_link_unavailable'};}
     return signIn(req,res,user,201,{studioLink});
    }
    let user=null;
    if(body.email!==undefined){user=await accounts.authenticate(body.email,body.password);}
    else{
     if(typeof body.password!=='string'||body.password.length<1||body.password.length>1024)throw fail(401,'invalid_credentials');
     if(ownerKdfs>=4)throw fail(503,'server_busy');ownerKdfs++;
     try{if(timingSafeEqual(await derive(body.password,salt,32),ownerHash))user={id:'owner',email:null,role:'owner'};}finally{ownerKdfs--;}
    }
    if(!user)throw fail(401,'invalid_credentials');return signIn(req,res,user,200);
   }
   if(method==='POST'&&path==='/api/logout'){
    const s=authorize(req,true);sessions.delete(s.key);setCookie(res,'',0);return json(res,200,{ok:true});
   }
   if(path==='/api/studio/link-code'&&method==='POST'){
    const s=authorize(req,true);if(s.user.role!=='user')throw fail(403,'studio_account_unavailable');
    const body=await bodyOf(req);if(!exactBody(body,[]))throw fail(400,'invalid_input');
    rate(`studio-issue:${s.user.id}`,10);return json(res,201,await studioLinks.issue(s.user.id));
   }
   if(path==='/api/studio/connections'&&method==='GET'){
    const s=authorize(req);if(s.user.role!=='user')throw fail(403,'studio_account_unavailable');return json(res,200,{connections:studioLinks.list(s.user.id)});
   }
   if(path.startsWith('/api/studio/connections/')&&method==='DELETE'){
    const s=authorize(req,true);if(s.user.role!=='user')throw fail(403,'studio_account_unavailable');
    const id=path.slice('/api/studio/connections/'.length);
    if(!await studioLinks.revoke(s.user.id,id))throw fail(404,'studio_connection_not_found');return json(res,200,{ok:true});
   }
   if(path==='/api/studio/redeem'&&method==='POST'){
    studioOrigin(req);rate(`studio-redeem:${address}`,10);const body=await bodyOf(req);
    if(!exactBody(body,['code','label']))throw fail(400,'invalid_studio_link');
    const result=await studioLinks.redeem(body),principal=studioLinks.authenticate(result.token);
    if(!principal)throw fail(401,'studio_unauthorized');
    return json(res,201,{...result,account:accounts.get(principal.accountId),apiBase,scopes:[...STUDIO_SCOPES]});
   }
   if(path==='/api/studio/profile'&&method==='GET'){
    const token=studioBearer(req);rate(`studio-profile:${address}`,240);
    return json(res,200,await studioLinks.withAuthorization(token,'voice.status',principal=>studioProfile(principal)));
   }
   if(path==='/api/studio/devices'&&method==='GET'){
    const token=studioBearer(req);rate(`studio-devices:${address}`,240);
    return json(res,200,await studioLinks.withAuthorization(token,'devices.list',async principal=>({devices:(await readyTenant(principal.accountId)).kibiContext.listDevices()})));
   }
   if(path==='/api/studio/pairing/claim'&&method==='POST'){
    const token=studioBearer(req),body=await bodyOf(req);if(!exactBody(body,['code']))throw fail(400,'invalid_input');
    return json(res,200,await studioLinks.withAuthorization(token,'pairing.claim',principal=>{rate(`pair-claim:${principal.accountId}`,20);return pairings.claim(principal.accountId,body.code);}));
   }
   if(path==='/api/studio/voice/activate'&&method==='POST'){
    const token=studioBearer(req),body=await bodyOf(req);if(!exactBody(body,['deviceId']))throw fail(400,'invalid_input');
    rate(`studio-voice:${address}`,30);
    return json(res,200,await studioLinks.withAuthorization(token,'voice.activate',async principal=>({ok:true,voice:await owner.kibiContext.voice.activateStudioDevice({accountId:principal.accountId,deviceId:body.deviceId},{isAuthorized:()=>!principal.signal.aborted&&!closed})})));
   }
   if(path==='/api/studio/session'&&method==='DELETE'){
    const token=studioBearer(req);if(!await studioLinks.disconnect(token))throw fail(401,'studio_unauthorized');return json(res,200,{ok:true});
   }
   if(method==='GET'&&path==='/api/sdk')return json(res,200,{version:'1.0',deviceContract:'1.0',supportRelease:'2026-11-09-r1',validation:true,execution:false,links:{instructions:'docs/LOCAL_STUDIO.md',sdk:'docs/SDK.md',hardware:'docs/HARDWARE.md',services:'docs/SERVICES.md',update:'docs/SDK_UPDATE.md',deviceContract:'sdk/device/contract.json',supportRelease:'sdk/device/release.json',client:'sdk/index.mjs',schema:'sdk/kibiplugin.schema.json',example:'examples/server-plugin/local-notification.kibiplugin'}});
   if(method==='POST'&&path==='/api/sdk/validate'){
    authorize(req,true);const body=await bodyOf(req,136*1024),result=validatePlugin(typeof body.package==='string'?body.package:JSON.stringify(body.package));
    return json(res,200,{ok:true,valid:result.ok,errors:result.errors||[],requiresRuntime:!!result.requiresRuntime,runtimeSupported:false});
   }
   if(method==='POST'&&path==='/api/pairing/start'){
    rate(`pair-start:${address}`,5);return json(res,201,pairings.start(await bodyOf(req)));
   }
   if(method==='POST'&&path==='/api/pairing/poll'){
    rate(`pair-poll:${address}`,120);return json(res,200,pairings.poll(await bodyOf(req)));
   }
   if(method==='POST'&&path==='/api/pairing/claim'){
    const s=authorize(req,true);rate(`pair-claim:${s.user.id}`,20);const body=await bodyOf(req);
    return json(res,200,await pairings.claim(s.user.id,body.code));
   }
   if(path==='/api/settings/voice/studio-account'&&['POST','DELETE'].includes(method)){
    const s=authorize(req,true);if(s.user.id!=='owner'||s.user.role!=='owner')throw fail(403,'owner_required');bound.set(req,s);
    let accountId=null;
    if(method==='POST'){
     const body=await bodyOf(req);
     if(Object.keys(body).length!==1||typeof body.email!=='string'||body.email.length>254)throw fail(400,'invalid_studio_voice_account');
     const user=accounts.list().find(value=>value.email===body.email.trim().toLowerCase());
     if(!user)throw fail(400,'invalid_studio_voice_account');accountId=user.id;
    }
    if(resolver(req)!==s)throw fail(401,'unauthorized');
    return json(res,200,{ok:true,voice:await owner.kibiContext.voice.allowStudioAccount(accountId,{isAuthorized:()=>resolver(req)===s})});
   }
   if(path==='/api/settings/voice/delegation'&&['POST','DELETE'].includes(method)){
    const s=authorize(req,true);if(s.user.id!=='owner'||s.user.role!=='owner')throw fail(403,'owner_required');
    bound.set(req,s);
    let grant=null;
    if(method==='POST'){
     const body=await bodyOf(req);
     if(Object.keys(body).length!==2||typeof body.email!=='string'||body.email.length>254||typeof body.deviceId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(body.deviceId))throw fail(400,'invalid_voice_delegation');
     const user=accounts.list().find(value=>value.email===body.email.trim().toLowerCase());
     if(!user)throw fail(400,'invalid_voice_delegation');
     const tenant=await readyTenant(user.id);
     if(!tenant.kibiContext.hasDevice(body.deviceId))throw fail(400,'invalid_voice_delegation');
     grant={accountId:user.id,deviceId:body.deviceId};
    }
    // A body or tenant creation may have awaited while the owner logged out.
    if(resolver(req)!==s)throw fail(401,'unauthorized');
    return json(res,200,{ok:true,voice:await owner.kibiContext.voice.setDelegation(grant,{isAuthorized:()=>resolver(req)===s})});
   }
   const asset=PUBLIC.get(path);
   if(asset&&['GET','HEAD'].includes(method)){
    const data=await readFile(fileURLToPath(new URL(asset[0],import.meta.url)));
    res.writeHead(200,{'Content-Type':asset[1],'Content-Length':data.length});return res.end(method==='HEAD'?undefined:data);
   }
   let tenant=owner;
   if(path.startsWith('/api/device/')){
    const bearer=req.headers.authorization||'';
    if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer))throw fail(401,'unauthorized');
    rate(`device-auth:${address}`,2000);
    const hash=sha(bearer.slice(7));tenant=tenants.get(deviceOwners.get(hash));
    if(!tenant)throw fail(401,'unauthorized');
   }else if(path.startsWith('/api/')&&path!=='/api/health'){
    const s=authorize(req,method!=='GET');bound.set(req,s);tenant=await readyTenant(s.user.id);
   }
   tenant.emit('request',req,res);
  }catch(error){if(!res.headersSent)json(res,error.status||500,{ok:false,code:error.status?error.code:'internal_error'});else res.end();}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=50;server.maxConnections=256;
 const closeHttp=server.close.bind(server);
 server.close=callback=>{
  closed=true;pairings.clear();sessions.clear();
  const closing=Promise.allSettled([studioLinks.close(),...[...tenants.values()].map(async t=>(t.creating?await t.creating:t).kibiContext.close())]);
  closeHttp(error=>{closing.then(results=>callback?.(error|| (results.some(r=>r.status==='rejected')?new Error('voice_close_failed'):undefined)));});return server;
 };
 return server;
}
