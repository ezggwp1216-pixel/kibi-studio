import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, chmod, writeFile, symlink, link, mkdir, readdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const base = 'https://sldvkibi.ru/server/';
const scopes = ['pairing.claim', 'devices.list', 'voice.status', 'voice.activate', 'catalog.read'];
const code = 'kibi_link_' + 'a'.repeat(32);
const token = 'kibi_studio_' + 'a'.repeat(43);
const alternateToken = 'kibi_studio_' + 'b'.repeat(43);
const time = Date.parse('2026-11-10T00:00:00.000Z');
const account = { id: randomUUID(), email: 'studio@example.test', role: 'user' };
const connection = { id: randomUUID(), label: 'Моя Studio', createdAt: '2026-11-10T00:00:00.000Z', expiresAt: '2027-02-08T00:00:00.000Z', scopes };
const grant = overrides => ({ token, account, connection, scopes, apiBase: base, ...overrides });
const profile = overrides => ({ account, connection, scopes,
  voice: { configured: false, enabled: false, status: 'disabled', code: 'tenant_voice_unavailable', activeSessions: 0 },
  voiceEligibility: { eligible: false, code: 'voice_owner_approval_required' }, ...overrides });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, responder = () => json(grant(), 201), options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kibi-studio-account-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createStudioAccount } = await import('./studio-account.mjs');
  const calls = [];
  let now = time;
  const fetchImpl = async (url, request) => { calls.push({ url: String(url), ...request }); return responder(url, request); };
  const settings = { root, now: () => now, fetchImpl, ...options };
  const client = await createStudioAccount(settings);
  t.after(() => client.close());
  return { root, path: join(root, '.studio', 'private', 'account-connection.json'), client, calls,
    advance: amount => { now += amount; }, reopen: () => createStudioAccount(settings) };
}

test('connection redeems once on the pinned HTTPS API and saves only its dedicated credential privately', async t => {
  const { client, calls, path, root, reopen } = await fixture(t);
  assert.equal(client.publicInfo().connected, false);
  const info = await client.connect({ code, label: 'Моя Studio' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, base + 'api/studio/redeem');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].credentials, 'omit');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].body), { code, label: 'Моя Studio' });
  assert.equal(info.connected, true);
  assert.deepEqual(info.account, account);
  assert.equal(JSON.stringify(info).includes(token), false);
  assert.equal(JSON.stringify(info).includes(code), false);
  assert.equal(JSON.stringify(client).includes(token), false);
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes(token), true);
  assert.equal(raw.includes(code), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, '.studio'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, '.studio', 'private'))).mode & 0o777, 0o700);
  const restored = await reopen();
  t.after(() => restored.close());
  assert.equal(restored.publicInfo().connected, true);
  assert.equal(restored.publicInfo().verified, false);
  assert.equal(calls.length, 1);
});

test('profile and device operations use only bearer credentials and return safe metadata', async t => {
  const deviceId = randomUUID();
  const { client, calls } = await fixture(t, url => {
    if (String(url).endsWith('/redeem')) return json(grant(), 201);
    if (String(url).endsWith('/profile')) return json(profile({ privateKey: token }));
    if (String(url).endsWith('/devices')) return json({ devices: [{ id: deviceId, name: 'Киби', status: 'not_seen', createdAt: connection.createdAt, lastSeenAt: null, token: 'must not escape' }] });
    if (String(url).endsWith('/pairing/claim')) return json({ ok: true, device: { id: deviceId, name: 'Киби', token: 'must not escape' } });
    if (String(url).endsWith('/voice/activate')) return json({ ok: true, voice: { status: 'listening', configured: true, enabled: true, apiKey: 'must not escape' } });
    return json({ ok: true });
  });
  await client.connect({ code, label: 'Моя Studio' });
  const refreshed = await client.refresh();
  assert.equal(refreshed.verified, true);
  assert.equal(refreshed.voice.status, 'disabled');
  assert.equal(refreshed.voiceEligibility.eligible, false);
  assert.equal(JSON.stringify(refreshed).includes(token), false);
  const devices = await client.listDevices();
  assert.equal(devices.devices[0].id, deviceId);
  assert.equal('token' in devices.devices[0], false);
  const claimed = await client.claimPairing({ code: 'ABCD-EFGH' });
  assert.deepEqual(claimed, { ok: true, device: { id: deviceId, name: 'Киби' } });
  await client.activateVoice({ deviceId });
  assert.equal('apiKey' in client.publicInfo().voice, false);
  for (const call of calls.slice(1)) {
    assert.equal(call.headers.Authorization, 'Bearer ' + token);
    assert.equal(call.url.includes(token), false);
    assert.equal(call.url.includes('?'), false);
  }
});

test('rejection of a malformed redemption never replaces the existing connection or exposes server text', async t => {
  let reply = grant();
  const { client } = await fixture(t, () => json(reply, 201));
  await client.connect({ code, label: 'Моя Studio' });
  for (const corrupt of [
    value => { value.token = 'device-token'; },
    value => { value.apiBase = 'https://attacker.example/'; },
    value => { value.scopes = [...scopes, 'admin']; },
    value => { value.connection = { ...connection, scopes: ['settings.read'] }; },
    value => { value.account = { ...account, role: 'owner' }; },
    value => { value.account = { ...account, id: 'owner' }; },
    value => { value.connection = { ...connection, expiresAt: '2028-01-01T00:00:00.000Z' }; },
  ]) {
    reply = grant({ token: alternateToken });
    corrupt(reply);
    await assert.rejects(client.connect({ code, label: 'New' }), error => error.code === 'account_invalid_response' && !error.message.includes(token));
    assert.equal(client.publicInfo().connection.id, connection.id);
  }
});

test('profile cannot change the pinned account, connection or absolute expiry', async t => {
  let reply = profile();
  const { client } = await fixture(t, url => String(url).endsWith('/redeem') ? json(grant(), 201) : json(reply));
  await client.connect({ code, label: 'Моя Studio' });
  for (const next of [profile({ account: { ...account, id: randomUUID() } }),
    profile({ connection: { ...connection, id: randomUUID() } }),
    profile({ connection: { ...connection, expiresAt: '2027-02-08T00:00:00.001Z' } })]) {
    reply = next;
    await assert.rejects(client.refresh(), { code: 'account_invalid_response' });
    assert.equal(client.publicInfo().account.id, account.id);
    assert.equal(client.publicInfo().connection.id, connection.id);
  }
});

test('expiry prevents new requests and aborts an already pending request without returning its late result', async t => {
  let enter, request;
  const entered = new Promise(resolve => { enter = resolve; });
  const { client, advance, calls } = await fixture(t, (url, options) => {
    if (String(url).endsWith('/redeem')) return json(grant(), 201);
    request = options;
    enter();
    return new Promise(() => {});
  });
  await client.connect({ code, label: 'Моя Studio' });
  const pending = client.listDevices();
  pending.catch(() => {});
  await entered;
  advance(90 * 24 * 60 * 60 * 1000);
  assert.equal(client.publicInfo().status, 'expired');
  assert.equal(request.signal.aborted, true);
  await assert.rejects(pending, { code: 'account_session_changed' });
  await assert.rejects(client.listDevices(), { code: 'account_expired' });
  assert.equal(calls.length, 2);
});

test('revoked credentials are removed and any other pending generation cannot publish results', async t => {
  let pendingOptions, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const { client, path } = await fixture(t, (url, options) => {
    if (String(url).endsWith('/redeem')) return json(grant(), 201);
    if (String(url).endsWith('/devices')) { pendingOptions = options; enter(); return new Promise(() => {}); }
    return json({ ok: false, code: token }, 401);
  });
  await client.connect({ code, label: 'Моя Studio' });
  const pending = client.listDevices();
  pending.catch(() => {});
  await entered;
  await assert.rejects(client.refresh(), { code: 'account_revoked' });
  await assert.rejects(pending, { code: 'account_session_changed' });
  assert.equal(pendingOptions.signal.aborted, true);
  assert.equal(client.publicInfo().connected, false);
  assert.equal((await readFile(path, 'utf8')).includes(token), false);
});

test('failed private persistence preserves the previous connection and revokes the newly redeemed orphan', async t => {
  let redemption = grant();
  const { client, path, root, calls } = await fixture(t, url => String(url).endsWith('/redeem') ? json(redemption, 201) : json({ ok: true }));
  await client.connect({ code, label: 'Моя Studio' });
  const before = await readFile(path, 'utf8');
  const probe = await open(join(root, 'probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close(); await rm(join(root, 'probe'));
  const stub = t.mock.method(prototype, 'sync', async function () { throw new Error('private storage path and ' + token); });
  redemption = grant({ token: alternateToken, connection: { ...connection, id: randomUUID(), label: 'Replacement' } });
  await assert.rejects(client.connect({ code, label: 'Replacement' }), error => error.code === 'account_storage_error' && !JSON.stringify(error).includes(token) && !error.message.includes(token));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(client.publicInfo().connection.id, connection.id);
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer ' + alternateToken);
  assert.equal((await readdir(join(root, '.studio', 'private'))).some(name => name.endsWith('.tmp')), false);
  stub.mock.restore();
  assert.equal(client.publicInfo().connected, true);
});

test('disconnect aborts outstanding work and stays locally disconnected if server revocation is unreachable', async t => {
  let enter, deviceRequest;
  const entered = new Promise(resolve => { enter = resolve; });
  const { client, path } = await fixture(t, (url, options) => {
    if (String(url).endsWith('/redeem')) return json(grant(), 201);
    if (String(url).endsWith('/devices')) { deviceRequest = options; enter(); return new Promise(() => {}); }
    throw new Error('provider key ' + token);
  });
  await client.connect({ code, label: 'Моя Studio' });
  const pending = client.listDevices(); pending.catch(() => {});
  await entered;
  const info = await client.disconnect();
  await assert.rejects(pending, { code: 'account_session_changed' });
  assert.equal(deviceRequest.signal.aborted, true);
  assert.equal(info.connected, false);
  assert.equal(info.revocationConfirmed, false);
  assert.equal((await readFile(path, 'utf8')).includes(token), false);
});

test('a changed connection cancels old requests and sends every subsequent request with the replacement token', async t => {
  let redeemCount = 0, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const { client, calls } = await fixture(t, url => {
    if (String(url).endsWith('/redeem')) return json(++redeemCount === 1 ? grant() : grant({ token: alternateToken, connection: { ...connection, id: randomUUID() } }), 201);
    if (String(url).endsWith('/profile')) { enter(); return new Promise(() => {}); }
    if (String(url).endsWith('/devices')) return json({ devices: [] });
    return json({ ok: true });
  });
  await client.connect({ code, label: 'Моя Studio' });
  const pending = client.refresh(); pending.catch(() => {});
  await entered;
  await client.connect({ code, label: 'Replacement' });
  await assert.rejects(pending, { code: 'account_session_changed' });
  await client.listDevices();
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer ' + alternateToken);
  assert.equal(calls.some(call => call.method === 'DELETE' && call.headers.Authorization === 'Bearer ' + token), true);
});

test('permission denial on voice activation does not revoke an otherwise valid Studio connection', async t => {
  const { client } = await fixture(t, url => {
    if (String(url).endsWith('/redeem')) return json(grant(), 201);
    return json({ ok: false, code: 'studio_voice_not_approved' }, 403);
  });
  await client.connect({ code, label: 'Моя Studio' });
  await assert.rejects(client.activateVoice({ deviceId: randomUUID() }), { code: 'account_voice_unavailable' });
  assert.equal(client.publicInfo().connected, true);
});

test('public safe profiles cannot contain a credential echoed inside otherwise permitted metadata', async t => {
  let reply = profile({ voice: { status: 'disabled', code: token }, voiceEligibility: { approved: false, canActivate: false, code: token } });
  const { client } = await fixture(t, url => String(url).endsWith('/redeem') ? json(grant(), 201) : json(reply));
  await client.connect({ code, label: 'Моя Studio' });
  const info = await client.refresh();
  assert.equal(JSON.stringify(info).includes(token), false);
  reply = profile({ connection: { ...connection, label: token } });
  await assert.rejects(client.refresh(), { code: 'account_invalid_response' });
  assert.equal(JSON.stringify(client.publicInfo()).includes(token), false);
});

test('bounded readers cancel oversized, overchunked, redirected and stalled responses with fixed errors', async t => {
  let reply = () => json(grant(), 201), cancelled = false;
  const { client } = await fixture(t, () => reply(), { timeoutMs: 25 });
  const cases = [
    () => new Response('x', { headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' } }),
    () => new Response(JSON.stringify({ ...grant(), ignored: 'x'.repeat(65536) }), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } }),
    () => ({ ok: true, status: 200, redirected: true, headers: new Headers({ 'Content-Type': 'application/json' }), body: new ReadableStream({ cancel() { cancelled = true; } }) }),
  ];
  for (const next of cases) {
    reply = next;
    await assert.rejects(client.connect({ code, label: 'Моя Studio' }), { code: 'account_invalid_response' });
    assert.equal(client.publicInfo().connected, false);
  }
  assert.equal(cancelled, true);
  reply = () => new Promise(() => {});
  await assert.rejects(client.connect({ code, label: 'Моя Studio' }), { code: 'account_timeout' });
  reply = () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } });
  cancelled = false;
  await assert.rejects(client.connect({ code, label: 'Моя Studio' }), { code: 'account_timeout' });
  assert.equal(cancelled, true);
});

test('malformed local input, provider credentials and attempted API changes cause no transport request', async t => {
  const { client, calls } = await fixture(t);
  for (const input of [null, {}, { code, label: 'Studio', password: 'website password' }, { code, label: 'Studio', apiBase: 'https://attacker.example/' }, { code: token, label: 'Studio' }, { code, label: 'Bad\nlabel' }]) {
    await assert.rejects(client.connect(input), { code: 'account_invalid_input' });
  }
  await assert.rejects(client.claimPairing({ code: token }), { code: 'account_invalid_input' });
  await assert.rejects(client.activateVoice({ deviceId: '../owner' }), { code: 'account_invalid_input' });
  assert.equal(calls.length, 0);
});

test('unsafe local paths, permissions, links and malformed or differently pinned credentials fail before network', async t => {
  const { client, root, path, reopen, calls } = await fixture(t);
  await client.connect({ code, label: 'Моя Studio' });
  const raw = await readFile(path, 'utf8');
  await client.close();
  await chmod(path, 0o644);
  await assert.rejects(reopen(), { code: 'account_storage_error' });
  assert.equal((await stat(path)).mode & 0o777, 0o644);
  await chmod(path, 0o600);
  const target = join(root, 'private-copy');
  await writeFile(target, raw, { mode: 0o600 });
  await rm(path); await symlink(target, path);
  await assert.rejects(reopen(), { code: 'account_storage_error' });
  await rm(path); await link(target, path);
  await assert.rejects(reopen(), { code: 'account_storage_error' });
  await rm(path);
  for (const corrupt of [value => { value.apiBase = 'https://attacker.example/'; }, value => { value.record.token = 'website-password'; }, value => { value.record.account.role = 'owner'; }, value => { value.record.scopes.push('admin'); }, value => { value.password = 'not allowed'; }]) {
    const value = JSON.parse(raw); corrupt(value);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(reopen(), { code: 'account_storage_error' });
  }
  assert.equal(calls.length, 1);
  assert.equal(await readFile(target, 'utf8'), raw);
});

test('closing cancels pending work, retains the private saved connection and rejects new requests', async t => {
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const { client, path } = await fixture(t, url => {
    if (String(url).endsWith('/redeem')) return json(grant(), 201);
    enter(); return new Promise(() => {});
  });
  await client.connect({ code, label: 'Моя Studio' });
  const pending = client.refresh(); pending.catch(() => {});
  await entered;
  await client.close();
  await assert.rejects(pending, { code: 'account_session_changed' });
  await assert.rejects(client.refresh(), { code: 'account_closed' });
  assert.equal(client.publicInfo().connected, false);
  assert.equal((await readFile(path, 'utf8')).includes(token), true);
});

test('public snapshots cannot rewrite the account, grant scopes or bearer used by later requests', async t => {
  const { client, calls } = await fixture(t, url => String(url).endsWith('/redeem') ? json(grant(), 201) : json({ devices: [] }));
  const result = await client.connect({ code, label: 'Моя Studio' });
  result.account.id = 'owner'; result.account.role = 'owner'; result.connection.id = 'owner'; result.connection.scopes.push('admin'); result.scopes.push('settings.read');
  assert.deepEqual(client.publicInfo().account, account);
  assert.deepEqual(client.publicInfo().connection, connection);
  assert.deepEqual(client.publicInfo().scopes, scopes);
  await client.listDevices();
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer ' + token);
});

test('a client admits at most sixteen pending requests and close aborts each admitted request', async t => {
  const { client, calls } = await fixture(t, url => String(url).endsWith('/redeem') ? json(grant(), 201) : new Promise(() => {}));
  await client.connect({ code, label: 'Моя Studio' });
  const pending = Array.from({ length: 16 }, () => client.listDevices());
  for (const operation of pending) operation.catch(() => {});
  await assert.rejects(client.listDevices(), { code: 'account_busy' });
  await client.close();
  const outcomes = await Promise.allSettled(pending);
  assert.equal(outcomes.every(result => result.status === 'rejected' && result.reason.code === 'account_session_changed'), true);
  assert.equal(calls.length, 17);
});

test('linked roots and permissive private parents are rejected before writing through them', async t => {
  const { root } = await fixture(t);
  const { createStudioAccount } = await import('./studio-account.mjs');
  const target = join(root, 'target'), alias = join(root, 'alias');
  await mkdir(target, { mode: 0o700 }); await symlink(target, alias);
  await assert.rejects(createStudioAccount({ root: alias }), { code: 'account_storage_error' });
  assert.deepEqual(await readdir(target), []);
  const parent = join(target, '.studio'); await mkdir(parent, { mode: 0o755 });
  await assert.rejects(createStudioAccount({ root: target }), { code: 'account_storage_error' });
  assert.deepEqual(await readdir(parent), []);
});
