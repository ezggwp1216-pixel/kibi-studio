import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, lstat, mkdir, writeFile, symlink, link, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/init.mjs');
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'kibi-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, data: join(root, 'private', 'data') };
}
function init(data) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, KIBI_DATA_DIR: data }, encoding: 'utf8',
  });
}

test('creates a private random password without printing it', async t => {
  const { data } = await fixture(t);
  const result = init(data);
  assert.equal(result.status, 0, result.stderr);
  const password = (await readFile(join(data, 'admin-password'), 'utf8')).trim();
  assert.match(password, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await lstat(data)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(data, 'admin-password'))).mode & 0o777, 0o600);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
});

test('repeat initialization preserves password, key and state byte for byte', async t => {
  const { data } = await fixture(t);
  assert.equal(init(data).status, 0);
  const password = await readFile(join(data, 'admin-password'));
  await writeFile(join(data, 'master.key'), 'existing key', { mode: 0o600 });
  await writeFile(join(data, 'state.json'), '{"keep":"all data"}', { mode: 0o600 });
  const result = init(data);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(join(data, 'admin-password')), password);
  assert.equal(await readFile(join(data, 'master.key'), 'utf8'), 'existing key');
  assert.equal(await readFile(join(data, 'state.json'), 'utf8'), '{"keep":"all data"}');
});

test('refuses to replace a missing password in an existing data set', async t => {
  const { data } = await fixture(t);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(data, 'master.key'), 'keep', { mode: 0o600 });
  assert.notEqual(init(data).status, 0);
  await assert.rejects(readFile(join(data, 'admin-password')), { code: 'ENOENT' });
  assert.equal(await readFile(join(data, 'master.key'), 'utf8'), 'keep');
});

test('rejects directory and parent symlinks without writing through them', async t => {
  const { root } = await fixture(t);
  const target = join(root, 'target');
  await mkdir(target);
  await symlink(target, join(root, 'alias'));
  assert.notEqual(init(join(root, 'alias', 'data')).status, 0);
  await assert.rejects(lstat(join(target, 'data')), { code: 'ENOENT' });
  assert.notEqual(init(join(root, 'alias')).status, 0);
});

test('rejects secret symlinks and hardlinks without modifying their targets', async t => {
  const { root, data } = await fixture(t);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const target = join(root, 'secret');
  await writeFile(target, 'do not touch', { mode: 0o644 });
  await symlink(target, join(data, 'admin-password'));
  assert.notEqual(init(data).status, 0);
  await rm(join(data, 'admin-password'));
  await link(target, join(data, 'admin-password'));
  assert.notEqual(init(data).status, 0);
  assert.equal(await readFile(target, 'utf8'), 'do not touch');
  assert.equal((await lstat(target)).mode & 0o777, 0o644);
});

test('rejects linked stored data even when the admin password is safe', async t => {
  const { root, data } = await fixture(t);
  assert.equal(init(data).status, 0);
  const target = join(root, 'target');
  await writeFile(target, 'keep');
  await link(target, join(data, 'state.json'));
  assert.notEqual(init(data).status, 0);
  assert.equal(await readFile(target, 'utf8'), 'keep');
});

test('refuses an empty existing password rather than overwriting it', async t => {
  const { data } = await fixture(t);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(data, 'admin-password'), '', { mode: 0o600 });
  assert.notEqual(init(data).status, 0);
  assert.equal(await readFile(join(data, 'admin-password'), 'utf8'), '');
});

test('help and unsupported arguments never initialize a data directory', async t => {
  const { data } = await fixture(t);
  const help = spawnSync(process.execPath, [script, '--help'], {
    env: { ...process.env, KIBI_DATA_DIR: data }, encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  await assert.rejects(lstat(data), { code: 'ENOENT' });
  const invalid = spawnSync(process.execPath, [script, '--overwrite'], {
    env: { ...process.env, KIBI_DATA_DIR: data }, encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  await assert.rejects(lstat(data), { code: 'ENOENT' });
});
