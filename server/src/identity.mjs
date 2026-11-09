import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {openAccounts} from './accounts.mjs';
import {createPairings} from './pairing.mjs';
import {validatePlugin} from '../sdk/manifest.mjs';

const derive=promisify(scrypt), sha=value=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const TTL=12*60*60*1000;
const PUBLIC=new Map([
 ['/docs/API.md',['../docs/API.md','text/plain; charset=utf-8']],
 ['/docs/MODULES.md',['../docs/MODULES.md','text/plain; charset=utf-8']],
 ['/docs/SDK.md',['../docs/SDK.md','text/plain; charset=utf-8']],
 ['/docs/LOCAL_STUDIO.md',['../docs/LOCAL_STUDIO.md','text/plain; charset=utf-8']],
 ['/sdk/index.mjs',['../sdk/index.mjs','text/javascript; charset=utf-8']],
 ['/sdk/client.mjs',['../sdk/client.mjs','text/javascript; charset=utf-8']],
 ['/sdk/manifest.mjs',['../sdk/manifest.mjs','text/javascript; charset=utf-8']],
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
 const signIn=(req,res,user,status)=>{
  const previous=sessionOf(req);if(previous)sessions.delete(previous.key);
  const own=[...sessions.values()].filter(s=>s.user.id===user.id);if(own.length>=8)sessions.delete(own[0].key);
  if(sessions.size>=1024)throw fail(503,'server_busy');
  const token=secret(),s={key:sha(token),csrf:secret(),expires:Date.now()+TTL,user};
  sessions.set(s.key,s);setCookie(res,token,TTL/1000);json(res,status,{ok:true,csrfToken:s.csrf,user});
 };
 const coreOptions={...options,adminPassword:'unused delegated authentication',sessionResolver:resolver};
 const indexTokens=(id,hashes)=>{for(const [hash,ownerId]of deviceOwners)if(ownerId===id)deviceOwners.delete(hash);for(const hash of hashes)deviceOwners.set(hash,id);};
 const tenantOptions=(id,extra={})=>({...coreOptions,...extra,onDevicesChanged:hashes=>indexTokens(id,hashes)});
 const owner=await createTenant(tenantOptions('owner'));tenants.set('owner',owner);indexTokens('owner',owner.kibiContext.tokenHashes());
 let accounts;
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
 const pairings=createPairings({apiBase,issueDevice:async(ownerId,name)=>(await readyTenant(ownerId)).kibiContext.createDevice(name)});
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
     const user=await accounts.register(body.email,body.password);await readyTenant(user.id);return signIn(req,res,user,201);
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
   if(method==='GET'&&path==='/api/sdk')return json(res,200,{version:'1.0',validation:true,execution:false,links:{instructions:'docs/LOCAL_STUDIO.md',sdk:'docs/SDK.md',client:'sdk/index.mjs',schema:'sdk/kibiplugin.schema.json',example:'examples/server-plugin/local-notification.kibiplugin'}});
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
  const closing=Promise.allSettled([...tenants.values()].map(async t=>(t.creating?await t.creating:t).kibiContext.close()));
  closeHttp(error=>{closing.then(results=>callback?.(error|| (results.some(r=>r.status==='rejected')?new Error('voice_close_failed'):undefined)));});return server;
 };
 return server;
}
