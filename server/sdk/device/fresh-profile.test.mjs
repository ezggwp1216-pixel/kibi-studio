import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {planFreshSdk,FRESH_SDK_INPUTS} from './fresh-profile.mjs';
import {inspectSdk} from './doctor.mjs';
import {deviceVariantHeader} from '../../studio/device-variants.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const publicRoot=process.env.KIBI_PUBLIC_FRESH_STUDIO_ROOT;
const wanted=code=>error=>error?.code===code;
async function scratch(t){const root=await mkdtemp(join(tmpdir(),'kibi-fresh-sdk-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function put(root,path,bytes){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);}
async function fixture(t){
 const root=await scratch(t),manifest=JSON.parse(await readFile(join(publicRoot,'templates/kibi-base/manifest.json'),'utf8'));
 for(const path of ['resources/board.json','prompts/agent-system.md','templates/kibi-base/manifest.json',...manifest.files.map(f=>'templates/kibi-base/'+f.path)])await put(root,path,await readFile(join(publicRoot,path)));
 return root;
}

test('fresh SDK recipe pins an immutable public lineage and never accepts a caller-supplied baseline',()=>{
 assert.equal(FRESH_SDK_INPUTS.commit,'43d47afb090c9bf6ab69ea46ee559da3c9867616');
 assert.equal(FRESH_SDK_INPUTS.templateManifest,'bb4326bfb56cfc3990b8e96692a733859b559653003dd2b5cf306a4dd09f4567');
 assert.ok(Object.isFrozen(FRESH_SDK_INPUTS));
});

test('unknown manifests fail before any template or project is read',async t=>{
 const root=await scratch(t);
 const edited=Buffer.from('{"files":[]}');await put(root,'templates/kibi-base/manifest.json',edited);
 await assert.rejects(planFreshSdk({root,templateManifest:sha(edited)}),wanted('fresh_sdk_unknown_manifest'));
});

test('linked public roots are refused rather than following a private tree',async t=>{
 const parent=await scratch(t),target=join(parent,'target'),link=join(parent,'link');
 await mkdir(target);await symlink(target,link);
 await assert.rejects(planFreshSdk({root:link}),wanted('fresh_sdk_unsafe_root'));
});

test('exact fresh public source gets all five voice pins and a complete manifest without source writes',{skip:!publicRoot},async t=>{
 const root=await fixture(t),before=await readFile(join(root,'templates/kibi-base/manifest.json'));
 const first=await planFreshSdk({root}),second=await planFreshSdk({root});
 assert.equal(first.ok,true);assert.equal(first.privateProjectsRead,false);assert.equal(first.hardwareVerified,false);
 assert.deepEqual(first.profile,second.profile);assert.deepEqual(first.payloads,second.payloads);
 assert.deepEqual(await readFile(join(root,'templates/kibi-base/manifest.json')),before);
 assert.ok(first.profile.files.every(f=>f.before===null||/^[a-f0-9]{64}$/.test(f.before)));
 const payloads=new Map(first.payloads.map(f=>[f.path,f.bytes]));
 const bytes=async path=>payloads.get(path)||readFile(join(root,path));
 const module=JSON.parse(await readFile(new URL('../../studio/device-modules.json',import.meta.url),'utf8'));
 assert.equal(module.dependencies.length,5);
 for(const d of module.dependencies)assert.ok(d.sha256.includes(sha(await bytes('templates/kibi-base/firmware/'+d.path))),d.path);
 assert.equal(sha(await bytes('templates/kibi-base/firmware/wifi.h')),'06ef13ced44a002c88151a5e4da4be94848b662959a2ecc9df73d30e5e126e16');
 assert.match((await bytes('templates/kibi-base/firmware/config.h')).toString(),/kSpeakerDout\s*=\s*6/);
 const manifest=JSON.parse((await bytes('templates/kibi-base/manifest.json')).toString());
 assert.equal(manifest.files.length,JSON.parse(before).files.length+1);
 assert.ok(!manifest.files.some(f=>/kibi_xiaozhi_(client|core)\.h/.test(f.path)),'voice module must stay opt-in');
 for(const f of manifest.files){const b=await bytes('templates/kibi-base/'+f.path);assert.equal(b.length,f.size,f.path);assert.equal(sha(b),f.sha256,f.path);}
 for(const f of first.profile.files)assert.equal(f.after,sha(payloads.get(f.path)),f.path);
});

test('fresh template compiles with a protected basic speaker gate and exposes only the selected variant',{skip:!publicRoot},async t=>{
 const root=await fixture(t),result=await planFreshSdk({root});
 for(const f of result.payloads)await put(root,f.path,f.bytes);
 const firmware=join(root,'templates/kibi-base/firmware');
 assert.deepEqual(await readFile(join(firmware,'kibi_device_config.h')),deviceVariantHeader('basic'));
 const config=await readFile(join(firmware,'config.h'),'utf8');
 assert.match(config,/^#pragma once\n#include "kibi_device_config\.h"\n/);
 const project=JSON.parse(await readFile(join(root,'templates/kibi-base/project.json'),'utf8'));
 assert.equal(project.deviceVariant,'basic');
 const manifest=JSON.parse(await readFile(join(root,'templates/kibi-base/manifest.json'),'utf8'));
 assert.equal(manifest.files.length,67);
 const gate=manifest.files.find(f=>f.path==='firmware/kibi_device_config.h');
 assert.ok(gate);assert.equal(gate.sha256,sha(deviceVariantHeader('basic')));
 const compile=variant=>execFileSync('c++',['-std=c++17','-I',firmware,'-x','c++','-fsyntax-only','-'],{
  input:'#include "config.h"\nstatic_assert(KIBI_DEVICE_HAS_SPEAKER == '+(variant==='basic'?0:1)+');\nstatic_assert(Tamagotchi::Board::kSpeakerDout == 6);\n',encoding:'utf8',timeout:15000,
 });
 assert.equal(compile('basic'),'');
 await writeFile(join(firmware,'kibi_device_config.h'),deviceVariantHeader('speaker'));
 assert.equal(compile('speaker'),'');
});

test('fresh recipe is a coherent legacy SDK with honest neutral instructions and migration guards',{skip:!publicRoot},async t=>{
 const root=await fixture(t),result=await planFreshSdk({root});
 for(const f of result.payloads)await put(root,f.path,f.bytes);
 const inspected=await inspectSdk(root);assert.equal(inspected.ok,true,JSON.stringify(inspected));
 assert.equal(inspected.wifiFamily,'legacy');assert.equal(inspected.hardwareVerified,false);
 const prompt=await readFile(join(root,'prompts/agent-system.md'),'utf8');
 assert.ok(!prompt.includes('During design only app_view.h is editable'));
 assert.ok(!prompt.includes('Core/view edits invalidate design approval'));
 assert.match(prompt,/app_core\.h and app_view\.h/);
 assert.equal(prompt.split('# Kibi development reliability — authoritative addendum').length,2);
 assert.match(prompt,/kibi_enable_module\(\{module:"xiaozhi"\}\)/);
 assert.match(prompt,/250ms\/256\/360ms/);
 const board=JSON.parse(await readFile(join(root,'resources/board.json'),'utf8'));
 assert.equal(board.deviceVariants.length,2);assert.equal(board.capabilities.audioOutput.hardwareVerified,false);
 const migration=await import(pathToFileURL(join(root,'src/module-migrations.mjs')).href);
 assert.deepEqual(Object.keys(migration.MODULE_FIRMWARE_MIGRATIONS),[]);
 const manifest=JSON.parse(await readFile(join(root,'templates/kibi-base/manifest.json'),'utf8'));
 const files=manifest.files.filter(f=>f.path.startsWith('firmware/')).map(f=>({path:f.path.slice(9),sha256:f.sha256}));
 const pins=Object.fromEntries(files.map(f=>[f.path,f.sha256]));
 assert.deepEqual(migration.moduleReadiness(files,pins),{wifiModuleReady:true,apiModuleReady:true});
 assert.deepEqual(migration.moduleReadiness(files,{...pins,'wifi.h':'0'.repeat(64)}),{wifiModuleReady:false,apiModuleReady:true});
 assert.equal(migration.REVIEWED_FIRMWARE_MIGRATIONS['config.h'].to,pins['config.h']);
});

test('a modified public template is rejected even when all five voice dependency files remain intact',{skip:!publicRoot},async t=>{
 const root=await fixture(t);await writeFile(join(root,'templates/kibi-base/firmware/app_view.h'),'unreviewed');
 await assert.rejects(planFreshSdk({root}),wanted('fresh_sdk_source_mismatch'));
});

test('an existing unknown migration is not overwritten by the fresh SDK recipe',{skip:!publicRoot},async t=>{
 const root=await fixture(t);await put(root,'src/device-migrations.mjs',Buffer.from('unknown edit'));
 await assert.rejects(planFreshSdk({root}),wanted('fresh_sdk_unexpected_file'));
});

test('a changed trusted payload is rejected before a migration plan is returned',{skip:!publicRoot},async t=>{
 const root=await fixture(t),kit=await scratch(t);
 // Only this explicit kit input is needed to fail its independent pin.
 await put(kit,'overlays/files/74c1dcd37618e6d9c59946989c3796d8c67fb7a63f830b6d626012f48245c5c6.txt',Buffer.from('edited payload'));
 await assert.rejects(planFreshSdk({root,kitRoot:kit}),wanted('fresh_sdk_payload_mismatch'));
});
