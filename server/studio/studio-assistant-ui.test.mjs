import test from 'node:test';
import assert from 'node:assert/strict';
import {initStudioAccountUI} from './studio-account.js';
import {ASSISTANT_ACTIONS} from '../src/assistant.mjs';

// Only the browser document and local API are injected. The real account UI,
// event handlers, request ordering, editable values and response guards execute.
class Element {
 constructor(tag='div',attributes={}){this.tagName=tag.toUpperCase();this.attributes=attributes;this.id=attributes.id||'';this.children=[];this.listeners={};this.dataset={};this._value=attributes.value||'';this._text='';this.hidden='hidden' in attributes;this.open=false;this.isConnected=true;this.checked=false;for(const [k,v]of Object.entries(attributes))if(k.startsWith('data-'))this.dataset[k.slice(5)]=v;this.classList={toggle(){}};}
 get elements(){return {namedItem:name=>this.querySelector(`[name="${name}"]`)};}
 set innerHTML(html){this.children=[];const stack=[this];for(const match of html.matchAll(/<(\/)?([a-z][\w-]*)([^>]*)>/gi)){const [,close,tag,rest]=match;if(close){while(stack.length>1)if(stack.pop().tagName===tag.toUpperCase())break;continue;}const attrs={};for(const attr of rest.matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[attr[1]]=attr[2]??'';const node=new Element(tag,attrs);stack.at(-1).append(node);if(!['input','br','hr'].includes(tag))stack.push(node);}}
 get value(){return this.tagName==='SELECT'?(this.children.some(child=>child.value===this._value)?this._value:this.children[0]?.value||''):this._value;}
 set value(value){this._value=String(value);}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
 replaceChildren(...nodes){this._text='';this.children=[];this.append(...nodes);}
 setAttribute(key,value){this.attributes[key]=String(value);}
 removeAttribute(key){delete this.attributes[key];}
 addEventListener(name,listener){(this.listeners[name]??=[]).push(listener);}
 removeEventListener(name,listener){this.listeners[name]=this.listeners[name]?.filter(value=>value!==listener);}
 async fire(name){for(const listener of this.listeners[name]||[])await listener({preventDefault(){},target:this,currentTarget:this});}
 matches(selector){const attr=/^\[([^=]+)="([^"]*)"\]$/.exec(selector);return attr?this.attributes[attr[1]]===attr[2]:this.tagName===selector.toUpperCase();}
 querySelectorAll(selector){const result=[];const visit=node=>{for(const child of node.children){if(selector.split(',').some(value=>child.matches(value.trim())))result.push(child);visit(child);}};visit(this);return result;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 showModal(){this.open=true;}
 close(){this.open=false;void this.fire('close');}
 focus(){this.focused=true;}
 select(){this.selected=true;}
 remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
}
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const profile=(id=A,values={})=>({deviceId:id,revision:2,character:'Спокойный помощник',context:'Личный контекст',actions:['kibi.get_device_status'],rolePrompt:'Роль для своей консоли Xiaozhi',application:{mode:'manual_xiaozhi',status:'manual_step_required'},catalog:structuredClone(ASSISTANT_ACTIONS),...values});
async function fixture(t,scopes=['assistant.read','assistant.write']){
 const document=new Element('document');document.body=new Element('body');document.createElement=tag=>new Element(tag);document.append(document.body);
 const previous=globalThis.document;globalThis.document=document;t.after(()=>{globalThis.document=previous;});
 let info={connected:true,verified:true,account:{id:'account-a',email:'a@example.test'},connection:{id:'connection-a'},scopes},handler;
 const calls=[];
 const ui=initStudioAccountUI({mount:document.body,api:async(path,options)=>{
  calls.push({path,options});const handled=handler?.(path,options);if(handled!==undefined)return handled;
  if(path==='/api/account')return structuredClone(info);
  if(path==='/api/account/devices')return {devices:[{id:A,name:'Мой Киби',status:'online'},{id:B,name:'Другой Киби',status:'offline'}]};
  if(path==='/api/account/disconnect')return {connected:false};
  if(path.endsWith('/assistant'))return profile(path.split('/').at(-2),options?.method==='POST'?{...options.body,revision:3,rolePrompt:'Обновлённая роль Xiaozhi'}:{});
  throw Error('unexpected local request');
 }});t.after(()=>ui.destroy());await ui.ready;
 const form=()=>ui.dialog.querySelector('[data-form="assistant"]');
 return {ui,calls,form,part:name=>ui.dialog.querySelector(`[data-part="${name}"]`),action:name=>ui.dialog.querySelector(`[data-action="${name}"]`),field:name=>form()?.elements.namedItem(name),handle:fn=>{handler=fn;},account:value=>{info=value;}};
}
async function load(f){assert.ok(f.action('assistant-load'),'assistant profile load control must exist');await f.action('assistant-load').fire('click');await flush();}

test('assistant profile is explicitly loaded for an own device and renders data safely as text',async t=>{
 const f=await fixture(t);assert.ok(f.form());assert.equal(f.calls.some(call=>call.path.endsWith('/assistant')),false);
 assert.equal(f.field('character').attributes.maxlength,'4000');assert.equal(f.field('context').attributes.maxlength,'6000');
 f.handle(path=>path.endsWith('/assistant')?profile(A,{character:'<img src=x onerror=evil()>',catalog:[...profile().catalog,{id:'arbitrary_script',title:'Bad',description:'Bad'}]}):undefined);
 await load(f);assert.equal(f.field('deviceId').value,A);assert.equal(f.field('character').value,'<img src=x onerror=evil()>');
 assert.equal(f.ui.dialog.querySelectorAll('img').length,0);assert.equal(f.ui.dialog.querySelectorAll('[data-action-id="arbitrary_script"]').length,0);
 assert.equal(f.ui.dialog.querySelectorAll('[data-action-id="kibi.get_device_status"]').length,1);
 assert.match(f.part('assistant-instructions').textContent,/вручную|вставьте/i);assert.match(f.part('assistant-instructions').textContent,/контекст|MCP/i);
 assert.doesNotMatch(f.part('assistant-status').textContent,/применён.*Xiaozhi|роль установлена/i);
});

test('explicit save sends only editable fields and enables copying the saved role afterward',async t=>{
 const f=await fixture(t);await load(f);f.field('character').value='Новый характер';await f.field('character').fire('input');f.field('context').value='Новый контекст';await f.field('context').fire('input');
 const notify=f.ui.dialog.querySelector('[data-action-id="kibi.notify"]');notify.checked=true;await notify.fire('change');
 assert.equal(f.action('assistant-copy-role').disabled,true);await f.form().fire('submit');await flush();
 const saved=f.calls.find(call=>call.options?.method==='POST'&&call.path.endsWith('/assistant'));
 assert.deepEqual(saved.options.body,{character:'Новый характер',context:'Новый контекст',actions:['kibi.get_device_status','kibi.notify']});
 assert.equal(f.field('rolePrompt').value,'Обновлённая роль Xiaozhi');assert.equal(f.action('assistant-copy-role').disabled,false);
 const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');let copied;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>{copied=text;}}}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;});
 await f.action('assistant-copy-role').fire('click');await flush();assert.equal(copied,'Обновлённая роль Xiaozhi');
});

test('save errors preserve edits and never expose raw server text; account refresh does not overwrite them',async t=>{
 const f=await fixture(t);await load(f);f.field('character').value='Не потеряй';await f.field('character').fire('input');
 f.handle((path,options)=>path.endsWith('/assistant')&&options?.method==='POST'?Promise.reject(Object.assign(Error('PRIVATE SERVER TEXT'),{code:'account_network_error'})):undefined);
 await f.form().fire('submit');await flush();assert.equal(f.field('character').value,'Не потеряй');assert.doesNotMatch(f.ui.dialog.textContent,/PRIVATE SERVER TEXT/);
 await f.ui.refresh();assert.equal(f.field('character').value,'Не потеряй');assert.equal(f.calls.filter(call=>call.path.endsWith('/assistant')&&!call.options?.method).length,1);
 assert.equal(f.action('assistant-copy-role').disabled,true);
});

test('legacy connections explain reconnecting while preserving unrelated account controls',async t=>{
 const f=await fixture(t,['devices.list','voice.status']);assert.ok(f.form());assert.equal(f.action('assistant-load').disabled,true);assert.equal(f.action('assistant-save').disabled,true);
 assert.match(f.part('assistant-scope').textContent,/нов.*ключ|переподключ/i);assert.equal(f.action('diagnostics-refresh').disabled,false);
 await f.action('assistant-load').fire('click');await flush();assert.equal(f.calls.some(call=>call.path.endsWith('/assistant')),false);
});

test('late profile data cannot populate a changed device/account or a disconnected/closed/destroyed dialog',async t=>{
 for(const change of ['device','account','disconnect','close','destroy']){
  const f=await fixture(t);let resolve;f.handle(path=>path.endsWith('/assistant')?new Promise(done=>{resolve=done;}):undefined);
  assert.ok(f.action('assistant-load'));await f.action('assistant-load').fire('click');await flush();assert.equal(typeof resolve,'function');
  if(change==='device'){f.field('deviceId').value=B;await f.field('deviceId').fire('change');}
  else if(change==='account'){f.account({connected:true,verified:true,account:{id:'account-b',email:'b@example.test'},connection:{id:'connection-b'},scopes:['assistant.read','assistant.write']});await f.ui.refresh();}
  else if(change==='disconnect'){await f.action('disconnect').fire('click');await flush();}
  else if(change==='close'){f.ui.dialog.showModal();f.ui.dialog.close();}
  else f.ui.destroy();
  resolve(profile(A,{character:'PRIVATE LATE PROFILE',rolePrompt:'PRIVATE LATE ROLE'}));await flush();
  assert.equal(f.field('character').value,'');assert.equal(f.field('context').value,'');assert.equal(f.field('rolePrompt').value,'');assert.doesNotMatch(f.ui.dialog.textContent,/PRIVATE LATE/);
 }
});

test('closing clears loaded private fields and copying has a selectable keyboard fallback',async t=>{
 const f=await fixture(t);await load(f);
 const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{throw Error('denied');}}}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;});
 await f.action('assistant-copy-role').fire('click');await flush();assert.equal(f.field('rolePrompt').selected,true);
 assert.match(f.part('assistant-status').textContent,/выделен|скопируйте/i);
 f.ui.dialog.showModal();f.ui.dialog.close();await flush();assert.equal(f.field('character').value,'');assert.equal(f.field('context').value,'');assert.equal(f.field('rolePrompt').value,'');
});

test('late save responses cannot restore private profile data after a device change',async t=>{
 const f=await fixture(t);await load(f);let resolve;f.handle((path,options)=>path.endsWith('/assistant')&&options?.method==='POST'?new Promise(done=>{resolve=done;}):undefined);
 f.field('context').value='Сохранение';await f.field('context').fire('input');await f.form().fire('submit');await flush();
 f.field('deviceId').value=B;await f.field('deviceId').fire('change');resolve(profile(A,{context:'PRIVATE SAVE',rolePrompt:'PRIVATE ROLE'}));await flush();
 assert.equal(f.field('character').value,'');assert.equal(f.field('context').value,'');assert.equal(f.field('rolePrompt').value,'');
});

test('length bounds and read-only assistant scope cannot create a save request',async t=>{
 const f=await fixture(t);await load(f);f.field('character').value='x'.repeat(4001);await f.field('character').fire('input');await f.form().fire('submit');await flush();
 assert.equal(f.calls.some(call=>call.path.endsWith('/assistant')&&call.options?.method==='POST'),false);assert.equal(f.field('character').value.length,4001);assert.match(f.part('assistant-status').textContent,/4000/);
 const g=await fixture(t,['assistant.read']);await load(g);assert.equal(g.action('assistant-save').disabled,true);await g.form().fire('submit');await flush();assert.equal(g.calls.some(call=>call.options?.method==='POST'),false);
});

test('foreign profile responses are discarded and removed action controls lose their listeners',async t=>{
 const f=await fixture(t);f.handle(path=>path.endsWith('/assistant')?profile(B,{character:'FOREIGN PRIVATE PROFILE'}):undefined);await load(f);assert.equal(f.field('character').value,'');assert.doesNotMatch(f.ui.dialog.textContent,/FOREIGN PRIVATE/);
 f.handle(()=>undefined);await load(f);const old=f.ui.dialog.querySelector('[data-action-id="kibi.notify"]');assert.equal(old.listeners.change.length,1);
 f.ui.dialog.showModal();f.ui.dialog.close();await flush();assert.equal(old.listeners.change.length,0);assert.equal(f.ui.dialog.querySelectorAll('[data-action-id="kibi.notify"]').length,0);
});
