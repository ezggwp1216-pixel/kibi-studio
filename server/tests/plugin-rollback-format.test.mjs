import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/retire-plugin-links.mjs', import.meta.url));
const five = ['pairing.claim', 'devices.list', 'voice.status', 'voice.activate', 'catalog.read'];
const seven = [...five, 'assistant.read', 'assistant.write'];
const ten = [...seven, 'plugins.read', 'plugins.publish', 'plugins.bind'];
const createdAt = '2026-11-17T00:00:00.000Z';
const sha = raw => createHash('sha256').update(raw).digest('hex');
const code = (digit, plugin = false) => ({ codeHash: digit.repeat(64), createdAt, expiresAt: '2026-11-17T00:10:00.000Z', ...(plugin ? { pluginAccess: true } : {}) });
const connection = (scopes, digit) => ({ id: randomUUID(), label: `private-${digit}@example.invalid`, createdAt, expiresAt: '2027-02-15T00:00:00.000Z', scopes, tokenHash: digit.repeat(64) });

async function fixture(t, { missing = false } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'kibi-rollback-')));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  const registryPath = join(dataDir, 'studio-links.json');
  const backup = join(dir, 'before.json');
  const old5 = connection(five, '1'), old7 = connection(seven, '2'), plugin = connection(ten, '3');
  const ordinaryCode = code('4'), pluginCode = code('5', true);
  // These raw legacy records deliberately use unusual whitespace and escapes.
  const old5Raw = JSON.stringify(old5, null, 3).replace('private-', '\\u0070rivate-');
  const old7Raw = JSON.stringify(old7, null, '\t');
  const ordinaryCodeRaw = JSON.stringify(ordinaryCode, null, 2);
  const registry = { version: 1, accounts: [
    { id: randomUUID(), code: ordinaryCode, connections: [old5, plugin, old7] },
    { id: randomUUID(), code: pluginCode, connections: [connection(ten, '6')] },
  ] };
  const raw = `{ "version" : 1, "accounts" : [\n{ "id":${JSON.stringify(registry.accounts[0].id)}, "code":${ordinaryCodeRaw}, "connections":[${old5Raw},\n${JSON.stringify(plugin)},\n${old7Raw}] },\n${JSON.stringify(registry.accounts[1])}\n] }\n`;
  if (!missing) await writeFile(registryPath, raw, { mode: 0o600 });
  const sentinels = ['accounts.json', 'state.json', 'encryption.key', 'devices.json', 'xiaozhi.json'];
  for (const name of sentinels) await writeFile(join(dataDir, name), `untouched-${name}`, { mode: 0o600 });
  await mkdir(join(dataDir, 'plugins'), { mode: 0o700 });
  await writeFile(join(dataDir, 'plugins', 'registry.json'), 'untouched-plugin-registry', { mode: 0o600 });
  return { dir, dataDir, registryPath, backup, registry, raw, old5Raw, old7Raw, ordinaryCodeRaw, sentinels };
}

async function cli(args, { preload } = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [...(preload ? ['--import', preload] : []), script, ...args], { cwd: tmpdir(), env: { PATH: process.env.PATH }, maxBuffer: 100_000 });
    return { status: 0, stdout, stderr };
  } catch (error) { return { status: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
const applyArgs = f => ['--data-dir', f.dataDir, '--apply', '--expected-sha256', sha(f.raw), '--backup', f.backup, '--confirm-server-stopped'];
async function unchanged(f, expected = f.raw) {
  assert.equal(await readFile(f.registryPath, 'utf8'), expected);
  for (const name of f.sentinels) assert.equal(await readFile(join(f.dataDir, name), 'utf8'), `untouched-${name}`);
  assert.equal(await readFile(join(f.dataDir, 'plugins', 'registry.json'), 'utf8'), 'untouched-plugin-registry');
}
function publicOutput(result, f) {
  const output = result.stdout + result.stderr;
  for (const account of f.registry.accounts) {
    assert.ok(!output.includes(account.id));
    assert.ok(!output.includes(account.code.codeHash));
    for (const item of account.connections) for (const value of [item.id, item.label, item.tokenHash]) assert.ok(!output.includes(value));
  }
  assert.ok(!output.includes(f.dataDir));
  assert.ok(!output.includes(f.backup));
}

test('dry-run reports only counts and file hashes without writing any files', async t => {
  const f = await fixture(t);
  const beforeFiles = await readdir(f.dataDir), before = await lstat(f.registryPath, { bigint: true });
  const result = await cli(['--data-dir', f.dataDir]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report).sort(), ['accounts', 'changedFiles', 'preservedConnections', 'preservedPendingCodes', 'registryFiles', 'resultSha256', 'revokedPluginConnections', 'revokedPluginPendingCodes', 'sourceSha256'].sort());
  assert.equal(report.registryFiles, 1);
  assert.equal(report.accounts, 2);
  assert.equal(report.preservedConnections, 2);
  assert.equal(report.revokedPluginConnections, 2);
  assert.equal(report.preservedPendingCodes, 1);
  assert.equal(report.revokedPluginPendingCodes, 1);
  assert.equal(report.changedFiles, 0);
  assert.equal(report.sourceSha256, sha(f.raw));
  assert.match(report.resultSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(f.dataDir), beforeFiles);
  assert.deepEqual(await readdir(f.dir), ['data']);
  const after = await lstat(f.registryPath, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  await unchanged(f);
  publicOutput(result, f);
});

test('apply revokes only plugin grants, retains legacy bytes and writes a private exact backup', async t => {
  const f = await fixture(t);
  const dry = JSON.parse((await cli(['--data-dir', f.dataDir])).stdout);
  const result = await cli(applyArgs(f));
  assert.equal(result.status, 0, result.stderr);
  const migratedRaw = await readFile(f.registryPath, 'utf8');
  const migrated = JSON.parse(migratedRaw);
  assert.deepEqual(migrated, { version: 1, accounts: [
    { ...f.registry.accounts[0], connections: [f.registry.accounts[0].connections[0], f.registry.accounts[0].connections[2]] },
    { ...f.registry.accounts[1], code: null, connections: [] },
  ] });
  for (const raw of [f.old5Raw, f.old7Raw, f.ordinaryCodeRaw]) assert.ok(migratedRaw.includes(raw));
  assert.equal(await readFile(f.backup, 'utf8'), f.raw);
  for (const path of [f.backup, f.registryPath]) {
    const stat = await lstat(path);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
  }
  const report = JSON.parse(result.stdout);
  assert.equal(report.changedFiles, 1);
  assert.equal(report.backupSha256, sha(f.raw));
  assert.equal(report.resultSha256, sha(migratedRaw));
  assert.equal(report.resultSha256, dry.resultSha256);
  await unchanged(f, migratedRaw);
  assert.deepEqual((await readdir(f.dataDir)).filter(name => name.startsWith('.studio-links-')), []);
  publicOutput(result, f);
});

test('the same apply command is an idempotent no-op and creates no second backup', async t => {
  const f = await fixture(t);
  assert.equal((await cli(applyArgs(f))).status, 0);
  const before = await readFile(f.registryPath), originalBackup = await readFile(f.backup);
  const result = await cli(applyArgs(f));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changedFiles, 0);
  assert.equal(JSON.parse(result.stdout).revokedPluginConnections, 0);
  assert.deepEqual(await readFile(f.registryPath), before);
  assert.deepEqual(await readFile(f.backup), originalBackup);
  assert.deepEqual((await readdir(f.dir)).sort(), ['before.json', 'data']);
});

test('a missing Studio registry is a dry-run and apply no-op without a backup', async t => {
  const f = await fixture(t, { missing: true });
  for (const args of [['--data-dir', f.dataDir], applyArgs(f)]) {
    const result = await cli(args);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.registryFiles, 0);
    assert.equal(report.changedFiles, 0);
    assert.equal(report.sourceSha256, null);
  }
  assert.deepEqual(await readdir(f.dir), ['data']);
  assert.ok(!(await readdir(f.dataDir)).includes('studio-links.json'));
});

test('CLI requires an explicit directory and every apply acknowledgement', async t => {
  const f = await fixture(t);
  const complete = applyArgs(f);
  const bad = [[], ['--wat'], ['--data-dir'], ['--data-dir', f.dataDir, '--data-dir', f.dataDir], ['--data-dir', f.dataDir, '--expected-sha256', sha(f.raw)]];
  for (const flag of ['--expected-sha256', '--backup', '--confirm-server-stopped']) {
    const args = [...complete], index = args.indexOf(flag);
    args.splice(index, flag === '--confirm-server-stopped' ? 1 : 2);
    bad.push(args);
  }
  bad.push(complete.map(arg => arg === sha(f.raw) ? 'not-a-sha' : arg));
  for (const args of bad) {
    const result = await cli(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    publicOutput(result, f);
  }
  await unchanged(f);
  assert.deepEqual(await readdir(f.dir), ['data']);
});

test('a changed hash fails before backup or data writes', async t => {
  const f = await fixture(t);
  const args = applyArgs(f).map(arg => arg === sha(f.raw) ? '0'.repeat(64) : arg);
  const result = await cli(args);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registry_changed/);
  await unchanged(f);
  assert.deepEqual(await readdir(f.dir), ['data']);
});

test('an existing backup is never overwritten', async t => {
  const f = await fixture(t);
  await writeFile(f.backup, 'keep-private-backup', { mode: 0o600 });
  const result = await cli(applyArgs(f));
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(f.backup, 'utf8'), 'keep-private-backup');
  await unchanged(f);
});

test('unknown schema, duplicate fields and unknown or reordered scopes fail closed', async t => {
  const f = await fixture(t);
  const forms = [
    raw => raw.replace('"version" : 1', '"version" : 2'),
    raw => raw.replace('"version" : 1', '"version":1,"version":1'),
    raw => raw.replace('"version" : 1', '"unexpected":true,"version":1'),
    raw => raw.replace('"pluginAccess":true', '"pluginAccess":false'),
    raw => raw.replace('"plugins.bind"', '"devices.write"'),
    raw => raw.replace('"plugins.read","plugins.publish"', '"plugins.publish","plugins.read"'),
    raw => raw.replace('"codeHash"', '"extra":true,"codeHash"'),
    raw => raw.replace('2027-02-15', '2027-02-16'),
    raw => raw.replace('"tokenHash"', '"secret":"do-not-print","tokenHash"'),
    () => '{"version":1,"accounts":',
  ];
  for (const mutate of forms) {
    const raw = mutate(f.raw);
    await writeFile(f.registryPath, raw, { mode: 0o600 });
    const result = await cli(applyArgs({ ...f, raw }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid_studio_links/);
    assert.equal(result.stdout, '');
    assert.equal(await readFile(f.registryPath, 'utf8'), raw);
    assert.ok(!result.stderr.includes('do-not-print'));
    publicOutput(result, f);
  }
  assert.deepEqual(await readdir(f.dir), ['data']);
});

test('unsafe directory and registry modes are rejected without repairing them', async t => {
  const f = await fixture(t);
  for (const [path, mode, restore] of [[f.dataDir, 0o755, 0o700], [f.registryPath, 0o644, 0o600]]) {
    await chmod(path, mode);
    for (const args of [['--data-dir', f.dataDir], applyArgs(f)]) assert.notEqual((await cli(args)).status, 0);
    assert.equal((await lstat(path)).mode & 0o777, mode);
    await chmod(path, restore);
  }
  await unchanged(f);
  assert.deepEqual(await readdir(f.dir), ['data']);
});

test('registry symlinks and hardlinks are rejected', async t => {
  const f = await fixture(t);
  const real = join(f.dataDir, 'actual.json');
  await writeFile(real, f.raw, { mode: 0o600 });
  await rm(f.registryPath);
  await symlink(real, f.registryPath);
  assert.notEqual((await cli(applyArgs(f))).status, 0);
  await rm(f.registryPath);
  await link(real, f.registryPath);
  assert.notEqual((await cli(applyArgs(f))).status, 0);
  assert.equal(await readFile(real, 'utf8'), f.raw);
  assert.deepEqual(await readdir(f.dir), ['data']);
});

test('a linked data directory or ancestor and a linked backup destination are rejected', async t => {
  const f = await fixture(t);
  const alias = join(f.dir, 'data-alias');
  await symlink(f.dataDir, alias);
  for (const dataDir of [alias, join(alias, '..', 'data')]) {
    // resolve() deliberately normalizes '..'; only actual linked components are forbidden.
    if (resolve(dataDir) === f.dataDir) continue;
    assert.notEqual((await cli(['--data-dir', dataDir])).status, 0);
  }
  await symlink(join(f.dir, 'outside.json'), f.backup);
  assert.notEqual((await cli(applyArgs(f))).status, 0);
  await unchanged(f);
});

test('backup parent must be an existing owned private directory', async t => {
  const f = await fixture(t);
  const unsafe = join(f.dir, 'unsafe');
  await mkdir(unsafe, { mode: 0o755 });
  for (const backup of [join(unsafe, 'copy.json'), join(f.dir, 'missing', 'copy.json')]) {
    const args = applyArgs(f).map(arg => arg === f.backup ? backup : arg);
    assert.notEqual((await cli(args)).status, 0);
  }
  await unchanged(f);
  assert.deepEqual(await readdir(unsafe), []);
});

test('a registry changed after the backup is revalidated before atomic replacement', async t => {
  const f = await fixture(t);
  const raced = `${f.raw} `;
  const preload = join(f.dir, 'race.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';\nimport { syncBuiltinESMExports } from 'node:module';\nconst original = fs.open;\nfs.open = async function(path, ...args) {\n const handle = await original.call(this, path, ...args);\n if (path === ${JSON.stringify(f.backup)}) {\n  const sync = handle.sync.bind(handle);\n  handle.sync = async () => { await sync(); await fs.writeFile(${JSON.stringify(f.registryPath)}, ${JSON.stringify(raced)}); };\n }\n return handle;\n};\nsyncBuiltinESMExports();\n`, { mode: 0o600 });
  const result = await cli(applyArgs(f), { preload });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registry_changed/);
  assert.equal(await readFile(f.registryPath, 'utf8'), raced);
  assert.equal(await readFile(f.backup, 'utf8'), f.raw);
  assert.deepEqual((await readdir(f.dataDir)).filter(name => name.startsWith('.studio-links-')), []);
  publicOutput(result, f);
});

test('directory and registry ownership checks reject a different reported owner', async t => {
  if (typeof process.getuid !== 'function') return t.skip('POSIX ownership required');
  const f = await fixture(t);
  const directoryPreload = join(f.dir, 'directory-owner.mjs');
  await writeFile(directoryPreload, 'const uid = process.getuid(); process.getuid = () => uid + 1;\n', { mode: 0o600 });
  assert.notEqual((await cli(applyArgs(f), { preload: directoryPreload })).status, 0);
  const filePreload = join(f.dir, 'file-owner.mjs');
  await writeFile(filePreload, `import fs from 'node:fs/promises';\nimport { syncBuiltinESMExports } from 'node:module';\nconst original = fs.open;\nfs.open = async function(path, ...args) {\n const handle = await original.call(this, path, ...args);\n if (path === ${JSON.stringify(f.registryPath)}) {\n  const stat = handle.stat.bind(handle);\n  handle.stat = async () => { const actual = await stat(); Object.defineProperty(actual, 'uid', {value:process.getuid() + 1}); return actual; };\n }\n return handle;\n};\nsyncBuiltinESMExports();\n`, { mode: 0o600 });
  const result = await cli(applyArgs(f), { preload: filePreload });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe_private_file/);
  await unchanged(f);
  assert.ok(!(await readdir(f.dir)).includes('before.json'));
});

test('a registry changed after temporary-file flush prevents replacement and removes the temp file', async t => {
  const f = await fixture(t);
  const raced = `${f.raw}\n`;
  const preload = join(f.dir, 'late-race.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';\nimport { syncBuiltinESMExports } from 'node:module';\nconst original = fs.open;\nfs.open = async function(path, ...args) {\n const handle = await original.call(this, path, ...args);\n if (String(path).includes('.studio-links-rollback-')) {\n  const sync = handle.sync.bind(handle);\n  handle.sync = async () => { await sync(); await fs.writeFile(${JSON.stringify(f.registryPath)}, ${JSON.stringify(raced)}); };\n }\n return handle;\n};\nsyncBuiltinESMExports();\n`, { mode: 0o600 });
  const result = await cli(applyArgs(f), { preload });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registry_changed/);
  await unchanged(f, raced);
  assert.equal(await readFile(f.backup, 'utf8'), f.raw);
  assert.deepEqual((await readdir(f.dataDir)).filter(name => name.startsWith('.studio-links-')), []);
});

test('a backup modified before commit prevents registry replacement', async t => {
  const f = await fixture(t);
  const preload = join(f.dir, 'backup-race.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';\nimport { syncBuiltinESMExports } from 'node:module';\nconst original = fs.open;\nfs.open = async function(path, ...args) {\n const handle = await original.call(this, path, ...args);\n if (String(path).includes('.studio-links-rollback-')) {\n  const sync = handle.sync.bind(handle);\n  handle.sync = async () => { await sync(); await fs.writeFile(${JSON.stringify(f.backup)}, 'changed-backup'); };\n }\n return handle;\n};\nsyncBuiltinESMExports();\n`, { mode: 0o600 });
  const result = await cli(applyArgs(f), { preload });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backup_verification_failed/);
  await unchanged(f);
  assert.deepEqual((await readdir(f.dataDir)).filter(name => name.startsWith('.studio-links-')), []);
});

test('atomic rename failure retains source and exact backup without temporary debris', async t => {
  const f = await fixture(t);
  const preload = join(f.dir, 'rename-failure.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';\nimport { syncBuiltinESMExports } from 'node:module';\nfs.rename = async () => { throw Object.assign(new Error('do-not-print-filesystem-error'), {code:'EIO'}); };\nsyncBuiltinESMExports();\n`, { mode: 0o600 });
  const result = await cli(applyArgs(f), { preload });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'rollback_failed\n');
  await unchanged(f);
  assert.equal(await readFile(f.backup, 'utf8'), f.raw);
  assert.deepEqual((await readdir(f.dataDir)).filter(name => name.startsWith('.studio-links-')), []);
});
