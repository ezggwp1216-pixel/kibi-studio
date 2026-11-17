import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const SCOPES=['pairing.claim','devices.list','voice.status','voice.activate','catalog.read','assistant.read','assistant.write','plugins.read','plugins.publish','plugins.bind'];
const DEVICE='33333333-3333-4333-8333-333333333333';
const NOW=Date.parse('2026-11-17T00:00:00.000Z');
const TOKEN='kibi_studio_'+'t'.repeat(43);
const PACKAGE='{"format":"kibi-plugin","manifestVersion":2,"id":"live-frame","version":"1.0.0"}';
const SHA=createHash('sha256').update(PACKAGE).digest('hex');
const META={id:'live-frame',version:'1.0.0',name:'Эфир',description:'Кадр',sha256:SHA,createdAt:new Date(NOW).toISOString()};
const CAPS={protocol:1,publish:true,bind:true,rollback:true,runtime:{configured:false,available:false},media:{configured:false,available:false}};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});

async function fixture(t,{beforeMutation=()=>{},respond}={}){
  const root=await mkdtemp(join(tmpdir(),'kibi-plugin-platform-')),src=join(root,'src');await mkdir(src);
  for(const name of ['studio-account.mjs','studio-plugins.mjs','studio-platform.mjs'])await copyFile(new URL('../src/'+name,import.meta.url),join(src,name));
  for(const name of ['attachment-assets.mjs','png-raster.mjs','managed-assets.mjs'])await copyFile(new URL('../../server/studio/'+name,import.meta.url),join(src,name));
  // Unrelated resource/firmware modules are distribution dependencies. The actual
  // account and platform implementation under test are copied unchanged above.
  await writeFile(join(src,'public-resources.mjs'),"export class PublicResourceError extends Error{}; export const SDK_HEADERS={}; export const PUBLIC_ASSET_RECIPES=[]; export const createPublicResourceService=()=>({});");
  await writeFile(join(src,'device-modules.mjs'),"export const createDeviceModuleService=()=>({status:async()=>({modules:[]})});");
  await writeFile(join(src,'portable-design-upgrade.mjs'),"export const PORTABLE_DESIGN_INSTRUCTIONS='';");
  const {createStudioPlatform,platformTools,platformInstructions}=await import(pathToFileURL(join(src,'studio-platform.mjs')));
  let epoch=1,announcements=0,mutations=0;const store={projectId:'fixture-project'},calls=[];
  const platform=await createStudioPlatform({root,getStore:()=>store,getEpoch:()=>epoch,announce:async()=>{announcements++;},mutate:async action=>{mutations++;beforeMutation(()=>{epoch++;});return action();},accountOptions:{now:()=>NOW,fetchImpl:async(url,options)=>{
    const body=options.body===undefined?undefined:JSON.parse(options.body);calls.push({url,options,body});
    if(url.endsWith('/redeem'))return json({token:TOKEN,apiBase:'https://sldvkibi.ru/server/',scopes:SCOPES,account:{id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.test',role:'user'},connection:{id:'22222222-2222-4222-8222-222222222222',label:'Studio',createdAt:new Date(NOW).toISOString(),expiresAt:new Date(NOW+90*86400000).toISOString(),scopes:SCOPES}});
    if(respond)return respond({url,options,body});
    if(url.endsWith('/plugins')&&options.method==='GET'&&!url.includes('/devices/'))return json({capabilities:CAPS,plugins:[META]});
    if(url.endsWith('/plugins')&&options.method==='POST')return json({plugin:META});
    if(url.endsWith('/plugins')&&options.method==='GET')return json({bindings:[]});
    return json({binding:{pluginId:'live-frame',version:'1.0.0',revision:body.expectedRevision+1,enabled:body.enabled??false,settings:body.settings??{},updatedAt:new Date(NOW).toISOString()}});
  }}});
  t.after(async()=>{await platform.close();await rm(root,{recursive:true,force:true});});
  async function route(path,method='GET',input){let output;const handled=await platform.route({method},{},{route:path,body:async()=>input,send:(_response,value)=>{output=value;}});return {handled,output};}
  await route('/api/account/connect','POST',{code:'kibi_link_'+'c'.repeat(32),label:'Studio'});
  return {platform,platformTools,platformInstructions,calls,route,changeProject:()=>{epoch++;},counts:()=>({announcements,mutations})};
}

test('named module tools publish metadata and guard assignment without affecting source tools',async t=>{
  const f=await fixture(t);
  for(const name of ['kibi_server_modules','kibi_publish_server_module','kibi_device_modules','kibi_bind_server_module','kibi_rollback_server_module'])assert.ok(f.platformTools.some(tool=>tool.name===name),name);
  const list=await f.platform.tool('kibi_server_modules',{});assert.equal(list.result.capabilities.runtime.available,false);
  const published=await f.platform.tool('kibi_publish_server_module',{packageText:PACKAGE});assert.deepEqual(published,{handled:true,result:{plugin:META}});
  const assigned=await f.platform.tool('kibi_bind_server_module',{deviceId:DEVICE,pluginId:'live-frame',version:'1.0.0',expectedRevision:0,enabled:true,settings:{}});assert.equal(assigned.result.binding.enabled,true);
  const rolled=await f.platform.tool('kibi_rollback_server_module',{deviceId:DEVICE,pluginId:'live-frame',toRevision:1,expectedRevision:1});assert.equal(rolled.result.binding.revision,2);
  assert.deepEqual((await f.platform.tool('kibi_device_modules',{deviceId:DEVICE})).result,{bindings:[]});
  assert.deepEqual(f.counts(),{announcements:3,mutations:3});
  assert.equal(JSON.stringify(published).includes(TOKEN),false);
  assert.equal(JSON.stringify(published).includes(PACKAGE),false);
});

test('browser account module routes use exact payloads and guarded mutations',async t=>{
  const f=await fixture(t);
  assert.equal((await f.route('/api/account/plugins')).output.supported,true);
  assert.deepEqual((await f.route('/api/account/plugins','POST',{packageText:PACKAGE,sha256:SHA})).output,{plugin:META});
  assert.deepEqual((await f.route(`/api/account/devices/${DEVICE}/plugins`)).output,{bindings:[]});
  const path=`/api/account/devices/${DEVICE}/plugins/live-frame`;
  assert.equal((await f.route(path,'POST',{version:'1.0.0',expectedRevision:0,enabled:false,settings:{}})).output.binding.enabled,false);
  assert.equal((await f.route(path+'/rollback','POST',{toRevision:1,expectedRevision:1})).output.binding.revision,2);
  assert.deepEqual(f.counts(),{announcements:3,mutations:3});
  await assert.rejects(()=>f.route(path,'POST',{version:'1.0.0',expectedRevision:0,enabled:true,settings:{},deviceId:'foreign'}),error=>error.code==='account_invalid_input');
});

test('changing projects before mutation prevents publishing or binding',async t=>{
  const f=await fixture(t,{beforeMutation:change=>change()});
  await assert.rejects(()=>f.platform.tool('kibi_publish_server_module',{packageText:PACKAGE}),error=>error.status===409);
  assert.equal(f.calls.length,1);
  await assert.rejects(()=>f.route(`/api/account/devices/${DEVICE}/plugins/live-frame`,'POST',{version:'1.0.0',expectedRevision:0,enabled:true,settings:{}}),error=>error.status===409);
  assert.equal(f.calls.length,1);
});

test('tool permission failures retain fixed actionable states and no upstream text',async t=>{
  const f=await fixture(t,{respond:()=>json({ok:false,code:'studio_scope_denied',detail:TOKEN,source:PACKAGE},403)});
  const result=await f.platform.tool('kibi_bind_server_module',{deviceId:DEVICE,pluginId:'live-frame',version:'1.0.0',expectedRevision:0,enabled:true,settings:{}});
  assert.equal(result.result.code,'account_plugin_scope_required');
  assert.equal(JSON.stringify(result).includes(TOKEN),false);
  assert.equal(JSON.stringify(result).includes(PACKAGE),false);
});


test('publish tool accepts only package text and sends the host-computed UTF-8 digest',async t=>{
  const packageText='{"format":"kibi-plugin","manifestVersion":2,"id":"live-frame","version":"1.0.0","name":"\u041a\u0430\u0434\u0440 \ud83c\udfa5"}';
  const expectedDigest='51693718e0caf2a0e7852f43fbe0bf7a736c7148cd8fd1d676d999e75eeef67e';
  const metadata={...META,sha256:expectedDigest};
  const f=await fixture(t,{respond:()=>json({plugin:metadata})});
  const result=await f.platform.tool('kibi_publish_server_module',{packageText});
  assert.deepEqual(result,{handled:true,result:{plugin:metadata}});
  const call=f.calls.at(-1);
  assert.equal(call.url,'https://sldvkibi.ru/server/api/studio/plugins');
  assert.equal(call.options.method,'POST');
  assert.deepEqual(call.body,{packageText,sha256:expectedDigest});
  const contract=f.platformTools.find(tool=>tool.name==='kibi_publish_server_module').inputSchema;
  assert.deepEqual(contract.required,['packageText']);assert.deepEqual(Object.keys(contract.properties),['packageText']);
  assert.deepEqual(f.counts(),{announcements:1,mutations:1});
});

for(const sha256 of [SHA,'f'.repeat(64)])test('publish tool rejects caller-supplied digest instead of silently ignoring it: '+sha256.slice(0,8),async t=>{
  const f=await fixture(t);
  const result=await f.platform.tool('kibi_publish_server_module',{packageText:PACKAGE,sha256});
  assert.equal(result.result.code,'account_invalid_input');assert.equal(f.calls.length,1);
});


test('effective host instructions explain the executable package and device lifecycle without replacing user prompts',async t=>{
  const f=await fixture(t),text=f.platformInstructions;
  for(const required of ['manifestVersion:2','sdkVersion:"1.1"','secrets:[]','onDeviceRequest(input, context)','context.settings','POST /api/device/plugins/:pluginId/invoke','Authorization: Bearer','{input}','142080','X-Content-SHA256','plugin_disabled','plugin_runtime_unavailable','expectedRevision','toRevision','last 16','settings are public','not scheduled'])assert.ok(text.includes(required),required);
  assert.match(text,/older.*planned.*superseded/i);
  assert.match(text,/request-handler.*onDeviceRequest/);
  assert.match(text,/event-handler.*onDeviceEvent/);
  assert.match(text,/message-handler.*onDeviceMessage/);
});

test('a connected supported server reports real unavailable workers through tools and routes',async t=>{
  const f=await fixture(t),tool=await f.platform.tool('kibi_server_modules',{}),route=await f.route('/api/account/plugins');
  assert.equal(tool.result.supported,true);assert.deepEqual(tool.result.capabilities,CAPS);
  assert.deepEqual(route.output.capabilities,CAPS);assert.equal(f.calls.length,3);
  assert.equal(f.counts().mutations,0);
});


test('the server-modules guide is available offline with exact device instructions and public reference links',async t=>{
  const f=await fixture(t),contract=f.platformTools.find(tool=>tool.name==='kibi_server_guide');
  assert.ok(contract.inputSchema.properties.topic.enum.includes('server-modules'));
  const result=await f.platform.tool('kibi_server_guide',{topic:'server-modules'});
  assert.equal(result.result.topic,'server-modules');assert.equal(result.result.credentials,false);
  assert.ok(result.result.text.length<16000);assert.match(result.result.text,/manifestVersion:2/);
  assert.match(result.result.text,/https:\/\/sldvkibi\.ru\/server\/docs\/SERVER_MODULES\.md/);
  assert.match(result.result.text,/YOUTUBE_MODULE\.md/);
  assert.equal(f.calls.length,1);
});
