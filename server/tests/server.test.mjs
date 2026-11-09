import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, symlink, link, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin = 'http://localhost:4391';
const password = 'a long private test password';
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kibi-test-'));
  const { createKibiServer } = await import('../src/server.mjs');
  let server;
  let base;
  let cookie;
  let csrf;
  const start = async () => {
    server = await createKibiServer({ dataDir, adminPassword: password, publicOrigin: origin, voiceConfig: { enabled: false }, ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, { method = 'GET', body, admin = false, token, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(admin ? { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
    }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch {}
    return { status: response.status, headers: response.headers, json, text };
  };
  const login = async () => {
    const res = await call('/api/login', { method: 'POST', body: { password }, headers: { Origin: origin } });
    assert.equal(res.status, 200);
    cookie = res.headers.get('set-cookie').split(';')[0]; csrf = res.json.csrfToken;
    return res;
  };
  return { call, login, dataDir, restart: async () => { await stop(); await start(); } };
}

test('fresh server exposes health, empty truthful modules and private session protections', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/api/health')).json, { ok: true, name: 'kibi-server', version: '0.1.0' });
  assert.deepEqual((await f.call('/api/session')).json, { authenticated: false });
  assert.equal((await f.call('/api/overview')).status, 401);
  assert.equal((await f.call('/api/login', { method: 'POST', body: { password } })).status, 403);
  const login = await f.login();
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  const overview = (await f.call('/api/overview', { admin: true })).json;
  assert.deepEqual(overview.devices, []); assert.deepEqual(overview.events, []);
  assert.equal(overview.modules.find(x => x.id === 'voice').status, 'disabled');
  const voice = (await f.call('/api/settings', { admin: true })).json.voice;
  assert.equal(voice.enabled, false); assert.equal(voice.model, 'gpt-realtime'); assert.equal(voice.tls, false);
  assert.equal(voice.endpoint, 'wss://localhost:4391/kibi-xiaozhi/v1');
  assert.equal(overview.modules.find(x => x.id === 'schedules').status, 'planned');
  assert.equal((await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'x' }, headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'x' }, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  await f.restart();
  assert.equal((await f.call('/api/overview', { admin: true })).status, 401);
});

test('device events, scoped deduplication, queued message acknowledgement and revocation persist', async t => {
  const f = await fixture(t); await f.login();
  const create = name => f.call('/api/devices', { method: 'POST', admin: true, body: { name } });
  const a = (await create('Киби')).json; const b = (await create('Второй')).json;
  assert.equal(a.device.status, 'not_seen'); assert.equal(a.device.lastSeenAt, null);
  const post = token => f.call('/api/device/events', { method: 'POST', token, body: { title: 'Звонок', message: 'Привет', eventId: 'evt-1' } });
  const first = await post(a.token); assert.equal(first.json.duplicate, false);
  assert.deepEqual((await post(a.token)).json, { ok: true, eventId: first.json.eventId, duplicate: true });
  assert.equal((await post(b.token)).json.duplicate, false);
  const sent = (await f.call(`/api/devices/${a.device.id}/messages`, { method: 'POST', admin: true, body: { title: 'Ответ', message: 'Готово' } })).json;
  const queue = (await f.call('/api/device/messages', { token: a.token })).json.messages;
  assert.equal(queue[0].id, sent.messageId);
  assert.equal((await f.call('/api/device/ack', { method: 'POST', token: b.token, body: { messageId: sent.messageId } })).status, 404);
  await f.restart(); await f.login();
  assert.equal((await post(a.token)).json.duplicate, true);
  assert.equal((await f.call('/api/device/messages', { token: a.token })).json.messages.length, 1);
  assert.equal((await f.call('/api/device/ack', { method: 'POST', token: a.token, body: { messageId: sent.messageId } })).status, 200);
  assert.deepEqual((await f.call('/api/device/messages', { token: a.token })).json.messages, []);
  const overview = (await f.call('/api/overview', { admin: true })).json;
  assert.equal(overview.events.length, 2); assert.equal(overview.devices[0].status, 'online');
  assert.ok(!JSON.stringify(overview).includes(a.token));
  await f.call(`/api/devices/${a.device.id}`, { method: 'DELETE', admin: true });
  assert.equal((await post(a.token)).status, 401);
});

test('Telegram settings are encrypted, explicit test uses fixed host, failures retain events without secret errors', async t => {
  const secret = '123456:private_secret_telegram_token';
  const chatId = '-123456789';
  const requests = []; let fail = false;
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (fail) throw new Error(`oops ${url}`);
    return new Response('{"ok":true}');
  } });
  await f.login();
  assert.deepEqual((await f.call('/api/settings', { admin: true })).json.telegram, { configured: false, enabled: false });
  const save = await f.call('/api/settings/telegram', { method: 'POST', admin: true, body: { token: secret, chatId, enabled: true } });
  assert.deepEqual(save.json, { ok: true, telegram: { configured: true, enabled: true } });
  assert.equal(requests.length, 0);
  await f.restart(); await f.login();
  assert.equal((await f.call('/api/modules/telegram/test', { method: 'POST', admin: true })).status, 200);
  assert.equal(new URL(requests[0].url).origin, 'https://api.telegram.org');
  assert.equal(JSON.parse(requests[0].options.body).chat_id, chatId);
  const a = (await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'one' } })).json;
  const event = { title: 'Тест', message: 'Сообщение', eventId: 'one' };
  const concurrent = await Promise.all([1, 2].map(() => f.call('/api/device/events', { method: 'POST', token: a.token, body: event })));
  assert.deepEqual(concurrent.map(x => x.json.duplicate).sort(), [false, true]);
  assert.equal(requests.length, 2);
  fail = true;
  const failure = await f.call('/api/events', { method: 'POST', admin: true, body: { title: 'Не потерять', message: '' } });
  assert.equal(failure.status, 200); assert.equal(failure.json.event.delivery, 'telegram_failed');
  const testFailure = await f.call('/api/modules/telegram/test', { method: 'POST', admin: true });
  assert.equal(testFailure.status, 502); assert.deepEqual(testFailure.json, { ok: false, code: 'telegram_failed' });
  for (const file of await readdir(f.dataDir)) {
    const raw = await readFile(join(f.dataDir, file));
    assert.ok(!raw.includes(Buffer.from(secret))); assert.ok(!raw.includes(Buffer.from(chatId))); assert.ok(!raw.includes(Buffer.from(a.token)));
    assert.equal((await stat(join(f.dataDir, file))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(f.dataDir)).mode & 0o777, 0o700);
  await f.call('/api/settings/telegram', { method: 'DELETE', admin: true });
  assert.equal((await f.call('/api/settings', { admin: true })).json.telegram.configured, false);
});

test('validation rejects oversized/invalid input, login abuse is bounded and web paths are allowlisted', async t => {
  const f = await fixture(t); await f.login();
  assert.equal((await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'x'.repeat(65) } })).status, 400);
  assert.equal((await f.call('/api/events', { method: 'POST', admin: true, body: { title: 'x', message: 'y'.repeat(17000) } })).status, 413);
  assert.equal((await f.call('/api/events', { method: 'POST', admin: true, body: 'null' })).status, 400);
  assert.equal((await f.call('/api/events', { method: 'POST', admin: true, body: '{' })).status, 400);
  assert.equal((await f.call('/src/server.mjs')).status, 404);
  assert.equal((await f.call('/.data/state.json')).status, 404);
  const page = await f.call('/'); assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  let result;
  for (let i = 0; i < 11; i++) result = await f.call('/api/login', { method: 'POST', body: { password: 'wrong' }, headers: { Origin: origin } });
  assert.equal(result.status, 429);
});

test('AI uses encrypted settings and bounded official Responses requests only on explicit invocation', async t => {
  const apiKey = 'sk-test-private-key-1234567890';
  const requests = []; let status = 200;
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(status === 200 ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Привет от Киби' }] }] } : { error: { message: apiKey } }), { status });
  } });
  await f.login();
  let settings = (await f.call('/api/settings', { admin: true })).json;
  assert.deepEqual(settings.ai, { configured: false, enabled: false, provider: 'openai', model: 'gpt-5-mini', systemPrompt: '' });
  const save = await f.call('/api/settings/ai', { method: 'POST', admin: true, body: { apiKey, model: 'gpt-5-mini', systemPrompt: 'Отвечай по-русски.', enabled: true } });
  assert.equal(save.status, 200); assert.equal(requests.length, 0);
  assert.ok(!save.text.includes(apiKey));
  await f.restart(); await f.login();
  settings = (await f.call('/api/settings', { admin: true })).json;
  assert.equal(settings.ai.configured, true); assert.equal(settings.ai.systemPrompt, 'Отвечай по-русски.');
  const reply = await f.call('/api/modules/ai/test', { method: 'POST', admin: true, body: { text: 'Привет' } });
  assert.deepEqual(reply.json, { ok: true, text: 'Привет от Киби' });
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${apiKey}`);
  assert.deepEqual(JSON.parse(requests[0].options.body), { model: 'gpt-5-mini', instructions: 'Отвечай по-русски.', input: 'Привет', store: false, max_output_tokens: 1024 });
  assert.equal(requests[0].options.redirect, 'error');
  const device = (await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'AI device' } })).json;
  assert.equal((await f.call('/api/device/chat', { method: 'POST', token: device.token, body: { text: 'Вопрос' } })).status, 200);
  for (const [providerStatus, code] of [[401, 'ai_auth_failed'], [429, 'ai_quota_exceeded'], [500, 'ai_unavailable']]) {
    status = providerStatus;
    const result = await f.call('/api/modules/ai/test', { method: 'POST', admin: true, body: { text: 'Привет' } });
    assert.equal(result.status, 502); assert.deepEqual(result.json, { ok: false, code });
  }
  for (const file of await readdir(f.dataDir)) assert.ok(!(await readFile(join(f.dataDir, file))).includes(Buffer.from(apiKey)));
  await f.call('/api/settings/ai', { method: 'POST', admin: true, body: { apiKey: '', model: 'gpt-5-mini', systemPrompt: '', enabled: false } });
  assert.equal((await f.call('/api/device/chat', { method: 'POST', token: device.token, body: { text: 'Вопрос' } })).json.code, 'ai_disabled');
  await f.call('/api/settings/ai', { method: 'DELETE', admin: true });
  assert.equal((await f.call('/api/settings', { admin: true })).json.ai.configured, false);
});

test('AI rejects excess input, malformed or oversized provider output without leaking it', async t => {
  let response = 'too large';
  const f = await fixture(t, { fetchImpl: async () => response === 'too large'
    ? new Response('secret'.repeat(50000))
    : new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(5000) }] }] })) });
  await f.login();
  await f.call('/api/settings/ai', { method: 'POST', admin: true, body: { apiKey: 'sk-test-private-key-1234567890', model: 'gpt-5-mini', systemPrompt: '', enabled: true } });
  assert.equal((await f.call('/api/modules/ai/test', { method: 'POST', admin: true, body: { text: 'x'.repeat(2001) } })).status, 400);
  const tooLarge = await f.call('/api/modules/ai/test', { method: 'POST', admin: true, body: { text: 'x' } });
  assert.deepEqual(tooLarge.json, { ok: false, code: 'ai_unavailable' });
  response = 'long text';
  const long = await f.call('/api/modules/ai/test', { method: 'POST', admin: true, body: { text: 'x' } });
  assert.equal(long.json.text.length, 4000);
});

test('a pending provider request does not block device administration', async t => {
  let release; let started;
  const beginning = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { fetchImpl: async () => { started(); await pending; return new Response(JSON.stringify({ output: [] })); } });
  await f.login();
  await f.call('/api/settings/ai', { method: 'POST', admin: true, body: { apiKey: 'sk-test-private-key-1234567890', model: 'gpt-5-mini', systemPrompt: '', enabled: true } });
  const request = f.call('/api/modules/ai/test', { method: 'POST', admin: true, body: { text: 'x' } });
  await beginning;
  let timer;
  try {
    const result = await Promise.race([
      f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'Available' } }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'blocked' }), 500); }),
    ]);
    assert.equal(result.status, 200);
  } finally { clearTimeout(timer); release(); await request; }
});

test('retention, device and message queue limits are enforced without losing unacknowledged messages', async t => {
  const f = await fixture(t); await f.login();
  const device = (await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'queue' } })).json;
  for (let i = 0; i < 50; i++) assert.equal((await f.call(`/api/devices/${device.device.id}/messages`, { method: 'POST', admin: true, body: { title: `m${i}`, message: '' } })).status, 200);
  assert.equal((await f.call(`/api/devices/${device.device.id}/messages`, { method: 'POST', admin: true, body: { title: 'overflow', message: '' } })).status, 409);
  assert.equal((await f.call('/api/device/messages', { token: device.token })).json.messages.length, 50);
  for (let i = 1; i < 50; i++) assert.equal((await f.call('/api/devices', { method: 'POST', admin: true, body: { name: `d${i}` } })).status, 200);
  assert.equal((await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'overflow' } })).status, 409);
});

test('event deduplication expires with the documented recent event retention window', async t => {
  const f = await fixture(t); await f.login();
  const device = (await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'event device' } })).json;
  const body = { title: 'first', message: '', eventId: 'first' };
  const first = (await f.call('/api/device/events', { method: 'POST', token: device.token, body })).json;
  for (let i = 0; i < 200; i++) assert.equal((await f.call('/api/events', { method: 'POST', admin: true, body: { title: `e${i}`, message: '' } })).status, 200);
  let overview = (await f.call('/api/overview', { admin: true })).json;
  assert.equal(overview.events.length, 200); assert.equal(overview.events[0].title, 'e199');
  const repeated = (await f.call('/api/device/events', { method: 'POST', token: device.token, body })).json;
  assert.equal(repeated.duplicate, false); assert.notEqual(repeated.eventId, first.eventId);
});

test('expired sessions, logout and device rate limits reject continued use', async t => {
  const f = await fixture(t); await f.login();
  const device = (await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'rate' } })).json;
  for (let i = 0; i < 120; i++) assert.equal((await f.call('/api/device/messages', { token: device.token })).status, 200);
  assert.equal((await f.call('/api/device/messages', { token: device.token })).status, 429);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 13 * 60 * 60 * 1000;
    assert.deepEqual((await f.call('/api/session', { admin: true })).json, { authenticated: false });
    assert.equal((await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'stale' } })).status, 401);
  } finally { Date.now = realNow; }
  await f.login();
  assert.equal((await f.call('/api/logout', { method: 'POST', admin: true })).status, 200);
  assert.equal((await f.call('/api/overview', { admin: true })).status, 401);
});

test('runtime refuses linked/private-insecure data files and never modifies outside link targets', async t => {
  const { createKibiServer } = await import('../src/server.mjs');
  const root = await mkdtemp(join(tmpdir(), 'kibi-private-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  const value = 'outside-secret-material-32-bytes!';
  await writeFile(outside, value, { mode: 0o600 });
  for (const kind of ['symlink', 'hardlink', 'insecure']) {
    const dataDir = join(root, kind); await mkdir(dataDir, { mode: 0o700 });
    const key = join(dataDir, 'encryption.key');
    if (kind === 'symlink') await symlink(outside, key);
    else if (kind === 'hardlink') await link(outside, key);
    else { await writeFile(key, Buffer.alloc(32), { mode: 0o600 }); await chmod(key, 0o644); }
    await assert.rejects(createKibiServer({ dataDir, adminPassword: password, publicOrigin: origin }));
    assert.equal(await readFile(outside, 'utf8'), value);
    assert.equal((await stat(outside)).mode & 0o777, 0o600);
  }
  const linkedParent = join(root, 'linked-parent'); await symlink(root, linkedParent);
  await assert.rejects(createKibiServer({ dataDir: join(linkedParent, 'nested'), adminPassword: password, publicOrigin: origin }));
  const missingKey = join(root, 'missing-key'); await mkdir(missingKey, { mode: 0o700 });
  await writeFile(join(missingKey, 'state.json'), '{}', { mode: 0o600 });
  await assert.rejects(createKibiServer({ dataDir: missingKey, adminPassword: password, publicOrigin: origin }));
  await assert.rejects(createKibiServer({ dataDir: join(root, 'short-password'), adminPassword: 'short', publicOrigin: origin }));
});

test('pending Telegram delivery preserves deduplication while inbox and revoke remain available', async t => {
  let release; let started;
  const beginning = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => { calls++; started(); await pending; return new Response('{"ok":true}'); } });
  await f.login();
  await f.call('/api/settings/telegram', { method: 'POST', admin: true, body: { token: '123456:private_secret_telegram_token', chatId: '-123456789', enabled: true } });
  const a = (await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'sending' } })).json;
  const b = (await f.call('/api/devices', { method: 'POST', admin: true, body: { name: 'other' } })).json;
  const options = { method: 'POST', token: a.token, body: { title: 'Pending', message: '', eventId: 'pending' } };
  const request = f.call('/api/device/events', options); await beginning;
  let timer;
  try {
    const result = await Promise.race([
      (async () => {
        const duplicate = await f.call('/api/device/events', options);
        assert.equal(duplicate.json.duplicate, true);
        assert.equal((await f.call('/api/device/messages', { token: b.token })).status, 200);
        assert.equal((await f.call(`/api/devices/${a.device.id}`, { method: 'DELETE', admin: true })).status, 200);
        assert.equal((await f.call('/api/device/messages', { token: a.token })).status, 401);
        return 'responsive';
      })(),
      new Promise(resolve => { timer = setTimeout(() => resolve('blocked'), 500); }),
    ]);
    assert.equal(result, 'responsive'); assert.equal(calls, 1);
  } finally { clearTimeout(timer); release(); await request; }
});

test('upstream deadlines fail closed even when an injected transport ignores abort', async () => {
  const { askAi } = await import('../src/ai.mjs');
  const { sendTelegram } = await import('../src/telegram.mjs');
  const never = () => new Promise(() => {});
  const [ai, telegram] = await Promise.all([
    askAi({ apiKey: 'sk-test-private-key-1234567890', model: 'gpt-5-mini', systemPrompt: '' }, 'test', never),
    sendTelegram({ token: '123456:private_secret_telegram_token', chatId: '-123456789' }, 'test', '', never),
  ]);
  assert.deepEqual(ai, { code: 'ai_unavailable' }); assert.equal(telegram, false);
});

test('Xiaozhi setup is explicit, owner-only, CSRF guarded, and cannot fall back to paid voice', async t => {
 let calls=0;
 const f=await fixture(t,{fetchImpl:async()=>{calls++;throw new Error('PRIVATE_PROVIDER_TOKEN');}});
 assert.equal((await f.call('/api/settings/xiaozhi')).status,401);await f.login();
 assert.equal((await f.call('/api/settings/xiaozhi',{admin:true})).json.configured,false);assert.equal(calls,0);
 assert.equal((await f.call('/api/settings/xiaozhi/prepare',{method:'POST',admin:true,body:{},headers:{'X-CSRF-Token':'bad'}})).status,403);assert.equal(calls,0);
 const selected=await f.call('/api/settings/voice',{method:'POST',admin:true,body:{provider:'xiaozhi',scope:{kind:'legacy',id:'project-test'}}});
 assert.equal(selected.status,200);assert.equal(selected.json.voice.provider,'xiaozhi');assert.equal(selected.json.voice.configured,false);assert.equal(calls,0);
 const prepare=await f.call('/api/settings/xiaozhi/prepare',{method:'POST',admin:true,body:{}});
 assert.equal(prepare.status,502);assert.equal(calls,1);assert.doesNotMatch(prepare.text,/PRIVATE_PROVIDER_TOKEN|stack|\.mjs/);
 await f.restart();await f.login();assert.equal((await f.call('/api/settings',{admin:true})).json.voice.provider,'xiaozhi');
});
