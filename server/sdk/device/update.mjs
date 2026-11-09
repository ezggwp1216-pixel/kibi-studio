import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

const ALLOWED=new Set(['resources/board.json','resources/device-contract.json','templates/kibi-base/board.json','templates/kibi-base/AGENTS.md','templates/kibi-base/manifest.json','templates/kibi-base/firmware/README.md','templates/kibi-base/firmware/audio_codec_power.h','templates/kibi-base/firmware/wifi.h','prompts/agent-system.md','src/device-migrations.mjs','src/module-migrations.mjs','scripts/check-public-sdk.mjs','scripts/package.mjs']);
const digest=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
const isHash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
async function safePath(input,code){
 let path=resolve(input);
 if(process.platform==='darwin')for(const prefix of ['/tmp','/var'])if((path===prefix||path.startsWith(prefix+'/'))&&await realpath(prefix)==='/private'+prefix)path='/private'+path;
 let current='/';
 for(const part of path.slice(1).split('/')){
  current=join(current,part);try{if((await lstat(current)).isSymbolicLink())throw fail(code);}catch(error){if(error.code==='ENOENT')break;throw error;}
 }
 return path;
}
async function bytes(root,path,optional=false){
 let current=root;
 for(const part of path.split('/')){
  current=join(current,part);
  let info;try{info=await lstat(current);}catch(e){if(optional&&e.code==='ENOENT'&&current===join(root,path))return null;throw fail('public_path_missing');}
  if(info.isSymbolicLink()||current!==join(root,path)&&!info.isDirectory())throw fail('unsafe_public_path');
 }
 const fd=await open(current,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await fd.stat();if(!s.isFile()||s.nlink!==1||s.size>2*1024*1024)throw fail('unsafe_public_file');return await fd.readFile();}
 finally{await fd.close();}
}
async function replace(root,path,value){
 const target=join(root,path),temp=join(dirname(target),'.kibi-sdk-'+randomUUID()+'.tmp');
 try{await writeFile(temp,value,{flag:'wx',mode:0o644});await rename(temp,target);}finally{await rm(temp,{force:true}).catch(()=>{});}
}

/** Default is a read-only plan. Never enumerates or reads user projects/.studio. */
export async function updatePublicSdk({root,kitRoot=fileURLToPath(new URL('./',import.meta.url)),profileId,apply=false,backupDir,afterWrite}={}){
 root=await safePath(root,'unsafe_studio_root');kitRoot=await safePath(kitRoot,'unsafe_kit_root');
 if(!(await lstat(root)).isDirectory()||!(await lstat(kitRoot)).isDirectory())throw fail('invalid_sdk_root');
 const data=JSON.parse((await bytes(kitRoot,'overlays/profiles.json')).toString('utf8'));
 if(data.schemaVersion!==1||!Array.isArray(data.profiles)||data.profiles.length<1||data.profiles.length>8)throw fail('invalid_update_profiles');
 const prepared=[];
 for(const profile of data.profiles){
  if(!/^[a-z0-9-]{1,80}$/.test(profile.id)||!Array.isArray(profile.files)||!profile.files.length||profile.files.length>ALLOWED.size)throw fail('invalid_update_profile');
  if(new Set(profile.files.map(f=>f.path)).size!==profile.files.length)throw fail('invalid_update_profile');
  const files=[];let matches=true;
  for(const item of profile.files){
   if(!ALLOWED.has(item.path)||!isHash(item.after)||!(item.before===null||isHash(item.before)))throw fail('invalid_update_path');
   const content=await bytes(kitRoot,'overlays/files/'+item.after+'.txt');if(digest(content)!==item.after)throw fail('invalid_update_payload');
   const current=await bytes(root,item.path,true);const hash=current===null?null:digest(current);
   if(hash!==item.before&&hash!==item.after)matches=false;
   files.push({...item,content,current,hash});
  }
  if(matches&&(!profileId||profile.id===profileId))prepared.push({id:profile.id,files});
 }
 if(!prepared.length)throw fail('unknown_public_sdk_snapshot');
 // Fully installed profiles may coincide; their output is identical and needs no write.
 const chosen=prepared.find(p=>p.files.some(f=>f.hash!==f.after))||prepared[0];
 const manifestFile=chosen.files.find(f=>f.path==='templates/kibi-base/manifest.json');
 if(!manifestFile?.current)throw fail('public_template_manifest_required');
 const manifest=JSON.parse(manifestFile.current.toString('utf8'));
 if(manifest.schemaVersion!==1||manifest.boardId!=='kibi-ds02-s3-16m'||!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>100)throw fail('invalid_public_manifest');
 const seen=new Set();
 for(const entry of manifest.files){
  if(typeof entry.path!=='string'||! /^(?:AGENTS\.md|board\.json|project\.json|firmware\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:h|ino|md|json))$/.test(entry.path)||seen.has(entry.path)||!isHash(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0)throw fail('invalid_public_manifest');
  seen.add(entry.path);const path='templates/kibi-base/'+entry.path,current=await bytes(root,path),hash=digest(current),reviewed=chosen.files.find(f=>f.path===path);
  if(reviewed){if(hash!==reviewed.before&&hash!==reviewed.after)throw fail('public_template_hash_mismatch');}
  else if(hash!==entry.sha256||current.length!==entry.size)throw fail('public_template_hash_mismatch');
 }
 const changed=chosen.files.filter(f=>f.hash!==f.after);
 const result={ok:true,profile:chosen.id,changedFiles:changed.map(f=>f.path),applied:false,privateProjectsRead:false};
 if(!apply||!changed.length)return result;
 if(typeof backupDir!=='string')throw fail('backup_directory_required');
 backupDir=await safePath(backupDir,'unsafe_backup_path');if(backupDir===root||backupDir.startsWith(root+'/'))throw fail('backup_must_be_outside_studio');
 await mkdir(backupDir,{mode:0o700});
 if(await realpath(backupDir)!==backupDir)throw fail('unsafe_backup_path');
 for(const [index,file]of changed.entries())if(file.current!==null)await writeFile(join(backupDir,index+'.public'),file.current,{flag:'wx',mode:0o600});
 await writeFile(join(backupDir,'receipt.json'),JSON.stringify({profile:chosen.id,files:changed.map(({path,hash,after})=>({path,before:hash,after})),status:'prepared'}),{flag:'wx',mode:0o600});
 const written=[];
 try{
  for(const file of changed){
   const current=await bytes(root,file.path,true);if((current===null?null:digest(current))!==file.hash)throw fail('sdk_changed_during_update');
   await replace(root,file.path,file.content);written.push(file);await afterWrite?.(written.length);
  }
  await writeFile(join(backupDir,'receipt.json'),JSON.stringify({profile:chosen.id,files:changed.map(({path,hash,after})=>({path,before:hash,after})),status:'applied'}),{mode:0o600});
  return {...result,applied:true};
 }catch(error){
  for(const file of written.reverse()){
   const current=await bytes(root,file.path,true);if(current===null||digest(current)!==file.after)throw fail('sdk_rollback_requires_review');
   if(file.current===null)await rm(join(root,file.path));else await replace(root,file.path,file.current);
  }
  throw fail(error.code==='sdk_changed_during_update'?error.code:'sdk_update_failed_rolled_back');
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(process.argv[1])).href){
 try{
  const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i++){
   if(args[i]==='--apply'){options.apply=true;continue;}
   const key={'--root':'root','--profile':'profileId','--backup-dir':'backupDir'}[args[i]];if(!key||!args[i+1])throw fail('invalid_update_arguments');options[key]=args[++i];
  }
  if(!options.root)throw fail('studio_root_required');console.log(JSON.stringify(await updatePublicSdk(options)));
 }catch(error){console.log(JSON.stringify({ok:false,code:/^[a-z_]{1,80}$/.test(error.code||'')?error.code:'sdk_update_failed'}));process.exitCode=1;}
}
