import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadLocalInstallSource} from './local-install-source.mjs';

const hash=data=>createHash('sha256').update(data).digest('hex');
const nativePartitions=[
 {type:1,subtype:0,offset:0xe000,size:0x2000},
 {type:0,subtype:0x10,offset:0x10000,size:0x200000},
 {type:0,subtype:0x11,offset:0x210000,size:0x200000},
];
function fixture(){
 const kinds={bootloader:['bootloader.bin',0],partitions:['partitions.bin',0x8000],otadata:['boot_app0.bin',0xe000],app:['app.bin',0x10000]};
 const entries=Object.entries(kinds).map(([kind,[name,offset]],index)=>{const data=new Uint8Array(kind==='otadata'?0x2000:32).fill(index+1);return{kind,name,offset,data,size:data.length,sha256:hash(data),url:`/api/configurator/jobs/job-123/files/${name}`};});
 const job={id:'job-123',status:'succeeded',artifacts:entries.map(({data,kind,...file})=>({...file}))};
 const manifest={boardId:'kibi-ds02-s3-16m',chip:'ESP32-S3',chipId:9,flashBytes:16777216,maxAppBytes:2097152,mode:'full',version:job.id,dataWarning:'old warning',files:entries.map(({data,...file})=>({...file}))};
 const device={chip:'ESP32-S3',flashBytes:16777216,partitions:[...nativePartitions,{type:0,subtype:0,offset:0x410000,size:0x200000}]};
 const calls=[],downloads=[],requests=[];
 const flasherApi={
  async loadApplication(file){calls.push('app');const data=new Uint8Array(await file.arrayBuffer());return{mode:'app',dataWarning:'app only',files:[{name:'app.bin',kind:'app',data,size:data.length,sha256:hash(data)}]};},
  async loadManifest(url,fetcher){calls.push('full');const m=await(await fetcher(url)).json(),files=[];for(const f of m.files){const data=new Uint8Array(await(await fetcher(f.url)).arrayBuffer());files.push({...f,data});}return{...m,files};},
 };
 const fetcher=async(url,options)=>{requests.push({url,options});if(url==='/api/configurator/jobs/job-123/manifest')return{ok:true,status:200,redirected:false,json:async()=>structuredClone(manifest)};
  const entry=entries.find(item=>item.url===url)||entries.find(item=>url==='/api/build/job-123/app.bin'&&item.kind==='app');assert.ok(entry,`unexpected URL ${url}`);downloads.push(entry.name);return{ok:true,status:200,redirected:false,arrayBuffer:async()=>entry.data.slice().buffer};};
 const parsePartitions=data=>{assert.ok(data instanceof Uint8Array);if(data[0]!==2)throw Error('bad target table');return{partitions:nativePartitions,app:nativePartitions[1],otadata:nativePartitions[0]};};
 const validateLocalPartitions=parsed=>{assert.deepEqual(parsed.partitions,nativePartitions,'not native 2OTA');return parsed;};
 const run=()=>loadLocalInstallSource({job,device,flasherApi,fetcher,parsePartitions,validateLocalPartitions});
 return{job,device,entries,manifest,calls,downloads,requests,flasherApi,fetcher,parsePartitions,validateLocalPartitions,run};
}

test('a factory layout prepares a validated four-file full source without writing',async()=>{
 const f=fixture(),source=await f.run();assert.equal(source.mode,'full');assert.deepEqual(f.calls,['full']);assert.equal(source.files.length,4);
 assert.match(source.dataWarning,/системные|загрузчик/i);assert.match(source.dataWarning,/данные.*сброс/i);assert.match(source.dataWarning,/подтвержден/i);
 assert.equal(f.requests.length,5);for(const request of f.requests){assert.equal(request.options.redirect,'error');assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.cache,'no-store');}
});

test('an exact native two-OTA layout retains application-only updating',async()=>{
 const f=fixture();f.device.partitions=nativePartitions;const source=await f.run();assert.equal(source.mode,'app');assert.deepEqual(f.calls,['app']);assert.deepEqual(f.downloads,['app.bin']);assert.equal(source.files[0].sha256,f.job.artifacts.find(file=>file.name==='app.bin').sha256);
});

test('every full-source metadata field must agree with the current job before any binary download',async()=>{
 for(const change of [
  f=>{f.manifest.files[0].sha256='0'.repeat(64);},f=>{f.manifest.files[0].size++;},f=>{f.manifest.files[0].offset=0x1000;},
  f=>{f.manifest.files[0].name='other.bin';},f=>{f.manifest.files[0].kind='app';},f=>{f.manifest.version='job-stale';},
  f=>{f.manifest.files.pop();},f=>{f.job.artifacts.push({...f.job.artifacts[0]});},
 ]){const f=fixture();change(f);await assert.rejects(f.run());assert.equal(f.downloads.length,0);}
});

test('foreign, stale-job or encoded file URLs and redirects are rejected before binary downloads',async()=>{
 for(const url of ['https://other.example/app.bin','//other.example/app.bin','/api/configurator/jobs/job-old/files/bootloader.bin','/api/configurator/jobs/job-123/files/%62ootloader.bin','/api/configurator/jobs/job-123/files/bootloader.bin?x=1']){
  const f=fixture();f.manifest.files[0].url=url;await assert.rejects(f.run());assert.equal(f.downloads.length,0);
 }
 const f=fixture();await assert.rejects(loadLocalInstallSource({...f,fetcher:async()=>({ok:true,status:200,redirected:true,json:async()=>f.manifest})}));
});

test('corrupt downloaded bytes and a non-native target partition table never yield an install source',async()=>{
 for(const kind of ['app','partitions']){const f=fixture();f.entries.find(file=>file.kind===kind).data[0]^=0xff;await assert.rejects(f.run());}
 const f=fixture(),table=f.entries.find(file=>file.kind==='partitions');table.data.fill(9);table.sha256=hash(table.data);f.job.artifacts.find(file=>file.name===table.name).sha256=table.sha256;f.manifest.files.find(file=>file.kind==='partitions').sha256=table.sha256;await assert.rejects(f.run(),/bad target table/);
 const app=fixture();app.device.partitions=nativePartitions;app.entries.find(file=>file.kind==='app').data[0]^=0xff;await assert.rejects(app.run());
});

test('an unknown board, unfinished job or missing trusted partition callbacks is refused',async()=>{
 const f=fixture();for(const extra of [{device:null},{device:{...f.device,chip:'ESP32'}},{job:{...f.job,status:'running'}},{job:{...f.job,id:'../other'}},{parsePartitions:undefined},{validateLocalPartitions:undefined}])await assert.rejects(loadLocalInstallSource({...f,...extra}));
});
