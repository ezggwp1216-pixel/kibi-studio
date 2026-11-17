import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FRESH_UI_BASELINES,upgradeFreshUiProgram} from './fresh-ui-upgrade.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const root=process.env.KIBI_PUBLIC_FRESH_STUDIO_ROOT;
const state=()=>({project:{id:'project-new',requirements:{wifi:false,api:false}},revision:2,sourceHash:'a'.repeat(64),configuration:{revision:0},projectEpoch:1,csrfToken:'test-token',implementationRequested:true,workflow:{canBuild:true},chat:{busy:false}});
function fixture(){
 const kinds={bootloader:['bootloader.bin',0],partitions:['partitions.bin',0x8000],otadata:['boot_app0.bin',0xe000],app:['app.bin',0x10000]};
 const entries=Object.entries(kinds).map(([kind,[name,offset]],index)=>{const data=new Uint8Array(kind==='otadata'?0x2000:32).fill(index+1);return{kind,name,offset,data,size:data.length,sha256:digest(data),url:`/api/configurator/jobs/job-new/files/${name}`};});
 const current=state();current.build={id:'job-new',projectId:current.project.id,status:'succeeded',sourceRevision:current.revision,sourceHash:current.sourceHash,configurationRevision:current.configuration.revision,artifacts:entries.map(({data,...file})=>({...file}))};
 const partitions=[{type:1,subtype:0,offset:0xe000,size:0x2000},{type:0,subtype:0x10,offset:0x10000,size:0x200000},{type:0,subtype:0x11,offset:0x210000,size:0x200000}];
 const manifest={boardId:'kibi-ds02-s3-16m',chip:'ESP32-S3',chipId:9,flashBytes:16777216,maxAppBytes:2097152,mode:'full',version:current.build.id,files:entries.map(({data,...file})=>({...file}))};
 const calls=[];
 const fetcher=async url=>{calls.push(url);if(url==='/api/configurator/jobs/job-new/manifest')return{ok:true,status:200,redirected:false,json:async()=>structuredClone(manifest)};const row=entries.find(f=>f.url===url)||entries.find(f=>url==='/api/build/job-new/app.bin'&&f.kind==='app');assert.ok(row,'unexpected download');return{ok:true,status:200,redirected:false,arrayBuffer:async()=>row.data.slice().buffer};};
 const flasherApi={async loadApplication(file){const data=new Uint8Array(await file.arrayBuffer());return{mode:'app',files:[{kind:'app',name:'app.bin',data,size:data.length,sha256:digest(data)}]};},async loadManifest(url,fetcher){const result=await(await fetcher(url)).json();return{...result,files:await Promise.all(result.files.map(async row=>({...row,data:new Uint8Array(await(await fetcher(row.url)).arrayBuffer())})))};}};
 const parsePartitions=data=>{assert.equal(data[0],2);return{partitions,app:partitions[1],otadata:partitions[0]};};
 const validateLocalPartitions=value=>{assert.deepEqual(value.partitions,partitions);return value;};
 return{current,entries,partitions,manifest,calls,fetcher,flasherApi,parsePartitions,validateLocalPartitions};
}
let uiPromise;
let settingsPromise;
async function ui(){
 if(!uiPromise)uiPromise=(async()=>{
  const bytes=await readFile(join(root,'web/app.js'));
  const code=upgradeFreshUiProgram('web/app.js',bytes).toString()
   .replace("import {initStudioAccountUI} from './studio-account.js';",'const initStudioAccountUI=()=>{};')
   .replace("import {loadLocalInstallSource} from './local-install-source.js';",`import {loadLocalInstallSource} from ${JSON.stringify(new URL('./local-install-source.mjs',import.meta.url).href)};`)
   .replace("import {parsePartitions,validateLocalPartitions} from './vendor/flash-core.js';",'const parsePartitions=()=>{};const validateLocalPartitions=()=>{};');
  return import('data:text/javascript;base64,'+Buffer.from(code+'\n//# sourceURL=kibi-fresh-public-ui.mjs\n').toString('base64'));
 })();
 return uiPromise;
}
async function settings(){
 if(!settingsPromise)settingsPromise=(async()=>{
  const bytes=await readFile(join(root,'web/settings.js'));
  const code=upgradeFreshUiProgram('web/settings.js',bytes).toString();
  return import('data:text/javascript;base64,'+Buffer.from(code+'\n//# sourceURL=kibi-fresh-public-settings.mjs\n').toString('base64'));
 })();
 return settingsPromise;
}

test('fresh UI migration rejects unknown files and malformed input before transformations',()=>{
 assert.throws(()=>upgradeFreshUiProgram('web/other.js',Buffer.from('x')),{code:'upgrade_unknown_baseline'});
 assert.throws(()=>upgradeFreshUiProgram('web/app.js',Buffer.from('x')),{code:'upgrade_unknown_baseline'});
 assert.throws(()=>upgradeFreshUiProgram('web/app.js',Buffer.from([255])),{code:'upgrade_unknown_baseline'});
});

test('exact shipped public browser files become an idempotent account/build/install UI',{skip:!root},async()=>{
 for(const path of ['web/app.js','web/index.html','web/settings.js','web/settings.css']){
  const source=await readFile(join(root,path));assert.equal(digest(source),FRESH_UI_BASELINES[path].beforeSha256);
  const final=upgradeFreshUiProgram(path,source);assert.equal(digest(final),FRESH_UI_BASELINES[path].afterSha256);assert.deepEqual(upgradeFreshUiProgram(path,final),final);
  for(const bytes of [source,final])assert.throws(()=>upgradeFreshUiProgram(path,Buffer.concat([bytes,Buffer.from('\n// unreviewed edit\n')])),{code:'upgrade_unknown_baseline'});
 }
 const code=upgradeFreshUiProgram('web/app.js',await readFile(join(root,'web/app.js'))).toString();
 const html=upgradeFreshUiProgram('web/index.html',await readFile(join(root,'web/index.html'))).toString();
 assert.match(code,/initStudioAccountUI\(\{api,mount:document\.querySelector\('\.header-utilities'\)\}\)/);
 assert.match(html,/studio-account\.css/);assert.match(html,/id="build-ready"[^>]*hidden/);
 assert.match(code,/prepareCurrentInstall\(/);assert.match(code,/gate\.take\(latest\)/);assert.match(code,/runtime\.flasher\.write\(plan\)/);
 assert.ok(!code.includes("onPhase('approve')"));
});

test('fresh Settings has a genuine basic/speaker selector rather than a cosmetic board label',{skip:!root},async()=>{
 const code=upgradeFreshUiProgram('web/settings.js',await readFile(join(root,'web/settings.js'))).toString();
 assert.match(code,/data-settings-tab="device"/);assert.match(code,/id="settings-device-form"/);
 assert.match(code,/name="variant"/);assert.match(code,/value="basic"/);assert.match(code,/value="speaker"/);
 assert.match(code,/saveDeviceVariant\(/);assert.match(code,/studio:state/);
 const m=await settings();assert.deepEqual(m.deviceVariantView({}),{saved:'basic',value:'basic',label:'Киби без динамика',dirty:false});
 assert.deepEqual(m.deviceVariantView({deviceVariant:'speaker'}),{saved:'speaker',value:'speaker',label:'Киби с динамиком',dirty:false});
 assert.deepEqual(m.deviceVariantView({deviceVariant:'speaker'},'basic'),{saved:'speaker',value:'basic',label:'Киби с динамиком',dirty:true});
 assert.equal(m.deviceVariantView({deviceVariant:'unknown'}).saved,'basic');
 assert.equal(m.deviceVariantView(null).saved,'basic');
});

test('variant save is scoped to the current project, confirmed by refreshed state and invalidates prepared USB',{skip:!root},async()=>{
 const m=await settings(),calls=[];let current='project-a';
 const scope=m.createSettingsProjectScope({getProjectId:()=>current});scope.open();const operation=scope.capture();
 const result=await m.saveDeviceVariant({variant:'speaker',operation,scope,api:async(path,input)=>{calls.push({path,input});return{};},invalidateFlash:text=>calls.push({invalidate:text}),refresh:async()=>{calls.push({refresh:true});return{configuration:{deviceVariant:'speaker'}};}});
 assert.deepEqual(calls[0],{path:'/api/device/variant',input:{method:'POST',body:{variant:'speaker'}}});
 assert.equal(calls.length,3);assert.match(calls[1].invalidate,/Вариант Киби изменён/);assert.equal(calls[2].refresh,true);assert.deepEqual(result,{applied:true,variant:'speaker'});
 current='project-b';await assert.rejects(m.saveDeviceVariant({variant:'basic',operation,scope,api:async()=>assert.fail('stale dispatch'),invalidateFlash:()=>{},refresh:async()=>{}}),/Проект изменился/);
});

test('late variant replies cannot clear or refresh the newly selected project',{skip:!root},async()=>{
 const m=await settings();let current='project-a',resolveRequest;const scope=m.createSettingsProjectScope({getProjectId:()=>current});scope.open();const operation=scope.capture(),effects=[];
 const pending=m.saveDeviceVariant({variant:'speaker',operation,scope,api:()=>new Promise(resolve=>{resolveRequest=resolve;}),invalidateFlash:()=>effects.push('invalidate'),refresh:async()=>{effects.push('refresh');return{configuration:{deviceVariant:'speaker'}};}});
 current='project-b';scope.update(current);resolveRequest({});assert.deepEqual(await pending,{applied:false,stale:true});assert.deepEqual(effects,[]);
 scope.open();const next=scope.capture();const duringRefresh=await m.saveDeviceVariant({variant:'basic',operation:next,scope,api:async()=>({}),invalidateFlash:()=>effects.push('invalidate'),refresh:async()=>{current='project-c';scope.update(current);return{configuration:{deviceVariant:'basic'}};}});
 assert.deepEqual(duringRefresh,{applied:false,stale:true});assert.deepEqual(effects,['invalidate']);
});

test('invalid variants and unconfirmed server state are not reported as saved',{skip:!root},async()=>{
 const m=await settings(),scope=m.createSettingsProjectScope({getProjectId:()=> 'project-a'});scope.open();const operation=scope.capture();
 const input={operation,scope,api:async()=>({}),invalidateFlash:()=>{},refresh:async()=>({configuration:{deviceVariant:'basic'}})};
 for(const variant of ['unknown','',1,null,{toString:()=> 'speaker'}])await assert.rejects(m.saveDeviceVariant({...input,variant,api:async()=>assert.fail('invalid variant dispatched')}),/Выберите вариант/);
 await assert.rejects(m.saveDeviceVariant({...input,variant:'speaker'}),/подтвердить/);
});

test('Project ready requests implementation while build never silently approves a design',{skip:!root},async()=>{
 const m=await ui(),current=state(),calls=[],api=async(path,input)=>{calls.push({path,input});return path==='/api/check'?{passed:true,readiness:{passed:true}}:{id:'job-new'};};
 await m.requestProjectCode({getState:()=>current,api,refresh:async()=>{},send:async text=>calls.push({text})});
 assert.equal(calls[0].path,'/api/project/ready');assert.equal(calls[1].text,m.PROJECT_READY_TEXT);
 calls.length=0;await m.buildCurrentProject({getState:()=>current,api,refresh:async()=>{}});assert.deepEqual(calls.map(x=>x.path),['/api/check','/api/build']);
 current.implementationRequested=false;calls.length=0;await assert.rejects(m.buildCurrentProject({getState:()=>current,api,refresh:async()=>{}}),/Проект готов/);assert.equal(calls.length,0);
 current.implementationRequested=true;calls.length=0;await assert.rejects(m.buildCurrentProject({getState:()=>current,api:async path=>{calls.push(path);return{passed:true,readiness:{passed:false}};},refresh:async()=>{}}));assert.deepEqual(calls,['/api/check']);
});

test('build controls require current server readiness and downloads require exact source/configuration identity',{skip:!root},async()=>{
 const m=await ui(),f=fixture();assert.equal(m.projectWorkflowView(f.current).canBuild,true);assert.equal(m.currentBuildStatus(f.current).ready,true);
 for(const change of [s=>{s.workflow.canBuild=false;},s=>{s.implementationRequested=false;}]){const value=structuredClone(f.current);change(value);assert.equal(m.projectWorkflowView(value).canBuild,false);}
 const building=structuredClone(f.current);building.workflow.canBuild=false;building.build.status='building';const view=m.projectWorkflowView(building);assert.equal(view.showAction,true);assert.equal(view.action,'status');assert.match(view.label,/Собираем/);
 for(const change of [s=>{s.sourceHash='b'.repeat(64);},s=>{s.revision++;},s=>{s.configuration.revision++;},s=>{delete s.build.configurationRevision;},s=>{s.build.projectId='other';},s=>{s.build.status='completed';},s=>{s.build.artifacts.push({...s.build.artifacts.find(x=>x.name==='app.bin')});}]){const value=structuredClone(f.current);change(value);assert.equal(m.currentBuildStatus(value).ready,false);}
});

test('a successful current frame clears only the pending project hint and preserves gesture outcomes',{skip:!root},async()=>{
 const m=await ui(),pending='Открыт другой проект · ожидаем его нативный экран',proof={sourceHash:'a'.repeat(64),expectedSourceHash:'a'.repeat(64),previewError:false};
 assert.equal(m.frameInputFeedback(pending,proof),'Коснитесь экрана или проведите по нему');
 for(const text of ['Касание · Следующий экран','Кнопка + · Предыдущий экран','Состояние макета сброшено после изменения кода'])assert.equal(m.frameInputFeedback(text,proof),text);
 for(const options of [{...proof,previewError:true},{...proof,sourceHash:'b'.repeat(64)},{...proof,sourceHash:''}])assert.equal(m.frameInputFeedback(pending,options),pending);
 const code=upgradeFreshUiProgram('web/app.js',await readFile(join(root,'web/app.js'))).toString();assert.match(code,/frameInputFeedback\(\$\('#input-feedback'\)\.textContent/);
});

test('factory preparation validates the current four-file bundle without authorizing a write',{skip:!root},async()=>{
 const m=await ui(),f=fixture(),approval=new m.FlashApproval(),writes=[],device={chip:'ESP32-S3',flashBytes:16777216,partitions:[]};
 const flasher={async prepare(source){return{...source};},async write(plan){writes.push(plan);}};
 const prepared=await m.prepareCurrentInstall({refresh:async()=>f.current,device,flasherApi:f.flasherApi,flasher,fetcher:f.fetcher,parsePartitions:f.parsePartitions,validateLocalPartitions:f.validateLocalPartitions,approval});
 assert.equal(prepared.plan.mode,'full');assert.equal(prepared.plan.files.length,4);assert.equal(writes.length,0);assert.equal(approval.approved,false);assert.throws(()=>approval.take(f.current),/Подтвердите/);
 approval.approve(f.current);assert.equal(approval.take(f.current),prepared.plan);assert.throws(()=>approval.take(f.current),/Подготовьте/);
});

test('native preparation keeps app-only and stale identities never retain approval',{skip:!root},async()=>{
 const m=await ui(),f=fixture(),approval=new m.FlashApproval(),device={chip:'ESP32-S3',flashBytes:16777216,partitions:f.partitions};
 const options={refresh:async()=>f.current,device,flasherApi:f.flasherApi,flasher:{async prepare(source){return source;}},fetcher:f.fetcher,parsePartitions:f.parsePartitions,validateLocalPartitions:f.validateLocalPartitions,approval};
 const prepared=await m.prepareCurrentInstall(options);assert.equal(prepared.plan.mode,'app');assert.deepEqual(f.calls,['/api/build/job-new/app.bin']);approval.approve(f.current);
 f.current.projectEpoch++;assert.equal(approval.valid(f.current),false);assert.throws(()=>approval.take(f.current),/изменилось/);
 const stale=fixture();let refreshes=0;await assert.rejects(m.prepareCurrentInstall({...options,approval:new m.FlashApproval(),fetcher:stale.fetcher,flasherApi:stale.flasherApi,refresh:async()=>{refreshes++;if(refreshes===2)stale.current.configuration.revision++;return stale.current;}}),/изменился/);
});

test('corrupt and stale factory metadata cannot produce a prepared plan',{skip:!root},async()=>{
 const m=await ui();
 for(const change of [f=>{f.manifest.version='old-job';},f=>{f.manifest.files[0].sha256='0'.repeat(64);},f=>{f.entries.find(x=>x.kind==='app').data[0]^=1;}]){
  const f=fixture();change(f);let prepared=0;const approval=new m.FlashApproval();
  await assert.rejects(m.prepareCurrentInstall({refresh:async()=>f.current,device:{chip:'ESP32-S3',flashBytes:16777216,partitions:[]},flasherApi:f.flasherApi,flasher:{async prepare(source){prepared++;return source;}},fetcher:f.fetcher,parsePartitions:f.parsePartitions,validateLocalPartitions:f.validateLocalPartitions,approval}));
  assert.equal(prepared,0);assert.equal(approval.approved,false);assert.equal(approval.plan,null);
 }
});
