import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const base='templates/kibi-base/';
export const PUBLIC_SDK_FILES=Object.freeze([
 'resources/board.json',base+'manifest.json',base+'board.json',base+'AGENTS.md',base+'firmware/README.md',
 ...['audio_codec_power.h','microphone_i2s.h','microphone_filter.h','display_touch.h','power.h','power_management.h','power_runtime.h','power_ui.h','state_info.h','wifi.h','http_json.h','network_gate.h'].map(p=>base+'firmware/'+p),
 'prompts/agent-system.md',
]);
const digest=b=>createHash('sha256').update(b).digest('hex');
async function publicBytes(root,relative){
 let current=root;
 for(const part of relative.split('/')){
  current=join(current,part);const s=await lstat(current);
  if(s.isSymbolicLink()||(current!==join(root,relative)&&!s.isDirectory()))throw Object.assign(new Error(),{code:'sdk_unsafe_path'});
 }
 const handle=await open(current,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const s=await handle.stat();if(!s.isFile()||s.nlink!==1||s.size>2*1024*1024)throw Object.assign(new Error(),{code:'sdk_unsafe_path'});
  return await handle.readFile();
 }finally{await handle.close();}
}

/** Reads a fixed PUBLIC template allowlist, never projects, settings or binaries. */
export async function inspectSdk(input){
 const errors=[],files=new Map();
 const add=(code,path)=>errors.push({code,...(path?{path}:{})});
 let root;
 try{
  if(typeof input!=='string'||!input.trim())throw new Error();
  root=await realpath(resolve(input));const s=await lstat(root);if(!s.isDirectory())throw new Error();
 }catch{return {ok:false,hardwareVerified:false,checkedFiles:0,errors:[{code:'sdk_root_invalid'}]};}
 for(const path of PUBLIC_SDK_FILES){
  try{files.set(path,await publicBytes(root,path));}
  catch(error){add(error.code==='ENOENT'?'sdk_file_missing':error.code==='sdk_unsafe_path'?'sdk_unsafe_path':'sdk_read_failed',path);}
 }
 const parse=path=>{try{return JSON.parse(files.get(path)?.toString('utf8'));}catch{add('sdk_json_invalid',path);return null;}};
 const manifest=parse(base+'manifest.json'),board=parse(base+'board.json'),resource=parse('resources/board.json');
 const safePath=p=>typeof p==='string'&&/^(?:AGENTS\.md|board\.json|project\.json|firmware\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:h|ino|json|md))$/.test(p);
 const entries=manifest?.files;
 if(manifest?.schemaVersion!==1||manifest?.boardId!=='kibi-ds02-s3-16m'||!Array.isArray(entries)||entries.length<1||entries.length>100||
  entries.some(e=>!safePath(e?.path)||!Number.isSafeInteger(e.size)||e.size<0||!/^[a-f0-9]{64}$/.test(e.sha256))||new Set(entries?.map(e=>e.path)).size!==entries?.length)add('sdk_manifest_invalid');
 else{
  const inventory=new Map(entries.map(e=>[e.path,e]));
  for(const [path,bytes]of files)if(path.startsWith(base)&&path!==base+'manifest.json'){
   const e=inventory.get(path.slice(base.length));if(!e||e.size!==bytes.length||e.sha256!==digest(bytes))add('sdk_hash_mismatch',path);
  }
 }
 if(board&&resource&&JSON.stringify(board)!==JSON.stringify(resource))add('board_snapshots_differ');
 if(board?.id!=='kibi-ds02-s3-16m'||board?.coreVersion!=='3.3.12'||board?.sdkVersion!=='5.5.5'||board?.display?.width!==240||board?.display?.height!==296)add('sdk_profile_incompatible');
 const audio=files.get(base+'firmware/audio_codec_power.h')?.toString('utf8')||'';
 const wifi=files.get(base+'firmware/wifi.h')?.toString('utf8')||'';
 const readme=files.get(base+'firmware/README.md')?.toString('utf8')||'';
 const prepared=/\bpreparePlayback\s*\(/.test(audio);
 if(!prepared)add('audio_prepare_missing');
 if(board?.capabilities?.audioOutput&&prepared!==JSON.stringify(board.capabilities.audioOutput).includes('preparePlayback'))add('audio_metadata_mismatch');
 if(/^# Kibi BTC|Coinbase|BTC-MEM|добавлены `btc_/mi.test(readme))add('starter_instructions_stale');
 const wifiFamily=/namespace\s+(?:Tamagotchi::)?DeviceWifi\s*\{/.test(wifi)?'controller':'legacy';
 if(board?.capabilities?.wifi&&(wifiFamily==='controller')!==JSON.stringify(board.capabilities.wifi).includes('DeviceWifi'))add('wifi_metadata_mismatch');
 return {ok:errors.length===0,hardwareVerified:false,checkedFiles:files.size,checkedSubset:true,profile:board?.id||null,wifiFamily,audioPreparation:prepared,errors};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(process.argv[1])).href){
 const result=await inspectSdk(process.argv.length===3?process.argv[2]:null);console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
}
