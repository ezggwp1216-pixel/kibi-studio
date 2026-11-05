#!/usr/bin/env node
// Verified, dependency-free installer. Run only after checking this file's SHA.
import {createHash,randomUUID} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {readFile,writeFile,mkdir,lstat,realpath,chmod,rename,cp,rm,symlink,mkdtemp,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
const RAW='https://raw.githubusercontent.com/ezggwp1216-pixel/kibi-studio/';
const ROOT='kibi-studio/',ARCHIVE='kibi-studio-local.zip',MANIFEST='kibi-studio-local.manifest.json';
const sha=(data,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(data).digest(encoding);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const privateParts=new Set(['.studio','.git','.github','.codex','.aws','node_modules','backups']);
const privateFiles=/^(?:auth\.json|kibi_project_config\.h|wifi_config\.h|wifi_credentials\.h|settings\.json|secrets?\.(?:h|json)|\.env(?:\..*)?)$/i;
export function memberPath(name){
 if(typeof name!=='string'||name.length>1024||/[\\\x00-\x1f:]/.test(name))throw Error('Invalid archive path');
 const parts=name.split('/');
 if(parts.length<2||parts.length>24||parts[0]!=='kibi-studio'||parts.some(p=>!p||p==='.'||p==='..'||privateParts.has(p.toLowerCase()))||privateFiles.test(parts.at(-1)))throw Error('Forbidden archive path');
 if(/\.(bin|elf|o|a)$/i.test(name)&&name!==ROOT+'resources/native-sdk/bin/bootloader_dio_40m.elf'&&!(name.startsWith(ROOT+'resources/native-sdk/')&&/\.a$/i.test(name)))throw Error('Forbidden runtime binary');
 return parts.slice(1).join('/');
}
export async function download(url,maximum){
 const parsed=new URL(url);
 if(parsed.protocol!=='https:'||!['raw.githubusercontent.com','registry.npmjs.org','dl.google.com'].includes(parsed.hostname)||parsed.username||parsed.password||parsed.port||parsed.hash||parsed.search)throw Error('Untrusted download URL');
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(600000)});
 if(!response.ok)throw Error('Download failed: HTTP '+response.status);
 const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>maximum))throw Error('Download exceeds byte limit');
 const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>maximum)throw Error('Download exceeds byte limit');chunks.push(chunk);}
 return Buffer.concat(chunks,total);
}
export function verifyKit(release,manifest,bytes){
 if(!release||release.schemaVersion!==1||release.archive!==ARCHIVE||release.root!=='kibi-studio'||release.platform!=='darwin'||!hash(release.sha256)||!integer(release.bytes,1,64*1024*1024)||!integer(release.expandedBytes,1,256*1024*1024)||!integer(release.fileCount,1,10000))throw Error('Unsupported release metadata');
 if(bytes.length!==release.bytes||sha(bytes)!==release.sha256)throw Error('Archive SHA-256 mismatch');
 if(!manifest||manifest.schemaVersion!==1||manifest.root!=='kibi-studio'||manifest.fileCount!==release.fileCount||manifest.totalBytes!==release.expandedBytes||manifest.archive?.name!==ARCHIVE||manifest.archive?.size!==bytes.length||manifest.archive?.sha256!==release.sha256||!Array.isArray(manifest.files)||manifest.files.length!==release.fileCount)throw Error('Archive manifest mismatch');
 const expected=new Map(),folded=new Set();let expanded=0;
 for(const entry of manifest.files){const relative=memberPath(entry.path),fold=entry.path.toLowerCase();if(expected.has(entry.path)||folded.has(fold)||!hash(entry.sha256)||!integer(entry.size,0,64*1024*1024))throw Error('Invalid or colliding manifest entry');expected.set(entry.path,{...entry,relative});folded.add(fold);expanded+=entry.size;}
 if(expanded!==release.expandedBytes)throw Error('Expanded size mismatch');
 for(const name of expected.keys()){const parts=name.split('/');for(let i=1;i<parts.length;i++)if(expected.has(parts.slice(0,i).join('/')))throw Error('Conflicting archive paths');}
 for(const name of ['package.json','scripts/start.mjs','scripts/doctor.mjs','projects/kibi-base/firmware/project.ino'])if(!expected.has(ROOT+name))throw Error('Missing required Studio file');
 // A small ZIP reader keeps Python, unzip packages and npm out of first launch.
 // Only ordinary single-disk ZIP32 stored/deflate files are accepted.
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==expected.size||bytes.readUInt16LE(end+10)!==expected.size)throw Error('Unsupported ZIP directory');
 let cursor=bytes.readUInt32LE(end+16);const directoryEnd=cursor+bytes.readUInt32LE(end+12);if(directoryEnd!==end)throw Error('Invalid ZIP directory bounds');
 const files=[],seen=new Set(),ranges=[];
 for(let index=0;index<expected.size;index++){
  if(cursor+46>directoryEnd||bytes.readUInt32LE(cursor)!==0x02014b50)throw Error('Invalid ZIP entry');
  const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),packed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24),nameLength=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),disk=bytes.readUInt16LE(cursor+34),mode=bytes.readUInt32LE(cursor+38)>>>16,offset=bytes.readUInt32LE(cursor+42);
  const next=cursor+46+nameLength+extra+comment;if(next>directoryEnd)throw Error('Invalid ZIP entry bounds');
  const name=bytes.subarray(cursor+46,cursor+46+nameLength).toString('utf8'),entry=expected.get(name);
  if(!entry||seen.has(name)||size!==entry.size||disk||flags&~0x808||![0,8].includes(method)||![0,0x8000].includes(mode&0xf000))throw Error('ZIP member differs from manifest or is not a regular file');
  if(offset+30>bytes.readUInt32LE(end+16)||bytes.readUInt32LE(offset)!==0x04034b50)throw Error('Invalid ZIP local header');
  const localNameLength=bytes.readUInt16LE(offset+26),localExtra=bytes.readUInt16LE(offset+28),start=offset+30+localNameLength+localExtra,finish=start+packed;
  if(bytes.readUInt16LE(offset+6)!==flags||bytes.readUInt16LE(offset+8)!==method||bytes.subarray(offset+30,offset+30+localNameLength).toString('utf8')!==name||finish>bytes.readUInt32LE(end+16))throw Error('Invalid ZIP local entry bounds');
  ranges.push([offset,finish]);
  const compressed=bytes.subarray(start,finish),content=method===0?Buffer.from(compressed):inflateRawSync(compressed,{maxOutputLength:Math.max(1,size)});
  if(content.length!==size||sha(content)!==entry.sha256)throw Error('ZIP member SHA-256 mismatch');
  files.push({path:entry.relative,bytes:content});seen.add(name);cursor=next;
 }
 if(cursor!==directoryEnd)throw Error('Unexpected ZIP directory bytes');
 ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])throw Error('Overlapping ZIP entries');
 return files;
}
async function exists(filename){try{await lstat(filename);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function safeDirectory(directory){
 const absolute=path.resolve(directory);let current=path.parse(absolute).root;
 for(const part of absolute.slice(current.length).split('/').filter(Boolean)){current=path.join(current,part);try{await mkdir(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Installation directory contains a symlink or special file');}
 return realpath(absolute);
}
async function ensureRuntime({runtimeRoot,nodeRoot,lock,fetchBytes=download,arch=process.arch}){
 if(lock.schemaVersion!==1||lock.nodeVersion!=='24.22.2'||lock.codexVersion!=='0.166.0'||!['arm64','x64'].includes(arch))throw Error('Unsupported runtime lock');
 runtimeRoot=await safeDirectory(runtimeRoot);
 const verifyHome=path.join(runtimeRoot,'.verification-profile');await safeDirectory(verifyHome);
 const verifyEnv={...process.env,CODEX_HOME:verifyHome};
 const nodeDest=path.join(runtimeRoot,`node-v${lock.nodeVersion}-darwin-${arch}`);
 if(!await exists(nodeDest)){
  const stage=path.join(runtimeRoot,'.node-'+randomUUID());await cp(nodeRoot,stage,{recursive:true,errorOnExist:true,force:false});
  try{if((await run(path.join(stage,'bin/node'),['--version'])).stdout.trim()!=='v'+lock.nodeVersion)throw Error('Node runtime verification failed');await rename(stage,nodeDest);}finally{await rm(stage,{recursive:true,force:true});}
 }
 if((await lstat(nodeDest)).isSymbolicLink()||!(await lstat(nodeDest)).isDirectory()||(await run(path.join(nodeDest,'bin/node'),['--version'])).stdout.trim()!=='v'+lock.nodeVersion)throw Error('Installed Node runtime is incompatible');
 const spec=lock.codex[arch],codexDest=path.join(runtimeRoot,`codex-${lock.codexVersion}-darwin-${arch}`);
 if(!await exists(codexDest)){
  if(spec.url!==`https://registry.npmjs.org/@openai/codex/-/codex-${lock.codexVersion}-darwin-${arch}.tgz`||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(spec.integrity)||!['aarch64-apple-darwin','x86_64-apple-darwin'].includes(spec.target))throw Error('Invalid pinned Codex distribution');
  console.log('Downloading verified private Codex runtime…');const data=await fetchBytes(spec.url,180*1024*1024);
  if('sha512-'+sha(data,'sha512','base64')!==spec.integrity)throw Error('Codex package integrity mismatch');
  const stage=await mkdtemp(path.join(runtimeRoot,'.codex-'));try{
   const archive=path.join(stage,'codex.tgz');await writeFile(archive,data,{flag:'wx',mode:0o600});await run('/usr/bin/tar',['-xzf',archive,'-C',stage],{maxBuffer:65536});await rm(archive);
   const binary=path.join(stage,'package','vendor',spec.target,'bin','codex');
   if((await lstat(binary)).isSymbolicLink()||!(await lstat(binary)).isFile()||!(await run(binary,['--version'],{env:verifyEnv})).stdout.includes(lock.codexVersion))throw Error('Codex runtime verification failed');
   await rename(stage,codexDest);
  }finally{await rm(stage,{recursive:true,force:true});}
 }
 if((await lstat(codexDest)).isSymbolicLink()||!(await lstat(codexDest)).isDirectory())throw Error('Unsafe installed Codex runtime');
 const codex=path.join(codexDest,'package','vendor',spec.target,'bin','codex');
 if(!(await run(codex,['--version'],{env:verifyEnv})).stdout.includes(lock.codexVersion))throw Error('Installed Codex runtime is incompatible');
 return {nodeRoot:nodeDest,node:path.join(nodeDest,'bin/node'),codex};
}
async function browserExecutable({fetchBytes=download,home=os.homedir(),installChrome=true}={}){
 const candidates=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',path.join(home,'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),path.join(home,'Applications/Kibi Studio/Google Chrome.app/Contents/MacOS/Google Chrome')];
 for(const candidate of candidates)if(await exists(candidate))return candidate;
 if(!installChrome)return null;
 console.log('Installing signed Google Chrome privately for USB access…');
 const work=await mkdtemp(path.join(os.tmpdir(),'kibi-chrome-')),mount=path.join(work,'mount'),targetRoot=await safeDirectory(path.join(home,'Applications/Kibi Studio')),target=path.join(targetRoot,'Google Chrome.app');let attached=false;
 try{
  const dmg=path.join(work,'chrome.dmg');await writeFile(dmg,await fetchBytes('https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg',350*1024*1024),{flag:'wx',mode:0o600});await mkdir(mount);
  await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,dmg],{timeout:120000,maxBuffer:65536});attached=true;
  const app=path.join(mount,'Google Chrome.app');await run('/usr/bin/codesign',['--verify','--deep','--strict',app],{timeout:120000,maxBuffer:65536});
  const signature=await run('/usr/bin/codesign',['-dv','--verbose=4',app],{maxBuffer:65536});if(!/^TeamIdentifier=EQHXZ8M8AV$/m.test(signature.stderr))throw Error('Unexpected Chrome signing identity');
  await run('/usr/sbin/spctl',['--assess','--type','execute',app],{timeout:120000,maxBuffer:65536});
  if(await exists(target))throw Error('Browser destination already exists');
  const stage=path.join(targetRoot,'.chrome-'+randomUUID()+'.app');try{await run('/usr/bin/ditto',[app,stage],{timeout:120000,maxBuffer:65536});await rename(stage,target);}finally{await rm(stage,{recursive:true,force:true});}
  return path.join(target,'Contents/MacOS/Google Chrome');
 }finally{if(attached)await run('/usr/bin/hdiutil',['detach',mount],{timeout:60000,maxBuffer:65536}).catch(()=>{});await rm(work,{recursive:true,force:true});}
}
export async function install({commit,destination,runtimeRoot,nodeRoot,lock,fetchBytes=download,installOnly=false,installChrome=true}){
 if(!/^[a-f0-9]{40}$/.test(commit||''))throw Error('An exact lowercase GitHub commit is required');
 if(!path.isAbsolute(destination)||await exists(destination))throw Error('Choose a new absolute project destination; no existing project is overwritten');
 const parent=await realpath(path.dirname(destination));if(!(await lstat(parent)).isDirectory())throw Error('Destination parent must exist');destination=path.join(parent,path.basename(destination));
 console.log('Downloading and verifying the pinned Kibi Studio project…');
 const base=RAW+commit+'/',releaseBytes=await fetchBytes(base+'release.json',65536),release=JSON.parse(releaseBytes);
 const manifestBytes=await fetchBytes(base+MANIFEST,4*1024*1024);if(!hash(release.manifestSha256)||sha(manifestBytes)!==release.manifestSha256)throw Error('Manifest SHA-256 mismatch');
 const files=verifyKit(release,JSON.parse(manifestBytes),await fetchBytes(base+ARCHIVE,64*1024*1024));
 const runtime=await ensureRuntime({runtimeRoot,nodeRoot,lock,fetchBytes}),browser=await browserExecutable({fetchBytes,installChrome});
 await mkdir(destination,{mode:0o700});try{
  for(const file of files){const target=path.join(destination,file.path);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,file.bytes,{flag:'wx',mode:file.path.endsWith('.command')?0o755:0o644});}
  const state=path.join(destination,'.studio');await mkdir(state,{mode:0o700});await symlink(runtime.nodeRoot,path.join(state,'runtime-node'));await mkdir(path.join(state,'runtime-bin'),{mode:0o700});await symlink(runtime.codex,path.join(state,'runtime-bin/codex'));await mkdir(path.join(state,'account'),{mode:0o700});
  await writeFile(path.join(state,'installation.json'),JSON.stringify({schemaVersion:1,commit,nodeVersion:lock.nodeVersion,codexVersion:lock.codexVersion,browser,compiler:'remote',installedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
 }catch(error){await rm(destination,{recursive:true,force:true});throw error;}
 console.log(JSON.stringify({projectPath:destination,verifiedFiles:files.length,node:runtime.node,codex:runtime.codex,compiler:'remote',browser,started:false},null,2));
 if(!installOnly){
  const env={...process.env,PATH:path.join(destination,'.studio/runtime-bin')+':'+path.join(runtime.nodeRoot,'bin')+':/usr/bin:/bin:/usr/sbin:/sbin',CODEX_HOME:path.join(destination,'.studio/account'),...(browser?{KIBI_STUDIO_BROWSER:browser}:{})};
  const status=await run(runtime.codex,['login','status'],{env,timeout:15000,maxBuffer:65536}).catch(()=>null);
  if(!status||!/ChatGPT/i.test(status.stdout+' '+status.stderr)){
   console.log('Finish the official ChatGPT sign-in in your browser. No API key is needed.');
   await new Promise((resolve,reject)=>{const child=spawn(runtime.codex,['login'],{env,stdio:'inherit',shell:false});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('ChatGPT sign-in did not complete; rerun the Studio launcher')));});
  }
  const child=spawn(runtime.node,['scripts/start.mjs','--open'],{cwd:destination,env,stdio:'inherit',shell:false});await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Studio exited with an error')));});
 }
 return {projectPath:destination,verifiedFiles:files.length,runtime,browser};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i++){const key=args[i];if(key==='--install-only'){options.installOnly=true;continue;}const keys={'--commit':'commit','--destination':'destination','--runtime-root':'runtimeRoot','--node-root':'nodeRoot','--lock':'lockPath'};if(!keys[key]||!args[i+1])throw Error('Invalid bootstrap argument');options[keys[key]]=args[++i];}
 try{options.lock=JSON.parse(await readFile(options.lockPath,'utf8'));await install(options);}catch(error){console.error('Kibi Studio installation failed: '+error.message);process.exitCode=1;}
}
