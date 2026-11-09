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
async function fixture(){
 const {document,ids}=documentFixture(),calls=[],historyWrites=[];let session={authenticated:false},handler=null;
 const voice={configured:false,enabled:false,status:'disabled',code:'tenant_voice_unavailable',studioVoice:{approved:false,canActivate:false,code:'studio_voice_not_approved'}};
 const context={document,URL,AbortController,TextEncoder,Intl,Date,location:{hash:''},history:{replaceState:(_state,_title,url)=>historyWrites.push(url)},navigator:{},window:{addEventListener(){}},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},fetch:async(url,options={})=>{
  const path=new URL(url).pathname.replace(/^\/server/,'');calls.push({path,...options});const custom=await handler?.(path,options);if(custom)return custom;
  if(path==='/api/session')return response(session);if(path==='/api/health')return response({ok:true,version:'0.1.0'});if(path==='/api/overview')return response({server:{status:'ready',version:'0.1.0',uptimeSeconds:1},devices:[],events:[],modules:[]});
  if(path==='/api/settings')return response({voice,ai:{configured:false,enabled:false},telegram:{configured:false,enabled:false}});if(path==='/api/sdk')return response({version:'1.0',validation:true});if(path==='/docs/LOCAL_STUDIO.md')return response('Public Studio instructions');
  if(path==='/api/studio/connections')return response({connections:[]});if(path==='/api/studio/link-code')return response({code,expiresAt:'2026-12-01T00:00:00Z'},201);if(path==='/api/logout'){session={authenticated:false};return response({ok:true});}throw new Error(`unexpected request ${path}`);
 }};
 vm.runInNewContext(source.replaceAll('import.meta.url',JSON.stringify('https://kibi.example/server/app.js'))+'\nglobalThis.ui={state,enterApp,clearAccountUI,setAuthMode,renderVoice};',context);await flush();
 return{ids,calls,historyWrites,ui:context.ui,handle:callback=>{handler=callback;},session:value=>{session=value;},async enter(account=user){session={authenticated:true,user:account,csrfToken:'CSRF-PRIVATE'};await context.ui.enterApp(session);await flush();},async login(mode,studioLink){session={authenticated:true,user,csrfToken:'CSRF-PRIVATE'};handler=(path)=>path===(mode==='register'?'/api/register':'/api/login')?response({...session,ok:true,...(studioLink?{studioLink}:{})},mode==='register'?201:200):null;context.ui.setAuthMode(mode);ids.get('auth-email').value=user.email;ids.get('admin-password').value='a strong test password';await ids.get('login-form').fire('submit',{submitter:ids.get('auth-submit')});await flush();}};
}

test('Studio link is explicit on login, uses CSRF, and clears its code when the dialog closes',async()=>{
 const f=await fixture();await f.login('login');assert.equal(f.calls.filter(call=>call.path==='/api/studio/link-code').length,0);
 await f.ids.get('studio-connect').fire('click');await flush();assert.equal(f.ids.get('studio-dialog').open,true);
 await f.ids.get('studio-issue').fire('click');await flush();const issued=f.calls.find(call=>call.path==='/api/studio/link-code');assert.equal(issued.method,'POST');assert.equal(issued.body,'{}');assert.equal(issued.headers['X-CSRF-Token'],'CSRF-PRIVATE');assert.equal(f.ids.get('studio-link-code').value,code);
 assert.ok(f.historyWrites.every(value=>!String(value).includes(code)));assert.ok(f.calls.every(call=>!call.path.includes(code)));assert.ok(!f.ids.get('global-message-text').textContent.includes(code));
 f.ids.get('studio-dialog').close();assert.equal(f.ids.get('studio-link-code').value,'');assert.equal(f.ids.get('studio-link-expiry').textContent,'');
});

test('registration displays its returned code without issuing another one and supports unavailable linking',async()=>{
 const f=await fixture();await f.login('register',{code,expiresAt:'2026-12-01T00:00:00Z'});assert.equal(f.ids.get('studio-dialog').open,true);assert.equal(f.ids.get('studio-link-code').value,code);assert.equal(f.calls.filter(call=>call.path==='/api/studio/link-code').length,0);
 const unavailable=await fixture();await unavailable.login('register',{code:null,error:'studio_link_unavailable'});assert.equal(unavailable.ids.get('studio-dialog').open,true);assert.equal(unavailable.ids.get('studio-link-code').value,'');assert.match(unavailable.ids.get('studio-link-feedback').textContent,/код|подключ/i);assert.equal(unavailable.calls.filter(call=>call.path==='/api/studio/link-code').length,0);
});

test('late link-code responses cannot repopulate a closed dialog or another account',async()=>{
 const f=await fixture();await f.enter();let resolve;f.handle(path=>path==='/api/studio/link-code'?new Promise(done=>{resolve=done;}):null);
 await f.ids.get('studio-connect').fire('click');await flush();const issue=f.ids.get('studio-issue').fire('click');await flush();f.ids.get('studio-dialog').close();resolve(response({code,expiresAt:'2026-12-01T00:00:00Z'},201));await issue;await flush();assert.equal(f.ids.get('studio-link-code').value,'');assert.equal(f.ids.get('studio-dialog').open,false);
 await f.ids.get('studio-connect').fire('click');await flush();const next=f.ids.get('studio-issue').fire('click');await flush();await f.enter({...user,id:'account-b',email:'bob@example.test'});resolve(response({code,expiresAt:'2026-12-01T00:00:00Z'},201));await next;await flush();assert.equal(f.ids.get('studio-link-code').value,'');assert.equal(f.ids.get('studio-dialog').open,false);
});

test('logout hides a displayed Studio code before the logout response arrives',async()=>{
 const f=await fixture();await f.enter();await f.ids.get('studio-connect').fire('click');await f.ids.get('studio-issue').fire('click');assert.equal(f.ids.get('studio-link-code').value,code);
 let resolve;f.handle(path=>path==='/api/logout'?new Promise(done=>{resolve=done;}):null);const logout=f.ids.get('logout').fire('click');await flush();
 try{assert.equal(f.ids.get('studio-link-code').value,'');assert.equal(f.ids.get('studio-dialog').open,false);}
 finally{resolve(response({ok:true}));await logout;}
});

test('Studio connections are listed and individually revoked; owners cannot issue account links',async()=>{
 const f=await fixture();await f.enter();let revoked=false;f.handle((path,options)=>path==='/api/studio/connections'?response({connections:revoked?[]:[{id:'connection/one',createdAt:'2026-11-10T01:00:00Z'}]}):path==='/api/studio/connections/connection%2Fone'?(revoked=true,response({ok:true})):null);
 await f.ids.get('studio-connect').fire('click');await flush();const revoke=f.ids.get('studio-connections').querySelectorAll('button')[0];assert.ok(revoke);await revoke.fire('click');await flush();assert.equal(revoked,true);const request=f.calls.find(call=>call.path.includes('connection%2Fone'));assert.equal(request.method,'DELETE');assert.equal(request.headers['X-CSRF-Token'],'CSRF-PRIVATE');
 await f.enter(owner);assert.equal(f.ids.get('studio-connect').hidden,true);const before=f.calls.length;await f.ids.get('studio-connect').fire('click');assert.equal(f.calls.length,before);
});

test('owner approves one Studio account with protected requests and ordinary users see only their eligibility',async()=>{
 const f=await fixture();await f.enter(owner);const voice={provider:'xiaozhi',studioAccountId:null,delegation:null,status:'listening',enabled:true};f.ui.state.settings.voice=voice;f.ui.renderVoice(voice);
 f.handle((path,options)=>path==='/api/settings/voice/studio-account'?response({ok:true,voice:{...voice,studioAccountId:options.method==='POST'?'approved-account':null}}):null);
 f.ids.get('voice-studio-account-email').value='alice@example.test';await f.ids.get('voice-studio-account-form').fire('submit',{submitter:f.ids.get('voice-studio-account-approve')});await flush();const request=f.calls.find(call=>call.path==='/api/settings/voice/studio-account');assert.equal(request.body,JSON.stringify({email:'alice@example.test'}));assert.equal(request.headers['X-CSRF-Token'],'CSRF-PRIVATE');assert.match(f.ids.get('voice-studio-account-status').textContent,/approved-account/);
 await f.ids.get('voice-studio-account-revoke').fire('click');await flush();assert.equal(f.calls.filter(call=>call.path==='/api/settings/voice/studio-account').at(-1).method,'DELETE');
 await f.enter();f.ui.renderVoice({code:'tenant_voice_unavailable',studioVoice:{approved:true,canActivate:true,code:null}});assert.match(f.ids.get('voice-studio-eligibility').textContent,/разреш|Studio/);assert.equal(f.ids.get('voice-owner-controls').hidden,true);assert.equal(f.ids.get('voice-studio-account-email').disabled,true);
});

test('a late owner approval response cannot replace a different account profile',async()=>{
 const f=await fixture();await f.enter(owner);f.ui.state.settings.voice={studioAccountId:null,delegation:null,provider:'xiaozhi'};f.ui.renderVoice(f.ui.state.settings.voice);
 let resolve;f.handle(path=>path==='/api/settings/voice/studio-account'?new Promise(done=>{resolve=done;}):null);f.ids.get('voice-studio-account-email').value=user.email;
 const approval=f.ids.get('voice-studio-account-form').fire('submit',{submitter:f.ids.get('voice-studio-account-approve')});await flush();await f.enter();resolve(response({ok:true,voice:{studioAccountId:'OTHER-ACCOUNT-PRIVATE',provider:'xiaozhi'}}));await approval;await flush();
 assert.equal(f.ui.state.user.role,'user');assert.equal(f.ui.state.settings.voice.studioAccountId,undefined);assert.equal(f.ids.get('voice-studio-account-status').textContent,'');assert.equal(f.ids.get('voice-studio-account-email').value,'');assert.equal(f.ids.get('voice-studio-account-approve').disabled,true);
});
