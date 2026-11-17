import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStudioLinks} from '../src/studio-links.mjs';
const current=['pairing.claim','devices.list','voice.status','voice.activate','catalog.read','assistant.read','assistant.write'];
async function fixture(t){const dir=await mkdtemp('/private/tmp/kibi-plugin-current-'),id=randomUUID();let links=await openStudioLinks(dir,{accountExists:value=>value===id});t.after(async()=>{await links.close();await rm(dir,{recursive:true,force:true});});return{dir,id,get links(){return links;},async reopen(){await links.close();links=await openStudioLinks(dir,{accountExists:value=>value===id});}};}
test('adding server modules retains the current seven-right default without granting plugin writes',async t=>{
 const f=await fixture(t),issued=await f.links.issue(f.id),linked=await f.links.redeem({code:issued.code,label:'Current Studio'});
 assert.deepEqual(linked.connection.scopes,current);
 assert.equal(f.links.authenticate(linked.token).scopes.includes('plugins.publish'),false);
 const approved=await f.links.issue(f.id,{plugins:true}),withoutNegotiation=await f.links.redeem({code:approved.code,label:'Existing client'});
 assert.deepEqual(withoutNegotiation.connection.scopes,current);
});
test('persisted five and seven right links reopen unchanged beside explicitly approved plugin links',async t=>{
 const f=await fixture(t),issued=await f.links.issue(f.id),old=await f.links.redeem({code:issued.code,label:'Old Studio'});
 const next=await f.links.issue(f.id),modern=await f.links.redeem({code:next.code,label:'Current Studio'});
 const code=await f.links.issue(f.id,{plugins:true}),plugins=await f.links.redeem({code:code.code,label:'Modules Studio'},{protocol:'plugins-v1'});
 await f.links.close();
 const file=join(f.dir,'studio-links.json'),registry=JSON.parse(await readFile(file,'utf8'));
 registry.accounts[0].connections.find(x=>x.id===old.connection.id).scopes=current.slice(0,5);
 registry.accounts[0].connections.find(x=>x.id===modern.connection.id).scopes=[...current];
 await writeFile(file,JSON.stringify(registry),{mode:0o600});await f.reopen();
 assert.deepEqual(f.links.authenticate(old.token).scopes,current.slice(0,5));
 assert.deepEqual(f.links.authenticate(modern.token).scopes,current);
 assert.deepEqual(f.links.authenticate(plugins.token).scopes,[...current,'plugins.read','plugins.publish','plugins.bind']);
 await assert.rejects(f.links.withAuthorization(old.token,'assistant.write',()=>true),{code:'studio_scope_denied'});
 await assert.rejects(f.links.withAuthorization(modern.token,'plugins.publish',()=>true),{code:'studio_scope_denied'});
});
