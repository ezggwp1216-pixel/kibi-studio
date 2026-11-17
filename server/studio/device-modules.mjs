import manifest from './device-modules.json' with {type:'json'};
import {lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const NAMES=Object.freeze(['kibi_xiaozhi_core.h','kibi_xiaozhi_client.h']);
const DEPENDENCIES=Object.freeze(['wifi.h','http_json.h','audio_codec_power.h','server_transport.h','power_management.h']);
const MAX_FILE_BYTES=256*1024;
const HASH=/^[a-f0-9]{64}$/;
const record=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(left,right)=>left && right && left.dev===right.dev && left.ino===right.ino;
const evidence=()=>({compiled:'unknown',hardware:'unknown',provider:'unknown',application:'unknown'});
const messages={
 module_unknown:'Неизвестный модуль Киби.',
 module_invalid_host:'Не удалось подключить каталог модулей Studio.',
 module_payload_unavailable:'Публичный пакет Xiaozhi отсутствует или не прошёл проверку. Обновите SDK Studio.',
 module_project_unavailable:'Не удалось подтвердить текущий проект Studio.',
 module_project_changed:'Проект изменился. Повторите подключение модуля.',
 module_file_conflict:'Файлы модуля уже изменены в проекте. Они сохранены без замены.',
 module_invalid_request:'Для подключения модуля требуется проверка текущего проекта.',
 module_sdk_incompatible:'Модуль Xiaozhi несовместим с версией SDK этого проекта. Используйте поддерживаемый комплект SDK.',
};
const failure=code=>Object.assign(new Error(messages[code]),{code});

function descriptor(){
 if(!record(manifest) || manifest.schemaVersion!==1 || manifest.id!=='xiaozhi' || typeof manifest.release!=='string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(manifest.release) || !Array.isArray(manifest.files) || manifest.files.length!==NAMES.length || !Array.isArray(manifest.dependencies) || manifest.dependencies.length!==DEPENDENCIES.length)return null;
 const files=[],dependencies=[];
 for(const path of NAMES){
  const matches=manifest.files.filter(file=>record(file) && file.path===path);
  if(matches.length!==1)return null;
  const file=matches[0];
  if(!Number.isSafeInteger(file.bytes) || file.bytes<1 || file.bytes>MAX_FILE_BYTES || !HASH.test(file.sha256))return null;
  files.push({path,bytes:file.bytes,sha256:file.sha256});
 }
 for(const path of DEPENDENCIES){
  const matches=manifest.dependencies.filter(file=>record(file) && file.path===path);
  if(matches.length!==1)return null;
  const hashes=matches[0].sha256;
  if(!Array.isArray(hashes) || hashes.length<1 || hashes.length>8 || hashes.some(hash=>typeof hash!=='string' || !HASH.test(hash)) || new Set(hashes).size!==hashes.length)return null;
  dependencies.push({path,sha256:[...hashes]});
 }
 return{release:manifest.release,files,dependencies};
}

function snapshot(value){
 if(!record(value) || typeof value.projectId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.projectId) || !Array.isArray(value.files) || value.files.length>256)return null;
 const files=new Map();
 for(const file of value.files){
  if(!record(file) || !NAMES.includes(file.path) && !DEPENDENCIES.includes(file.path))continue;
  if(files.has(file.path))return null;
  files.set(file.path,typeof file.sha256==='string' && HASH.test(file.sha256) ? file.sha256 : null);
 }
 return{projectId:value.projectId,files};
}

function projectState(current,definition){
 if(!current || !definition)return{installed:false,conflict:false};
 return{
  installed:definition.files.every(file=>current.files.get(file.path)===file.sha256),
  conflict:definition.files.some(file=>current.files.has(file.path) && current.files.get(file.path)!==file.sha256),
 };
}

function compatible(current,definition){
 return Boolean(current && definition && definition.dependencies.every(file=>file.sha256.includes(current.files.get(file.path))));
}

function validPaths(paths){
 return Array.isArray(paths) && paths.length===NAMES.length && new Set(paths).size===NAMES.length && NAMES.every(path=>paths.includes(path));
}

// The only filesystem reads are these exact public source headers plus their
// directory/file metadata. Nothing is executed and no provider is contacted.
async function readPayload(root,definition){
 if(!definition || typeof constants.O_NOFOLLOW!=='number')throw failure('module_payload_unavailable');
 try{
  const directories=[root,join(root,'src'),join(root,'src/device-sdk')],pins=[];
  async function directory(path){const info=await lstat(path);if(!info.isDirectory() || info.isSymbolicLink() || await realpath(path)!==path)throw failure('module_payload_unavailable');return info;}
  for(const path of directories)pins.push(await directory(path));
  async function checkDirectories(){for(let i=0;i<directories.length;i++)if(!same(pins[i],await directory(directories[i])))throw failure('module_payload_unavailable');}
  const files=[];
  for(const file of definition.files){
   await checkDirectories();const path=join(directories[2],file.path),before=await lstat(path);
   if(!before.isFile() || before.isSymbolicLink() || before.nlink!==1 || before.size!==file.bytes)throw failure('module_payload_unavailable');
   const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes,opened;
   try{
    opened=await handle.stat();if(!same(before,opened) || !opened.isFile() || opened.nlink!==1 || opened.size!==file.bytes)throw failure('module_payload_unavailable');
    const buffer=Buffer.alloc(file.bytes+1);let at=0;
    while(at<buffer.length){const {bytesRead}=await handle.read(buffer,at,Math.min(16384,buffer.length-at),at);if(!bytesRead)break;at+=bytesRead;}
    bytes=buffer.subarray(0,at);const after=await handle.stat();
    if(!same(opened,after) || after.nlink!==1 || after.size!==file.bytes || after.mtimeMs!==opened.mtimeMs || after.ctimeMs!==opened.ctimeMs || bytes.length!==file.bytes)throw failure('module_payload_unavailable');
   }finally{await handle.close();}
   await checkDirectories();const after=await lstat(path);if(!same(opened,after) || after.nlink!==1 || digest(bytes)!==file.sha256)throw failure('module_payload_unavailable');
   const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(content.includes('\0'))throw failure('module_payload_unavailable');
   files.push({path:file.path,content,sha256:file.sha256});
  }
  await checkDirectories();return files;
 }catch{throw failure('module_payload_unavailable');}
}

/** Host-only service. The host installer must serialize its project transaction,
 * revalidate expectedProjectId and every existing target hash, and run the passed
 * assertProjectCurrent guard at commit boundaries. Callback completion alone is
 * not accepted as evidence that the module was installed.
 */
export function createDeviceModuleService({root,getProjectFiles,installModule}={}) {
 if(typeof root!=='string' || !root || typeof getProjectFiles!=='function' || typeof installModule!=='function')throw failure('module_invalid_host');
 root=resolve(root);const definition=descriptor();
 async function current(){let value;try{value=await getProjectFiles();}catch{return null;}return snapshot(value);}
 async function status(){
  let available=false;try{await readPayload(root,definition);available=true;}catch{}
  const project=await current(),state=projectState(project,definition),sdkCompatible=compatible(project,definition);
  return{modules:[{id:'xiaozhi',name:'Голос Xiaozhi',available,compatible:sdkCompatible,...state,
   code:!available ? 'module_payload_unavailable' : !project ? 'module_project_unavailable' : !sdkCompatible ? 'module_sdk_incompatible' : state.conflict ? 'module_file_conflict' : null,
   capabilities:['account_pairing','xiaozhi_voice'],
   provenance:{kind:'bundled_public_sdk',release:definition?.release??null,sha256Verified:available},evidence:evidence()}]};
 }
 async function enable(id,{guard}={}){
  if(id!=='xiaozhi')throw failure('module_unknown');
  if(typeof guard!=='function')throw failure('module_invalid_request');
  await guard();const initial=await current();await guard();
  if(!initial)throw failure('module_project_unavailable');
  if(!definition)throw failure('module_payload_unavailable');
  if(projectState(initial,definition).conflict)throw failure('module_file_conflict');
  const files=await readPayload(root,definition);await guard();
  const before=await current();await guard();
  if(!before)throw failure('module_project_unavailable');
  if(before.projectId!==initial.projectId)throw failure('module_project_changed');
  const state=projectState(before,definition);if(state.conflict)throw failure('module_file_conflict');
  if(!compatible(before,definition))throw failure('module_sdk_incompatible');
  if(state.installed)return{id,installed:true,compatible:true,changed:false,paths:[...NAMES],code:null,evidence:evidence()};
  const result=await installModule({id,files,expectedProjectId:before.projectId,assertProjectCurrent:async()=>{await guard();}});
  await guard();const after=await current();await guard();
  if(!after)throw failure('module_project_unavailable');
  if(after.projectId!==before.projectId)throw failure('module_project_changed');
  if(!compatible(after,definition))throw failure('module_sdk_incompatible');
  const confirmed=record(result) && typeof result.changed==='boolean' && validPaths(result.paths) && projectState(after,definition).installed;
  return{id,installed:confirmed,compatible:true,changed:confirmed ? result.changed : null,paths:confirmed ? [...NAMES] : [],code:confirmed ? null : 'module_install_unconfirmed',evidence:evidence()};
 }
 return{status,enable};
}
