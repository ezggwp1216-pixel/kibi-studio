import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
test('published Studio overlay matches its pinned release and contains only explicit public program files',async()=>{
 const release=JSON.parse(await readFile(new URL('studio/release.json',root))),bytes=await readFile(new URL('studio/'+release.archive,root));
 assert.equal(release.release,'studio-platform-2026-11-17-complete-r3');
 assert.equal(release.fullStudio,false);assert.equal(release.kind,'public-studio-overlay');assert.equal(release.bytes,bytes.length);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),release.sha256);
 const entries=execFileSync('tar',['-tzf',fileURLToPath(new URL('studio/'+release.archive,root))],{encoding:'utf8'}).trim().split('\n');
 assert.deepEqual(entries.sort(),Object.keys(release.files).sort());
 const added=['studio/png-raster.mjs','studio/portable-design-upgrade.mjs','studio/new-project-upgrade.mjs','studio/module-upgrade.mjs','studio/project-readiness.mjs','studio/device-modules.mjs','studio/device-modules.json','studio/device-module-install.mjs','sdk/device/source/kibi_xiaozhi_core.h','sdk/device/source/kibi_xiaozhi_client.h','docs/LOCAL_STUDIO.md','docs/SDK.md','docs/SDK_UPDATE.md','docs/STUDIO_CONNECTION.md'];
 for(const name of added)assert.ok(entries.includes(name),name);
 for(const name of ['studio/automatic-build-upgrade.mjs','studio/local-install-source.mjs','studio/full-install-upgrade.mjs','studio/fresh-server-upgrade.mjs','studio/fresh-ui-upgrade.mjs','studio/device-variants.mjs'])assert.ok(entries.includes(name));assert.equal(entries.length,33);assert.ok(entries.every(name=>/^(?:(studio|docs)\/[A-Za-z0-9_.-]+|sdk\/device\/source\/kibi_xiaozhi_(?:core|client)\.h)$/.test(name)));
 assert.ok(entries.every(name=>!/(projects|\.studio|private|auth|\.bin|\.data)/.test(name)));
 // This release is immutable: verify every historical payload in its archive.
 // Current guides are verified separately by support-r4 and full-Studio cohorts.
 for(const name of entries){
  const archived=execFileSync('tar',['-xOzf',fileURLToPath(new URL('studio/'+release.archive,root)),name]);
  assert.equal(createHash('sha256').update(archived).digest('hex'),release.files[name],name+' archived');
  if(!name.startsWith('docs/')){
   const actual=await readFile(new URL(name,root));
   assert.equal(createHash('sha256').update(actual).digest('hex'),release.files[name],name);
  }
 }
});
