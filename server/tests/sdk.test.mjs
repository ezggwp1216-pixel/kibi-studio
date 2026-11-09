import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const sdk = () => import('../sdk/index.mjs');
const base = 'https://kibi.example/server/';
const token = 'test-device-token-never-log';
const pollToken = 'test-poll-token-never-log';
const expiresAt = '2026-11-09T12:05:00.000Z';
const device = { id: 'device-1', name: 'Киби', createdAt: '2026-11-09T12:00:00.000Z', lastSeenAt: null, status: 'not_seen' };
const runFile = promisify(execFile);
const exampleUrl = new URL('../examples/server-plugin/local-notification.kibiplugin', import.meta.url);

test('plugin validator accepts declarative example and treats source strictly as inert text', async () => {
  const { validatePlugin } = await sdk();
  const text = await readFile(exampleUrl, 'utf8');
  const valid = validatePlugin(text);
  assert.equal(valid.ok, true);
  assert.equal(valid.requiresRuntime, false);
  assert.equal(valid.runtimeSupported, false);
  const withCode = { ...JSON.parse(text), server: { language: 'javascript', source: 'globalThis.__kibiSdkExecuted = true; throw new Error("never execute");' } };
  const codeResult = validatePlugin(JSON.stringify(withCode));
  assert.equal(codeResult.ok, true);
  assert.equal(codeResult.requiresRuntime, true);
  assert.equal(codeResult.runtimeSupported, false);
  assert.equal(globalThis.__kibiSdkExecuted, undefined);
  const future = validatePlugin(await readFile(new URL('../examples/server-plugin/future-handler.kibiplugin', import.meta.url), 'utf8'));
  assert.equal(future.ok, true);
  assert.equal(future.requiresRuntime, true);
});

test('plugin validator rejects unknown privileges, secret values, code objects and excessive input safely', async () => {
  const { validatePlugin } = await sdk();
  const manifest = JSON.parse(await readFile(exampleUrl, 'utf8'));
  const cases = [
    { ...manifest, manifestVersion: 2 },
    { ...manifest, id: '../outside' },
    { ...manifest, permissions: ['filesystem:read'] },
    { ...manifest, capabilities: ['network:any'] },
    { ...manifest, secrets: [{ key: 'providerKey', label: 'Ключ', required: true, value: 'PRIVATE_VALUE' }] },
    { ...manifest, settings: [{ key: 'prefix', label: 'Подпись', type: 'text', default: { private: true } }] },
    { ...manifest, settings: [{ key: 'prefix', label: 'Подпись', type: 'text' }, { key: 'prefix', label: 'Повтор', type: 'text' }] },
    { ...manifest, server: { language: 'javascript', source: 'x'.repeat(65537) } },
    { ...manifest, unexpected: 'PRIVATE_VALUE' },
  ];
  for (const candidate of cases) {
    const result = validatePlugin(JSON.stringify(candidate));
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE/);
  }
  for (const candidate of ['null', '{', 'x'.repeat(131073), '{"__proto__":{}}', { ...manifest, server: { language: 'javascript', source: () => {} } }]) {
    assert.equal(validatePlugin(candidate).ok, false);
  }
});

test('validator CLI reports structure only and never echoes invalid package data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kibi-sdk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = new URL('../sdk/validate.mjs', import.meta.url).pathname;
  const valid = await runFile(process.execPath, [cli, exampleUrl.pathname]);
  assert.equal(JSON.parse(valid.stdout).ok, true);
  const path = join(directory, 'invalid.kibiplugin');
  await writeFile(path, '{"PRIVATE_VALUE":"not a package"}');
  await assert.rejects(runFile(process.execPath, [cli, path]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).ok, false);
    assert.doesNotMatch(error.stdout + error.stderr, /PRIVATE_VALUE|not a package/);
    return true;
  });
});

test('device client pins a configured HTTPS base and sends secrets only in protected request fields', async () => {
  const { createKibiClient } = await sdk();
  const requests = [];
  const responses = [
    { pairingId: 'pair-1', code: 'ABCD1234', pollToken, expiresAt, intervalSeconds: 3 },
    { status: 'pending', expiresAt },
    { status: 'paired', device, token, apiBase: base },
    { ok: true, eventId: 'event-1', duplicate: false },
    { messages: [{ id: 'message-1', title: 'Ответ', message: 'Готово', createdAt: '2026-11-09T12:00:00.000Z' }] },
    { ok: true },
  ];
  const client = createKibiClient({ apiBase: base, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(responses.shift()), { status: requests.length === 1 ? 201 : 200 });
  } });
  assert.equal(requests.length, 0);
  const pairing = await client.startPairing({ name: 'Киби' });
  assert.equal(pairing.code, 'ABCD1234');
  assert.deepEqual(await client.pollPairing(pairing), { status: 'pending', expiresAt });
  const paired = await client.pollPairing(pairing);
  assert.equal(paired.token, token);
  await assert.rejects(client.getMessages(), error => error.code === 'token_required');
  client.setDeviceToken(paired.token);
  assert.deepEqual(await client.sendEvent({ title: 'Кнопка', message: 'Нажата', eventId: 'press-1' }), { ok: true, eventId: 'event-1', duplicate: false });
  const messages = await client.getMessages();
  assert.equal(messages.messages[0].message, 'Готово');
  assert.deepEqual(await client.acknowledge({ messageId: 'message-1' }), { ok: true });
  assert.deepEqual(requests.map(request => request.url), [
    base + 'api/pairing/start', base + 'api/pairing/poll', base + 'api/pairing/poll',
    base + 'api/device/events', base + 'api/device/messages', base + 'api/device/ack',
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body), { pairingId: 'pair-1', pollToken });
  assert.deepEqual(JSON.parse(requests[3].options.body), { title: 'Кнопка', message: 'Нажата', eventId: 'press-1' });
  for (const [index, request] of requests.entries()) {
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.headers.Authorization, index >= 3 ? `Bearer ${token}` : undefined);
    assert.ok(!request.url.includes(token) && !request.url.includes(pollToken));
  }
  assert.doesNotMatch(JSON.stringify(client), /test-device-token|test-poll-token/);
  client.clearDeviceToken();
  await assert.rejects(client.getMessages(), error => error.code === 'token_required');
});

test('client rejects insecure or ambiguous base URLs and disallows a pairing response changing its base', async () => {
  const { createKibiClient } = await sdk();
  for (const apiBase of ['http://kibi.example/', 'https://user:secret@kibi.example/', 'https://kibi.example/?token=x', 'https://kibi.example/#x', 'https://kibi.example/a/../b', 'https://kibi.example/a%2fb', 'https://kibi.example//server', 'https://kibi.example\\evil/', '//kibi.example/', 'https://kibi.example/ server']) {
    assert.throws(() => createKibiClient({ apiBase }), error => error.code === 'invalid_base');
  }
  assert.throws(() => createKibiClient({ apiBase: 'http://localhost:4391/' }), error => error.code === 'invalid_base');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const local = createKibiClient({ apiBase: `http://${host}:4391/`, allowLocalhostHttp: true, fetchImpl: async () => new Response('{"messages":[]}') });
    local.setDeviceToken(token);
    assert.deepEqual(await local.getMessages(), { messages: [] });
  }
  assert.throws(() => createKibiClient({ apiBase: 'http://127.1/', allowLocalhostHttp: true }), error => error.code === 'invalid_base');
  assert.throws(() => createKibiClient({ apiBase: 'http://localhost.evil.invalid/', allowLocalhostHttp: true }), error => error.code === 'invalid_base');
  for (const apiBase of ['https://evil.invalid/server/', 'https://kibi.example/other/']) {
    const client = createKibiClient({ apiBase: base, fetchImpl: async () => new Response(JSON.stringify({ status: 'paired', device, token, apiBase })) });
    await assert.rejects(client.pollPairing({ pairingId: 'pair-1', pollToken }), error => error.code === 'invalid_response');
    await assert.rejects(client.getMessages(), error => error.code === 'token_required');
  }
});

test('client validates inputs before transport and returns bounded fixed errors without leaking responses', async () => {
  const { createKibiClient, KibiSdkError } = await sdk();
  let calls = 0;
  const noNetwork = createKibiClient({ apiBase: base, deviceToken: token, fetchImpl: async () => { calls++; throw new Error('PRIVATE_TRANSPORT_VALUE'); } });
  await assert.rejects(noNetwork.startPairing({ name: '' }), error => error.code === 'invalid_argument');
  await assert.rejects(noNetwork.sendEvent({ title: 'x', message: 'x'.repeat(2001) }), error => error.code === 'invalid_argument');
  await assert.rejects(noNetwork.sendEvent({ title: 'x', eventId: '../invalid' }), error => error.code === 'invalid_argument');
  await assert.rejects(noNetwork.acknowledge({ messageId: '' }), error => error.code === 'invalid_argument');
  assert.equal(calls, 0);
  await assert.rejects(noNetwork.getMessages(), error => {
    assert.ok(error instanceof KibiSdkError);
    assert.equal(error.code, 'network_error');
    assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE_TRANSPORT_VALUE/);
    return true;
  });
  for (const [body, status, code] of [
    ['{"code":"PRIVATE_ERROR_VALUE"}', 410, 'http_error'],
    ['PRIVATE_BODY_VALUE', 200, 'invalid_response'],
    ['x'.repeat(131073), 200, 'invalid_response'],
    ['{"messages":[{"id":"one","title":"x","message":"x","createdAt":"invalid"}]}', 200, 'invalid_response'],
  ]) {
    const client = createKibiClient({ apiBase: base, deviceToken: token, fetchImpl: async () => new Response(body, { status }) });
    await assert.rejects(client.getMessages(), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE_ERROR_VALUE|PRIVATE_BODY_VALUE/);
      if (status === 410) assert.equal(error.status, 410);
      return true;
    });
  }
});

test('SDK deadline bounds a transport that ignores abort and never retries', async () => {
  const { createKibiClient } = await sdk();
  let calls = 0;
  const client = createKibiClient({ apiBase: base, deviceToken: token, timeoutMs: 15, fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(client.getMessages(), error => error.code === 'timeout');
  assert.equal(calls, 1);
});

test('device client preserves multiline messages and the server safe ASCII event ID alphabet', async () => {
  const { createKibiClient } = await sdk();
  const requests = [];
  const client = createKibiClient({ apiBase: base, deviceToken: token, fetchImpl: async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response('{"ok":true,"eventId":"server-event-1","duplicate":false}');
  } });
  await client.sendEvent({ title: 'Отчёт', message: 'Строка 1\nСтрока 2\tготова', eventId: 'button:press.1-2_3' });
  assert.deepEqual(requests, [{ title: 'Отчёт', message: 'Строка 1\nСтрока 2\tготова', eventId: 'button:press.1-2_3' }]);
});

test('client refuses redirects and oversized valid response bodies before returning data', async () => {
  const { createKibiClient } = await sdk();
  for (const response of [
    { status: 200, url: 'https://evil.invalid/api/device/messages', text: async () => '{"messages":[]}' },
    { status: 200, redirected: true, text: async () => '{"messages":[]}' },
    new Response(JSON.stringify({ messages: [], padding: 'x'.repeat(512 * 1024) })),
  ]) {
    const client = createKibiClient({ apiBase: base, deviceToken: token, fetchImpl: async () => response });
    await assert.rejects(client.getMessages(), error => error.code === 'invalid_response');
  }
});
