import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('installer CLI does not silently skip execution through a directory alias',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kibi-bootstrap-alias-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'real'));
 await copyFile(new URL('../bootstrap.mjs',import.meta.url),join(root,'real/bootstrap.mjs'));
 await symlink(join(root,'real'),join(root,'alias'),'dir');
 const run=spawnSync(process.execPath,[join(root,'alias/bootstrap.mjs'),'--not-a-valid-option'],{encoding:'utf8',timeout:15000});
 assert.equal(run.status,1,'A CLI invocation through an alias must execute and reject invalid arguments');
 assert.match(run.stderr,/Invalid bootstrap argument/);
});
