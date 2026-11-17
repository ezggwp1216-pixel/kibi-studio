// Strict reversible patch for the hash-authorized public browser program.
const fail=code=>Object.assign(new Error(code),{code});
const marker='\n// KIBI_LOCAL_FULL_INSTALL_V1\n';
const importBefore="import {initStudioAccountUI} from './studio-account.js';";
const importAfter=importBefore+"\nimport {loadLocalInstallSource} from './local-install-source.js';\nimport {parsePartitions,validateLocalPartitions} from './vendor/flash-core.js';";
const before=`      const response = await fetch(\`/api/build/\${encodeURIComponent(job.id)}/app.bin\`, { cache: 'no-store', credentials: 'same-origin' }); if (!response.ok) throw new Error(\`Не удалось загрузить сборку (\${response.status})\`);
      const source = await runtime.flasherApi.loadApplication(new File([await response.arrayBuffer()], 'app.bin', { type: 'application/octet-stream' }));
      if (source.files[0].sha256 !== artifact.sha256 || source.files[0].size !== artifact.size) throw new Error('SHA-256 или размер скачанной сборки не совпадает с заданием');`;
const after='      const source = await loadLocalInstallSource({ job, device: runtime.flasher.device, flasherApi: runtime.flasherApi, fetcher: fetch, parsePartitions, validateLocalPartitions });';
function decode(path,bytes){
 if(path!=='web/app.js')throw fail('upgrade_unknown_baseline');
 try{if(!(bytes instanceof Uint8Array))throw new TypeError();return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw fail('upgrade_invalid_program');}
}
function one(source,from,to){if(source.split(from).length!==2)throw fail('upgrade_anchor_mismatch');return source.replace(from,to);}
function apply(source){
 if(source.includes(marker.trim())||source.includes("from './local-install-source.js'")||source.includes(after))throw fail('upgrade_anchor_mismatch');
 return one(one(source,importBefore,importAfter),before,after)+marker;
}
export function patchFullInstallProgram(path,bytes){
 const source=decode(path,bytes);
 if(source.includes(marker.trim())){restoreFullInstallProgram(path,bytes);return Buffer.from(bytes);}
 return Buffer.from(apply(source));
}
export function restoreFullInstallProgram(path,bytes){
 const source=decode(path,bytes);
 if(!source.endsWith(marker)||source.split(marker.trim()).length!==2||source.includes(before))throw fail('upgrade_anchor_mismatch');
 const restored=one(one(source.slice(0,-marker.length),after,before),importAfter,importBefore);
 if(apply(restored)!==source)throw fail('upgrade_anchor_mismatch');return Buffer.from(restored);
}
