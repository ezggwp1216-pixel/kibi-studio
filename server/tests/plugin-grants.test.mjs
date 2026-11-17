import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStudioLinks,STUDIO_SCOPES} from '../src/studio-links.mjs';

test('plugin grants require a newly approved code and a compatible Studio protocol',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'kibi-plugin-grants-'));
 const id=randomUUID(),links=await openStudioLinks(dataDir,{accountExists:value=>value===id});
 t.after(async()=>{await links.close();await rm(dataDir,{recursive:true,force:true});});
 const legacy=await links.issue(id);
 const old=await links.redeem({code:legacy.code,label:'Legacy'},{protocol:'plugins-v1'});
 assert.equal(old.connection.scopes.includes('plugins.publish'),false);
 const approved=await links.issue(id,{plugins:true});
 const modern=await links.redeem({code:approved.code,label:'Modern'},{protocol:'plugins-v1'});
 assert.deepEqual(modern.connection.scopes.slice(-3),['plugins.read','plugins.publish','plugins.bind']);
 assert.equal(links.authenticate(old.token).scopes.includes('plugins.publish'),false);
 assert.equal(links.authenticate(modern.token).scopes.includes('plugins.publish'),true);
 await assert.rejects(links.withAuthorization(old.token,'plugins.publish',()=>true),{status:403,code:'studio_scope_denied'});
 assert.equal(await links.withAuthorization(modern.token,'plugins.publish',()=>true),true);
 await links.close();
 const reopened=await openStudioLinks(dataDir,{accountExists:value=>value===id});
 t.after(()=>reopened.close());
 assert.equal(reopened.authenticate(old.token).scopes.includes('plugins.publish'),false);
 assert.equal(reopened.authenticate(modern.token).scopes.includes('plugins.publish'),true);
});

test('an approved plugin code redeemed without negotiation keeps current non-plugin rights',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'kibi-plugin-old-client-'));
 const id=randomUUID(),links=await openStudioLinks(dataDir,{accountExists:value=>value===id});
 t.after(async()=>{await links.close();await rm(dataDir,{recursive:true,force:true});});
 const issued=await links.issue(id,{plugins:true});
 const result=await links.redeem({code:issued.code,label:'Older Studio'});
 assert.deepEqual(result.connection.scopes,STUDIO_SCOPES);
 assert.equal(result.connection.scopes.includes('plugins.publish'),false);
});
