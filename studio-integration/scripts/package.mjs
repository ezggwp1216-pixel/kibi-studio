import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PAYLOAD_FILES} from './update.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out'||!path.isAbsolute(args[1]))throw new Error('Use Node 24: node scripts/package.mjs --out /absolute/output');
const output=args[1],archive='kibi-studio-server-modules-20261117-r1.tar.gz';
const files=[...PAYLOAD_FILES,'scripts/update.mjs','scripts/package.mjs','manifests/baselines.json','manifests/previous-releases.json','manifests/github-baseline-verification.json','README.md'];
const payload=new Map();
// This builder reads named public source files, never an installation or directory tree.
for(const name of files){
  const filename=path.join(root,name),info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>2*1024*1024||await realpath(filename)!==filename)throw new Error('Unsafe public payload: '+name);
  payload.set(name,await readFile(filename));
}
const release={schemaVersion:1,release:'studio-server-modules-2026-11-17-r1',kind:'public-studio-overlay',fullStudio:false,files:Object.fromEntries(PAYLOAD_FILES.map(name=>[name,sha(payload.get(name))]))};
const releaseBytes=Buffer.from(JSON.stringify(release,null,2)+'\n');
payload.set('release.json',releaseBytes);
// Keep source checks and package checks on the same generated manifest.
if(!releaseBytes.equals(await readFile(path.join(root,'release.json')).catch(()=>Buffer.alloc(0))))await writeFile(path.join(root,'release.json'),releaseBytes);
const chunks=[];
for(const[name,bytes]of payload){
  const filename='kibi-studio-server-modules/'+name,header=Buffer.alloc(512);
  if(Buffer.byteLength(filename)>100)throw new Error('Tar filename limit');
  header.write(filename,0,100,'utf8');
  const octal=(offset,length,value)=>header.write(value.toString(8).padStart(length-1,'0')+'\0',offset,length,'ascii');
  octal(100,8,0o644);octal(108,8,0);octal(116,8,0);octal(124,12,bytes.length);octal(136,12,0);
  header.fill(32,148,156);header[156]=48;header.write('ustar\0',257,6,'ascii');header.write('00',263,2,'ascii');
  header.write(header.reduce((sum,value)=>sum+value,0).toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
  chunks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
}
chunks.push(Buffer.alloc(1024));
const packed=gzipSync(Buffer.concat(chunks),{level:9}),metadata={schemaVersion:1,release:release.release,archive,bytes:packed.length,sha256:sha(packed),kind:release.kind,fullStudio:false,files:Object.fromEntries([...payload].map(([name,bytes])=>[name,sha(bytes)]))};
await mkdir(output,{recursive:true});
await writeFile(path.join(output,archive),packed);
await writeFile(path.join(output,archive+'.sha256'),metadata.sha256+'  '+archive+'\n');
await writeFile(path.join(output,'release.json'),JSON.stringify(metadata,null,2)+'\n');
console.log(JSON.stringify(metadata));
