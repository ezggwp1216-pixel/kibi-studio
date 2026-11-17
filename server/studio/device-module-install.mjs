import {lstat,realpath,open,link,rm} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import defaultManifest from './device-modules.json' with {type:'json'};

const names=['kibi_xiaozhi_core.h','kibi_xiaozhi_client.h'];
const dependencyNames=['wifi.h','http_json.h','audio_codec_power.h','server_transport.h','power_management.h'];
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>Object.assign(new Error(code),{code,status:409});
const same=(a,b)=>a&&b&&a.ino===b.ino&&a.dev===b.dev;
const size=f=>typeof f.content==='string'?Buffer.byteLength(f.content):Buffer.isBuffer(f.bytes)?f.bytes.length:Number.isSafeInteger(f.bytes)&&f.bytes>=0?f.bytes:NaN;

/** Trusted host only. The caller serializes project mutation and commits the
 * returned protection hashes. Source code is never executed by this installer.
 * Unknown existing headers are preserved; new files use exclusive hard-link
 * publication, so a racing destination cannot be overwritten. Like the asset
 * installer, this rejects boundary swaps rather than arbitrary same-user races.
 */
export async function installPublicDeviceModule({sourceDir,existingFiles,input,guard=()=>{},manifest=defaultManifest}={}) {
 if(input?.id!=='xiaozhi'||typeof input.assertProjectCurrent!=='function'||typeof guard!=='function'||!Array.isArray(existingFiles)||!Array.isArray(input.files)||input.files.length!==2||manifest?.id!=='xiaozhi'||manifest.schemaVersion!==1||!Array.isArray(manifest.files)||manifest.files.length!==2)throw fail('MODULE_INPUT');
 const incoming=new Map(),hashes={};
 for(const name of names){
  const matches=input.files.filter(f=>f?.path===name),pins=manifest.files.filter(f=>f?.path===name);
  if(matches.length!==1||pins.length!==1)throw fail('MODULE_PAYLOAD');
  const file=matches[0],pin=pins[0];
  if(typeof file.content!=='string'||file.content.includes('\0')||!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>512*1024||!/^[a-f0-9]{64}$/.test(pin.sha256||''))throw fail('MODULE_PAYLOAD');
  const bytes=Buffer.from(file.content);
  if(bytes.length!==pin.bytes||sha(bytes)!==pin.sha256||file.sha256!==pin.sha256)throw fail('MODULE_PAYLOAD');
  incoming.set(name,bytes);hashes[name]=pin.sha256;
 }
 if(new Set(existingFiles.map(f=>f.path)).size!==existingFiles.length)throw fail('MODULE_SNAPSHOT');
 if(!Array.isArray(manifest.dependencies)||manifest.dependencies.length!==dependencyNames.length)throw fail('MODULE_PAYLOAD');
 for(const name of dependencyNames){
  const matches=manifest.dependencies.filter(item=>item?.path===name),actual=existingFiles.find(item=>item.path===name);
  if(matches.length!==1||!Array.isArray(matches[0].sha256)||!matches[0].sha256.length||matches[0].sha256.length>8||matches[0].sha256.some(hash=>!/^[a-f0-9]{64}$/.test(hash)))throw fail('MODULE_PAYLOAD');
  if(!actual||!matches[0].sha256.includes(actual.sha256))throw fail('MODULE_SDK_INCOMPATIBLE');
 }
 let total=0;
 for(const f of existingFiles){const n=size(f);if(!Number.isSafeInteger(n)||n<0||n>2*1024*1024)throw fail('MODULE_SNAPSHOT');total+=n;}
 const additions=names.filter(name=>!existingFiles.some(f=>f.path===name));
 total+=additions.reduce((n,name)=>n+incoming.get(name).length,0);
 if(existingFiles.length+additions.length>96||total>4*1024*1024)throw fail('MODULE_LIMIT');
 for(const name of names){const existing=existingFiles.find(f=>f.path===name);if(existing&&existing.sha256!==hashes[name])throw fail('MODULE_CONFLICT');}
 sourceDir=resolve(sourceDir);const directories=[dirname(sourceDir),sourceDir],pins=[];
 async function directory(path){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(path)!==path)throw fail('MODULE_BOUNDARY');return s;}
 async function boundary(){for(let i=0;i<directories.length;i++){const current=await directory(directories[i]);if(pins[i]&&!same(current,pins[i]))throw fail('MODULE_BOUNDARY');}}
 async function guarded(){await guard();await input.assertProjectCurrent();await boundary();}
 await guarded();for(const p of directories)pins.push(await directory(p));
 async function read(name){
  await boundary();const path=join(sourceDir,name);let before;
  try{before=await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>512*1024)throw fail('MODULE_BOUNDARY');
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const opened=await fd.stat();if(!same(before,opened)||opened.nlink!==1)throw fail('MODULE_CHANGED');const bytes=await fd.readFile(),after=await fd.stat();if(after.size!==bytes.length||after.mtimeMs!==opened.mtimeMs||!same(opened,after))throw fail('MODULE_CHANGED');await boundary();if(!same(await lstat(path),opened))throw fail('MODULE_CHANGED');return{hash:sha(bytes),info:opened};}finally{await fd.close();}
 }
 const previous=new Map();
 for(const name of names){const current=await read(name),expected=existingFiles.find(f=>f.path===name);if(Boolean(current)!==Boolean(expected))throw fail('MODULE_CHANGED');if(current&&current.hash!==hashes[name])throw fail('MODULE_CONFLICT');previous.set(name,current);}
 const owned=new Map(),staged=new Map(),committed=[];
 async function removeOwn(path){const expected=owned.get(path);if(!expected)return;const now=await lstat(path).catch(()=>null);if(same(now,expected))await rm(path);owned.delete(path);}
 try{
  for(const name of additions){
   await boundary();const path=join(directories[0],'.kibi-module-'+randomUUID()+'.tmp'),fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);
   try{const info=await fd.stat();owned.set(path,info);await fd.writeFile(incoming.get(name));await fd.sync();if((await fd.stat()).size!==incoming.get(name).length)throw fail('MODULE_CHANGED');staged.set(name,{path,info});}finally{await fd.close();}
  }
  for(const name of additions){
   await guarded();for(const known of names){const current=await read(known),expected=previous.get(known);if(committed.includes(known)){if(current?.hash!==hashes[known]||!same(current.info,staged.get(known).info))throw fail('MODULE_CHANGED');}else if(Boolean(current)!==Boolean(expected)||current&&(current.hash!==expected.hash||!same(current.info,expected.info)))throw fail('MODULE_CHANGED');}
   const target=join(sourceDir,name),stage=staged.get(name);
   await link(stage.path,target);owned.set(target,stage.info);committed.push(name);await removeOwn(stage.path);
   await guarded();const installed=await read(name);if(!installed||installed.hash!==hashes[name]||!same(installed.info,stage.info))throw fail('MODULE_CHANGED');
  }
  await guarded();
  return{paths:[...names],hashes,changed:additions.length>0};
 }catch(error){for(const name of committed.reverse())await removeOwn(join(sourceDir,name));throw error;}
 finally{for(const path of [...owned.keys()])if(!names.some(name=>path===join(sourceDir,name)))await removeOwn(path);}
}
