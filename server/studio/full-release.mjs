// Public full-distribution utilities. These functions never discover or read an
// installed Studio, credentials, runtime state or a user's projects.
import {createHash} from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';

export const UPSTREAM_COMMIT='43d47afb090c9bf6ab69ea46ee559da3c9867616';
export const UPSTREAM_ZIP_SHA256='d6707edbbcea2ed631dc7dcfb1d4ecabf487dae839ae4c3003f7529a03ce4f58';
export const UPSTREAM_MANIFEST_SHA256='ca93f03c219cb88e442dbaa59ee584994cbb241ef47d2f6c95da607302077ee7';
const ROOT='kibi-studio/',ARCHIVE='kibi-studio-local.zip';
const MAX_ARCHIVE=64*1024*1024,MAX_EXPANDED=256*1024*1024;
const digest=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
const json=b=>Buffer.from(JSON.stringify(b,null,2)+'\n');
const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const required=['package.json','scripts/start.mjs','scripts/doctor.mjs','projects/kibi-base/firmware/project.ino'];
const forbiddenParts=new Set(['.studio','.data','.git','.github','.codex','.aws','node_modules','backups']);
const forbiddenFile=/^(?:auth\.json|settings\.json|kibi_project_config\.h|wifi_config\.h|wifi_credentials\.h|secrets?\.(?:h|json)|\.env(?:\..*)?)$/i;

export function assertDistributionPath(name){
 if(typeof name!=='string'||!name||Buffer.byteLength(name)>1024||/[\\\x00-\x1f\x7f:]/.test(name))throw fail('distribution_path');
 const parts=name.split('/');
 if(parts.length>23||parts.some(p=>!p||p==='.'||p==='..'||forbiddenParts.has(p.toLowerCase()))||forbiddenFile.test(parts.at(-1)))throw fail('distribution_path');
 if(parts[0]==='projects'&&(parts[1]!=='kibi-base'||parts.length<3))throw fail('distribution_path');
 if(/\.(bin|elf|o|a)$/i.test(name)&&name!=='resources/native-sdk/bin/bootloader_dio_40m.elf'&&!(name.startsWith('resources/native-sdk/')&&/\.a$/i.test(name)))throw fail('distribution_path');
 return name;
}

const crcTable=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes){let value=0xffffffff;for(const b of bytes)value=crcTable[(value^b)&255]^(value>>>8);return(value^0xffffffff)>>>0;}

/** ZIP32, UTF-8, deflate, fixed timestamp and ordinary file permissions. */
export function encodeFullPackage(input,{version='0.3.1',releaseName='studio-full-2026-11-17-r3',publicSdkExceptions=[]}={}){
 const entries=[...input].map(([name,value])=>[assertDistributionPath(name),Buffer.from(value)]).sort(([a],[b])=>a<b?-1:a>b?1:0);
 if(entries.length<required.length||entries.length>10000)throw fail('distribution_incomplete');
 const folded=new Set(),names=new Set(entries.map(([name])=>name));let total=0;
 for(const[name,bytes]of entries){if(folded.has(name.toLowerCase()))throw fail('distribution_collision');folded.add(name.toLowerCase());total+=bytes.length;if(bytes.length>64*1024*1024||total>MAX_EXPANDED)throw fail('distribution_size');}
 for(const name of names){const parts=name.split('/');for(let index=1;index<parts.length;index++)if(names.has(parts.slice(0,index).join('/')))throw fail('distribution_collision');}
 if(total<1)throw fail('distribution_incomplete');
 if(required.some(name=>!names.has(name)))throw fail('distribution_incomplete');
 const local=[],central=[],files=[];let offset=0;
 for(const[name,bytes]of entries){
  const member=ROOT+name,encoded=Buffer.from(member),packed=deflateRawSync(bytes,{level:9}),crc=crc32(bytes),header=Buffer.alloc(30),directory=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(encoded.length,26);
  directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(0x0314,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(8,10);directory.writeUInt16LE(33,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(packed.length,20);directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(encoded.length,28);directory.writeUInt32LE(((0o100644|(name.endsWith('.command')?0o111:0))<<16)>>>0,38);directory.writeUInt32LE(offset,42);
  local.push(header,encoded,packed);central.push(directory,encoded);offset+=header.length+encoded.length+packed.length;
  files.push({path:member,size:bytes.length,sha256:digest(bytes)});
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 const archive=Buffer.concat([...local,directory,end]);if(archive.length>MAX_ARCHIVE)throw fail('distribution_size');
 const manifest={schemaVersion:1,root:'kibi-studio',archive:{name:ARCHIVE,size:archive.length,sha256:digest(archive)},fileCount:files.length,totalBytes:total,publicSdkExceptions,files};
 const release={schemaVersion:1,release:releaseName,archive:ARCHIVE,sha256:digest(archive),bytes:archive.length,expandedBytes:total,fileCount:files.length,root:'kibi-studio',version,platform:'darwin',fullStudio:true,manifestSha256:digest(json(manifest)),sourceCommit:UPSTREAM_COMMIT};
 return{archive,manifest,release};
}

/** Independent manifest/hash/bounds checks before exposing public file bytes. */
export function decodeReleaseZip({archive,manifest,release}){
 if(!Buffer.isBuffer(archive)||archive.length>MAX_ARCHIVE||archive.length!==release?.bytes||digest(archive)!==release?.sha256)throw fail('archive_integrity');
 if(!hash(release?.manifestSha256)||digest(json(manifest))!==release.manifestSha256)throw fail('manifest_integrity');
 if(manifest?.schemaVersion!==1||manifest.root!=='kibi-studio'||release.root!=='kibi-studio'||release.archive!==ARCHIVE||!Array.isArray(manifest.files)||manifest.fileCount!==manifest.files.length||manifest.fileCount!==release.fileCount||manifest.files.length>10000||manifest.archive?.name!==ARCHIVE||manifest.archive.size!==archive.length||manifest.archive.sha256!==release.sha256)throw fail('manifest_integrity');
 const expected=new Map(),folded=new Set();let total=0;
 for(const item of manifest.files){
  if(typeof item.path!=='string'||!item.path.startsWith(ROOT))throw fail('distribution_path');
  const name=assertDistributionPath(item.path.slice(ROOT.length));
  if(expected.has(item.path)||folded.has(name.toLowerCase()))throw fail('distribution_collision');
  if(!hash(item.sha256)||!Number.isSafeInteger(item.size)||item.size<0||item.size>64*1024*1024)throw fail('manifest_integrity');
  total+=item.size;expected.set(item.path,item);folded.add(name.toLowerCase());
 }
 if(total<1||total!==manifest.totalBytes||total!==release.expandedBytes||total>MAX_EXPANDED)throw fail('manifest_integrity');
 for(const name of expected.keys()){const parts=name.split('/');for(let index=1;index<parts.length;index++)if(expected.has(parts.slice(0,index).join('/')))throw fail('distribution_collision');}
 let end=-1;
 for(let cursor=archive.length-22;cursor>=Math.max(0,archive.length-65557);cursor--)if(archive.readUInt32LE(cursor)===0x06054b50&&cursor+22+archive.readUInt16LE(cursor+20)===archive.length){end=cursor;break;}
 if(end<0||archive.readUInt16LE(end+4)||archive.readUInt16LE(end+6)||archive.readUInt16LE(end+8)!==expected.size||archive.readUInt16LE(end+10)!==expected.size)throw fail('zip_directory');
 const directoryStart=archive.readUInt32LE(end+16),directoryEnd=directoryStart+archive.readUInt32LE(end+12);
 if(directoryEnd!==end)throw fail('zip_directory');
 let cursor=directoryStart;const result=new Map(),ranges=[];
 for(let index=0;index<expected.size;index++){
  if(cursor+46>directoryEnd||archive.readUInt32LE(cursor)!==0x02014b50)throw fail('zip_entry');
  const flags=archive.readUInt16LE(cursor+8),method=archive.readUInt16LE(cursor+10),crc=archive.readUInt32LE(cursor+16),packed=archive.readUInt32LE(cursor+20),size=archive.readUInt32LE(cursor+24),nameSize=archive.readUInt16LE(cursor+28),extra=archive.readUInt16LE(cursor+30),comment=archive.readUInt16LE(cursor+32),disk=archive.readUInt16LE(cursor+34),mode=archive.readUInt32LE(cursor+38)>>>16,offset=archive.readUInt32LE(cursor+42),next=cursor+46+nameSize+extra+comment;
  if(next>directoryEnd)throw fail('zip_entry');
  const name=archive.subarray(cursor+46,cursor+46+nameSize).toString('utf8'),entry=expected.get(name),relative=name.slice(ROOT.length);
  if(!entry||result.has(relative)||size!==entry.size||disk||flags&~0x808||![0,8].includes(method)||![0,0x8000].includes(mode&0xf000)||offset+30>directoryStart||archive.readUInt32LE(offset)!==0x04034b50)throw fail('zip_entry');
  const localNameSize=archive.readUInt16LE(offset+26),localExtra=archive.readUInt16LE(offset+28),start=offset+30+localNameSize+localExtra,finish=start+packed;
  if(finish>directoryStart||archive.readUInt16LE(offset+6)!==flags||archive.readUInt16LE(offset+8)!==method||archive.subarray(offset+30,offset+30+localNameSize).toString('utf8')!==name)throw fail('zip_entry');
  const source=archive.subarray(start,finish),bytes=method===0?Buffer.from(source):inflateRawSync(source,{maxOutputLength:Math.max(1,size)});
  if(bytes.length!==size||digest(bytes)!==entry.sha256||crc32(bytes)!==crc)throw fail('zip_content_integrity');
  result.set(relative,bytes);ranges.push([offset,finish]);cursor=next;
 }
 if(cursor!==directoryEnd)throw fail('zip_directory');
 ranges.sort((a,b)=>a[0]-b[0]);for(let index=1;index<ranges.length;index++)if(ranges[index][0]<ranges[index-1][1])throw fail('zip_entry_overlap');
 return result;
}
