import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {upgradePublicProgram,PUBLIC_STUDIO_BASELINES} from './upgrade.mjs';
import {patchFullInstallProgram,restoreFullInstallProgram} from './full-install-upgrade.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const block=`      const response = await fetch(\`/api/build/\${encodeURIComponent(job.id)}/app.bin\`, { cache: 'no-store', credentials: 'same-origin' }); if (!response.ok) throw new Error(\`Не удалось загрузить сборку (\${response.status})\`);
      const source = await runtime.flasherApi.loadApplication(new File([await response.arrayBuffer()], 'app.bin', { type: 'application/octet-stream' }));
      if (source.files[0].sha256 !== artifact.sha256 || source.files[0].size !== artifact.size) throw new Error('SHA-256 или размер скачанной сборки не совпадает с заданием');`;
const fixture=`import {initStudioAccountUI} from './studio-account.js';
async function prepareFlash(){
 const expectedIdentity = flashIdentity(state), job = state.build, artifact = appArtifact(job);
${block}
 const plan = await runtime.flasher.prepare(source), latest = await refreshState(); if (expectedIdentity !== flashIdentity(latest)) throw new Error('Проект изменился');
 gate.prepare(latest, plan, artifact.sha256);
}
async function writeFirmware(){if(gate.approved&&gate.valid(state))await runtime.flasher.write(gate.take(state));}
`;
test('the public UI changes source preparation while retaining current-job and explicit-write gates',()=>{
 const patched=patchFullInstallProgram('web/app.js',Buffer.from(fixture)).toString();
 assert.ok(patched.includes("import {loadLocalInstallSource} from './local-install-source.js';"));
 assert.ok(patched.includes("import {parsePartitions,validateLocalPartitions} from './vendor/flash-core.js';"));
 assert.ok(patched.includes('device: runtime.flasher.device'));assert.ok(patched.includes('expectedIdentity !== flashIdentity(latest)'));assert.ok(patched.includes('gate.prepare(latest, plan, artifact.sha256)'));assert.ok(patched.includes('if(gate.approved&&gate.valid(state))await runtime.flasher.write(gate.take(state))'));
});
test('the install-source patch is exact, reversible and rejects incomplete or duplicate edits',()=>{
 const input=Buffer.from('\ufeff'+fixture),final=patchFullInstallProgram('web/app.js',input);
 assert.deepEqual(restoreFullInstallProgram('web/app.js',final),input);assert.deepEqual(patchFullInstallProgram('web/app.js',final),final);
 for(const bytes of [Buffer.from(fixture+block),Buffer.from(fixture.replace(block,'')),Buffer.from(final.toString().replace('device: runtime.flasher.device','device: otherDevice')),Buffer.concat([final,Buffer.from('edit')]),Buffer.from('// KIBI_LOCAL_FULL_INSTALL_V1\n')])assert.throws(()=>patchFullInstallProgram('web/app.js',bytes),{code:'upgrade_anchor_mismatch'});
 assert.throws(()=>patchFullInstallProgram('web/other.js',input),{code:'upgrade_unknown_baseline'});assert.throws(()=>patchFullInstallProgram('web/app.js',Buffer.from([0xff])),{code:'upgrade_invalid_program'});
});
const root=process.env.KIBI_REVIEWED_STUDIO_ROOT;
test('the exact reviewed public browser program upgrades idempotently and rejects arbitrary edits',{skip:!root},async()=>{
 const path=join(root,'web/app.js'),info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<4*1024*1024);
 const installed=await readFile(path),before=hash(installed)===PUBLIC_STUDIO_BASELINES['web/app.js'].afterSha256?installed:restoreFullInstallProgram('web/app.js',installed);
 assert.equal(hash(before),PUBLIC_STUDIO_BASELINES['web/app.js'].afterSha256);
 const final=upgradePublicProgram('web/app.js',before);assert.deepEqual(upgradePublicProgram('web/app.js',installed),final);assert.deepEqual(upgradePublicProgram('web/app.js',final),final);assert.deepEqual(restoreFullInstallProgram('web/app.js',final),before);
 for(const bytes of [before,final])assert.throws(()=>upgradePublicProgram('web/app.js',Buffer.concat([bytes,Buffer.from('\n// arbitrary local edit\n')])),{code:'upgrade_unknown_baseline'});
});
