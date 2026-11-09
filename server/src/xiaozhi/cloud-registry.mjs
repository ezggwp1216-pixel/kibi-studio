import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync} from 'node:fs';
import {isAbsolute,parse,resolve,dirname,join} from 'node:path';
import {createHash,createDecipheriv} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const DEFAULT_DATA='/var/lib/kibi-voice',HEX32=/^[0-9a-f]{32}$/,HEX64=/^[0-9a-f]{64}$/;
const fail=()=>Object.assign(new Error('cloud_voice_unavailable'),{code:'cloud_voice_unavailable'});
const hash=value=>createHash('sha256').update(value).digest('hex');
const increment=n=>Math.min(Number.MAX_SAFE_INTEGER,n+1);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const MODES=new Set([0o440,0o600,0o640]);

function absolute(value){if(typeof value!=='string'||!value.length||value.length>4096||value.includes('\0')||!isAbsolute(value))throw fail();return resolve(value);}
function noSymlinkPath(path){
 let cursor=parse(path).root;
 for(const part of path.slice(cursor.length).split('/').filter(Boolean)){cursor=join(cursor,part);if(lstatSync(cursor).isSymbolicLink())throw fail();}
}
function privateDirectory(path){
 noSymlinkPath(path);const stat=lstatSync(path),mode=stat.mode&0o7777;
 if(!stat.isDirectory()||![0o700,0o750,0o500,0o550,0o2700,0o2750,0o2500,0o2550].includes(mode))throw fail();
 return stat;
}
function openPrivateFile(path,{size,maximum=64*1024}={}){
 const parent=privateDirectory(dirname(path));noSymlinkPath(path);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||!MODES.has(stat.mode&0o7777)||stat.uid!==0&&stat.uid!==parent.uid||size!==undefined&&stat.size!==size||stat.size<1||stat.size>maximum)throw fail();
  return{fd,stat};
 }catch{closeSync(fd);throw fail();}
}
const columns=`d.id AS device_id,d.active_generation_id,d.revoked_at,d.updated_at,
 g.id AS generation_id,g.device_id AS generation_device_id,g.source_hash,g.source_revision,
 g.configuration_revision,g.token_hash,g.state,g.created_at,g.expires_at`;
function activeMetadata(row,now){
 return !!row&&HEX32.test(row.device_id)&&HEX32.test(row.generation_id)&&row.generation_device_id===row.device_id&&
  row.active_generation_id===row.generation_id&&row.revoked_at===null&&row.state==='active'&&HEX64.test(row.source_hash)&&HEX64.test(row.token_hash)&&
  integer(row.source_revision)&&integer(row.configuration_revision)&&integer(row.updated_at)&&integer(row.created_at)&&
  (row.expires_at===null||integer(row.expires_at)&&row.expires_at>now);
}
function metadata(row){
 // The watcher stores only generation/revocation identity, never plaintext or ciphertext configuration.
 // updated_at is bookkeeping: preparing a pending replacement can change it while
 // the previously active generation must keep working until activation succeeds.
 return JSON.stringify([row.device_id,row.project_id,row.active_generation_id,row.generation_id,row.generation_device_id,row.source_hash,row.source_revision,row.configuration_revision,row.token_hash,row.state,row.created_at,row.expires_at]);
}
function decrypt(row,master){
 const encoded=row.encrypted_config;
 if(typeof encoded!=='string'||encoded.length<40||encoded.length>16384||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw fail();
 const bytes=Buffer.from(encoded,'base64');let plain;
 try{
  if(bytes.length<30||bytes.length>8220||bytes.toString('base64')!==encoded)throw fail();
  const decipher=createDecipheriv('aes-256-gcm',master,bytes.subarray(0,12));
  decipher.setAAD(Buffer.from('kibi-voice/v1:'+row.generation_id));decipher.setAuthTag(bytes.subarray(-16));
  plain=Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]);
  if(plain.length>8192)throw fail();
  const configuration=JSON.parse(plain.toString('utf8'));
  if(!configuration||Array.isArray(configuration)||typeof configuration!=='object'||Object.keys(configuration).sort().join(',')!=='api_base_url,api_key,model'||
   configuration.api_base_url!=='https://api.openai.com/v1'||configuration.model!=='gpt-realtime'||
   typeof configuration.api_key!=='string'||!configuration.api_key.length||configuration.api_key.length>4096||! /^[\x21-\x7e]+$/.test(configuration.api_key))throw fail();
  return Object.freeze({api_key:configuration.api_key,api_base_url:configuration.api_base_url,model:configuration.model});
 }finally{plain?.fill(0);bytes.fill(0);}
}

/** Server-only capability authorizer. dataDir/masterKeyFile are trusted process configuration.
 * The registry is a separate, read-only database. No Studio state or HTTP configuration is accepted.
 * The pilot intentionally has one active cancellation scope and one coalesced metadata poller.
 */
export function createCloudVoiceAuthorizer({dataDir=DEFAULT_DATA,masterKeyFile,pollMs=2000}={}){
 let db,dbFile,master,dbGuard,lookup,watch,timer=null,current=null,closed=false,code='ready';
 const totals={authorized:0,denied:0,revoked:0};
 try{
  dataDir=absolute(dataDir);privateDirectory(dataDir);
  masterKeyFile=absolute(masterKeyFile??join(dataDir,'master.key'));
  if(!Number.isSafeInteger(pollMs)||pollMs<25||pollMs>60000)throw fail();
  const key=openPrivateFile(masterKeyFile,{size:32});
  try{master=readFileSync(key.fd);if(master.length!==32)throw fail();}finally{closeSync(key.fd);}
  dbFile=join(dataDir,'voice.sqlite3');dbGuard=openPrivateFile(dbFile,{maximum:256*1024*1024});
  db=new DatabaseSync(dbFile,{readOnly:true,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false,timeout:250});
  const after=lstatSync(dbFile);if(after.dev!==dbGuard.stat.dev||after.ino!==dbGuard.stat.ino)throw fail();
  // DELETE avoids read-only WAL/shm side files; the Python writer initializes this journal mode.
  if(db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='delete')throw fail();
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
  const tables=db.prepare("SELECT name,type FROM sqlite_schema WHERE name IN ('voice_devices','voice_generations')").all();
  if(tables.length!==2||tables.some(table=>table.type!=='table'))throw fail();
  const hasProject=db.prepare('PRAGMA table_info(voice_devices)').all().some(column=>column.name==='project_id');
  const scopedColumns=columns+(hasProject?',d.project_id':',NULL AS project_id');
  lookup=db.prepare(`SELECT ${scopedColumns},g.encrypted_config FROM voice_generations g JOIN voice_devices d ON d.id=g.device_id WHERE g.token_hash=? LIMIT 2`);
  watch=db.prepare(`SELECT ${scopedColumns} FROM voice_generations g JOIN voice_devices d ON d.id=g.device_id WHERE d.id=? AND g.id=? LIMIT 2`);
 }catch{
  try{db?.close();}catch{}if(dbGuard)try{closeSync(dbGuard.fd);}catch{}master?.fill(0);throw fail();
 }
 function stopTimer(){if(timer!==null){clearInterval(timer);timer=null;}}
 function retire(reason,{revoked=false}={}){
  const previous=current;current=null;stopTimer();
  if(previous){if(revoked)totals.revoked=increment(totals.revoked);previous.controller.abort(Object.assign(new Error(reason),{code:reason}));}
 }
 function unchangedFile(){
  const parent=privateDirectory(dataDir),stat=lstatSync(dbFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.dev!==dbGuard.stat.dev||stat.ino!==dbGuard.stat.ino||stat.nlink!==1||!MODES.has(stat.mode&0o7777)||stat.uid!==0&&stat.uid!==parent.uid)throw fail();
 }
 function poll(){
  if(closed||!current)return;
  try{
   unchangedFile();const rows=watch.all(current.deviceId,current.generationId);
   if(rows.length!==1||!activeMetadata(rows[0],Math.floor(Date.now()/1000))||metadata(rows[0])!==current.metadata){code='revoked';retire('revoked',{revoked:true});}
  }catch{code='registry_unavailable';retire('registry_unavailable',{revoked:true});}
 }
 function denied(){totals.denied=increment(totals.denied);if(!closed)code='authentication_required';return null;}
 return{
  authorize(request={}){
   const token=request?.token;
   if(closed||typeof token!=='string'||!HEX64.test(token))return denied();
   let row,configuration;
   try{
    unchangedFile();const rows=lookup.all(hash(token));
    if(rows.length!==1||!activeMetadata(rows[0],Math.floor(Date.now()/1000)))return denied();
    row=rows[0];configuration=decrypt(row,master);
   }catch{return denied();}
   // An invalid attempt never retires an existing valid session.
   retire('superseded');const controller=new AbortController();
   current={deviceId:row.device_id,generationId:row.generation_id,metadata:metadata(row),controller};
   timer=setInterval(poll,pollMs);timer.unref?.();totals.authorized=increment(totals.authorized);code='authorized';
   return{configuration,signal:controller.signal,principal:Object.freeze({kind:'legacy',id:typeof row.project_id==='string'?row.project_id:null})};
  },
  snapshot:()=>({kind:'cloud-voice-authorizer',code,metrics:{...totals,activeScopes:current?1:0,pollers:timer===null?0:1}}),
  close(){if(closed)return;closed=true;code='closed';retire('closed');master.fill(0);try{db.close();}finally{closeSync(dbGuard.fd);}}
 };
}
