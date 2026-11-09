import {lstat,realpath,open,rm,rename} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';

export const MANAGED_ASSET_PATH='embedded_assets.h';
export const PUBLIC_ASSET_BASE=Object.freeze({bytes:1538725,sha256:'070bb82f0d9a0f9d1c397957141023cb6662b50d1b925cdfec2c1ccdc4d94ef3'});
const PREFIX='\n// KIBI_PUBLIC_ASSETS_V1\n// Generated public resource blocks. Managed append-only; do not edit.\n';
const MAX_HEADER=2*1024*1024,MAX_TOTAL=4*1024*1024;
const ID=/^(?:leroyd_c309|public_image)_[a-f0-9]{16}$/;
const digest=content=>createHash('sha256').update(content).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const same=(a,b)=>a&&b&&a.ino===b.ino&&a.dev===b.dev;
const decoder=new TextDecoder('utf-8',{fatal:true});
function text(bytes){try{return decoder.decode(bytes);}catch{fail('ASSET_FORMAT');}}

// Data-only framing shared by the trusted generator and installer. The digest and
// byte length make each block independently verifiable; no C++ is ever executed.
export function createManagedAssetBlock(assetId,source){
 if(!ID.test(assetId)||typeof source!=='string'||!source.startsWith('#pragma once\n')||source.includes('\0'))fail('ASSET_INPUT');
 if(!source.endsWith('\n'))source+='\n';
 const bytes=Buffer.from(source);if(bytes.length>MAX_HEADER)fail('ASSET_LIMIT');
 return `// KIBI_ASSET_BEGIN ${assetId} ${digest(bytes)} ${bytes.length}\n${source}// KIBI_ASSET_END ${assetId}\n`;
}
function parseBlocks(bytes,at=0){
 const blocks=new Map();
 while(at<bytes.length){
  const start=at,end=bytes.indexOf(10,at);if(end<0||end-at>200)fail('ASSET_FORMAT');
  const match=/^\/\/ KIBI_ASSET_BEGIN ((?:leroyd_c309|public_image)_[a-f0-9]{16}) ([a-f0-9]{64}) ([1-9][0-9]{0,6})$/.exec(bytes.toString('ascii',at,end));
  if(!match||blocks.has(match[1]))fail('ASSET_FORMAT');
  const size=Number(match[3]);at=end+1;if(size>MAX_HEADER||at+size>bytes.length)fail('ASSET_FORMAT');
  const body=bytes.subarray(at,at+size),source=text(body);if(digest(body)!==match[2]||!source.startsWith('#pragma once\n')||!source.endsWith('\n')||source.includes('\0'))fail('ASSET_FORMAT');at+=size;
  const finish=Buffer.from(`// KIBI_ASSET_END ${match[1]}\n`);if(!bytes.subarray(at,at+finish.length).equals(finish))fail('ASSET_FORMAT');at+=finish.length;
  blocks.set(match[1],bytes.subarray(start,at));
 }
 return blocks;
}
function parseAggregate(bytes){
 if(bytes.length<PUBLIC_ASSET_BASE.bytes||bytes.length>MAX_HEADER||digest(bytes.subarray(0,PUBLIC_ASSET_BASE.bytes))!==PUBLIC_ASSET_BASE.sha256)fail('ASSET_BASE');
 if(bytes.length===PUBLIC_ASSET_BASE.bytes)return new Map();
 const prefix=Buffer.from(PREFIX),at=PUBLIC_ASSET_BASE.bytes;
 if(!bytes.subarray(at,at+prefix.length).equals(prefix))fail('ASSET_FORMAT');
 return parseBlocks(bytes,at+prefix.length);
}
function snapshotSize(file){
 if(typeof file.content==='string')return Buffer.byteLength(file.content);
 if(Buffer.isBuffer(file.bytes)||file.bytes instanceof Uint8Array)return file.bytes.length;
 if(Number.isSafeInteger(file.bytes)&&file.bytes>=0)return file.bytes;
 fail('ASSET_SNAPSHOT');
}
function snapshotHash(file){
 const content=typeof file.content==='string'?Buffer.from(file.content):Buffer.isBuffer(file.bytes)||file.bytes instanceof Uint8Array?Buffer.from(file.bytes):null;
 const declared=file.sha256??file.hash;
 if(declared!==undefined&&(typeof declared!=='string'||!/^[a-f0-9]{64}$/.test(declared)))fail('ASSET_SNAPSHOT');
 if(content&&declared&&digest(content)!==declared)fail('ASSET_SNAPSHOT');
 if(!content&&!declared)fail('ASSET_SNAPSHOT');
 return declared??digest(content);
}

// Trusted host only. Host serializes project mutations and updates protectedHashes
// from the returned hashes. The pinned stock artwork prefix stays byte-for-byte
// unchanged. Only this existing asset bank receives verified blocks by atomic
// replacement; drivers and other application files are never opened for writing.
// Node lacks openat: this rejects awaited-boundary swaps, not an arbitrary hostile
// same-user syscall race. Rollback touches only inodes created by this operation.
export async function installManagedAssets({sourceDir,existingFiles,input,guard=async()=>{}}){
 const {assetId,files,mode}=input||{};
 if(mode!=='append-only'||!ID.test(assetId)||!Array.isArray(files)||files.length!==1||files[0]?.path!==MANAGED_ASSET_PATH||typeof files[0].content!=='string'||typeof input.assertProjectCurrent!=='function'||!Array.isArray(existingFiles))fail('ASSET_INPUT');
 const block=Buffer.from(files[0].content),incoming=parseBlocks(block);
 if(incoming.size!==1||!incoming.has(assetId))fail('ASSET_INPUT');
 const entries=existingFiles.filter(f=>f.path===MANAGED_ASSET_PATH);if(entries.length>1||new Set(existingFiles.map(f=>f.path)).size!==existingFiles.length)fail('ASSET_SNAPSHOT');
 const expected=entries[0];if(!expected)fail('ASSET_SNAPSHOT');
 const oldSize=snapshotSize(expected),total=existingFiles.reduce((sum,f)=>sum+snapshotSize(f),0);
 if(existingFiles.length>63)fail('ASSET_LIMIT');
 sourceDir=resolve(sourceDir);const directoryPaths=[dirname(sourceDir),sourceDir],owned=new Map();let pins;
 async function directory(path){
  const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)fail('ASSET_BOUNDARY');return info;
 }
 async function parent(){for(let i=0;i<directoryPaths.length;i++)if(!same(await directory(directoryPaths[i]),pins[i]))fail('ASSET_BOUNDARY');}
 async function guarded(){await guard();await input.assertProjectCurrent();if(pins)await parent();}
 await guarded();pins=[await directory(directoryPaths[0]),await directory(directoryPaths[1])];await parent();
 const target=join(sourceDir,MANAGED_ASSET_PATH);
 async function readTarget(){
  await parent();let before;try{before=await lstat(target);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX_HEADER)fail('ASSET_BOUNDARY');
  const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes,info;
  try{info=await handle.stat();if(!same(before,info)||info.nlink!==1)fail('ASSET_CHANGED');bytes=await handle.readFile();const after=await handle.stat();if(!same(info,after)||after.nlink!==1||after.size!==bytes.length||after.mtimeMs!==info.mtimeMs)fail('ASSET_CHANGED');}
  finally{await handle.close();}
  await parent();const after=await lstat(target);if(!same(info,after)||after.nlink!==1)fail('ASSET_CHANGED');return{bytes,info,hash:digest(bytes)};
 }
 const old=await readTarget();
 if(Boolean(old)!==Boolean(expected)||old&&(old.bytes.length!==oldSize||old.hash!==snapshotHash(expected)))fail('ASSET_CHANGED');
 const blocks=old?parseAggregate(old.bytes):new Map();
 if(blocks.has(assetId)){
  if(!blocks.get(assetId).equals(block))fail('ASSET_CONFLICT');
  await guarded();const current=await readTarget();if(!current||!same(current.info,old.info)||current.hash!==old.hash)fail('ASSET_CHANGED');
  return{paths:[MANAGED_ASSET_PATH],hashes:{[MANAGED_ASSET_PATH]:old.hash},unchanged:true};
 }
 const next=Buffer.concat([old.bytes,...(old.bytes.length===PUBLIC_ASSET_BASE.bytes?[Buffer.from(PREFIX)]:[]),block]);
 if(next.length>MAX_HEADER||total-oldSize+next.length>MAX_TOTAL)fail('ASSET_LIMIT');
 async function stage(bytes,label){
  await parent();const path=join(directoryPaths[0],`.kibi-assets-${randomBytes(16).toString('hex')}.${label}`);
  const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);
  try{const info=await handle.stat();owned.set(path,info);await parent();if(!info.isFile()||info.nlink!==1)fail('ASSET_BOUNDARY');await handle.writeFile(bytes);await handle.sync();const after=await handle.stat();if(!same(info,after)||after.nlink!==1||after.size!==bytes.length)fail('ASSET_CHANGED');return{path,info};}
  finally{await handle.close();}
 }
 async function removeOwn(path){const info=await lstat(path).catch(()=>null);if(same(info,owned.get(path))){await rm(path);owned.delete(path);}}
 let staged,backup,committed=false;
 try{
  staged=await stage(next,'tmp');backup=await stage(old.bytes,'rollback');
  await guarded();const current=await readTarget();if(Boolean(current)!==Boolean(old)||old&&(!same(current.info,old.info)||current.hash!==old.hash))fail('ASSET_CHANGED');
  await parent();
  await rename(staged.path,target);owned.delete(staged.path);
  committed=true;owned.set(target,staged.info);
  await guarded();const installed=await readTarget();if(!installed||!same(installed.info,staged.info)||installed.hash!==digest(next))fail('ASSET_CHANGED');
  return{paths:[MANAGED_ASSET_PATH],hashes:{[MANAGED_ASSET_PATH]:installed.hash},unchanged:false};
 }catch(error){
  if(committed){
   const current=await lstat(target).catch(()=>null);
   if(same(current,staged.info)){
    try{await parent();if(backup){await rename(backup.path,target);owned.delete(backup.path);owned.delete(target);}else await removeOwn(target);}
    catch{error.rollbackIncomplete=true;}
   }
  }
  throw error;
 }finally{for(const path of [...owned.keys()])if(path!==target)await removeOwn(path);}
}
