import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8'),source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
class Element{
 constructor(tag='div',attributes={}){this.tagName=tag.toUpperCase();this.attributes={...attributes};this.id=attributes.id||'';this.dataset={};for(const [key,value]of Object.entries(attributes))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;this.className=attributes.class||'';this.children=[];this.listeners={};this.value=attributes.value||'';this.hidden='hidden'in attributes;this.disabled='disabled'in attributes;this.open=false;this._text='';this.classList={toggle:(name,on)=>{const classes=new Set(this.className.split(/\s+/));on?classes.add(name):classes.delete(name);this.className=[...classes].join(' ');}};}
 set textContent(text){this._text=String(text);this.children=[];}get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 append(...children){for(const child of children){child.parent=this;this.children.push(child);}}replaceChildren(...children){this.children=[];this._text='';this.append(...children);}get firstChild(){return this.children[0];}
 setAttribute(key,value){this.attributes[key]=String(value);}removeAttribute(key){delete this.attributes[key];}
 addEventListener(type,callback){(this.listeners[type]??=[]).push(callback);}async fire(type,extra={}){for(const callback of this.listeners[type]||[])await callback({preventDefault(){},currentTarget:this,target:this,...extra});}
 matches(selector){if(selector.startsWith('.'))return this.className.split(/\s+/).includes(selector.slice(1));const attribute=/^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);if(attribute)return attribute[1]in this.attributes&&(attribute[2]===undefined||this.attributes[attribute[1]]===attribute[2]);return this.tagName===selector.toUpperCase();}
 querySelectorAll(selectors){const result=[];const visit=element=>{for(const child of element.children){if(selectors.split(',').some(selector=>child.matches(selector.trim())))result.push(child);visit(child);}};visit(this);return result;}
 closest(selector){for(let element=this;element;element=element.parent)if(element.matches(selector))return element;return null;}
 reset(){for(const element of this.querySelectorAll('input,textarea,select'))element.value=element.attributes.value||'';}reportValidity(){return true;}focus(){this.focused=true;}select(){this.selected=true;}showModal(){this.open=true;}close(){this.open=false;void this.fire('close');}
}
function documentFixture(){const document=new Element('document'),ids=new Map(),stack=[document],voids=new Set(['input','img','meta','link','hr','br']);for(const match of html.matchAll(/<(\/)?([a-z][\w-]*)([^>]*)>/gi)){const [,closing,tag,rest]=match;if(closing){while(stack.length>1){if(stack.pop().tagName===tag.toUpperCase())break;}continue;}const attributes={};for(const attribute of rest.matchAll(/([\w-]+)(?:="([^"]*)")?/g))attributes[attribute[1]]=attribute[2]??'';const element=new Element(tag,attributes);stack.at(-1).append(element);if(element.id){assert.ok(!ids.has(element.id),`duplicate id ${element.id}`);ids.set(element.id,element);}if(!voids.has(tag.toLowerCase()))stack.push(element);}document.getElementById=id=>{assert.ok(ids.has(id),`missing DOM node ${id}`);return ids.get(id);};document.createElement=tag=>new Element(tag);return{document,ids};}
const user={id:'account-a',email:'alice@example.test',role:'user'},owner={id:'owner',email:null,role:'owner'},code='KIBI-PRIVATE-ONE-TIME-CODE';
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(data),text:async()=>typeof data==='string'?data:JSON.stringify(data)});
const flush=async()=>{for(let index=0;index<35;index++)await Promise.resolve();};
async function fixture(devices=[]){
 const {document,ids}=documentFixture(),calls=[],historyWrites=[];let session={authenticated:false},handler=null;
 const voice={configured:false,enabled:false,status:'disabled',code:'tenant_voice_unavailable',studioVoice:{approved:false,canActivate:false,code:'studio_voice_not_approved'}};
 const context={document,URL,AbortController,TextEncoder,Intl,Date,location:{hash:''},history:{replaceState:(_state,_title,url)=>historyWrites.push(url)},navigator:{},window:{addEventListener(){}},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},fetch:async(url,options={})=>{
  const path=new URL(url).pathname.replace(/^\/server/,'');calls.push({path,...options});const custom=await handler?.(path,options);if(custom)return custom;
  if(path==='/api/session')return response(session);if(path==='/api/health')return response({ok:true,version:'0.1.0'});if(path==='/api/overview')return response({server:{status:'ready',version:'0.1.0',uptimeSeconds:1},devices,events:[],modules:[]});
  if(path==='/api/settings')return response({voice,ai:{configured:false,enabled:false},telegram:{configured:false,enabled:false}});if(path==='/api/sdk')return response({version:'1.0',validation:true});if(path==='/docs/LOCAL_STUDIO.md')return response('Public Studio instructions');
  if(path==='/api/studio/connections')return response({connections:[]});if(path==='/api/studio/link-code')return response({code,expiresAt:'2026-12-01T00:00:00Z'},201);if(path==='/api/logout'){session={authenticated:false};return response({ok:true});}throw new Error(`unexpected request ${path}`);
 }};
 vm.runInNewContext(source.replaceAll('import.meta.url',JSON.stringify('https://kibi.example/server/app.js'))+'\nglobalThis.ui={state,enterApp,clearAccountUI,setAuthMode,renderVoice,refreshData};',context);await flush();
 return{ids,calls,historyWrites,ui:context.ui,handle:callback=>{handler=callback;},session:value=>{session=value;},async enter(account=user){session={authenticated:true,user:account,csrfToken:'CSRF-PRIVATE'};await context.ui.enterApp(session);await flush();},async login(mode,studioLink){session={authenticated:true,user,csrfToken:'CSRF-PRIVATE'};handler=(path)=>path===(mode==='register'?'/api/register':'/api/login')?response({...session,ok:true,...(studioLink?{studioLink}:{})},mode==='register'?201:200):null;context.ui.setAuthMode(mode);ids.get('auth-email').value=user.email;ids.get('admin-password').value='a strong test password';await ids.get('login-form').fire('submit',{submitter:ids.get('auth-submit')});await flush();}};
}


const devices=[{id:'own/one',name:'Киби у окна',status:'not_seen',lastSeenAt:null},{id:'own-two',name:'Киби в кухне',status:'not_seen',lastSeenAt:null}];
const emptyDiagnostics={schemaVersion:'1.0',source:'server',retentionSeconds:3600,observed:false,updatedAt:null,connection:null,metrics:null,events:[]};
const observedDiagnostics={...emptyDiagnostics,observed:true,updatedAt:'2026-11-10T01:00:00Z',connection:{state:'closed',code:'closed',active:false},metrics:{inputPackets:0,inputPcmBytes:240,droppedInputPackets:null,outputPackets:2,outputPcmBytes:null,turnsCompleted:1,playbackRejections:0},events:[{at:'2026-11-10T01:00:00Z',state:'closed',code:'closed'}]};

test('diagnostics are manual, own-device scoped, and distinguish empty observations from missing devices',async()=>{
 const f=await fixture(devices);await f.enter();assert.equal(f.ids.get('voice-diagnostics').hidden,false);assert.equal(f.ids.get('voice-diagnostics-device').value,'own/one');assert.equal(f.calls.filter(call=>call.path.endsWith('/voice-diagnostics')).length,0);
 f.handle(path=>path==='/api/devices/own%2Fone/voice-diagnostics'?response(emptyDiagnostics):null);await f.ids.get('voice-diagnostics-refresh').fire('click');await flush();const request=f.calls.find(call=>call.path.endsWith('/voice-diagnostics'));assert.equal(request.method,'GET');assert.equal(request.body,undefined);assert.match(f.ids.get('voice-diagnostics-feedback').textContent,/наблюдений/i);assert.equal(f.ids.get('voice-diagnostics-result').hidden,true);
 const empty=await fixture();await empty.enter();assert.equal(empty.ids.get('voice-diagnostics-device').disabled,true);assert.equal(empty.ids.get('voice-diagnostics-refresh').disabled,true);assert.match(empty.ids.get('voice-diagnostics-feedback').textContent,/привяжите/i);
});

test('diagnostics render real zeroes, unknown counters and server timeline',async()=>{
 const f=await fixture(devices);await f.enter();f.handle(path=>path.endsWith('/voice-diagnostics')?response(observedDiagnostics):null);await f.ids.get('voice-diagnostics-refresh').fire('click');await flush();assert.equal(f.ids.get('voice-diagnostics-result').hidden,false);assert.match(f.ids.get('voice-diagnostics-latest').textContent,/заверш/i);const values=f.ids.get('voice-diagnostics-metrics').querySelectorAll('dd').map(el=>el.textContent);assert.deepEqual(values,['0','240','—','2','—','1','0']);assert.equal(f.ids.get('voice-diagnostics-events').children.length,1);assert.match(f.ids.get('voice-diagnostics-updated').textContent,/2026/);
});

test('device changes fence late results and delete old observations immediately',async()=>{
 const f=await fixture(devices);await f.enter();let resolve;f.handle(path=>path.endsWith('/voice-diagnostics')?new Promise(done=>{resolve=done;}):null);const loading=f.ids.get('voice-diagnostics-refresh').fire('click');await flush();assert.equal(f.ids.get('voice-diagnostics-refresh').disabled,true);assert.match(f.ids.get('voice-diagnostics-feedback').textContent,/получаем/i);
 f.ids.get('voice-diagnostics-device').value='own-two';await f.ids.get('voice-diagnostics-device').fire('change');assert.equal(f.ids.get('voice-diagnostics-result').hidden,true);resolve(response(observedDiagnostics));await loading;await flush();assert.equal(f.ids.get('voice-diagnostics-result').hidden,true);assert.equal(f.ids.get('voice-diagnostics-device').value,'own-two');assert.equal(f.ids.get('voice-diagnostics-refresh').disabled,false);
});

test('logout and account changes clear diagnostics before delayed responses arrive',async()=>{
 const f=await fixture(devices);await f.enter();let resolve;f.handle(path=>path.endsWith('/voice-diagnostics')?new Promise(done=>{resolve=done;}):null);const loading=f.ids.get('voice-diagnostics-refresh').fire('click');await flush();await f.enter({...user,id:'account-b'});resolve(response(observedDiagnostics));await loading;assert.equal(f.ids.get('voice-diagnostics-result').hidden,true);
 f.handle(path=>path.endsWith('/voice-diagnostics')?response(observedDiagnostics):path==='/api/logout'?new Promise(done=>{resolve=done;}):null);await f.ids.get('voice-diagnostics-refresh').fire('click');assert.equal(f.ids.get('voice-diagnostics-result').hidden,false);const logout=f.ids.get('logout').fire('click');await flush();assert.equal(f.ids.get('voice-diagnostics').hidden,true);assert.equal(f.ids.get('voice-diagnostics-events').children.length,0);resolve(response({ok:true}));await logout;
});

test('diagnostics show errors and clear when selected device is removed',async()=>{
 const f=await fixture(devices);await f.enter();f.handle(path=>path.endsWith('/voice-diagnostics')?response({ok:false,code:'device_not_found'},404):null);await f.ids.get('voice-diagnostics-refresh').fire('click');assert.match(f.ids.get('voice-diagnostics-feedback').textContent,/не найдено/i);assert.equal(f.ids.get('voice-diagnostics-refresh').disabled,false);
 f.handle(path=>path==='/api/overview'?response({server:{status:'ready',version:'0.1.0',uptimeSeconds:1},devices:[devices[1]],events:[],modules:[]}):null);await f.ui.refreshData();assert.equal(f.ids.get('voice-diagnostics-device').value,'own-two');assert.equal(f.ids.get('voice-diagnostics-result').hidden,true);
});

test('owners see generic service and approval state without user IDs or fake activity',async()=>{
 const f=await fixture(devices);await f.enter(owner);const voice={provider:'xiaozhi',status:'listening',code:'listening',enabled:true,configured:true,activityVisibility:'service_only',activeSessions:null,scope:null,delegation:null,studioAccountId:null,studioVoiceApproved:true};f.ui.state.settings.voice=voice;f.ui.renderVoice(voice);assert.equal(f.ids.get('voice-diagnostics').hidden,true);assert.equal(f.ids.get('voice-studio-account-revoke').disabled,false);assert.equal(f.ids.get('voice-delegation-revoke').disabled,false);assert.match(f.ids.get('voice-studio-account-status').textContent,/разрешено/i);assert.match(f.ids.get('voice-detail').textContent,/служб|шлюз/i);assert.doesNotMatch(f.ids.get('voice-detail').textContent,/разговор|подключена/i);const count=f.calls.length;await f.ids.get('voice-diagnostics-refresh').fire('click');assert.equal(f.calls.length,count);
});

test('a background overview response cannot reopen diagnostics while logout is pending',async()=>{
 const f=await fixture(devices);await f.enter();let resolveOverview,resolveLogout;
 f.handle(path=>path==='/api/overview'?new Promise(done=>{resolveOverview=done;}):path==='/api/logout'?new Promise(done=>{resolveLogout=done;}):null);
 const refresh=f.ui.refreshData();await flush();const logout=f.ids.get('logout').fire('click');await flush();resolveOverview(response({server:{status:'ready',version:'0.1.0',uptimeSeconds:1},devices,events:[],modules:[]}));await refresh;
 try{assert.equal(f.ids.get('voice-diagnostics').hidden,true);assert.equal(f.ids.get('voice-diagnostics-device').children.length,0);}
 finally{resolveLogout(response({ok:true}));await logout;}
});

test('unknown measurements and codes remain unknown and failed refresh can be retried',async()=>{
 const f=await fixture(devices);await f.enter();f.handle(path=>path.endsWith('/voice-diagnostics')?response({...observedDiagnostics,connection:{state:'__proto__',code:'PRIVATE-EXCEPTION-TEXT',active:null},metrics:null,events:[]}):null);
 await f.ids.get('voice-diagnostics-refresh').fire('click');assert.deepEqual(f.ids.get('voice-diagnostics-metrics').querySelectorAll('dd').map(el=>el.textContent),['—','—','—','—','—','—','—']);assert.match(f.ids.get('voice-diagnostics-latest').textContent,/неизвестно/);assert.doesNotMatch(f.ids.get('voice-diagnostics-code').textContent,/PRIVATE/);assert.match(f.ids.get('voice-diagnostics-active').textContent,/неизвестна/);
 f.handle(path=>path.endsWith('/voice-diagnostics')?response({invalid:true}):null);await f.ids.get('voice-diagnostics-refresh').fire('click');assert.equal(f.ids.get('voice-diagnostics-result').hidden,true);assert.match(f.ids.get('voice-diagnostics-feedback').className,/error/);assert.equal(f.ids.get('voice-diagnostics-refresh').disabled,false);
 f.handle(path=>path.endsWith('/voice-diagnostics')?response(emptyDiagnostics):null);await f.ids.get('voice-diagnostics-refresh').fire('click');assert.doesNotMatch(f.ids.get('voice-diagnostics-feedback').className,/error/);
});
