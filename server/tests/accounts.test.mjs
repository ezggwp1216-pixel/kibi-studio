import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod, symlink, link, mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAccounts } from '../src/accounts.mjs';

const password = 'a private account password';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kibi-accounts-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, path: join(dataDir, 'accounts.json'), accounts: await openAccounts(dataDir) };
}

test('registration returns a safe normalized user and does not create tenant directories', async t => {
  const { accounts, dataDir } = await fixture(t);
  assert.deepEqual(accounts.list(), []);
  for (const file of await readdir(dataDir)) assert.equal((await stat(join(dataDir, file))).isFile(), true);
  const user = await accounts.register('  Alice@Example.Test  ', password);
  assert.match(user.id, uuid);
  assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'email', 'id', 'role']);
  assert.equal(user.email, 'alice@example.test');
  assert.equal(user.role, 'user');
  assert.equal(new Date(user.createdAt).toISOString(), user.createdAt);
  assert.equal(accounts.dataDirFor(user.id), join(await realpath(dataDir), 'accounts', user.id));
  assert.deepEqual(accounts.get(user.id), user);
  assert.equal(accounts.get(randomUUID()), null);
  user.email = 'changed@example.test';
  const listed = accounts.list();
  listed[0].role = 'owner';
  listed.push({ id: randomUUID() });
  assert.equal(accounts.get(user.id).email, 'alice@example.test');
  assert.equal(accounts.get(user.id).role, 'user');
  assert.equal(accounts.list().length, 1);
  for (const file of await readdir(dataDir)) assert.equal((await stat(join(dataDir, file))).isFile(), true);
});

test('salted password hashes persist privately and authenticate after reopening', async t => {
  const { accounts, dataDir, path } = await fixture(t);
  const first = await accounts.register('alice@example.test', password);
  await accounts.register('bob@example.test', password);
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes(password), false);
  const stored = JSON.parse(raw);
  assert.equal(stored.version, 1);
  assert.equal(stored.users.length, 2);
  assert.match(stored.users[0].password.salt, /^[0-9a-f]{32,}$/);
  assert.match(stored.users[0].password.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.users[0].password.salt, stored.users[1].password.salt);
  assert.notEqual(stored.users[0].password.hash, stored.users[1].password.hash);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  const reopened = await openAccounts(dataDir);
  assert.deepEqual(await reopened.authenticate('  ALICE@EXAMPLE.TEST ', password), first);
  assert.equal(await reopened.authenticate('alice@example.test', 'a different long password'), null);
  assert.equal(await reopened.authenticate('missing@example.test', password), null);
});

test('invalid registration is bounded before hashing or creating a user', async t => {
  const { accounts } = await fixture(t);
  const cases = [
    [null, password], ['alice', password], ['a@@example.test', password],
    ['a b@example.test', password], ['алиса@example.test', password],
    ['a@example..test', password], ['.alice@example.test', password],
    ['alice..test@example.test', password], ['a'.repeat(65) + '@example.test', password],
    ['a@' + 'b'.repeat(248) + '.test', password], ['alice@example.test', null],
    ['alice@example.test', 'a'.repeat(11)], ['alice@example.test', 'a'.repeat(1025)],
  ];
  for (const [email, value] of cases) {
    await assert.rejects(accounts.register(email, value), { status: 400, code: 'invalid_registration' });
  }
  assert.deepEqual(accounts.list(), []);
  assert.equal(await accounts.authenticate(null, password), null);
  assert.equal(await accounts.authenticate('alice@example.test', null), null);
  await accounts.register('minimum@example.test', 'a'.repeat(12));
  await accounts.register('maximum@example.test', 'a'.repeat(1024));
});

test('dataDirFor rejects identifiers that could escape the account directory', async t => {
  const { accounts } = await fixture(t);
  for (const id of [null, '', '../owner', '/tmp/other', 'owner', randomUUID() + '/../../owner']) {
    assert.throws(() => accounts.dataDirFor(id), { status: 400, code: 'invalid_account' });
  }
});

test('concurrent duplicate registrations have one winner and preserve its password', async t => {
  const { accounts, dataDir } = await fixture(t);
  const results = await Promise.allSettled([
    accounts.register('Alice@example.test', password),
    accounts.register(' alice@EXAMPLE.test ', 'another private password'),
    accounts.register('ALICE@example.test', 'third private password'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) {
    assert.equal(result.reason.status, 409);
    assert.equal(result.reason.code, 'account_unavailable');
  }
  assert.equal(accounts.list().length, 1);
  await assert.rejects(accounts.register('alice@example.test', password), { status: 409, code: 'account_unavailable' });
  assert.equal((await openAccounts(dataDir)).list().length, 1);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  const winningPassword = [password, 'another private password', 'third private password'][winner];
  assert.equal((await accounts.authenticate('alice@example.test', winningPassword)).id, accounts.list()[0].id);
});

test('concurrent distinct registrations do not lose persisted users', async t => {
  const { accounts, dataDir } = await fixture(t);
  const users = await Promise.all(['one', 'two', 'three', 'four'].map(name => accounts.register(name + '@example.test', password)));
  assert.equal(new Set(users.map(user => user.id)).size, 4);
  assert.deepEqual((await openAccounts(dataDir)).list().map(user => user.email).sort(), [
    'four@example.test', 'one@example.test', 'three@example.test', 'two@example.test',
  ]);
});

test('KDF work for unknown accounts shares the four-work limit with registration', async t => {
  const { accounts } = await fixture(t);
  const work = Array.from({ length: 4 }, (_, index) => accounts.authenticate(`missing-${index}@example.test`, password));
  await assert.rejects(accounts.authenticate('another@example.test', password), { status: 503, code: 'server_busy' });
  await assert.rejects(accounts.register('new@example.test', password), { status: 503, code: 'server_busy' });
  assert.deepEqual(await Promise.all(work), [null, null, null, null]);
  assert.equal((await accounts.register('new@example.test', password)).email, 'new@example.test');
});

test('the registry rejects a 129th account without changing existing users', async t => {
  const { accounts, dataDir, path } = await fixture(t);
  await accounts.register('seed@example.test', password);
  const seed = JSON.parse(await readFile(path, 'utf8')).users[0];
  const users = Array.from({ length: 128 }, (_, index) => ({ ...seed, id: randomUUID(), email: `user-${index}@example.test` }));
  await writeFile(path, JSON.stringify({ version: 1, users }), { mode: 0o600 });
  const reopened = await openAccounts(dataDir);
  await assert.rejects(reopened.register('overflow@example.test', password), { status: 409, code: 'account_limit' });
  assert.equal(reopened.list().length, 128);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).users.length, 128);
});

test('malformed or privilege-bearing persisted records fail closed', async t => {
  const { accounts, dataDir, path } = await fixture(t);
  await accounts.register('seed@example.test', password);
  const baseline = JSON.parse(await readFile(path, 'utf8'));
  const corruptions = [
    value => { value.version = 2; },
    value => { value.users[0].role = 'owner'; },
    value => { value.users[0].id = '../owner'; },
    value => { value.users[0].email = 'SEED@example.test'; },
    value => { value.users[0].createdAt = 'yesterday'; },
    value => { value.users[0].password.hash = '00'; },
    value => { value.users[0].password.salt = '00'; },
    value => { value.users[0].password.cost = 1; },
    value => { value.users[0].admin = true; },
    value => { value.users.push({ ...value.users[0], id: randomUUID() }); },
    value => { value.users.push({ ...value.users[0], email: 'other@example.test' }); },
    value => { value.users = Array.from({ length: 129 }, (_, index) => ({ ...value.users[0], id: randomUUID(), email: `user-${index}@example.test` })); },
  ];
  for (const corrupt of corruptions) {
    const value = structuredClone(baseline);
    corrupt(value);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(openAccounts(dataDir));
  }
  await writeFile(path, '{not json', { mode: 0o600 });
  await assert.rejects(openAccounts(dataDir));
});

test('permissive registry permissions fail closed without rewriting the file', async t => {
  const { accounts, dataDir, path } = await fixture(t);
  await accounts.register('seed@example.test', password);
  const before = await readFile(path, 'utf8');
  await chmod(path, 0o644);
  await assert.rejects(openAccounts(dataDir));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await stat(path)).mode & 0o777, 0o644);
});

test('symbolic and hard linked registries are rejected without changing their targets', async t => {
  const { accounts, dataDir, path } = await fixture(t);
  await accounts.register('seed@example.test', password);
  const before = await readFile(path, 'utf8');
  const target = join(dataDir, 'original.json');
  await writeFile(target, before, { mode: 0o600 });
  await rm(path);
  await symlink(target, path);
  await assert.rejects(openAccounts(dataDir));
  await rm(path);
  await link(target, path);
  await assert.rejects(openAccounts(dataDir));
  assert.equal(await readFile(target, 'utf8'), before);
});

test('a linked data directory is rejected before creating registry files', async t => {
  const { dataDir } = await fixture(t);
  const target = join(dataDir, 'target');
  const alias = join(dataDir, 'alias');
  await mkdir(target);
  await symlink(target, alias);
  await assert.rejects(openAccounts(alias));
  assert.deepEqual(await readdir(target), []);
});

test('failed persistence rolls registration back and the next registration can succeed', async t => {
  const { accounts, dataDir, path } = await fixture(t);
  const seed = await accounts.register('seed@example.test', password);
  const before = await readFile(path, 'utf8');
  await rm(path);
  await mkdir(path);
  await assert.rejects(accounts.register('retry@example.test', password));
  assert.deepEqual(accounts.list(), [seed]);
  await rm(path, { recursive: true });
  await writeFile(path, before, { mode: 0o600 });
  const retried = await accounts.register('retry@example.test', password);
  assert.equal(retried.email, 'retry@example.test');
  assert.equal((await openAccounts(dataDir)).list().length, 2);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
});
