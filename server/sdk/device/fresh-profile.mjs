import {constants} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {deviceVariantHeader} from '../../studio/device-variants.mjs';

const base='templates/kibi-base/';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,path)=>Object.assign(new Error(code),{code,...(path?{path}:{})});
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

// The immutable public ZIP is the sole accepted fresh input. A template manifest
// pin transitively pins every listed template file; no project tree is scanned.
export const FRESH_SDK_INPUTS=Object.freeze({
 commit:'43d47afb090c9bf6ab69ea46ee559da3c9867616',
 archiveSha256:'d6707edbbcea2ed631dc7dcfb1d4ecabf487dae839ae4c3003f7529a03ce4f58',
 templateManifest:'bb4326bfb56cfc3990b8e96692a733859b559653003dd2b5cf306a4dd09f4567',
 board:'981e456e24dd31200d3be38e7d4999861a7a6f2e4c17807ea1ee5273f0513567',
 prompt:'8727ce50b925602e546343c8b192684de9e9073366f02e5523a2f356454cc389',
});
const reviewed=Object.freeze({
 board:'74c1dcd37618e6d9c59946989c3796d8c67fb7a63f830b6d626012f48245c5c6',
 contract:'36df4e66d472a15a603000a20f3250a93327111d2d381d2189c12a6432c3bc3c',
 doctor:'697e8924830c48c6521a9c3f09fce2ce95942e277f2555fcc4105d4016fafb11',
 agents:'aee5761203629ced617e3fe424ff4a8d7b86a1f23e768bd80de4970d7f581f7a',
 readme:'f7720b479b55a82c86b29a5989732392b9a906615186f0c479618962c91d1823',
 audio:'1923172d1aff4be60a68bd148d4256c70fabf9d4716e0e8dbf486b9529bb49d4',
 migration:'eafcd980c4c73c5f0ad5e8053828a07f45a4c020070dc9cc824082ccd429eb0d',
 instructions:'54540e0a73a96f1e38c4f1d1f111cff2c199ef0064bb465f9f1840fba8178973',
});
export const FRESH_SDK_PAYLOADS=reviewed;
const dependencyPins=Object.freeze({
 'wifi.h':'06ef13ced44a002c88151a5e4da4be94848b662959a2ecc9df73d30e5e126e16',
 'http_json.h':'0d71113432682654d8e08aa06fa8c31711db3d7ceb4ffb90127d7fef5c97661a',
 'audio_codec_power.h':reviewed.audio,
 'server_transport.h':'604b95ef06f86e509042e29d948e6047aae70755e10881a519caae3bdb4996c9',
 'power_management.h':'4e91470c9283f36e566a5c2cf460cd33aee2331273996c8bfbb2083a61e58c96',
});
const variantPath=base+'firmware/kibi_device_config.h';
const newPaths=Object.freeze(['resources/device-contract.json','scripts/check-public-sdk.mjs','src/device-migrations.mjs','src/module-migrations.mjs',variantPath]);

async function safeRoot(input){
 if(typeof input!=='string'||!input.trim())throw fail('fresh_sdk_unsafe_root');
 let root=resolve(input);
 // macOS system aliases are normalized explicitly, not arbitrary symlinks.
 if(process.platform==='darwin')for(const prefix of ['/tmp','/var'])if((root===prefix||root.startsWith(prefix+'/'))&&await realpath(prefix)==='/private'+prefix)root='/private'+root;
 let current='/';
 for(const part of root.slice(1).split('/')){current=join(current,part);const s=await lstat(current).catch(()=>null);if(!s?.isDirectory()||s.isSymbolicLink())throw fail('fresh_sdk_unsafe_root');}
 if(await realpath(root)!==root)throw fail('fresh_sdk_unsafe_root');return root;
}

async function publicBytes(root,path,optional=false){
 if(!/^[A-Za-z0-9._/-]+$/.test(path)||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw fail('fresh_sdk_unsafe_path',path);
 let current=root;
 for(const part of path.split('/')){
  current=join(current,part);let s;try{s=await lstat(current);}catch(e){if(e.code==='ENOENT'&&optional)return null;throw fail('fresh_sdk_source_missing',path);}
  if(s.isSymbolicLink()||(current!==join(root,path)&&!s.isDirectory()))throw fail('fresh_sdk_unsafe_path',path);
 }
 const fd=await open(current,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await fd.stat();if(!s.isFile()||s.nlink!==1||s.size>64*1024*1024)throw fail('fresh_sdk_unsafe_path',path);const b=await fd.readFile();if(b.length!==s.size)throw fail('fresh_sdk_source_changed',path);return b;}
 finally{await fd.close();}
}
function replaceOnce(source,before,after){if(source.split(before).length!==2)throw fail('fresh_sdk_anchor_mismatch');return source.replace(before,after);}
function updatedPrompt(input,instructions){
 let text=input.toString('utf8');
 const replaceParagraph=(prefix,replacement)=>{const rows=text.split('\n');const found=rows.filter(row=>row.startsWith(prefix));if(found.length!==1)throw fail('fresh_sdk_anchor_mismatch');text=replaceOnce(text,found[0],replacement);};
 replaceParagraph('Workflow:','Workflow: understand the idea → propose useful functions and four distinct compact visual directions → create and inspect the native mockup → test its screens and controls with the user → ask them to press «Проект готов» → implement the application → inspect the current native image and run kibi_check. Studio owns the requested preparation, target diagnostics, server compilation and verified download; report the actual workflow, never a binary before ready. USB installation is a separate explicit user action. An idea, screenshot or compilation is not hardware evidence.');
 replaceParagraph('Source contract:','Source contract: app_core.h and app_view.h are the portable mockup editing surface: model, input, hit targets and pixels must agree. app_feature.h owns hardware/application lifecycle and is gated until the explicit «Проект готов» request. That implementation permission persists through later ordinary edits; refresh current preview/check evidence after every source change. Read before writing and use the exact current SHA256. Fixed Feature.h/project.ino, drivers, pins, fonts, calibration, partitions, SDK and power remain protected.');
 replaceParagraph('No arbitrary shell/filesystem/HTTP,','No arbitrary shell/filesystem access, serial or flash tool is granted to the model. Use actual Studio tools and follow their exact permissions and returned workflow. Requested preparation and server compilation belong to Studio; the user confirms the exact current artifact before USB write. Source/configuration/SDK changes invalidate earlier evidence and binaries. Configured compiler logs and secrets stay private. Never fabricate replies, checks, service data or hardware results.');
 if(text.includes('# Kibi development reliability — authoritative addendum'))throw fail('fresh_sdk_anchor_mismatch');
 return Buffer.from(text.trimEnd()+'\n\n'+instructions.toString('utf8'));
}
function legacyModules(){
 return Buffer.from(`import {DEVICE_FIRMWARE_MIGRATIONS} from './device-migrations.mjs';

// This fresh reviewed cohort intentionally retains legacy beginWifi/getJson.
// No controller-family Wi-Fi/HTTPS migration is compatible with its voice pins.
export const MODULE_FIRMWARE_MIGRATIONS=Object.freeze({});
export const REVIEWED_FIRMWARE_MIGRATIONS=Object.freeze({...DEVICE_FIRMWARE_MIGRATIONS});
const pins=Object.freeze({wifi:'${dependencyPins['wifi.h']}',http:'${dependencyPins['http_json.h']}'});
export function moduleReadiness(files,protectedHashes){
 const current=new Map(files.map(file=>[file.path,file.sha256]));
 const checked=(name,pin)=>current.get(name)===pin&&protectedHashes?.[name]===pin;
 return {wifiModuleReady:checked('wifi.h',pins.wifi),apiModuleReady:checked('http_json.h',pins.http)};
}
`);
}

/** A deterministic read-only recipe for this one public factory cohort.
 * Never enumerates projects, private runtime directories or any Studio root.
 * The caller owns staging/transactional application and must verify before hashes.
 */
export async function planFreshSdk({root,kitRoot=fileURLToPath(new URL('./',import.meta.url))}={}){
 root=await safeRoot(root);kitRoot=await safeRoot(kitRoot);
 const originals=new Map(),kitReads=[];
 const remember=async(path,expected,code='fresh_sdk_source_mismatch')=>{const bytes=await publicBytes(root,path);if(digest(bytes)!==expected)throw fail(code,path);originals.set(path,bytes);return bytes;};
 const manifestBytes=await remember(base+'manifest.json',FRESH_SDK_INPUTS.templateManifest,'fresh_sdk_unknown_manifest');
 const manifest=JSON.parse(manifestBytes.toString('utf8'));
 if(manifest.schemaVersion!==1||manifest.boardId!=='kibi-ds02-s3-16m'||!Array.isArray(manifest.files)||manifest.files.length>100||new Set(manifest.files.map(f=>f.path)).size!==manifest.files.length)throw fail('fresh_sdk_invalid_manifest');
 for(const f of manifest.files){
  if(!/^(?:AGENTS\.md|board\.json|project\.json|firmware\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:h|ino|json|md))$/.test(f.path)||!hash(f.sha256)||!Number.isSafeInteger(f.size)||f.size<0)throw fail('fresh_sdk_invalid_manifest');
  const bytes=await remember(base+f.path,f.sha256);if(bytes.length!==f.size)throw fail('fresh_sdk_source_mismatch',base+f.path);
 }
 await remember('resources/board.json',FRESH_SDK_INPUTS.board);
 await remember('prompts/agent-system.md',FRESH_SDK_INPUTS.prompt);
 for(const path of newPaths){if(await publicBytes(root,path,true)!==null)throw fail('fresh_sdk_unexpected_file',path);originals.set(path,null);}
 const payload=async key=>{const expected=reviewed[key],path=key==='instructions'?'instructions.md':'overlays/files/'+expected+'.txt';const bytes=await publicBytes(kitRoot,path);if(digest(bytes)!==expected)throw fail('fresh_sdk_payload_mismatch',path);kitReads.push({path,sha256:expected});return bytes;};
 const outputs=new Map(),board=await payload('board');
 outputs.set('resources/board.json',board);outputs.set(base+'board.json',board);
 outputs.set('resources/device-contract.json',await payload('contract'));
 outputs.set('scripts/check-public-sdk.mjs',await payload('doctor'));
 outputs.set(base+'AGENTS.md',await payload('agents'));
 outputs.set(base+'firmware/README.md',await payload('readme'));
 outputs.set(base+'firmware/audio_codec_power.h',await payload('audio'));
 outputs.set('prompts/agent-system.md',updatedPrompt(originals.get('prompts/agent-system.md'),await payload('instructions')));
 const configPath=base+'firmware/config.h';
 const withVariant=replaceOnce(originals.get(configPath).toString('utf8'),'#pragma once\n','#pragma once\n#include "kibi_device_config.h"\n');
 const config=Buffer.from(replaceOnce(withVariant,'constexpr int kMicMclk=5,kMicBclk=15,kMicWs=16,kMicDin=7;','constexpr int kMicMclk=5,kMicBclk=15,kMicWs=16,kMicDin=7;\n// OSTB DS-02 / ES8311 I2S output; variant gating stays in the adapter.\nconstexpr int kSpeakerDout=6;'));
 outputs.set(configPath,config);
 outputs.set(variantPath,deviceVariantHeader('basic'));
 const projectPath=base+'project.json',project=JSON.parse(originals.get(projectPath).toString('utf8'));
 if(project.schemaVersion!==1||project.id!=='kibi-base'||project.boardId!=='kibi-ds02-s3-16m'||Object.hasOwn(project,'deviceVariant'))throw fail('fresh_sdk_project_mismatch');
 outputs.set(projectPath,Buffer.from(JSON.stringify({...project,deviceVariant:'basic'},null,2)+'\n'));
 const migration=await payload('migration');
 outputs.set('src/device-migrations.mjs',Buffer.from(replaceOnce(migration.toString('utf8'),"to:'50b55a5a4da7e81196df71cb175cbcf43b73956f609aa8ad20feca9465fba344'","to:'"+digest(config)+"'")));
 outputs.set('src/module-migrations.mjs',legacyModules());
 for(const [name,pin]of Object.entries(dependencyPins))if(digest(outputs.get(base+'firmware/'+name)||originals.get(base+'firmware/'+name))!==pin)throw fail('fresh_sdk_dependency_mismatch',name);
 const next={...manifest,files:[...manifest.files.map(f=>{const bytes=outputs.get(base+f.path)||originals.get(base+f.path);return {...f,size:bytes.length,sha256:digest(bytes)};}),{path:'firmware/kibi_device_config.h',size:outputs.get(variantPath).length,sha256:digest(outputs.get(variantPath))}].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
 outputs.set(base+'manifest.json',Buffer.from(JSON.stringify(next,null,2)+'\n'));
 // Check the source and trusted payloads again after all asynchronous reads.
 for(const [path,bytes]of originals){const current=await publicBytes(root,path,bytes===null);if((current===null?null:digest(current))!==(bytes===null?null:digest(bytes)))throw fail('fresh_sdk_source_changed',path);}
 for(const f of kitReads)if(digest(await publicBytes(kitRoot,f.path))!==f.sha256)throw fail('fresh_sdk_payload_mismatch',f.path);
 const files=[...outputs].map(([path,bytes])=>({path,beforeSha256:originals.get(path)===null?null:digest(originals.get(path)),afterSha256:digest(bytes),bytes}));
 return {ok:true,profile:{id:'public-main-43d47afb-legacy-r2',files:files.map(f=>({path:f.path,before:f.beforeSha256,after:f.afterSha256}))},payloads:files.map(f=>({path:f.path,bytes:f.bytes})),files,sourceCommit:FRESH_SDK_INPUTS.commit,release:'2026-11-17-r3',privateProjectsRead:false,hardwareVerified:false};
}
