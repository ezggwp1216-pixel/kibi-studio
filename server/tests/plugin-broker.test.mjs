import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const serverModule = await import('../src/plugins/broker.mjs').catch(() => ({}));
const clientModule = await import('../src/plugins/broker-client.mjs').catch(() => ({}));
const invocation = { source: 'THIS SOURCE MUST NEVER EXECUTE IN HTTP', handler: 'onDeviceRequest', input: { value: 42 }, settings: {} };
const runtimeStatus = { configured: true, available: true, reason: 'ready', isolation: 'docker' };
const frame = Buffer.alloc(240 * 296 * 2, 127);
const mediaFrame = { rgb565: frame, width: 240, height: 296, sha256: createHash('sha256').update(frame).digest('hex') };

async function fixture(t, { runtime, media, ...options } = {}) {
  assert.equal(typeof serverModule.createPluginBrokerServer, 'function', 'execution broker is implemented');
  assert.equal(typeof clientModule.createPluginBrokerClient, 'function', 'socket-only client is implemented');
  const directory = await mkdtemp('/tmp/kibi-broker-');
  const socketPath = directory + '/executor.sock';
  const server = serverModule.createPluginBrokerServer({ socketPath,
    runtime: runtime ?? { status: () => runtimeStatus, invoke: async () => ({ value: 42 }), close: async () => {} },
    media: media ?? { status: () => ({ enabled: true, available: true, status: 'ready' }), frame: async () => mediaFrame, close: async () => {} },
    ...options });
  await server.listen();
  const client = clientModule.createPluginBrokerClient({ socketPath });
  t.after(async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  await client.ready();
  return { server, client, directory, socketPath };
}

test('socket-only client fails closed without broker and never imports execution adapters', async () => {
  assert.equal(typeof clientModule.createPluginBrokerClient, 'function', 'socket-only client is implemented');
  const client = clientModule.createPluginBrokerClient({ socketPath: '/tmp/kibi-broker-does-not-exist.sock' });
  await client.ready();
  assert.equal(client.runtime.status().available, false);
  assert.equal(client.media.status().available, false);
  await assert.rejects(client.runtime.invoke(invocation), { code: 'plugin_runtime_unavailable' });
  await assert.rejects(client.media.frame({ videoId: 'dQw4w9WgXcQ', fit: 'contain' }), { code: 'plugin_media_unavailable' });
  await client.close();
  const source = await readFile(new URL('../src/plugins/broker-client.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /child_process|docker-runtime|youtube\.mjs|runner\.mjs|\beval\(|\bimport\(/);
});

test('private Unix socket forwards only typed execution and bounded media results', async t => {
  const calls = [];
  const { client, socketPath } = await fixture(t, { runtime: {
    status: () => ({ ...runtimeStatus, source: 'SECRET', privatePath: '/private/account' }),
    invoke: async request => { calls.push(request); return { value: request.input.value }; }, close: async () => {} } });
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  assert.equal(client.runtime.status().available, true);
  assert.equal(client.media.status().configured, true);
  assert.doesNotMatch(JSON.stringify(client.runtime.status()), /SECRET|private/);
  assert.deepEqual(await client.runtime.invoke(invocation), { value: 42 });
  assert.equal(calls[0].source, invocation.source);
  assert.equal(calls[0].signal instanceof AbortSignal, true);
  assert.deepEqual(await client.media.frame({ videoId: 'dQw4w9WgXcQ', fit: 'cover' }), mediaFrame);
});

test('broker preserves the fixed provider restriction as 424 for media frames only', async t => {
  const { client } = await fixture(t, { media: {
    status: () => ({ enabled: true, available: false, status: 'unverified' }), close: async () => {},
    frame: async () => { throw Object.assign(new Error('PRIVATE upstream https://private.example'), { code: 'plugin_media_provider_restricted' }); }
  } });
  await assert.rejects(client.media.frame({ videoId: '4t4AQ15yj1M' }), { code: 'plugin_media_provider_restricted', status: 424, message: 'plugin_media_provider_restricted' });
  assert.equal(client.media.status().available, false);
});

test('runtime exceptions cannot impersonate media provider or media cleanup failures', async t => {
  let emitted = 'plugin_media_provider_restricted';
  const { client } = await fixture(t, { runtime: {
    status: () => runtimeStatus, close: async () => {},
    invoke: async () => { throw Object.assign(new Error('PRIVATE user error'), { code: emitted }); }
  } });
  for (const value of ['plugin_media_provider_restricted', 'plugin_media_cleanup_failed']) {
    emitted = value;
    await assert.rejects(client.runtime.invoke(invocation), { code: 'plugin_runtime_failed', status: 502 });
  }
  assert.equal(client.runtime.status().available, true);
});

test('IPC client fences a runtime response carrying a media-only failure code', async t => {
  const directory = await mkdtemp('/tmp/kibi-broker-'), socketPath = directory + '/executor.sock';
  let emitted;
  const server = createServer(socket => socket.once('data', () => socket.end(JSON.stringify({ ok: false, code: emitted,
    status: { runtime: runtimeStatus, media: { configured: true, available: false, status: 'unverified' } } }) + '\n')));
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  for (const value of ['plugin_media_provider_restricted', 'plugin_media_cleanup_failed']) {
    emitted = value;
    const client = clientModule.createPluginBrokerClient({ socketPath });
    try {
      await assert.rejects(client.runtime.invoke(invocation), { code: 'plugin_runtime_cleanup_failed', status: 503 });
      assert.equal(client.runtime.status().available, false);
    } finally { await client.close(); }
  }
});

test('rejects unsupported, malformed and oversized IPC without dispatching or leaking private errors', async t => {
  let called = 0;
  const { socketPath, client } = await fixture(t, { runtime: {
    status: () => runtimeStatus, invoke: async () => { called++; throw new Error('PRIVATE KEY'); }, close: async () => {} } });
  async function raw(payload) {
    const socket = createConnection(socketPath); let response = '';
    socket.on('data', data => { response += data; }); socket.on('error', () => {});
    const done = new Promise(resolve => socket.on('close', resolve));
    await new Promise(resolve => socket.on('connect', resolve)); socket.write(payload); await done;
    assert.doesNotMatch(response, /PRIVATE|source|credential/); return response;
  }
  for (const payload of ['{"version":1,"op":"shell","payload":{"command":"id"}}\n', '{not JSON}\n', 'x'.repeat(512 * 1024 + 1),
    JSON.stringify({ version: 1, op: 'invoke', payload: { ...invocation, accountId: 'owner' } }) + '\n',
    JSON.stringify({ version: 1, op: 'frame', payload: { videoId: 'https://private', fit: 'cover' } }) + '\n']) {
    await raw(payload);
  }
  assert.equal(called, 0);
  await assert.rejects(client.runtime.invoke(invocation), { code: 'plugin_runtime_failed' });
  assert.equal(called, 1);
});

test('cancellation waits for worker cleanup before releasing the invocation', async t => {
  let started, aborted, cleanup;
  const hasStarted = new Promise(resolve => { started = resolve; });
  const hasAborted = new Promise(resolve => { aborted = resolve; });
  const cleaned = new Promise(resolve => { cleanup = resolve; });
  const { client } = await fixture(t, { runtime: {
    status: () => runtimeStatus, close: async () => {},
    async invoke({ signal }) { started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); aborted(); await cleaned; throw Object.assign(new Error('private'), { code: 'plugin_invocation_cancelled' }); }
  } });
  const controller = new AbortController();
  let settled = false;
  const promise = client.runtime.invoke({ ...invocation, signal: controller.signal }).finally(() => { settled = true; });
  const rejected = assert.rejects(promise, { code: 'plugin_invocation_cancelled' });
  await hasStarted; controller.abort(); await hasAborted; await delay(10);
  assert.equal(settled, false); cleanup(); await rejected;
});

test('client disconnect cancels broker work and close drains adapter cleanup', async t => {
  let started, aborted, cleaned, closeCalls = 0;
  const hasStarted = new Promise(resolve => { started = resolve; });
  const hasAborted = new Promise(resolve => { aborted = resolve; });
  const cleanup = new Promise(resolve => { cleaned = resolve; });
  const { socketPath, server } = await fixture(t, { runtime: {
    status: () => runtimeStatus,
    async invoke({ signal }) { started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); aborted(); await cleanup; throw Object.assign(new Error('private'), { code: 'plugin_invocation_cancelled' }); },
    async close() { closeCalls++; }
  } });
  const socket = createConnection(socketPath); socket.on('error', () => {});
  await new Promise(resolve => socket.on('connect', resolve));
  socket.write(JSON.stringify({ version: 1, op: 'invoke', payload: invocation }) + '\n');
  await hasStarted; socket.destroy(); await hasAborted;
  let closed = false; const closing = server.close().then(() => { closed = true; });
  await delay(10); assert.equal(closed, false); cleaned(); await closing; assert.equal(closeCalls, 1);
});

test('broker shares a four-operation cap across runtime and media and releases it after cleanup', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const { client } = await fixture(t, {
    runtime: { status: () => runtimeStatus, invoke: async () => { calls++; await gate; return {}; }, close: async () => {} },
    media: { status: () => ({ enabled: true, available: true, status: 'ready' }), frame: async () => { calls++; await gate; return mediaFrame; }, close: async () => {} }
  });
  const pending = [client.runtime.invoke(invocation), client.runtime.invoke(invocation), client.media.frame({ videoId: 'dQw4w9WgXcQ' }), client.media.frame({ videoId: 'dQw4w9WgXcQ' })];
  while (calls < 4) await delay(1);
  await assert.rejects(client.runtime.invoke(invocation), { code: 'plugin_runtime_busy' });
  release(); await Promise.all(pending); assert.deepEqual(await client.runtime.invoke(invocation), {});
});

test('broker bounds worker output and sanitizes frame hashes and status', async t => {
  const { client } = await fixture(t, {
    runtime: { status: () => runtimeStatus, invoke: async () => ({ private: 'x'.repeat(65537) }), close: async () => {} },
    media: { status: () => ({ enabled: true, available: true, status: 'ready', credentials: 'SECRET' }), frame: async () => ({ ...mediaFrame, sha256: '0'.repeat(64) }), close: async () => {} }
  });
  await assert.rejects(client.runtime.invoke(invocation), { code: 'plugin_runtime_output_limit' });
  await assert.rejects(client.media.frame({ videoId: 'dQw4w9WgXcQ' }), { code: 'plugin_media_invalid_frame' });
  assert.doesNotMatch(JSON.stringify(client.media.status()), /SECRET|credentials/);
});

test('broker refuses to replace an existing filesystem entry', async () => {
  assert.equal(typeof serverModule.createPluginBrokerServer, 'function', 'execution broker is implemented');
  const directory = await mkdtemp('/tmp/kibi-broker-'); const socketPath = directory + '/executor.sock';
  await writeFile(socketPath, 'preserve me');
  const server = serverModule.createPluginBrokerServer({ socketPath });
  try { await assert.rejects(server.listen(), { code: 'plugin_broker_unavailable' }); assert.equal(await readFile(socketPath, 'utf8'), 'preserve me'); }
  finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('abort followed by client close still waits for a single cleanup acknowledgement', async t => {
  let started, aborted, cleanup;
  const hasStarted = new Promise(resolve => { started = resolve; });
  const hasAborted = new Promise(resolve => { aborted = resolve; });
  const gate = new Promise(resolve => { cleanup = resolve; });
  const { client } = await fixture(t, { runtime: { status: () => runtimeStatus, close: async () => {},
    async invoke({ signal }) { started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); aborted(); await gate; throw Object.assign(new Error('private'), { code: 'plugin_invocation_cancelled' }); }
  } });
  const controller = new AbortController(); const result = assert.rejects(client.runtime.invoke({ ...invocation, signal: controller.signal }), { code: 'plugin_invocation_cancelled' });
  await hasStarted; controller.abort(); await hasAborted;
  let closed = false; const closing = client.close().then(() => { closed = true; });
  await delay(10); assert.equal(closed, false); cleanup(); await closing; await result;
});

test('unacknowledged cleanup is bounded, fixed and quarantined without late resurrection', async t => {
  let release;
  const worker = new Promise(resolve => { release = resolve; });
  const { client, server } = await fixture(t, { runtimeDeadlineMs: 10, cleanupGraceMs: 15,
    runtime: { status: () => runtimeStatus, invoke: () => worker, close: async () => {} } });
  await assert.rejects(client.runtime.invoke(invocation), { code: 'plugin_runtime_cleanup_failed' });
  assert.equal(client.runtime.status().available, false);
  await assert.rejects(client.runtime.invoke(invocation), { code: 'plugin_runtime_unavailable' });
  release({ value: 'late' }); await delay(1);
  assert.equal(client.runtime.status().available, false); await server.close();
});

test('an IPC disconnect after dispatch reports uncertain cleanup rather than releasing a reusable slot', async t => {
  assert.equal(typeof clientModule.createPluginBrokerClient, 'function');
  const directory = await mkdtemp('/tmp/kibi-broker-'); const socketPath = directory + '/executor.sock';
  const server = createServer(socket => socket.once('data', () => socket.destroy()));
  await new Promise(resolve => server.listen(socketPath, resolve));
  const client = clientModule.createPluginBrokerClient({ socketPath });
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(client.runtime.invoke(invocation), { code: 'plugin_runtime_cleanup_failed' });
  assert.equal(client.runtime.status().available, false);
  await assert.rejects(client.runtime.invoke(invocation), { code: 'plugin_runtime_unavailable' });
});

test('broker startup does not wait forever for a stuck adapter readiness check', async t => {
  const before = Date.now();
  const { client } = await Promise.race([fixture(t, { startupDeadlineMs: 15,
    runtime: { ready: () => new Promise(() => {}), status: () => runtimeStatus, invoke: async () => ({}), close: async () => {} } }), delay(100).then(() => { throw new Error('broker readiness must be bounded'); })]);
  assert.equal(client.runtime.status().available, false);
  assert.ok(Date.now() - before < 1000);
});

test('broker CLI starts with disabled adapters and exposes only local status', async t => {
  const module = await import('../src/plugins/broker-main.mjs').catch(() => ({}));
  assert.equal(typeof module.startPluginBroker, 'function', 'dedicated execution CLI is implemented');
  const directory = await mkdtemp('/tmp/kibi-broker-'); const socketPath = directory + '/executor.sock';
  const server = await module.startPluginBroker({ env: { KIBI_PLUGIN_BROKER_SOCKET: socketPath } });
  const client = clientModule.createPluginBrokerClient({ socketPath });
  t.after(async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  await client.ready(); assert.equal(client.runtime.status().configured, false); assert.equal(client.media.status().configured, false);
});

test('capability reads refresh an expired broker snapshot using only local IPC', async t => {
  const { client } = await fixture(t); const now = Date.now();
  t.mock.method(Date, 'now', () => now + 6000);
  assert.equal(client.runtime.status().available, false);
  for (let i = 0; i < 20 && !client.runtime.status().available; i++) await delay(5);
  assert.equal(client.runtime.status().available, true);
});

test('null settings remain invalid across the IPC boundary', async t => {
  let called = false;
  const { client } = await fixture(t, { runtime: { status: () => runtimeStatus, invoke: async () => { called = true; return {}; }, close: async () => {} } });
  await assert.rejects(client.runtime.invoke({ ...invocation, settings: null }), { code: 'plugin_runtime_invalid_input' });
  assert.equal(called, false);
});
