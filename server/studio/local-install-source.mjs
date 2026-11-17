// Browser-only preparation. This module never opens USB or writes device flash.
const BOARD='kibi-ds02-s3-16m',FLASH=16777216,MAX_APP=2097152;
const slots=Object.freeze({
 'bootloader.bin':{kind:'bootloader',offset:0,max:0x8000},
 'partitions.bin':{kind:'partitions',offset:0x8000,max:0x1000},
 'boot_app0.bin':{kind:'otadata',offset:0xe000,max:0x2000},
 'app.bin':{kind:'app',offset:0x10000,max:MAX_APP},
});
const fail=()=>{throw new Error('Комплект установки не соответствует текущей сборке Киби. Подготовьте план заново.');};
const sha256=async data=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(x=>x.toString(16).padStart(2,'0')).join('');
const fullWarning='Первая установка или смена разметки заменит приложение, загрузчик и системные разделы. Локальные данные устройства могут сброситься. Полное стирание flash не выполняется. Запись начнётся только после вашего подтверждения.';
function fileMetadata(file,id){
 const slot=Object.hasOwn(slots,file?.name)?slots[file.name]:null,url=slot?`/api/configurator/jobs/${id}/files/${file.name}`:'';
 if(!slot||file.offset!==slot.offset||!Number.isSafeInteger(file.size)||file.size<=0||file.size>slot.max||!(/^[a-f0-9]{64}$/).test(file.sha256)||file.kind!==undefined&&file.kind!==slot.kind||file.url!==undefined&&file.url!==url)fail();
 if(slot.kind==='otadata'&&file.size!==0x2000)fail();
 return{name:file.name,kind:slot.kind,offset:slot.offset,size:file.size,sha256:file.sha256,url};
}
function match(file,expected){
 if(!file||['name','kind','offset','size','sha256','url'].some(key=>file[key]!==expected[key]))fail();
}
function fullMetadata(source,expected,id){
 if(source?.boardId!==BOARD||source.chip!=='ESP32-S3'||source.chipId!==9||source.flashBytes!==FLASH||source.maxAppBytes!==MAX_APP||source.mode!=='full'||source.version!==id||!Array.isArray(source.files)||source.files.length!==4||new Set(source.files.map(file=>file.name)).size!==4)fail();
 for(const file of source.files){const entry=expected.find(item=>item.name===file.name);if(!entry)fail();match(file,entry);}
}
async function sameBytes(file,expected){
 if(!(file?.data instanceof Uint8Array)||file.data.length!==expected.size||await sha256(file.data)!==expected.sha256)fail();
}
export async function loadLocalInstallSource({job,device,flasherApi,fetcher=globalThis.fetch,parsePartitions,validateLocalPartitions}={}){
 if(!job||job.status!=='succeeded'||typeof job.id!=='string'||!(/^[a-zA-Z0-9-]+$/).test(job.id)||!Array.isArray(job.artifacts)||device?.chip!=='ESP32-S3'||device.flashBytes!==FLASH||typeof parsePartitions!=='function'||typeof validateLocalPartitions!=='function'||typeof fetcher!=='function'||typeof flasherApi?.loadApplication!=='function'||typeof flasherApi?.loadManifest!=='function')fail();
 const id=job.id,appFiles=job.artifacts.filter(file=>file.name==='app.bin');if(appFiles.length!==1)fail();
 const app=fileMetadata(appFiles[0],id);
 const get=async url=>{const response=await fetcher(url,{cache:'no-store',credentials:'same-origin',redirect:'error'});if(!response?.ok||response.redirected)fail();return response;};
 let native=false;
 try{
  const partitions=device.partitions;
  if(!device.partitionError&&Array.isArray(partitions)&&partitions.length){
   const app=partitions.find(p=>p.type===0&&p.subtype===0x10),otadata=partitions.find(p=>p.type===1&&p.subtype===0);
   if(otadata?.size===0x2000){validateLocalPartitions({partitions,app,otadata});native=true;}
  }
 }catch{native=false;}
 if(native){
  const response=await get(`/api/build/${id}/app.bin`),data=new Uint8Array(await response.arrayBuffer());await sameBytes({data},app);
  const source=await flasherApi.loadApplication(new File([data],'app.bin',{type:'application/octet-stream'}));
  if(source?.mode!=='app'||!Array.isArray(source.files)||source.files.length!==1||source.files[0].sha256!==app.sha256||source.files[0].size!==app.size)fail();
  await sameBytes(source.files[0],app);return source;
 }
 if(job.artifacts.length!==4||new Set(job.artifacts.map(file=>file.name)).size!==4)fail();
 const expected=job.artifacts.map(file=>fileMetadata(file,id)),manifestUrl=`/api/configurator/jobs/${id}/manifest`;
 let manifestChecked=false;
 const checkedFetcher=async url=>{
  if(url!==manifestUrl&&(!manifestChecked||!expected.some(file=>file.url===url)))fail();
  const response=await get(url);
  if(url===manifestUrl){
   if(manifestChecked)fail();const manifest=await response.json();fullMetadata(manifest,expected,id);manifestChecked=true;
   return{ok:true,status:response.status,json:async()=>manifest};
  }
  return response;
 };
 const source=await flasherApi.loadManifest(manifestUrl,checkedFetcher);
 if(!manifestChecked)fail();fullMetadata(source,expected,id);
 for(const file of source.files)await sameBytes(file,expected.find(entry=>entry.name===file.name));
 validateLocalPartitions(parsePartitions(source.files.find(file=>file.kind==='partitions').data));
 return{...source,dataWarning:fullWarning};
}
