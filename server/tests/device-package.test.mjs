import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,writeFile,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {packageDeviceSupport} from '../scripts/package-device-support.mjs';
const run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
test('public support package is reproducible, roundtrips with system tar and contains only manifested public files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kibi-support-tar-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=await packageDeviceSupport(),second=await packageDeviceSupport();assert.deepEqual(first.archive,second.archive);
 const archive=join(root,'kit.tar.gz');await writeFile(archive,first.archive);await mkdir(join(root,'extract'));
 await run('tar',['-xzf',archive,'-C',join(root,'extract')],{timeout:10000});
 const kit=join(root,'extract/kibi-device-support'),manifest=JSON.parse(await readFile(join(kit,'manifest.json'),'utf8'));
 for(const file of manifest.files){assert.ok(!/\.studio|^projects\/|settings\.json|auth\.json|\.bin$/.test(file.path),file.path);const bytes=await readFile(join(kit,file.path));assert.equal(bytes.length,file.size);assert.equal(sha(bytes),file.sha256);}
 assert.equal(sha(await readFile(join(kit,'manifest.json'))),first.release.manifestSha256);
 assert.equal((await lstat(join(kit,'overlays/files'))).mode&0o777,0o755);
 const plan=await run(process.execPath,[join(kit,'update.mjs')],{timeout:5000}).catch(e=>e);assert.equal(JSON.parse(plan.stdout).code,'studio_root_required');
});
