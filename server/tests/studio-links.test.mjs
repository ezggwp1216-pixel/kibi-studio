import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod, mkdir, symlink, link, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scopes = ['pairing.claim', 'devices.list', 'voice.status', 'voice.activate', 'catalog.read'];
const start = Date.parse('2026-11-09T00:00:00.000Z');
const ttl = 10 * 60 * 1000;
const lifetime = 90 * 24 * 60 * 60 * 1000;

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kibi-studio-links-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { openStudioLinks } = await import('../src/studio-links.mjs');
  let time = start;
  const accounts = new Set([randomUUID(), randomUUID()]);
  const settings = { now: () => time, accountExists: id => accounts.has(id), ...options };
  const links = await openStudioLinks(dataDir, settings);
  t.after(() => links.close());
  return { links, dataDir, path: join(dataDir, 'studio-links.json'), accounts, ids: [...accounts],
    advance: milliseconds => { time += milliseconds; },
    reopen: () => openStudioLinks(dataDir, settings) };
}

test('a private single-use link creates a scoped ordinary-account connection', async t => {
  const { links, ids, path, dataDir } = await fixture(t);
  const issued = await links.issue(ids[0]);
  assert.deepEqual(Object.keys(issued).sort(), ['code', 'expiresAt']);
  assert.match(issued.code, /^kibi_link_[A-Za-z0-9_-]{32}$/);
  assert.equal(issued.expiresAt, '2026-11-09T00:10:00.000Z');
  const redeemed = await links.redeem({ code: issued.code, label: '  Домашняя Studio  ' });
  assert.match(redeemed.token, /^kibi_studio_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(redeemed).sort(), ['connection', 'token']);
  assert.deepEqual(Object.keys(redeemed.connection).sort(), ['createdAt', 'expiresAt', 'id', 'label', 'scopes']);
  assert.equal(redeemed.connection.label, 'Домашняя Studio');
  assert.equal(redeemed.connection.createdAt, '2026-11-09T00:00:00.000Z');
  assert.equal(redeemed.connection.expiresAt, '2027-02-07T00:00:00.000Z');
  assert.deepEqual(redeemed.connection.scopes, scopes);
  const principal = links.authenticate(redeemed.token);
  assert.equal(principal.kind, 'studio');
  assert.equal(principal.accountId, ids[0]);
  assert.equal(principal.role, 'user');
  assert.equal(principal.connectionId, redeemed.connection.id);
  assert.deepEqual(principal.scopes, scopes);
  assert.equal(principal.signal.aborted, false);
  assert.deepEqual(links.list(ids[0]), [redeemed.connection]);
  assert.deepEqual(links.list(ids[1]), []);
  await assert.rejects(links.redeem({ code: issued.code, label: 'Replay' }), { status: 410, code: 'studio_link_not_found' });
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes(issued.code), false);
  assert.equal(raw.includes(redeemed.token), false);
  assert.equal(raw.includes('Домашняя Studio'), true);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
});

test('reissue invalidates the old code while exact TTL expiry prevents redemption', async t => {
  const { links, ids, advance } = await fixture(t);
  const old = await links.issue(ids[0]);
  const current = await links.issue(ids[0]);
  assert.notEqual(current.code, old.code);
  await assert.rejects(links.redeem({ code: old.code, label: 'Old' }), { code: 'studio_link_not_found' });
  advance(ttl - 1);
  const connection = await links.redeem({ code: current.code, label: 'Current' });
  assert.equal(links.authenticate(connection.token).accountId, ids[0]);
  const expired = await links.issue(ids[1]);
  advance(ttl);
  await assert.rejects(links.redeem({ code: expired.code, label: 'Late' }), { status: 410, code: 'studio_link_not_found' });
  assert.deepEqual(links.list(ids[1]), []);
});

test('token expiry is absolute and authenticating never extends it', async t => {
  const { links, ids, advance } = await fixture(t);
  const issued = await links.issue(ids[0]);
  const { token } = await links.redeem({ code: issued.code, label: 'Local' });
  const principal = links.authenticate(token);
  advance(lifetime - 1);
  assert.equal(links.authenticate(token).expiresAt, '2027-02-07T00:00:00.000Z');
  advance(1);
  assert.equal(links.authenticate(token), null);
  assert.equal(principal.signal.aborted, true);
  assert.deepEqual(links.list(ids[0]), []);
});

test('connection lists and authentication profiles cannot mutate authorization state', async t => {
  const { links, ids } = await fixture(t);
  const { code } = await links.issue(ids[0]);
  const redeemed = await links.redeem({ code, label: 'Original' });
  redeemed.connection.scopes.push('admin');
  const listed = links.list(ids[0]);
  listed[0].label = 'Changed';
  listed[0].scopes.push('settings.write');
  listed.push({ id: randomUUID() });
  const principal = links.authenticate(redeemed.token);
  principal.accountId = ids[1];
  principal.role = 'owner';
  principal.scopes.push('provider.read');
  assert.equal(links.list(ids[0]).length, 1);
  assert.equal(links.list(ids[0])[0].label, 'Original');
  assert.deepEqual(links.authenticate(redeemed.token).scopes, scopes);
  assert.equal(links.authenticate(redeemed.token).accountId, ids[0]);
  assert.equal(links.authenticate(redeemed.token).role, 'user');
});

test('pending codes and hashed connections survive reopen without resurrecting used codes', async t => {
  const { links, ids, reopen } = await fixture(t);
  const first = await links.issue(ids[0]);
  const second = await links.issue(ids[1]);
  const connection = await links.redeem({ code: first.code, label: 'Persistent' });
  await links.close();
  const reopened = await reopen();
  t.after(() => reopened.close());
  assert.equal(reopened.authenticate(connection.token).accountId, ids[0]);
  assert.deepEqual(reopened.list(ids[0]), [connection.connection]);
  await assert.rejects(reopened.redeem({ code: first.code, label: 'Replay' }), { code: 'studio_link_not_found' });
  assert.equal((await reopened.redeem({ code: second.code, label: 'Other' })).connection.label, 'Other');
});

test('owner, deleted, malformed and callback-rejected accounts cannot acquire Studio authority', async t => {
  const { links, ids, accounts } = await fixture(t);
  for (const id of [null, '', 'owner', '../owner', randomUUID(), ids[0] + '/..']) {
    await assert.rejects(links.issue(id), { status: 403, code: 'studio_account_unavailable' });
    assert.throws(() => links.list(id), { status: 403, code: 'studio_account_unavailable' });
  }
  const { code } = await links.issue(ids[0]);
  const current = await links.redeem({ code, label: 'Current' });
  const principal = links.authenticate(current.token);
  const pending = await links.issue(ids[0]);
  accounts.delete(ids[0]);
  assert.equal(links.authenticate(current.token), null);
  assert.equal(principal.signal.aborted, true);
  await assert.rejects(links.redeem({ code: pending.code, label: 'Deleted' }), { code: 'studio_link_not_found' });
  await assert.rejects(links.revoke(ids[0], current.connection.id), { code: 'studio_account_unavailable' });
  const rejected = await fixture(t, { accountExists: () => Promise.resolve(true) });
  await assert.rejects(rejected.links.issue(rejected.ids[0]), { code: 'studio_account_unavailable' });
  const throwing = await fixture(t, { accountExists: () => { throw new Error('private detail'); } });
  await assert.rejects(throwing.links.issue(throwing.ids[0]), { code: 'studio_account_unavailable' });
});

test('wrong credential classes and malformed inputs never authenticate or consume a valid code', async t => {
  const { links, ids } = await fixture(t);
  const issued = await links.issue(ids[0]);
  for (const input of [null, 1, [], {}, { code: '' }, { code: issued.code, label: '' },
    { code: issued.code, label: 'a'.repeat(65) }, { code: issued.code, label: 'Bad\nlabel' },
    { code: 'x'.repeat(10000), label: 'Too big' }]) {
    await assert.rejects(Promise.resolve().then(() => links.redeem(input)), error =>
      error.status === 400 && ['invalid_studio_link', 'invalid_studio_label'].includes(error.code));
  }
  const { token } = await links.redeem({ code: issued.code, label: 'Valid' });
  for (const wrong of [null, {}, '', issued.code, randomUUID(), token + 'a', token.slice(1),
    'kibi_studio_' + 'a'.repeat(43), 'a'.repeat(10000)]) assert.equal(links.authenticate(wrong), null);
  assert.equal(links.authenticate(token).accountId, ids[0]);
});

test('revocation is account-scoped, durable and aborts the existing connection only after commit', async t => {
  const { links, ids, reopen } = await fixture(t);
  const { code } = await links.issue(ids[0]);
  const current = await links.redeem({ code, label: 'Revocable' });
  const principal = links.authenticate(current.token);
  assert.equal(await links.revoke(ids[1], current.connection.id), false);
  assert.equal(principal.signal.aborted, false);
  assert.equal(await links.revoke(ids[0], randomUUID()), false);
  assert.equal(await links.revoke(ids[0], current.connection.id), true);
  assert.equal(principal.signal.aborted, true);
  assert.equal(links.authenticate(current.token), null);
  assert.equal(await links.revoke(ids[0], current.connection.id), false);
  await links.close();
  const reopened = await reopen();
  t.after(() => reopened.close());
  assert.equal(reopened.authenticate(current.token), null);
  assert.deepEqual(reopened.list(ids[0]), []);
});

test('a Studio can disconnect only the connection selected by its own token', async t => {
  const { links, ids, reopen } = await fixture(t);
  const one = await links.redeem({ ...(await links.issue(ids[0])), label: 'One' });
  const two = await links.redeem({ ...(await links.issue(ids[0])), label: 'Two' });
  const other = await links.redeem({ ...(await links.issue(ids[1])), label: 'Other' });
  const onePrincipal = links.authenticate(one.token);
  assert.equal(await links.disconnect('kibi_studio_' + 'a'.repeat(43)), false);
  assert.equal(await links.disconnect(one.token), true);
  assert.equal(onePrincipal.signal.aborted, true);
  assert.equal(links.authenticate(one.token), null);
  assert.equal(links.authenticate(two.token).accountId, ids[0]);
  assert.equal(links.authenticate(other.token).accountId, ids[1]);
  const reopened = await reopen();
  t.after(() => reopened.close());
  assert.equal(reopened.authenticate(one.token), null);
  assert.equal(reopened.authenticate(two.token).accountId, ids[0]);
});

test('concurrent redeems have one durable winner and concurrent issues retain only the final code', async t => {
  const { links, ids, reopen } = await fixture(t);
  const { code } = await links.issue(ids[0]);
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => links.redeem({ code, label: 'Racer' })));
  const winners = outcomes.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  for (const result of outcomes.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'studio_link_not_found');
  const issued = await Promise.all(Array.from({ length: 12 }, () => links.issue(ids[1])));
  for (const result of issued.slice(0, -1)) await assert.rejects(links.redeem({ code: result.code, label: 'Earlier' }), { code: 'studio_link_not_found' });
  await links.redeem({ code: issued.at(-1).code, label: 'Latest' });
  const reopened = await reopen();
  t.after(() => reopened.close());
  assert.equal(reopened.authenticate(winners[0].value.token).accountId, ids[0]);
  assert.equal(reopened.list(ids[0]).length, 1);
  assert.equal(reopened.list(ids[1]).length, 1);
});

test('the ninth active connection is rejected without consuming its code, and expiry releases capacity', async t => {
  const { links, ids, advance } = await fixture(t);
  const current = [];
  for (let index = 0; index < 8; index++) current.push(await links.redeem({ ...(await links.issue(ids[0])), label: `Studio ${index}` }));
  const ninth = await links.issue(ids[0]);
  await assert.rejects(links.redeem({ code: ninth.code, label: 'Overflow' }), { status: 409, code: 'studio_connection_limit' });
  assert.equal(links.list(ids[0]).length, 8);
  assert.equal(await links.revoke(ids[0], current[0].connection.id), true);
  assert.equal((await links.redeem({ code: ninth.code, label: 'Replacement' })).connection.label, 'Replacement');
  advance(lifetime);
  assert.deepEqual(links.list(ids[0]), []);
  assert.equal((await links.redeem({ ...(await links.issue(ids[0])), label: 'After expiry' })).connection.label, 'After expiry');
});

test('the 129th represented account is rejected and expired pending codes release account capacity', async t => {
  const { links, accounts, ids, advance } = await fixture(t);
  const extra = Array.from({ length: 127 }, () => randomUUID());
  extra.forEach(id => accounts.add(id));
  for (const id of [ids[0], ...extra]) await links.issue(id);
  await assert.rejects(links.issue(ids[1]), { status: 409, code: 'studio_account_limit' });
  advance(ttl);
  assert.match((await links.issue(ids[1])).code, /^kibi_link_/);
});

test('serialized authorization rejects requests queued behind revocation and scopes deny extra powers', async t => {
  const { links, ids } = await fixture(t);
  const current = await links.redeem({ ...(await links.issue(ids[0])), label: 'Guarded' });
  const principal = links.authenticate(current.token);
  for (const scope of ['admin', 'settings.read', 'provider.read', 'devices.write', '', null]) {
    await assert.rejects(links.withAuthorization(current.token, scope, () => assert.fail('scope bypass')), { status: 403, code: 'studio_scope_denied' });
  }
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const first = links.withAuthorization(current.token, 'pairing.claim', async profile => {
    assert.equal(profile.accountId, ids[0]);
    assert.equal(profile.signal.aborted, false);
    enter();
    await blocked;
    assert.equal(profile.signal.aborted, false);
    return 'authorized local change';
  });
  await entered;
  const revoking = links.revoke(ids[0], current.connection.id);
  const tooLate = links.withAuthorization(current.token, 'pairing.claim', () => assert.fail('queued stale authorization'));
  release();
  assert.equal(await first, 'authorized local change');
  assert.equal(await revoking, true);
  await assert.rejects(tooLate, { status: 401, code: 'studio_unauthorized' });
  assert.equal(principal.signal.aborted, true);
});

test('the exported fixed scopes permit voice activation only as a trusted separately-checked operation', async t => {
  const { links, ids } = await fixture(t);
  const { STUDIO_SCOPES } = await import('../src/studio-links.mjs');
  assert.deepEqual(STUDIO_SCOPES, scopes);
  assert.equal(Object.isFrozen(STUDIO_SCOPES), true);
  const current = await links.redeem({ ...(await links.issue(ids[0])), label: 'Activation' });
  const result = await links.withAuthorization(current.token, 'voice.activate', principal => ({ accountId: principal.accountId, checkedByServer: true }));
  assert.deepEqual(result, { accountId: ids[0], checkedByServer: true });
  await assert.rejects(links.withAuthorization(current.token, 'voice.admin', () => assert.fail('no owner authority')), { code: 'studio_scope_denied' });
});

test('the work queue is bounded and a failed callback does not poison later operations', async t => {
  const { links, ids } = await fixture(t);
  const current = await links.redeem({ ...(await links.issue(ids[0])), label: 'Queue' });
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const first = links.withAuthorization(current.token, 'devices.list', async () => { enter(); await blocked; });
  await entered;
  const queued = Array.from({ length: 63 }, () => links.issue(ids[1]));
  await assert.rejects(links.issue(ids[1]), { status: 503, code: 'server_busy' });
  release();
  await first;
  assert.equal((await Promise.all(queued)).length, 63);
  await assert.rejects(links.withAuthorization(current.token, 'devices.list', () => { throw new Error('local failure'); }), /local failure/);
  assert.equal(await links.withAuthorization(current.token, 'devices.list', profile => profile.accountId), ids[0]);
});

test('close cancels sessions, rejects queued operations and preserves already committed credentials', async t => {
  const { links, ids, reopen } = await fixture(t);
  const current = await links.redeem({ ...(await links.issue(ids[0])), label: 'Closed' });
  const principal = links.authenticate(current.token);
  const queued = links.issue(ids[1]);
  const closing = links.close();
  await assert.rejects(queued, { status: 503, code: 'studio_links_closed' });
  await closing;
  assert.equal(principal.signal.aborted, true);
  assert.equal(links.authenticate(current.token), null);
  await assert.rejects(links.issue(ids[0]), { code: 'studio_links_closed' });
  assert.throws(() => links.list(ids[0]), { code: 'studio_links_closed' });
  const reopened = await reopen();
  t.after(() => reopened.close());
  assert.equal(reopened.authenticate(current.token).accountId, ids[0]);
});

test('failed fsync rolls back every mutation and removes its already-written temporary file', async t => {
  const { links, ids, path, dataDir, reopen } = await fixture(t);
  const pending = await links.issue(ids[0]);
  const current = await links.redeem({ ...(await links.issue(ids[1])), label: 'Preserved' });
  const principal = links.authenticate(current.token);
  const before = await readFile(path, 'utf8');
  const probePath = join(dataDir, 'probe');
  const probe = await open(probePath, 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  await rm(probePath);
  const stub = t.mock.method(prototype, 'sync', async function () { throw Object.assign(new Error('injected sync failure'), { code: 'EIO' }); });
  for (const mutate of [
    () => links.issue(ids[0]),
    () => links.redeem({ code: pending.code, label: 'Uncommitted' }),
    () => links.revoke(ids[1], current.connection.id),
    () => links.disconnect(current.token),
  ]) {
    await assert.rejects(mutate(), { code: 'EIO' });
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(links.list(ids[0]), []);
    assert.deepEqual(links.list(ids[1]), [current.connection]);
    assert.equal(links.authenticate(current.token).accountId, ids[1]);
    assert.equal(principal.signal.aborted, false);
    assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
  }
  stub.mock.restore();
  await links.close();
  const reopened = await reopen();
  t.after(() => reopened.close());
  assert.equal(reopened.authenticate(current.token).accountId, ids[1]);
  assert.equal((await reopened.redeem({ code: pending.code, label: 'Retried' })).connection.label, 'Retried');
});

test('authentication keeps committed state while persistence is waiting and publishes after fsync succeeds', async t => {
  const { links, ids, dataDir } = await fixture(t);
  const current = await links.redeem({ ...(await links.issue(ids[0])), label: 'Committed' });
  const principal = links.authenticate(current.token);
  const probePath = join(dataDir, 'probe');
  const probe = await open(probePath, 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe), original = prototype.sync;
  await probe.close();
  await rm(probePath);
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const stub = t.mock.method(prototype, 'sync', async function () { enter(); await blocked; return original.call(this); });
  const revoking = links.revoke(ids[0], current.connection.id);
  await entered;
  assert.equal(links.authenticate(current.token).accountId, ids[0]);
  assert.deepEqual(links.list(ids[0]), [current.connection]);
  assert.equal(principal.signal.aborted, false);
  release();
  assert.equal(await revoking, true);
  stub.mock.restore();
  assert.equal(links.authenticate(current.token), null);
  assert.equal(principal.signal.aborted, true);
});

test('external registry changes or an unsafe replacement stop saves without publishing new authority', async t => {
  const { links, ids, path, dataDir } = await fixture(t);
  const pending = await links.issue(ids[0]);
  const before = await readFile(path, 'utf8');
  await writeFile(path, before + '\n');
  await assert.rejects(links.redeem({ code: pending.code, label: 'Changed' }), { code: 'studio_links_changed' });
  assert.deepEqual(links.list(ids[0]), []);
  await rm(path);
  await mkdir(path);
  await assert.rejects(links.issue(ids[0]));
  await rm(path, { recursive: true });
  await writeFile(path, before, { mode: 0o600 });
  assert.equal((await links.redeem({ code: pending.code, label: 'Restored' })).connection.label, 'Restored');
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
});

test('malformed, duplicate or privilege-bearing persisted registries fail closed without rewriting', async t => {
  const { links, ids, path, reopen } = await fixture(t);
  await links.redeem({ ...(await links.issue(ids[0])), label: 'Seed' });
  await links.issue(ids[1]);
  await links.close();
  const baseline = JSON.parse(await readFile(path, 'utf8'));
  const corruptions = [
    value => { value.version = 2; },
    value => { value.unexpected = true; },
    value => { value.accounts[0].role = 'owner'; },
    value => { value.accounts[0].id = 'owner'; },
    value => { value.accounts[0].connections[0].role = 'owner'; },
    value => { value.accounts[0].connections[0].tokenHash = '00'; },
    value => { value.accounts[0].connections[0].scopes.push('provider.read'); },
    value => { value.accounts[0].connections[0].scopes[0] = 'settings.write'; },
    value => { value.accounts[0].connections[0].expiresAt = '2028-02-07T00:00:00.000Z'; },
    value => { value.accounts[0].connections[0].createdAt = 'yesterday'; },
    value => { value.accounts[0].connections[0].label = ''; },
    value => { value.accounts[0].connections[0].label = 'Bad\nlabel'; },
    value => { value.accounts[1].code.codeHash = 'plain text'; },
    value => { value.accounts[1].code.expiresAt = '2026-11-09T01:00:00.000Z'; },
    value => { value.accounts[1].code.token = 'plaintext'; },
    value => { value.accounts.push(structuredClone(value.accounts[0])); },
    value => { value.accounts[0].connections.push(structuredClone(value.accounts[0].connections[0])); },
    value => { value.accounts[1].connections.push({ ...value.accounts[0].connections[0], id: randomUUID() }); },
    value => { value.accounts[0].connections = Array.from({ length: 9 }, (_, index) => ({ ...value.accounts[0].connections[0], id: randomUUID(), tokenHash: index.toString(16).padStart(64, '0') })); },
    value => { value.accounts = Array.from({ length: 129 }, () => ({ id: randomUUID(), code: null, connections: [] })); },
  ];
  for (const corrupt of corruptions) {
    const value = structuredClone(baseline);
    corrupt(value);
    const raw = JSON.stringify(value);
    await writeFile(path, raw);
    await assert.rejects(reopen(), { code: 'invalid_studio_links' });
    assert.equal(await readFile(path, 'utf8'), raw);
  }
  await writeFile(path, '{not JSON');
  await assert.rejects(reopen(), { code: 'invalid_studio_links' });
});

test('permissive permissions and symbolic or hard links fail closed without altering their targets', async t => {
  const { links, ids, path, dataDir, reopen } = await fixture(t);
  await links.issue(ids[0]);
  const before = await readFile(path, 'utf8');
  await chmod(path, 0o644);
  await assert.rejects(reopen());
  await assert.rejects(links.issue(ids[0]));
  assert.equal((await stat(path)).mode & 0o777, 0o644);
  await chmod(path, 0o600);
  await chmod(dataDir, 0o755);
  await assert.rejects(reopen(), { code: 'invalid_data_directory' });
  await assert.rejects(links.issue(ids[0]), { code: 'invalid_data_directory' });
  await chmod(dataDir, 0o700);
  const target = join(dataDir, 'original.json');
  await writeFile(target, before, { mode: 0o600 });
  await rm(path);
  await symlink(target, path);
  await assert.rejects(reopen());
  await assert.rejects(links.issue(ids[0]));
  await rm(path);
  await link(target, path);
  await assert.rejects(reopen());
  await assert.rejects(links.issue(ids[0]));
  assert.equal(await readFile(target, 'utf8'), before);
});

test('a linked data directory is rejected before writing any registry', async t => {
  const { dataDir } = await fixture(t);
  const target = join(dataDir, 'target'), alias = join(dataDir, 'alias');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, alias);
  const { openStudioLinks } = await import('../src/studio-links.mjs');
  await assert.rejects(openStudioLinks(alias));
  assert.deepEqual(await readdir(target), []);
});
