import {constants} from 'node:fs';
import {lstat,open,realpath,rename,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROGRAM_FILES=Object.freeze(['src/studio-account.mjs','src/studio-platform.mjs','src/studio-plugins.mjs','web/app.js','web/index.html','web/server-modules.js','web/server-modules.css']);
export const GUIDE_FILES=Object.freeze(['docs/API.md','docs/SDK.md','docs/LOCAL_STUDIO.md','docs/SERVER_MODULES.md','docs/SERVER_MODULES_DEPLOY.md','docs/YOUTUBE_MODULE.md','src/platform-guides/API.md']);
export const PAYLOAD_FILES=Object.freeze([...PROGRAM_FILES,...GUIDE_FILES]);
const BASELINE_SHA256='3522c57a2434a37f8eef35d556aa6b4d55e3bd309e0484be6e4a83b81b8c1c96';
const PREVIOUS_RELEASES_SHA256='9ac3aefbccd9a18ee016bee9270d8405df87645c44389c527f1309c45a9b49e9';
const releaseId='studio-server-modules-2026-11-17-r1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,file)=>Object.assign(new Error(code),{code,...(file?{file}:{})});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// Never enumerate an installation. Only these pinned, public program files are read.
async function publicFile(root,name,{optional=false}={}){
  let current=root;
  for(const part of name.split('/').slice(0,-1)){
    current=path.join(current,part);
    const info=await lstat(current).catch(()=>{throw fail('studio_path_unsafe',name);});
    if(!info.isDirectory()||info.isSymbolicLink())throw fail('studio_path_unsafe',name);
  }
  const filename=path.join(root,name);
  let info;
  try{info=await lstat(filename);}catch(error){if(optional&&error.code==='ENOENT')return null;throw fail('studio_path_unsafe',name);}
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>2*1024*1024)throw fail('studio_path_unsafe',name);
  const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>{throw fail('studio_path_unsafe',name);});
  try{
    const opened=await handle.stat();
    if(!opened.isFile()||opened.nlink!==1||opened.dev!==info.dev||opened.ino!==info.ino||opened.size!==info.size)throw fail('studio_path_unsafe',name);
    const bytes=await handle.readFile(),after=await handle.stat();
    if(bytes.length!==info.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw fail('studio_path_unsafe',name);
    return{bytes,sha256:sha(bytes),mode:info.mode&0o777};
  }finally{await handle.close();}
}

async function bundleFiles(bundle){
  const baselineFile=await publicFile(bundle,'manifests/baselines.json');
  if(baselineFile.sha256!==BASELINE_SHA256)throw fail('studio_baseline_manifest_mismatch');
  const baseline=JSON.parse(baselineFile.bytes.toString('utf8'));
  const previousFile=await publicFile(bundle,'manifests/previous-releases.json');
  if(previousFile.sha256!==PREVIOUS_RELEASES_SHA256)throw fail('studio_previous_release_manifest_mismatch');
  const previous=JSON.parse(previousFile.bytes.toString('utf8'));
  if(previous.schemaVersion!==1||!Array.isArray(previous.releases)||previous.releases.length>8||previous.releases.some(row=>!object(row.files)||!PROGRAM_FILES.every(name=>Object.hasOwn(row.files,name))||!Object.entries(row.files).every(([name,hash])=>PAYLOAD_FILES.includes(name)&&/^[a-f0-9]{64}$/.test(hash))))throw fail('studio_previous_release_manifest_mismatch');
  const release=JSON.parse((await publicFile(bundle,'release.json')).bytes.toString('utf8'));
  if(release.schemaVersion!==1||release.release!==releaseId||!object(release.files)||Object.keys(release.files).length!==PAYLOAD_FILES.length||!PAYLOAD_FILES.every(name=>/^[a-f0-9]{64}$/.test(release.files[name]||'')))throw fail('studio_payload_mismatch');
  const payload=new Map();
  for(const name of PAYLOAD_FILES){
    const file=await publicFile(bundle,name);
    if(file.sha256!==release.files[name])throw fail('studio_payload_mismatch',name);
    payload.set(name,file);
  }
  return{baseline,payload,previous:previous.releases};
}

async function planUpdate(root,baseline,payload,previous){
  const accepted=(name,hash)=>hash===baseline.files[name]||hash===payload.get(name)?.sha256||previous.some(row=>row.files[name]===hash);
  const original=new Map(),changes=[];
  for(const[name,expected]of Object.entries(baseline.files)){
    const file=await publicFile(root,name);
    if(!accepted(name,file.sha256))throw fail('studio_baseline_mismatch',name);
    original.set(name,file);
  }
  if(JSON.parse(original.get('package.json').bytes.toString('utf8')).version!==baseline.studioVersion)throw fail('studio_baseline_mismatch','package.json');
  for(const[name,file]of payload){
    if(!original.has(name))original.set(name,await publicFile(root,name,{optional:true}));
    const previous=original.get(name);
    if(previous&&!accepted(name,previous.sha256))throw fail('studio_baseline_mismatch',name);
    if(previous?.sha256!==file.sha256)changes.push(name);
  }
  return{original,changes};
}

export async function updateStudio({studio,bundle=fileURLToPath(new URL('../',import.meta.url)),apply=false}={}){
  if(typeof studio!=='string'||!path.isAbsolute(studio)||typeof apply!=='boolean')throw fail('studio_update_usage');
  let root=path.resolve(studio);
  // macOS system aliases are canonicalized; application-created links are refused.
  if(process.platform==='darwin')for(const prefix of ['/tmp','/var']){
    if((root===prefix||root.startsWith(prefix+'/'))&&await realpath(prefix)==='/private'+prefix)root='/private'+root;
  }
  let current=path.parse(root).root;
  for(const part of root.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    const info=await lstat(current).catch(()=>{throw fail('studio_path_unsafe');});
    if(!info.isDirectory()||info.isSymbolicLink())throw fail('studio_path_unsafe');
  }
  if(await realpath(root)!==root)throw fail('studio_path_unsafe');
  const {baseline,payload,previous}=await bundleFiles(bundle),plan=await planUpdate(root,baseline,payload,previous);
  const result={ok:true,release:releaseId,baseline:baseline.id,mode:apply?'apply':'check',changes:plan.changes};
  if(!apply||!plan.changes.length)return result;
  const staged=new Map(),committed=[];
  try{
    // Stage every file before the first replacement. The Studio process must be stopped.
    for(const name of plan.changes){
      const temp=path.join(path.dirname(path.join(root,name)),'.kibi-modules-'+randomUUID()+'.tmp');
      staged.set(name,temp);
      const handle=await open(temp,'wx',plan.original.get(name)?.mode??0o644);
      try{await handle.writeFile(payload.get(name).bytes);await handle.sync();}finally{await handle.close();}
    }
    const fresh=await planUpdate(root,baseline,payload,previous);
    for(const[name,previous]of plan.original)if(previous?.sha256!==fresh.original.get(name)?.sha256)throw fail('studio_update_changed',name);
    for(const name of plan.changes){
      const current=await publicFile(root,name,{optional:true});
      if(current?.sha256!==plan.original.get(name)?.sha256)throw fail('studio_update_changed',name);
      await rename(staged.get(name),path.join(root,name));committed.push(name);
    }
    await planUpdate(root,baseline,payload,previous);
    return result;
  }catch(error){
    let incomplete=false;
    for(const name of committed.reverse())try{
      const current=await publicFile(root,name);
      if(current.sha256!==payload.get(name).sha256)throw fail('studio_update_changed',name);
      const previous=plan.original.get(name);
      if(!previous)await rm(path.join(root,name));
      else{
        const temp=staged.get(name),handle=await open(temp,'wx',previous.mode);
        try{await handle.writeFile(previous.bytes);await handle.sync();}finally{await handle.close();}
        await rename(temp,path.join(root,name));
      }
    }catch{incomplete=true;}
    if(incomplete)throw fail('studio_update_rollback_incomplete');
    throw error;
  }finally{for(const temp of staged.values())await rm(temp,{force:true}).catch(()=>{});}
}

async function main(){
  const args=process.argv.slice(2);
  if(args.length!==3||args[0]!=='--studio'||!['--check','--apply'].includes(args[2]))throw fail('studio_update_usage');
  if(Number(process.versions.node.split('.')[0])<24)throw fail('studio_node_24_required');
  console.log(JSON.stringify(await updateStudio({studio:args[1],apply:args[2]==='--apply'})));
}
if(process.argv[1]&&await realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url))main().catch(error=>{
  console.error(JSON.stringify({ok:false,code:/^studio_[a-z_]+$/.test(error.code||'')?error.code:'studio_update_failed',...(error.file?{file:error.file}:{})}));process.exitCode=1;
});
