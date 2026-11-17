import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createStudioAccount } from '../src/studio-account.mjs';

const CURRENT = ['pairing.claim','devices.list','voice.status','voice.activate','catalog.read','assistant.read','assistant.write'];
const PLUGINS = [...CURRENT,'plugins.read','plugins.publish','plugins.bind'];
const USER = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-17T00:00:00.000Z');
const TOKEN = 'kibi_studio_' + 't'.repeat(43);
const PACKAGE = JSON.stringify({format:'kibi-plugin',manifestVersion:2,id:'live-frame',version:'1.0.0',server:{language:'javascript',source:'export function onRequest() { return {}; }'}});
const SHA = createHash('sha256').update(PACKAGE).digest('hex');
const META = {id:'live-frame',version:'1.0.0',name:'Трансляция',description:'Кадры эфира',sha256:SHA,createdAt:'2026-11-17T00:00:00.000Z'};
const CAPS = {protocol:1,publish:true,bind:true,rollback:true,runtime:{configured:false,available:false},media:{configured:false,available:false}};
const BINDING = {pluginId:'live-frame',version:'1.0.0',revision:1,enabled:true,settings:{videoId:'4t4AQ15yj1M',fit:'contain'},updatedAt:'2026-11-17T00:00:00.000Z'};
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const errorCode = code => error => error.code === code;

async function fixture(t,{scopes=PLUGINS,respond=()=>json({})}={}) {
  const root=await mkdtemp(join(tmpdir(),'kibi-plugin-client-'));
  const calls=[];
  const account={id:USER,email:'fixture@example.test',role:'user'};
  const connection={id:CONNECTION,label:'Test Studio',createdAt:new Date(NOW).toISOString(),expiresAt:new Date(NOW+90*86400000).toISOString(),scopes};
  const client=await createStudioAccount({root,now:()=>NOW,fetchImpl:async(url,options)=>{
    const call={url,options,body:options.body===undefined?undefined:JSON.parse(options.body)};calls.push(call);
    if(url.endsWith('/redeem'))return json({token:TOKEN,account,connection,scopes,apiBase:'https://sldvkibi.ru/server/'});
    if(url.endsWith('/profile'))return json({account,connection,scopes,voice:{configured:false,enabled:false,status:'disabled'}});
    if(url.endsWith('/session'))return json({ok:true});
    return respond(call);
  }});
  t.after(async()=>{await client.close();await rm(root,{recursive:true,force:true});});
  const connect=()=>client.connect({code:'kibi_link_'+'c'.repeat(32),label:'Test Studio'});
  return {client,calls,connect};
}

test('new connections negotiate plugin rights while existing profile refresh remains valid',async t=>{
  const {client,calls,connect}=await fixture(t);
  const connected=await connect();
  assert.deepEqual(connected.scopes,PLUGINS);
  assert.equal(calls[0].options.headers['X-Kibi-Studio-Protocol'],'plugins-v1');
  assert.equal(JSON.stringify(connected).includes(TOKEN),false);
  assert.equal((await client.refresh()).verified,true);
});

test('disconnected plugin calls fail locally without claiming any server capability',async t=>{
  const {client,calls}=await fixture(t);
  await assert.rejects(()=>client.listPlugins(),errorCode('account_not_connected'));
  assert.equal(calls.length,0);
  assert.equal(client.publicInfo().status,'disconnected');
});

for(const scopes of [CURRENT.slice(0,5),CURRENT]) {
  test(`legacy ${scopes.length}-scope connection remains usable and reports missing plugin permission`,async t=>{
    const {client,calls,connect}=await fixture(t,{scopes});await connect();
    const result=await client.listPlugins();
    assert.equal(result.code,'account_plugin_scope_required');
    assert.equal(result.capabilities,null);
    assert.deepEqual(result.plugins,[]);
    assert.equal(calls.length,1);
    assert.equal((await client.refresh()).connected,true);
    await assert.rejects(()=>client.publishPlugin({packageText:PACKAGE,sha256:SHA}),errorCode('account_plugin_scope_required'));
  });
}

test('listing modules preserves real unavailable runtime and strips unrelated response data',async t=>{
  const {client,connect}=await fixture(t,{respond:()=>json({capabilities:CAPS,plugins:[META],secret:TOKEN})});await connect();
  const result=await client.listPlugins();
  assert.equal(result.supported,true);
  assert.deepEqual(result.capabilities,CAPS);
  assert.deepEqual(result.plugins,[META]);
  assert.equal(JSON.stringify(result).includes(TOKEN),false);
});

test('publishing sends only the bounded package and digest and returns metadata',async t=>{
  const {client,calls,connect}=await fixture(t,{respond:()=>json({plugin:META,packageText:PACKAGE,token:TOKEN})});await connect();
  assert.deepEqual(await client.publishPlugin({packageText:PACKAGE,sha256:SHA}),{plugin:META});
  const call=calls.at(-1);
  assert.equal(call.url,'https://sldvkibi.ru/server/api/studio/plugins');
  assert.equal(call.options.method,'POST');
  assert.deepEqual(call.body,{packageText:PACKAGE,sha256:SHA});
  assert.equal(call.options.headers.Authorization,`Bearer ${TOKEN}`);
});

test('bindings support disabling and explicit versioned rollback with revision checks',async t=>{
  const {client,calls,connect}=await fixture(t,{respond:call=>{
    if(call.options.method==='GET')return json({bindings:[BINDING]});
    return json({binding:{...BINDING,revision:call.body.expectedRevision+1,enabled:false}});
  }});await connect();
  assert.deepEqual(await client.devicePlugins({deviceId:DEVICE}),{bindings:[BINDING]});
  const input={deviceId:DEVICE,pluginId:'live-frame',version:'1.0.0',expectedRevision:1,enabled:false,settings:{videoId:'4t4AQ15yj1M',fit:'contain'}};
  assert.equal((await client.bindPlugin(input)).binding.enabled,false);
  assert.equal(calls.at(-1).url,`https://sldvkibi.ru/server/api/studio/devices/${DEVICE}/plugins/live-frame`);
  assert.deepEqual(calls.at(-1).body,{version:'1.0.0',expectedRevision:1,enabled:false,settings:input.settings});
  assert.equal((await client.rollbackPlugin({deviceId:DEVICE,pluginId:'live-frame',toRevision:1,expectedRevision:2})).binding.revision,3);
  assert.deepEqual(calls.at(-1).body,{toRevision:1,expectedRevision:2});
});

test('old server and rejected operations return fixed states without revoking the account',async t=>{
  let status=404;
  const {client,connect}=await fixture(t,{respond:()=>json({ok:false,code:'untrusted',message:TOKEN},status)});await connect();
  assert.equal((await client.listPlugins()).code,'account_plugins_unsupported');
  status=403;
  await assert.rejects(()=>client.bindPlugin({deviceId:DEVICE,pluginId:'live-frame',version:'1.0.0',expectedRevision:0,enabled:true,settings:{}}),errorCode('account_plugin_scope_required'));
  assert.equal(client.publicInfo().connected,true);
  status=409;
  await assert.rejects(()=>client.rollbackPlugin({deviceId:DEVICE,pluginId:'live-frame',toRevision:1,expectedRevision:2}),errorCode('account_plugin_conflict'));
  assert.equal(client.publicInfo().connected,true);
});

test('bad digests, byte limits and unsafe route/settings inputs never contact the server',async t=>{
  const {client,calls,connect}=await fixture(t);await connect();
  const attempts=[
    ()=>client.publishPlugin({packageText:PACKAGE,sha256:'a'.repeat(64)}),
    ()=>client.publishPlugin({packageText:'я'.repeat(65537),sha256:'a'.repeat(64)}),
    ()=>client.bindPlugin({deviceId:DEVICE,pluginId:'../foreign',version:'1.0.0',expectedRevision:0,enabled:true,settings:{}}),
    ()=>client.bindPlugin({deviceId:DEVICE,pluginId:'live-frame',version:'1.0.0',expectedRevision:-1,enabled:true,settings:{}}),
    ()=>client.bindPlugin({deviceId:DEVICE,pluginId:'live-frame',version:'1.0.0',expectedRevision:0,enabled:true,settings:{constructor:'unsafe'}}),
  ];
  for(const attempt of attempts)await assert.rejects(attempt,errorCode('account_invalid_input'));
  assert.equal(calls.length,1);
});

test('malformed metadata cannot relay source or credential data',async t=>{
  const {client,connect}=await fixture(t,{respond:()=>json({capabilities:CAPS,plugins:[{...META,source:PACKAGE,token:TOKEN}]})});await connect();
  await assert.rejects(()=>client.listPlugins(),error=>error.code==='account_invalid_response'&&!error.message.includes(TOKEN)&&!error.message.includes(PACKAGE));
});

test('a published package is accepted only when returned metadata matches its submitted digest',async t=>{
  const {client,connect}=await fixture(t,{respond:()=>json({plugin:{...META,sha256:'a'.repeat(64)}})});await connect();
  await assert.rejects(()=>client.publishPlugin({packageText:PACKAGE,sha256:SHA}),errorCode('account_invalid_response'));
});

test('disconnect rejects a late package response instead of attributing it to another account',async t=>{
  let started,release;
  const entering=new Promise(resolve=>{started=resolve;});
  const delayed=new Promise(resolve=>{release=resolve;});
  const {client,connect}=await fixture(t,{respond:async()=>{started();await delayed;return json({plugin:META});}});await connect();
  const pending=client.publishPlugin({packageText:PACKAGE,sha256:SHA});
  const assertion=assert.rejects(pending,errorCode('account_session_changed'));
  await entering;await client.disconnect();release();await assertion;
  assert.equal(client.publicInfo().connected,false);
});

test('an old HTML 404 is unsupported rather than a malformed account or leaked error',async t=>{
  const {client,connect}=await fixture(t,{respond:()=>new Response('<html>old server</html>',{status:404,headers:{'content-type':'text/html'}})});await connect();
  assert.equal((await client.listPlugins()).code,'account_plugins_unsupported');
  assert.equal(client.publicInfo().connected,true);
});

test('HTTP is allowed only for an explicit trusted localhost test configuration',async t=>{
  const root=await mkdtemp(join(tmpdir(),'kibi-plugin-localhost-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const apiBase of ['http://127.0.0.1:4399/server/','http://localhost:4399/server/']){
    await assert.rejects(()=>createStudioAccount({root,apiBase}),errorCode('account_invalid_input'));
    const client=await createStudioAccount({root,apiBase,allowLocalhostHttp:true,fetchImpl:()=>{throw new Error('unexpected network');}});
    assert.equal(client.publicInfo().apiBase,apiBase);await client.close();
  }
  for(const apiBase of ['http://example.test/server/','http://127.0.0.2/server/','http://localhost.example.test/server/','http://user:password@localhost/server/','http://localhost/server/?token=x','http://[::1]/server/'])await assert.rejects(()=>createStudioAccount({root,apiBase,allowLocalhostHttp:true}),errorCode('account_invalid_input'));
});


test('worker labels distinguish missing setup, unconfirmed availability and observed readiness',async()=>{
  const {workerAvailabilityLabel}=await import('../web/server-modules.js');
  assert.equal(workerAvailabilityLabel({configured:false,available:false}),'Не настроен');
  assert.equal(workerAvailabilityLabel({configured:true,available:false}),'Доступность не подтверждена');
  assert.equal(workerAvailabilityLabel({configured:true,available:true}),'Доступен');
});
