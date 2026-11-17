import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {upgradePublicProgram} from './upgrade.mjs';
import {patchAutomaticBuildProgram,restoreAutomaticBuildProgram} from './automatic-build-upgrade.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const condition="if(event.status==='completed'&&eventStore===store&&!projectChanging&&intent.epoch===projectEpoch&&current.codeReady&&witnessedTurn(eventStore,event,current,intent.readyVersion)&&current.configuration.revision===intent.configurationRevision)";
const readyVersion='const readyVersion=target=>readyVersions.get(target.projectId)||0;';
const witnessedTurn="const witnessedTurn=(target,event,current,version)=>{const witness=readyWitnesses.get(target.projectId);return Boolean(witness&&witness.version>version&&witness.threadId===event?.threadId&&witness.turnId===event?.turnId&&witness.sourceHash===current.sourceHash&&witness.configurationRevision===current.configuration.revision);};";
const completed=`if(event.type==='chat.completed'&&autoIntent&&autoIntent.store===eventStore&&!building&&(!autoIntent.turnId||autoIntent.turnId===event.turnId)){
 const intent=autoIntent;autoIntent=null;const current=await eventStore.getState();
 ${condition}await startBuild(current.revision,{automatic:true,previousTurnId:event.turnId,expectedStore:eventStore,expectedEpoch:intent.epoch});
 else if(!current.workflow||['coding','testing'].includes(current.workflow.status))await workflow(eventStore,current,'blocked','Завершите код и текущие проверки с ИИ.','ask-ai');
 await announce();
}`;
const source=`export function create(){
 let current={sourceHash:'source-current',revision:7,configuration:{revision:0},codeReady:null,workflow:null};
 const originalStore={projectId:'fixture',getState:async()=>current},readyVersions=new Map(),readyWitnesses=new Map(),builds=[];
 let store=originalStore,projectEpoch=1,projectChanging=false,building=false,autoIntent=null;
 ${readyVersion}
 ${witnessedTurn}
 const workflow=async()=>{},announce=async()=>{},startBuild=async(revision,options)=>{builds.push({revision,configurationRevision:current.configuration.revision,...options});};
 async function chatEvent(event){const eventStore=originalStore;${completed}}
 return{
  request(){autoIntent={store,epoch:projectEpoch,readyVersion:readyVersion(store),configurationRevision:current.configuration.revision,turnId:'turn-current'};},
  check({threadId='thread-current',turnId='turn-current'}={}){
   current.codeReady={sourceHash:current.sourceHash,configurationRevision:current.configuration.revision};
   const ready=current,version=readyVersion(store)+1;readyVersions.set(store.projectId,version);readyWitnesses.set(store.projectId,{version,threadId,turnId,sourceHash:ready.sourceHash,configurationRevision:ready.configuration.revision});
  },
  changeConfiguration(){current.configuration.revision++;},changeSource(){current.sourceHash+='-changed';current.revision++;},advanceEpoch(){projectEpoch++;},
  changeStore(){store={...originalStore};},changing(){projectChanging=true;},busy(){building=true;},
  complete(event={}){return chatEvent({type:'chat.completed',threadId:'thread-current',turnId:'turn-current',status:'completed',...event});},builds
 };
}
//# sourceURL=kibi-automatic-build-fixture.mjs
`;
async function create(patched=true){
 const bytes=patched?patchAutomaticBuildProgram('src/server.mjs',Buffer.from(source)):Buffer.from(source);
 const module=await import('data:text/javascript;base64,'+bytes.toString('base64'));
 return module.create();
}

test('a fresh final witness after a user configuration change starts exactly one current build',async()=>{
 const old=await create(false);old.request();old.changeConfiguration();old.check();await old.complete();assert.equal(old.builds.length,0,'the unchanged gate reproduces the lost automatic build');
 const app=await create();app.request();app.changeConfiguration();app.check();await app.complete();await app.complete();
 assert.equal(app.builds.length,1);assert.equal(app.builds[0].configurationRevision,1);assert.equal(app.builds[0].revision,7);assert.equal(app.builds[0].automatic,true);
});

test('configuration or source changed after the final check never starts a build',async()=>{
 for(const action of ['changeConfiguration','changeSource']){const app=await create();app.request();app.check();app[action]();await app.complete();assert.equal(app.builds.length,0,action);}
});

test('a stale or missing witness, wrong thread/turn, changed epoch or project never starts a build',async()=>{
 const cases=[
  app=>{app.request();},
  app=>{app.check();app.request();},
  app=>{app.request();app.check({threadId:'old-thread'});},
  app=>{app.request();app.check({turnId:'old-turn'});},
  app=>{app.request();app.check();app.advanceEpoch();},
  app=>{app.request();app.check();app.changeStore();},
  app=>{app.request();app.check();app.changing();},
  app=>{app.request();app.check();app.busy();},
 ];
 for(const arrange of cases){const app=await create();arrange(app);await app.complete();assert.equal(app.builds.length,0);}
 const failed=await create();failed.request();failed.check();await failed.complete({status:'failed'});assert.equal(failed.builds.length,0);
});

test('the exact public gate diff is reversible, byte preserving and idempotent',()=>{
 const input=Buffer.from('\ufeff// Сохрани окружение\n'+source),patched=patchAutomaticBuildProgram('src/server.mjs',input);
 assert.deepEqual(restoreAutomaticBuildProgram('src/server.mjs',patched),input);
 assert.deepEqual(patchAutomaticBuildProgram('src/server.mjs',patched),patched);
 assert.ok(patched.includes(Buffer.from(witnessedTurn)));
 assert.equal(patched.toString().split('&&current.configuration.revision===intent.configurationRevision').length,1);
});

test('ambiguous, partial or edited automatic-build guards are rejected by the diff',()=>{
 const input=Buffer.from(source),patched=patchAutomaticBuildProgram('src/server.mjs',input);
 for(const bytes of [Buffer.from(source+condition),Buffer.from(source.replace(condition,'if(true)')),Buffer.from(source.replace('&&!projectChanging','')),Buffer.from('// KIBI_AUTOMATIC_BUILD_CURRENT_WITNESS_V1\n'),Buffer.concat([patched,Buffer.from('changed')]),Buffer.from(patched.toString().replace('&&!projectChanging',''))]){
  assert.throws(()=>patchAutomaticBuildProgram('src/server.mjs',bytes),{code:'upgrade_anchor_mismatch'});
 }
 assert.throws(()=>patchAutomaticBuildProgram('src/other.mjs',input),{code:'upgrade_unknown_baseline'});
 assert.throws(()=>patchAutomaticBuildProgram('src/server.mjs',Buffer.from([0xff])),{code:'upgrade_invalid_program'});
 assert.throws(()=>patchAutomaticBuildProgram('src/server.mjs','text'),{code:'upgrade_invalid_program'});
 assert.throws(()=>restoreAutomaticBuildProgram('src/server.mjs',input),{code:'upgrade_anchor_mismatch'});
});

const reviewedRoot=process.env.KIBI_REVIEWED_STUDIO_ROOT;
test('the actual reviewed r2 server upgrades once without authorizing unknown edits',{skip:!reviewedRoot},async()=>{
 const file=join(reviewedRoot,'src/server.mjs'),info=await lstat(file);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<4*1024*1024);
 const installed=await readFile(file),pin='71fee0562298f894ad1ae5d638e8f3ea66d91968824a893467ed8c2b33c23ece';
 const before=hash(installed)===pin?installed:restoreAutomaticBuildProgram('src/server.mjs',installed);assert.equal(hash(before),pin);
 assert.ok(before.includes(Buffer.from(readyVersion)));assert.ok(before.includes(Buffer.from(witnessedTurn)));assert.ok(before.includes(Buffer.from(condition)));
 const after=upgradePublicProgram('src/server.mjs',before);assert.notEqual(hash(after),hash(before));assert.deepEqual(upgradePublicProgram('src/server.mjs',after),after);
 assert.deepEqual(upgradePublicProgram('src/server.mjs',installed),after);
 assert.deepEqual(restoreAutomaticBuildProgram('src/server.mjs',after),before);
 assert.ok(!after.includes(Buffer.from(condition)));assert.ok(after.includes(Buffer.from(witnessedTurn)));
 for(const bytes of [before,after])assert.throws(()=>upgradePublicProgram('src/server.mjs',Buffer.concat([bytes,Buffer.from('\n// unknown change\n')])),{code:'upgrade_unknown_baseline'});
});
