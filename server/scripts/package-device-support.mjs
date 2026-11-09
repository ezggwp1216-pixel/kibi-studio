import {readFile,writeFile,lstat} from 'node:fs/promises';
import {resolve,join,dirname,posix} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';

const sha=b=>createHash('sha256').update(b).digest('hex');
const PREFIX='kibi-device-support';
const FIXED=['sdk/device/doctor.mjs','sdk/device/update.mjs','sdk/device/contract.json','sdk/device/README.md','sdk/device/instructions.md','sdk/device/overlays/profiles.json'];
const SOURCE=['audio_codec_power.h','wifi.h','state_info.h','microphone_i2s.h','microphone_filter.h','network_gate.h','power.h','power_management.h','power_runtime.h','power_ui.h','display_touch.h','http_json.h'];
async function readPublic(root,path){
 const filename=join(root,path);const s=await lstat(filename);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>2*1024*1024)throw Error('invalid_public_package_input');
 const bytes=await readFile(filename);if(bytes.length!==s.size)throw Error('public_source_changed');return bytes;
}
function header(path,size,directory=false){
 const block=Buffer.alloc(512),name=PREFIX+'/'+path;
 const cut=name.length>100?name.lastIndexOf('/'):-1,base=cut<0?name:name.slice(cut+1),prefix=cut<0?'':name.slice(0,cut);
 if(base.length>100||prefix.length>155||!/^[A-Za-z0-9._/-]+$/.test(name)||name.split('/').includes('..'))throw Error('invalid_tar_member');
 block.write(base,0);if(prefix)block.write(prefix,345);
 const oct=(value,at,count)=>block.write(value.toString(8).padStart(count-1,'0')+'\0',at,count);
 oct(directory?0o755:0o644,100,8);oct(0,108,8);oct(0,116,8);oct(size,124,12);oct(0,136,12);
 block.fill(32,148,156);block.write(directory?'5':'0',156);block.write('ustar\0',257,6);block.write('00',263,2);
 const checksum=block.reduce((a,b)=>a+b,0);block.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);return block;
}
export async function packageDeviceSupport({root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),output}={}){
 const paths=new Map(FIXED.map(p=>[p,p.slice('sdk/device/'.length)]));
 for(const p of SOURCE)paths.set('sdk/device/source/'+p,'source/'+p);
 for(const name of ['HARDWARE.md','SERVICES.md','SDK_UPDATE.md','LOCAL_STUDIO.md','SDK.md','API.md','VOICE.md'])paths.set('docs/'+name,'docs/'+name);
 paths.set('examples/diagnostics/KibiHardwareDiagnostics.ino','examples/KibiHardwareDiagnostics.ino');
 paths.set('examples/diagnostics/README.md','examples/README.md');
 const profiles=JSON.parse((await readPublic(root,'sdk/device/overlays/profiles.json')).toString('utf8'));
 for(const profile of profiles.profiles)for(const item of profile.files){if(!/^[a-f0-9]{64}$/.test(item.after))throw Error('invalid_payload_hash');const p='sdk/device/overlays/files/'+item.after+'.txt';paths.set(p,p.slice('sdk/device/'.length));}
 const files=new Map();
 for(const [source,target]of paths)files.set(target,await readPublic(root,source));
 const manifest={schemaVersion:1,release:'2026-11-09-r1',root:PREFIX,privateFilesIncluded:false,files:[...files].sort(([a],[b])=>a.localeCompare(b,'en')).map(([path,b])=>({path,size:b.length,sha256:sha(b)}))};
 files.set('manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
 const dirs=new Set(['']);for(const path of files.keys()){let parent=posix.dirname(path);while(parent!=='.'){dirs.add(parent);parent=posix.dirname(parent);}}
 const tar=[];for(const dir of [...dirs].sort())tar.push(header(dir,0,true));
 for(const [path,bytes]of [...files].sort(([a],[b])=>a.localeCompare(b,'en'))){tar.push(header(path,bytes.length),bytes,Buffer.alloc((512-bytes.length%512)%512));}
 tar.push(Buffer.alloc(1024));const archive=gzipSync(Buffer.concat(tar),{level:9});
 // Reject a changing source before publication. No private root enumeration.
 for(const [source,target]of paths)if(sha(await readPublic(root,source))!==sha(files.get(target)))throw Error('public_source_changed');
 if(output)await writeFile(output,archive);
 return {archive,release:{schemaVersion:1,release:manifest.release,archive:{path:'sdk/device/kibi-device-support-20261109.tar.gz',bytes:archive.length,sha256:sha(archive)},manifestSha256:sha(files.get('manifest.json')),requiresNode:'>=24',profiles:profiles.profiles.map(p=>p.id),privateFilesIncluded:false}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');const result=await packageDeviceSupport({root,output:join(root,'sdk/device/kibi-device-support-20261109.tar.gz')});
 await writeFile(join(root,'sdk/device/release.json'),JSON.stringify(result.release,null,2)+'\n');console.log(JSON.stringify(result.release));
}
