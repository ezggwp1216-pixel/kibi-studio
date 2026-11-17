import { createHash } from 'node:crypto';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const pluginId=value=>typeof value==='string'&&value.length<=64&&/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value);
const version=value=>typeof value==='string'&&value.length<=64&&/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(value);
const deviceId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const revision=value=>Number.isSafeInteger(value)&&value>=0;
const safeText=(value,max,empty=false)=>typeof value==='string'&&value.length<=(max)&& (empty||value.length>0)&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)&&!/kibi_(?:studio_[A-Za-z0-9_-]{43}|link_[A-Za-z0-9_-]{32})/.test(value);
const timestamp=value=>typeof value==='string'&&value.length===24&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const settings=value=>object(value)&&Object.keys(value).length<=16&&Object.entries(value).every(([key,item])=>/^[a-z][A-Za-z0-9_]{0,47}$/.test(key)&&!['constructor','prototype','__proto__'].includes(key)&&(typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item)||safeText(item,2000,true)));
const metadataKeys=new Set(['id','version','name','description','sha256','createdAt','manifestVersion','sdkVersion','capabilities','permissions','settings']);

// This projection deliberately never returns package source or arbitrary server errors.
export function createStudioPluginClient({authorized,requireConnection,fail}) {
  const invalid=()=>{throw fail('account_invalid_response');};
  function metadata(value){
    if(!object(value)||Object.keys(value).some(key=>!metadataKeys.has(key))||!pluginId(value.id)||!version(value.version)||!safeText(value.name,80)||!safeText(value.description,1000,true)||!digest(value.sha256)||!timestamp(value.createdAt))invalid();
    return {id:value.id,version:value.version,name:value.name,description:value.description,sha256:value.sha256,createdAt:value.createdAt};
  }
  function capabilities(value){
    if(!exact(value,['protocol','publish','bind','rollback','runtime','media'])||value.protocol!==1||!['publish','bind','rollback'].every(key=>typeof value[key]==='boolean'))invalid();
    for(const key of ['runtime','media'])if(!exact(value[key],['configured','available'])||typeof value[key].configured!=='boolean'||typeof value[key].available!=='boolean')invalid();
    return {protocol:1,publish:value.publish,bind:value.bind,rollback:value.rollback,runtime:{...value.runtime},media:{...value.media}};
  }
  function binding(value){
    if(!exact(value,['pluginId','version','revision','enabled','settings','updatedAt'])||!pluginId(value.pluginId)||!version(value.version)||!revision(value.revision)||value.revision<1||typeof value.enabled!=='boolean'||!settings(value.settings)||!timestamp(value.updatedAt))invalid();
    return {...value,settings:{...value.settings}};
  }
  function requireScope(scope){const {record}=requireConnection();if(!record.scopes.includes(scope))throw fail('account_plugin_scope_required',403);}
  const endpoint=(device,plugin)=>`api/studio/devices/${device}/plugins${plugin?'/'+plugin:''}`;
  return {
    async listPlugins(){
      const {record}=requireConnection();
      if(!record.scopes.includes('plugins.read'))return {supported:false,capabilities:null,plugins:[],code:'account_plugin_scope_required'};
      try{return await authorized('api/studio/plugins',{},data=>{
        if(!Array.isArray(data.plugins)||data.plugins.length>128)invalid();
        const plugins=data.plugins.map(metadata);
        if(new Set(plugins.map(row=>`${row.id}@${row.version}`)).size!==plugins.length)invalid();
        return {supported:true,capabilities:capabilities(data.capabilities),plugins};
      });}catch(error){if(error.code==='account_plugins_unsupported')return {supported:false,capabilities:null,plugins:[],code:error.code};throw error;}
    },
    async publishPlugin(input){
      requireScope('plugins.publish');
      if(!exact(input,['packageText','sha256'])||typeof input.packageText!=='string'||!input.packageText.length||Buffer.byteLength(input.packageText,'utf8')>128*1024||!digest(input.sha256)||createHash('sha256').update(input.packageText,'utf8').digest('hex')!==input.sha256)throw fail('account_invalid_input',400);
      try{if(!object(JSON.parse(input.packageText)))throw new Error();}catch{throw fail('account_invalid_input',400);}
      return authorized('api/studio/plugins',{method:'POST',body:{packageText:input.packageText,sha256:input.sha256}},data=>{const plugin=metadata(data.plugin);if(plugin.sha256!==input.sha256)invalid();return {plugin};});
    },
    async devicePlugins(input){
      requireScope('plugins.read');
      if(!exact(input,['deviceId'])||!deviceId(input.deviceId))throw fail('account_invalid_input',400);
      return authorized(endpoint(input.deviceId),{},data=>{
        if(!Array.isArray(data.bindings)||data.bindings.length>128)invalid();
        const bindings=data.bindings.map(binding);
        if(new Set(bindings.map(row=>row.pluginId)).size!==bindings.length)invalid();
        return {bindings};
      });
    },
    async bindPlugin(input){
      requireScope('plugins.bind');
      if(!exact(input,['deviceId','pluginId','version','expectedRevision','enabled','settings'])||!deviceId(input.deviceId)||!pluginId(input.pluginId)||!version(input.version)||!revision(input.expectedRevision)||typeof input.enabled!=='boolean'||!settings(input.settings))throw fail('account_invalid_input',400);
      const {version:targetVersion,expectedRevision,enabled,settings:values}=input;
      return authorized(endpoint(input.deviceId,input.pluginId),{method:'POST',body:{version:targetVersion,expectedRevision,enabled,settings:values}},data=>{
        const result=binding(data.binding);if(result.pluginId!==input.pluginId||result.version!==input.version||result.revision!==expectedRevision+1||result.enabled!==enabled)invalid();return {binding:result};
      });
    },
    async rollbackPlugin(input){
      requireScope('plugins.bind');
      if(!exact(input,['deviceId','pluginId','toRevision','expectedRevision'])||!deviceId(input.deviceId)||!pluginId(input.pluginId)||!revision(input.toRevision)||input.toRevision<1||!revision(input.expectedRevision))throw fail('account_invalid_input',400);
      return authorized(endpoint(input.deviceId,input.pluginId)+'/rollback',{method:'POST',body:{toRevision:input.toRevision,expectedRevision:input.expectedRevision}},data=>{
        const result=binding(data.binding);if(result.pluginId!==input.pluginId||result.revision!==input.expectedRevision+1)invalid();return {binding:result};
      });
    },
  };
}
