import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStudioAccount,STUDIO_ACCOUNT_SCOPES} from './studio-account.mjs';

const id='12345678-1234-4123-8123-123456789abc',deviceId='22345678-1234-4123-8123-123456789abc';
const now=Date.now(),createdAt=new Date(now).toISOString(),expiresAt=new Date(now+90*86400000).toISOString();
const profile={deviceId,revision:1,character:'Спокойный напарник',context:'Текущий проект',actions:['kibi.notify'],rolePrompt:'Готовый текст роли',application:{mode:'manual_xiaozhi',status:'manual_step_required'},catalog:[{id:'kibi.notify',title:'Уведомление',description:'В очередь своей Киби'},{id:'kibi.get_device_status',title:'Состояние',description:'Сохранённое состояние'}]};
async function fixture(t,scopes=STUDIO_ACCOUNT_SCOPES){
 const root=await mkdtemp(join(tmpdir(),'kibi-assistant-client-'));t.after(()=>rm(root,{recursive:true,force:true}));const calls=[];let replacement=null;
 const account=await createStudioAccount({root,now:()=>now,fetchImpl:async(url,options)=>{
  calls.push({url,options});
  const body=url.endsWith('/redeem')?{token:'kibi_studio_'+'T'.repeat(43),apiBase:'https://sldvkibi.ru/server/',account:{id,email:'person@example.test',role:'user'},connection:{id,label:'Fixture Studio',createdAt,expiresAt,scopes:[...scopes]},scopes:[...scopes]}:replacement||profile;
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 }});t.after(()=>account.close());
 await account.connect({code:'kibi_link_'+'C'.repeat(32),label:'Fixture Studio'});
 return {account,calls,replace:value=>replacement=value};
}

test('Studio reads and saves only the own selected assistant through dedicated bearer routes',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.account.getAssistant({deviceId}),profile);
 const input={deviceId,character:profile.character,context:profile.context,actions:profile.actions};
 await f.account.saveAssistant(input);
 const request=f.calls.at(-1);assert.equal(request.url,`https://sldvkibi.ru/server/api/studio/devices/${deviceId}/assistant`);
 assert.equal(request.options.method,'POST');assert.match(request.options.headers.Authorization,/^Bearer kibi_studio_/);
 assert.deepEqual(JSON.parse(request.options.body),{character:input.character,context:input.context,actions:input.actions});
 assert.equal(JSON.stringify(profile).includes('kibi_studio_'),false);
});

test('old saved scopes remain compatible but never gain assistant permission automatically',async t=>{
 const f=await fixture(t,STUDIO_ACCOUNT_SCOPES.slice(0,5));assert.equal(f.account.publicInfo().scopes.length,5);
 const before=f.calls.length;
 await assert.rejects(f.account.getAssistant({deviceId}),{code:'account_assistant_scope_required'});
 await assert.rejects(f.account.saveAssistant({deviceId,character:'',context:'',actions:[]}),{code:'account_assistant_scope_required'});
 assert.equal(f.calls.length,before);assert.equal(f.account.publicInfo().connected,true);
});

test('malformed profiles, another device response and unsupported actions cannot be forwarded',async t=>{
 const f=await fixture(t);const before=f.calls.length;
 await assert.rejects(f.account.saveAssistant({deviceId,character:'',context:'',actions:['execute_code']}),{code:'account_invalid_input'});assert.equal(f.calls.length,before);
 f.replace({...profile,deviceId:id});await assert.rejects(f.account.getAssistant({deviceId}),{code:'account_invalid_response'});
 f.replace({...profile,application:{mode:'automatic',status:'applied'}});await assert.rejects(f.account.getAssistant({deviceId}),{code:'account_invalid_response'});
});

test('assistant input and returned fields never echo a Studio connection credential to the model',async t=>{
 const f=await fixture(t),credential='kibi_studio_'+'T'.repeat(43),before=f.calls.length;
 await assert.rejects(f.account.saveAssistant({deviceId,character:'',context:credential,actions:[]}),{code:'account_invalid_input'});assert.equal(f.calls.length,before);
 for(const field of ['character','context','rolePrompt']){f.replace({...profile,[field]:credential});await assert.rejects(f.account.getAssistant({deviceId}),{code:'account_invalid_response'});}
 f.replace({...profile,catalog:profile.catalog.map((item,i)=>i?item:{...item,title:credential})});await assert.rejects(f.account.getAssistant({deviceId}),{code:'account_invalid_response'});
});
