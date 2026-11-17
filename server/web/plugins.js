import {initServerModulesUI} from './server-modules.js';

const scopes=Object.freeze(['plugins.read','plugins.publish','plugins.bind']);
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
const ownUser=session=>session?.authenticated===true&&session.user?.role==='user';
const identity=session=>JSON.stringify([session?.authenticated,session?.generation,session?.user?.id,session?.user?.email,session?.user?.role]);
const disconnected=()=>({connected:false,account:null,scopes:[]});
const errors={
 session_changed:'account_session_changed',unauthorized:'account_not_connected',authentication_required:'account_not_connected',
 plugin_revision_conflict:'account_plugin_conflict',plugin_version_conflict:'account_plugin_conflict',plugin_binding_changed:'account_plugin_conflict',
 plugin_invalid_package:'account_plugin_invalid_package',plugin_sha_mismatch:'account_plugin_invalid_package',
 plugin_invalid_settings:'account_plugin_invalid_settings',plugin_invalid_binding:'account_invalid_input',plugin_invalid_input:'account_invalid_input',body_too_large:'package_too_large',
 plugin_not_found:'account_plugin_not_found',binding_not_found:'account_plugin_not_found',device_not_found:'account_plugin_not_found',plugin_revision_not_found:'account_plugin_not_found',
 plugin_runtime_unavailable:'account_plugin_runtime_unavailable',plugin_runtime_cleanup_failed:'account_plugin_runtime_unavailable',
 plugin_media_unavailable:'account_plugin_media_unavailable',plugin_media_cleanup_failed:'account_plugin_media_unavailable',
 plugin_busy:'account_busy',plugin_runtime_busy:'account_busy',plugin_media_busy:'account_busy',
 network_error:'account_network_error',request_timeout:'account_timeout',forbidden:'account_plugin_scope_required',
};
const safeCodes=new Set([...Object.values(errors),'account_plugins_unsupported','account_invalid_response','account_plugin_unavailable','account_plugin_scope_required','account_invalid_input']);
function publicError(error){
 const code=errors[error?.code]||(safeCodes.has(error?.code)?error.code:error?.status===401?'account_not_connected':error?.status===403?'account_plugin_scope_required':'account_plugin_unavailable');
 return fail(code,Number.isInteger(error?.status)?error.status:503);
}
function routeFor(path,method){
 if(method==='GET'&&path==='/api/account')return '/api/session';
 if(['GET','POST'].includes(method)&&path==='/api/account/plugins')return '/api/plugins';
 if(method==='GET'&&path==='/api/account/devices')return '/api/overview';
 if(typeof path!=='string')throw fail('account_invalid_input');
 const match=path.match(/^\/api\/account\/devices\/([A-Za-z0-9_-]{1,128})\/plugins(?:\/([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)(\/rollback)?)?$/);
 if(!match||match[2]?.length>64||!(method==='GET'&&!match[2]||method==='POST'&&match[2]))throw fail('account_invalid_input');
 return `/api/devices/${encodeURIComponent(match[1])}/plugins${match[2]?'/'+encodeURIComponent(match[2]):''}${match[3]||''}`;
}

// This adapter projects the connected component's contract onto cookie APIs.
// UI scopes control affordances only; the server authorizes every real request.
export function createPluginPanelApi({api,getSession}={}){
 if(typeof api!=='function'||typeof getSession!=='function')throw new TypeError('Plugin panel API is unavailable');
 return async function panelApi(path,options={}){
  const method=options.method??'GET',target=routeFor(path,method),session=getSession(),stamp=identity(session);
  if(path==='/api/account'&&!ownUser(session))return disconnected();
  if(!session?.authenticated)throw fail('account_not_connected',401);
  if(!ownUser(session))throw fail('account_plugin_scope_required',403);
  const account={id:session.user.id,email:session.user.email};
  try{
   const data=await api(target,options);
   if(stamp!==identity(getSession()))throw fail('account_session_changed',409);
   if(path==='/api/account'){
    if(!ownUser(data))return disconnected();
    if(data.user.id!==account.id||data.user.email!==account.email)throw fail('account_session_changed',409);
    return{connected:true,account:{id:data.user.id,email:data.user.email},scopes:[...scopes]};
   }
   if(path==='/api/account/devices'){
    if(!Array.isArray(data?.devices))throw fail('account_invalid_response',502);
    return{devices:data.devices};
   }
   if(path==='/api/account/plugins'&&method==='GET'){
    if(!Array.isArray(data?.plugins)||!data.capabilities?.runtime||!data.capabilities?.media)throw fail('account_invalid_response',502);
    return{...data,supported:true};
   }
   return data;
  }catch(error){
   if(stamp!==identity(getSession()))throw fail('account_session_changed',409);
   if(path==='/api/account/plugins'&&error?.status===404){
    if(method==='POST')throw fail('account_plugins_unsupported',404);
    return{supported:false,code:'account_plugins_unsupported',plugins:[]};
   }
   throw publicError(error);
  }
 };
}

export function createPluginPanel({api,getSession,mount,initUI=initServerModulesUI}={}){
 const panelApi=createPluginPanelApi({api,getSession});
 let widget=null,stamp=null;
 const destroy=()=>{widget?.destroy();widget=null;stamp=null;};
 return{
  sync(){
   const session=getSession();if(!ownUser(session)){destroy();return;}
   const next=identity(session);if(widget&&stamp===next)return;
   destroy();widget=initUI({api:panelApi,mount});stamp=next;
  },
  destroy,
 };
}
