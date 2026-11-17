import {lstat,readdir,realpath,open,mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve,relative,parse} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const releaseName='server-modules-20261117-rc1';
const directories=['src','web','sdk','studio','resources','examples','workers','docs'];
const rootFiles=['package.json','README.md','START_HERE.md','bootstrap-prompt.txt','Dockerfile','.dockerignore','compose.yaml','compose.https.yaml','compose.plugins.yaml','Caddyfile','AGENTS.md'];
const scripts=['init.mjs','package-device-support.mjs','package-studio-full.mjs','package-studio-platform.mjs','register-fresh-sdk-profile.mjs','retire-plugin-links.mjs','package-modules-release.mjs'];
const limits=Object.freeze({files:4096,fileBytes:64*1024*1024,totalBytes:128*1024*1024,archiveBytes:160*1024*1024});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const fail=code=>Object.assign(new Error(code),{code});
const protectedPart=part=>/^(?:\.data|\.studio|\.git|\.env(?:\..*)?|auth\.json|settings(?:\..*)?|encryption\.key|admin-password(?:\..*)?)$/i.test(part);
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
function safePath(path){
 if(typeof path!=='string'||!path||path.includes('\\')||/[\x00-\x1f\x7f]/.test(path))throw fail('unsafe_release_path');
 for(const part of path.split('/')){
  if(!part||part==='.'||part==='..'||protectedPart(part)||/^(?:tests?|tmp|temp|logs?|node_modules|coverage)$/i.test(part)||/\.(?:log|tmp|swp)$/i.test(part))throw fail('unsafe_release_path');
 }
}
// Check each ancestor without resolving away evidence of a symbolic link.
async function safeDirectory(path){
 path=resolve(path);const root=parse(path).root;let current=root;
 for(const part of path.slice(root.length).split('/').filter(Boolean)){
  if(protectedPart(part)||/[\x00-\x1f\x7f\\]/.test(part))throw fail('unsafe_release_path');current=join(current,part);const stat=await lstat(current,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('unsafe_release_input');
 }
 if(await realpath(path)!==path)throw fail('unsafe_release_input');return path;
}
async function exists(path){try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function splitTarPath(path){
 if(Buffer.byteLength(path)<=100)return{name:path,prefix:''};
 let at=path.lastIndexOf('/');while(at>0){const prefix=path.slice(0,at),name=path.slice(at+1);if(Buffer.byteLength(prefix)<=155&&Buffer.byteLength(name)<=100)return{name,prefix};at=path.lastIndexOf('/',at-1);}
 throw fail('release_path_too_long');
}
async function inventory(root){
 const files=[];let total=0;
 await safeDirectory(join(root,'scripts'));
 async function visit(name,kind){
  safePath(name);splitTarPath(releaseName+'/'+name);
  const path=join(root,name),stat=await lstat(path,{bigint:true});
  if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink!==1n))throw fail('unsafe_release_input');
  if(kind==='directory'&&!stat.isDirectory()||kind==='file'&&!stat.isFile())throw fail('unsafe_release_input');
  if(stat.isDirectory()){
   await safeDirectory(path);const names=(await readdir(path)).sort();
   // Validate the complete directory before any payload is opened.
   for(const child of names)safePath(name+'/'+child);
   for(const child of names)await visit(name+'/'+child);
  }else{
   const bytes=Number(stat.size);total+=bytes;
   if(bytes>limits.fileBytes||total>limits.totalBytes||files.length>=limits.files)throw fail('release_limits_exceeded');
   files.push({path:name,bytes,stat});
  }
 }
 for(const name of directories)await visit(name,'directory');
 for(const name of rootFiles)await visit(name,'file');
 for(const name of scripts)await visit('scripts/'+name,'file');
 if(!files.some(file=>file.path==='docs/SERVER_MODULES_DEPLOY.md'))throw fail('missing_release_payload');
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return files;
}
async function readOrdinary(root,file){
 safePath(file.path);await safeDirectory(dirname(join(root,file.path)));
 const path=join(root,file.path),before=await lstat(path,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||!same(before,file.stat))throw fail('changing_release_source');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const opened=await handle.stat({bigint:true});if(!opened.isFile()||opened.nlink!==1n||!same(opened,file.stat))throw fail('changing_release_source');
  const bytes=Buffer.alloc(file.bytes+1);let count=0;
  while(count<bytes.length){const result=await handle.read(bytes,count,bytes.length-count,count);if(result.bytesRead===0)break;count+=result.bytesRead;}
  const after=await handle.stat({bigint:true}),named=await lstat(path,{bigint:true});
  if(count!==file.bytes||!same(after,opened)||!same(named,opened))throw fail('changing_release_source');
  return bytes.subarray(0,count);
 }finally{await handle.close();}
}
function tarHeader(path,bytes){
 const header=Buffer.alloc(512),{name,prefix}=splitTarPath(path);
 const text=(value,offset,length)=>{if(Buffer.byteLength(value)>length)throw fail('release_path_too_long');header.write(value,offset,length,'utf8');};
 const octal=(value,offset,length)=>text(value.toString(8).padStart(length-1,'0')+'\0',offset,length);
 text(name,0,100);octal(0o644,100,8);octal(0,108,8);octal(0,116,8);octal(bytes,124,12);octal(0,136,12);
 header.fill(32,148,156);text('0',156,1);text('ustar\0',257,6);text('00',263,2);text(prefix,345,155);
 const checksum=header.reduce((a,b)=>a+b,0);text(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);return header;
}

/** Public source only. No imports, installations, network calls or data-directory reads. */
export async function packageModulesRelease({sourceRoot=repository,outputDir,onPhase=()=>{}}={}){
 if(Number(process.versions.node.split('.')[0])<24)throw fail('node_24_required');
 if(typeof outputDir!=='string'||!outputDir||typeof sourceRoot!=='string'||typeof onPhase!=='function')throw fail('release_paths_required');
 sourceRoot=await safeDirectory(sourceRoot);outputDir=resolve(outputDir);safePath(outputDir.slice(outputDir.lastIndexOf('/')+1));
 const parent=await safeDirectory(dirname(outputDir)),inside=relative(sourceRoot,outputDir);
 if(!inside||(!inside.startsWith('../')&&inside!=='..'))throw fail('release_destination_inside_source');
 if(await exists(outputDir))throw fail('release_destination_exists');
 const source=await inventory(sourceRoot);await onPhase('inventory-validated');
 const payload=[],files=[];let totalBytes=0;
 for(const file of source){const bytes=await readOrdinary(sourceRoot,file);files.push({path:file.path,bytes:bytes.length,sha256:digest(bytes)});totalBytes+=bytes.length;payload.push(tarHeader(releaseName+'/'+file.path,bytes.length),bytes,Buffer.alloc((512-bytes.length%512)%512));}
 const sourceWitnessSha256=digest(Buffer.from(files.map(f=>`${f.path}\0${f.bytes}\0${f.sha256}\n`).join('')));
 const archiveName=releaseName+'.tar.gz',manifestName=releaseName+'.manifest.json';
 const tar=Buffer.concat([...payload,Buffer.alloc(1024)]),archive=gzipSync(tar,{level:9});
 if(archive.length>limits.archiveBytes||!gunzipSync(archive,{maxOutputLength:tar.length}).equals(tar))throw fail('release_verification_failed');
 const archiveSha256=digest(archive),manifest=json({schemaVersion:1,releaseName,archiveName,payloadRoot:releaseName,archiveBytes:archive.length,archiveSha256,privateFilesIncluded:false,published:false,fileCount:files.length,totalBytes,limits,sourceWitnessSha256,runtimeGates:{dockerImages:'not_verified',rootlessIsolation:'not_verified',youtube:'not_verified',physicalBoard:'not_verified',voice:'not_verified'},deploymentInstructions:'docs/SERVER_MODULES_DEPLOY.md',rollbackCli:'scripts/retire-plugin-links.mjs',tarMetadata:{format:'ustar',uid:0,gid:0,mtime:0,fileMode:'0644',gzipMtime:0},files});
 const manifestSha256=digest(manifest),stage=await mkdtemp(join(parent,'.kibi-modules-stage-'));
 try{
  const outputs=new Map([[archiveName,archive],[manifestName,manifest],[archiveName+'.sha256',Buffer.from(archiveSha256+'  '+archiveName+'\n')],[manifestName+'.sha256',Buffer.from(manifestSha256+'  '+manifestName+'\n')]]);
  for(const[name,bytes]of outputs)await writeFile(join(stage,name),bytes,{flag:'wx',mode:0o644});
  await onPhase('before-publication');
  // Fresh complete inventory catches added paths; fresh reads witness the final cohort.
  await safeDirectory(sourceRoot);const current=await inventory(sourceRoot);
  if(current.length!==source.length||current.some((file,index)=>file.path!==source[index].path))throw fail('changing_release_source');
  for(let index=0;index<current.length;index++)if(digest(await readOrdinary(sourceRoot,current[index]))!==files[index].sha256)throw fail('changing_release_source');
  await safeDirectory(parent);if(await exists(outputDir))throw fail('release_destination_exists');
  await rename(stage,outputDir);
  return{ok:true,releaseName,outputDir,archiveName,archiveBytes:archive.length,archiveSha256,manifestName,manifestSha256,fileCount:files.length,totalBytes,sourceWitnessSha256,sourceWitnessRechecked:true,privateFilesIncluded:false,published:false};
 }finally{await rm(stage,{recursive:true,force:true});}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const args=process.argv.slice(2),options={};
  for(let index=0;index<args.length;index++){const key={'--source-root':'sourceRoot','--output-dir':'outputDir'}[args[index]];if(!key||options[key]!==undefined||!args[index+1]||args[index+1].startsWith('--'))throw fail('invalid_release_arguments');options[key]=args[++index];}
  console.log(JSON.stringify(await packageModulesRelease(options)));
 }catch(error){console.error(JSON.stringify({ok:false,code:error.code||'release_package_failed'}));process.exitCode=1;}
}
