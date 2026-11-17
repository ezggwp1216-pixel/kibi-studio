import test from 'node:test';
import assert from 'node:assert/strict';
const loaded=await import('../web/plugins.js').catch(()=>({}));
function adapter(options){assert.equal(typeof loaded.createPluginPanelApi,'function','panel API adapter is implemented');return loaded.createPluginPanelApi(options);}
const session=()=>({authenticated:true,generation:1,user:{id:'account-a',email:'a@example.test',role:'user'}});
const catalog={ok:true,plugins:[{id:'test.video',version:'1.0.0'}],capabilities:{publish:true,bind:true,rollback:true,runtime:{configured:true,available:false},media:{configured:false,available:false}}};
const fail=(code,status=403)=>Object.assign(new Error('private diagnostic'),{code,status});

test('panel account status exposes only this user and UI scopes, never CSRF or credentials',async()=>{
 const calls=[],user=session();
 const api=adapter({getSession:()=>user,api:async(path,options)=>{calls.push({path,options});return{...user,csrfToken:'private',studioLink:{code:'private'},user:{...user.user,passwordHash:'private'}};}});
 assert.deepEqual(await api('/api/account'),{connected:true,account:{id:'account-a',email:'a@example.test'},scopes:['plugins.read','plugins.publish','plugins.bind']});assert.deepEqual(calls.map(call=>call.path),['/api/session']);
});

test('only catalog, own devices, bindings and rollback map through the existing API helper',async()=>{
 const calls=[],controller=new AbortController(),api=adapter({getSession:session,api:async(path,options)=>{calls.push({path,options});if(path==='/api/plugins'&&(!options?.method||options.method==='GET'))return catalog;if(path==='/api/overview')return{devices:[{id:'device_1',name:'Own'}],events:[{secret:'omit'}],server:{private:'omit'}};return{binding:{revision:2},plugin:{id:'test.video'}};}});
 assert.deepEqual(await api('/api/account/plugins'),{...catalog,supported:true});assert.deepEqual(await api('/api/account/devices'),{devices:[{id:'device_1',name:'Own'}]});
 const publish={method:'POST',body:{packageText:'{}',sha256:'abc'},signal:controller.signal};await api('/api/account/plugins',publish);await api('/api/account/devices/device_1/plugins');
 const binding={method:'POST',body:{version:'1.0.0',expectedRevision:1,enabled:false,settings:{}},signal:controller.signal};await api('/api/account/devices/device_1/plugins/test.video',binding);await api('/api/account/devices/device_1/plugins/test.video/rollback',{method:'POST',body:{toRevision:1,expectedRevision:2}});
 assert.deepEqual(calls.map(call=>call.path),['/api/plugins','/api/overview','/api/plugins','/api/devices/device_1/plugins','/api/devices/device_1/plugins/test.video','/api/devices/device_1/plugins/test.video/rollback']);assert.deepEqual(calls[2].options,publish);assert.deepEqual(calls[4].options,binding);
});

test('signed-out and owner sessions cannot dispatch plugin requests or receive plugin scopes',async()=>{
 for(const user of [{authenticated:false,generation:1,user:null},{authenticated:true,generation:1,user:{id:'owner',role:'owner'}}]){let calls=0;const api=adapter({getSession:()=>user,api:async()=>{calls++;return catalog;}});const own=await api('/api/account');assert.equal(own.connected,false);assert.deepEqual(own.scopes,[]);await assert.rejects(api('/api/account/plugins'),{code:user.authenticated?'account_plugin_scope_required':'account_not_connected'});assert.equal(calls,0);}
});

test('foreign URLs, traversal, arbitrary methods and unsupported routes never dispatch',async()=>{
 let calls=0;const api=adapter({getSession:session,api:async()=>{calls++;return catalog;}});
 for(const [path,method] of [['https://evil.example/api/account/plugins','GET'],['//evil.example/api/account/plugins','GET'],['/api/account/plugins?owner=other','GET'],['/api/account/devices/../plugins','GET'],['/api/account/devices/%2e%2e/plugins','GET'],['/api/account/devices/a%2fb/plugins','GET'],['/api/account/devices/own/plugins/test.video/invoke','POST'],['/api/account/devices/own/plugins/../rollback','POST'],['/api/account/devices/own/plugins/test.video','DELETE'],['/api/account/devices','POST'],['/api/account/settings','GET'],['/api/account','POST'],['/api/account/plugins/','GET']])await assert.rejects(api(path,{method}),{code:'account_invalid_input'});assert.equal(calls,0);
});

test('older servers report unsupported catalog and denials never fall back',async()=>{
 let calls=0;const api=adapter({getSession:session,api:async()=>{calls++;throw fail('not_found',404);}});const result=await api('/api/account/plugins');assert.equal(result.supported,false);assert.equal(result.code,'account_plugins_unsupported');assert.deepEqual(result.plugins,[]);await assert.rejects(api('/api/account/plugins',{method:'POST',body:{}}),{code:'account_plugins_unsupported'});assert.equal(calls,2);
 const denied=adapter({getSession:session,api:async()=>{throw fail('forbidden');}});await assert.rejects(denied('/api/account/plugins'),{code:'account_plugin_scope_required'});
});

test('server errors become fixed UI states without exposing diagnostics',async()=>{
 for(const [source,expected] of [['plugin_revision_conflict','account_plugin_conflict'],['plugin_sha_mismatch','account_plugin_invalid_package'],['plugin_invalid_settings','account_plugin_invalid_settings'],['plugin_runtime_cleanup_failed','account_plugin_runtime_unavailable'],['plugin_media_unavailable','account_plugin_media_unavailable'],['device_not_found','account_plugin_not_found'],['network_error','account_network_error'],['session_changed','account_session_changed']]){const api=adapter({getSession:session,api:async()=>{throw fail(source);}});await assert.rejects(api('/api/account/plugins',{method:'POST',body:{}}),error=>error.code===expected&&!error.message.includes('private'));}
});

test('late responses and changed server account never show another user data',async()=>{
 let user=session(),release;const api=adapter({getSession:()=>user,api:async()=>new Promise(resolve=>release=resolve)});const pending=api('/api/account/plugins');user={...session(),generation:2,user:{...session().user,id:'account-b',email:'b@example.test'}};release(catalog);await assert.rejects(pending,{code:'account_session_changed'});
 const mismatched=adapter({getSession:session,api:async()=>({...session(),user:{...session().user,id:'account-b',email:'b@example.test'}})});await assert.rejects(mismatched('/api/account'),{code:'account_session_changed'});
});

test('widget lifecycle destroys old accounts and mount never starts API requests',()=>{
 assert.equal(typeof loaded.createPluginPanel,'function','panel lifecycle is implemented');let user=session(),created=0,destroyed=0,calls=0;const mount={},panel=loaded.createPluginPanel({mount,getSession:()=>user,api:async()=>{calls++;},initUI:options=>{assert.equal(options.mount,mount);created++;return{destroy(){destroyed++;}};}});
 panel.sync();panel.sync();assert.equal(created,1);assert.equal(calls,0);user={...user,generation:2};panel.sync();assert.equal(created,2);assert.equal(destroyed,1);user={authenticated:false,generation:3,user:null};panel.sync();assert.equal(destroyed,2);panel.destroy();assert.equal(destroyed,2);user=session();panel.sync();panel.destroy();assert.equal(created,3);assert.equal(destroyed,3);assert.equal(calls,0);
});
