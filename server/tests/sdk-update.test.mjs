import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {updatePublicSdk} from '../sdk/device/update.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
 const home=await mkdtemp(join(tmpdir(),'kibi-sdk-update-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const root=join(home,'studio'),kitRoot=join(home,'kit'),backupDir=join(home,'backup');
 await mkdir(join(root,'resources'),{recursive:true});await mkdir(join(root,'prompts'),{recursive:true});await mkdir(join(root,'.studio'),{recursive:true});
 await writeFile(join(root,'.studio','private-marker'),'PRIVATE_UNTOUCHED');
 await mkdir(join(kitRoot,'overlays/files'),{recursive:true});
 const files=[{path:'resources/board.json',before:hash('old-board'),after:hash('new-board')},{path:'prompts/agent-system.md',before:hash('old-prompt'),after:hash('new-prompt')}];
 for(const [i,payload]of ['new-board','new-prompt'].entries())await writeFile(join(kitRoot,'overlays/files',files[i].after+'.txt'),payload);
 await writeFile(join(root,files[0].path),'old-board');await writeFile(join(root,files[1].path),'old-prompt');
 await mkdir(join(root,'templates/kibi-base/firmware'),{recursive:true});
 await writeFile(join(root,'templates/kibi-base/firmware/display_touch.h'),'known-driver');
 const manifest=JSON.stringify({schemaVersion:1,boardId:'kibi-ds02-s3-16m',files:[{path:'firmware/display_touch.h',size:12,sha256:hash('known-driver')}]});
 await writeFile(join(root,'templates/kibi-base/manifest.json'),manifest);
 files.push({path:'templates/kibi-base/manifest.json',before:hash(manifest),after:hash(manifest)});
 await writeFile(join(kitRoot,'overlays/files',hash(manifest)+'.txt'),manifest);
 const profiles={schemaVersion:1,profiles:[{id:'known-sdk',files}]};
 const save=()=>writeFile(join(kitRoot,'overlays/profiles.json'),JSON.stringify(profiles));await save();
 return {root,kitRoot,backupDir,home,profiles,save};
}
test('SDK update plans without writes then applies and is idempotent without touching private data',async t=>{
 const f=await fixture(t),plan=await updatePublicSdk(f);assert.equal(plan.applied,false);assert.equal(plan.changedFiles.length,2);
 assert.equal(await readFile(join(f.root,'resources/board.json'),'utf8'),'old-board');
 const r=await updatePublicSdk({...f,apply:true});assert.equal(r.applied,true);
 assert.equal(await readFile(join(f.root,'resources/board.json'),'utf8'),'new-board');
 assert.equal(await readFile(join(f.root,'.studio/private-marker'),'utf8'),'PRIVATE_UNTOUCHED');
 assert.deepEqual((await updatePublicSdk(f)).changedFiles,[]);
});
test('unknown edits and private target paths fail before any write',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'prompts/agent-system.md'),'user-custom');
 await assert.rejects(updatePublicSdk({...f,apply:true}),{code:'unknown_public_sdk_snapshot'});
 assert.equal(await readFile(join(f.root,'resources/board.json'),'utf8'),'old-board');
 f.profiles.profiles[0].files[0].path='.studio/private-marker';await f.save();
 await assert.rejects(updatePublicSdk({...f,apply:true}),{code:'invalid_update_path'});
});
test('a mid-update failure restores the exact public preimages and keeps a receipt',async t=>{
 const f=await fixture(t);await assert.rejects(updatePublicSdk({...f,apply:true,afterWrite:()=>{throw new Error('injected failure');}}),{code:'sdk_update_failed_rolled_back'});
 assert.equal(await readFile(join(f.root,'resources/board.json'),'utf8'),'old-board');assert.equal(await readFile(join(f.root,'prompts/agent-system.md'),'utf8'),'old-prompt');
 assert.ok((await readdir(f.backupDir)).includes('receipt.json'));
});
test('SDK update rejects target/root links before reading or changing their destination',async t=>{
 const f=await fixture(t),link=join(f.home,'alias');await symlink(f.root,link);
 await assert.rejects(updatePublicSdk({...f,root:link,apply:true}),{code:'unsafe_studio_root'});
 const target=join(f.root,'resources/board.json');await rm(target);await symlink(join(f.root,'.studio/private-marker'),target);
 await assert.rejects(updatePublicSdk({...f,apply:true}),{code:'unsafe_public_path'});
 assert.equal(await readFile(join(f.root,'.studio/private-marker'),'utf8'),'PRIVATE_UNTOUCHED');
});
test('a known manifest with an altered protected template stops the update before writes',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'templates/kibi-base/firmware/display_touch.h'),'different-driver');
 await assert.rejects(updatePublicSdk({...f,apply:true}),{code:'public_template_hash_mismatch'});
 assert.equal(await readFile(join(f.root,'resources/board.json'),'utf8'),'old-board');
});
