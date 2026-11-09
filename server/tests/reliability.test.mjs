import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createKibiServer } from '../src/server.mjs';
import { openStore } from '../src/store.mjs';
import { sendTelegram } from '../src/telegram.mjs';
import { createKibiClient } from '../sdk/client.mjs';

const origin = 'http://localhost:4391';
const password = 'synthetic reliability test password';
const telegram = { token: '123456:synthetic-test-token', chatId: '123456', enabled: true };

// Exercise the actual request handlers without opening a local or external socket.
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'kibi-reliability-'));
  let server;
  const start = async () => { server = await createKibiServer({ dataDir: dir, adminPassword: password, publicOrigin: origin, voiceConfig: { enabled: false }, ...options }); };
  const stop = () => new Promise(resolve => server.close(() => resolve()));
  await start();
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  const call = (url, { method = 'GET', body, session, token } = {}) => new Promise(resolve => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.url = url; req.method = method; req.socket = { remoteAddress: 'synthetic-test-address' };
    req.headers = { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const headers = {};
    const res = {
      headersSent: false,
      setHeader(key, value) { headers[key.toLowerCase()] = value; },
      writeHead(status, values) { this.status = status; this.headersSent = true; Object.assign(headers, values); },
      end(raw) { resolve({ status: this.status, headers, json: raw === undefined ? null : JSON.parse(raw) }); },
    };
    server.emit('request', req, res);
  });
  const login = async () => {
    const result = await call('/api/login', { method: 'POST', body: { password } });
    assert.equal(result.status, 200);
    return { cookie: result.headers['set-cookie'].split(';')[0], csrf: result.json.csrfToken };
  };
  const blockWrites = async () => {
    await rename(join(dir, 'state.json'), join(dir, 'saved-state.json'));
    await mkdir(join(dir, 'state.json'));
    return async () => { await rm(join(dir, 'state.json'), { recursive: true }); await rename(join(dir, 'saved-state.json'), join(dir, 'state.json')); };
  };
  return { dir, call, login, blockWrites, restart: async () => { await stop(); await start(); } };
}

test('failed pairing provisioning preserves existing devices and leaves no temporary state file', async t => {
  const f = await fixture(t), session = await f.login();
  const existing = (await f.call('/api/devices', { method: 'POST', session, body: { name: 'Existing device' } })).json;
  const pairing = (await f.call('/api/pairing/start', { method: 'POST', body: { name: 'New device' } })).json;
  const restore = await f.blockWrites();
  try { assert.equal((await f.call('/api/pairing/claim', { method: 'POST', session, body: { code: pairing.code } })).status, 500); }
  finally { await restore(); }
  assert.deepEqual((await f.call('/api/overview', { session })).json.devices.map(d => d.id), [existing.device.id]);
  assert.equal((await f.call('/api/device/messages', { token: existing.token })).status, 200);
  assert.equal((await readdir(f.dir)).some(name => name.endsWith('.tmp')), false);
  assert.equal((await f.call('/api/pairing/poll', { method: 'POST', body: pairing })).json.status, 'pending');
  assert.equal((await f.call('/api/pairing/claim', { method: 'POST', session, body: { code: pairing.code } })).status, 200);
});

test('failed ACK keeps a message available in memory and after restart', async t => {
  const f = await fixture(t), session = await f.login();
  const { device, token } = (await f.call('/api/devices', { method: 'POST', session, body: { name: 'Inbox device' } })).json;
  const { messageId } = (await f.call(`/api/devices/${device.id}/messages`, { method: 'POST', session, body: { title: 'Keep', message: 'Unacknowledged' } })).json;
  const restore = await f.blockWrites();
  try { assert.equal((await f.call('/api/device/ack', { method: 'POST', token, body: { messageId } })).status, 500); }
  finally { await restore(); }
  assert.equal((await f.call('/api/device/messages', { token })).json.messages[0]?.id, messageId);
  await f.restart();
  assert.equal((await f.call('/api/device/messages', { token })).json.messages[0]?.id, messageId);
});

test('failed revocation keeps the previously committed device token working', async t => {
  const f = await fixture(t), session = await f.login();
  const { device, token } = (await f.call('/api/devices', { method: 'POST', session, body: { name: 'Keep device' } })).json;
  const restore = await f.blockWrites();
  try { assert.equal((await f.call(`/api/devices/${device.id}`, { method: 'DELETE', session })).status, 500); }
  finally { await restore(); }
  assert.equal((await f.call('/api/device/messages', { token })).status, 200);
  await f.restart();
  assert.equal((await f.call('/api/device/messages', { token })).status, 200);
});

test('failed event persistence cannot make its retry appear already delivered', async t => {
  const f = await fixture(t), session = await f.login();
  const { token } = (await f.call('/api/devices', { method: 'POST', session, body: { name: 'Event device' } })).json;
  const body = { title: 'Retry me', message: '', eventId: 'reliable-event' };
  const restore = await f.blockWrites();
  try { assert.equal((await f.call('/api/device/events', { method: 'POST', token, body })).status, 500); }
  finally { await restore(); }
  assert.deepEqual((await f.call('/api/overview', { session })).json.events, []);
  const retry = await f.call('/api/device/events', { method: 'POST', token, body });
  assert.equal(retry.status, 200); assert.equal(retry.json.duplicate, false);
  await f.restart();
  assert.equal((await f.call('/api/device/events', { method: 'POST', token, body })).json.duplicate, true);
});

test('failed integration settings save restores the previous encrypted settings', async t => {
  const f = await fixture(t), session = await f.login();
  const body = { apiKey: 'synthetic-api-key-for-test', enabled: true, model: 'gpt-5-mini', systemPrompt: 'Committed instructions' };
  assert.equal((await f.call('/api/settings/ai', { method: 'POST', session, body })).status, 200);
  const restore = await f.blockWrites();
  try { assert.equal((await f.call('/api/settings/ai', { method: 'DELETE', session })).status, 500); }
  finally { await restore(); }
  assert.equal((await f.call('/api/settings', { session })).json.ai.systemPrompt, 'Committed instructions');
  await f.restart();
  const again = await f.login();
  assert.equal((await f.call('/api/settings', { session: again })).json.ai.configured, true);
});

test('rollback preserves committed event references retained by an asynchronous delivery', async t => {
  let release, began;
  const beginning = new Promise(resolve => { began = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { fetchImpl: async () => { began(); await pending; return new Response('{"ok":true}'); } });
  const session = await f.login();
  const { device } = (await f.call('/api/devices', { method: 'POST', session, body: { name: 'Delivery device' } })).json;
  await f.call('/api/settings/telegram', { method: 'POST', session, body: telegram });
  const delivery = f.call('/api/events', { method: 'POST', session, body: { title: 'Pending delivery', message: '' } });
  await beginning;
  const restore = await f.blockWrites();
  try { assert.equal((await f.call(`/api/devices/${device.id}/messages`, { method: 'POST', session, body: { title: 'Uncommitted', message: '' } })).status, 500); }
  finally { await restore(); release(); }
  assert.equal((await delivery).json.event.delivery, 'telegram_sent');
  assert.equal((await f.call('/api/overview', { session })).json.events[0].delivery, 'telegram_sent');
  assert.equal(JSON.parse(await readFile(join(f.dir, 'state.json'), 'utf8')).devices[0].messages.length, 0);
  await f.restart();
  assert.equal((await f.call('/api/overview', { session: await f.login() })).json.events[0].delivery, 'telegram_sent');
});

test('store rollback restores original nested objects and properties after a failed commit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kibi-store-rollback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir), devices = store.state.devices;
  const device = { id: 'original', messages: [{ id: 'keep', title: 'Original' }] };
  devices.push(device); await store.save();
  const messages = device.messages, message = messages[0];
  await rename(join(dir, 'state.json'), join(dir, 'saved-state.json')); await mkdir(join(dir, 'state.json'));
  devices.length = 0; device.messages = []; message.title = 'Changed'; message.extra = true; store.state.ai = store.seal({ apiKey: 'uncommitted' });
  await assert.rejects(store.save());
  assert.equal(store.state.devices, devices); assert.equal(devices[0], device);
  assert.equal(device.messages, messages); assert.equal(messages[0], message);
  assert.deepEqual(message, { id: 'keep', title: 'Original' }); assert.equal(store.state.ai, null);
});

test('SDK reads accepted multiline titles from the real device inbox', async t => {
  const f = await fixture(t), session = await f.login();
  const { device, token } = (await f.call('/api/devices', { method: 'POST', session, body: { name: 'SDK inbox' } })).json;
  await f.call(`/api/devices/${device.id}/messages`, { method: 'POST', session, body: { title: 'Строка 1\nСтрока 2\tготова', message: 'Ответ\nустройства' } });
  const client = createKibiClient({ apiBase: origin, allowLocalhostHttp: true, deviceToken: token,
    fetchImpl: async (url, options) => { const result = await f.call(new URL(url).pathname, { method: options.method, body: options.body, token }); return new Response(JSON.stringify(result.json), { status: result.status }); } });
  const { messages } = await client.getMessages();
  assert.equal(messages[0].title, 'Строка 1\nСтрока 2\tготова');
  await client.acknowledge({ messageId: messages[0].id });
  assert.deepEqual(await client.getMessages(), { messages: [] });
});

test('SDK pairing and inbox preserve every human-text value accepted by the API',async t=>{
 const f=await fixture(t),session=await f.login();
 const client=createKibiClient({apiBase:origin,allowLocalhostHttp:true,fetchImpl:async(url,options)=>{
  const result=await f.call(new URL(url).pathname,{method:options.method,body:options.body,token:(options.headers.Authorization||'').replace('Bearer ','')});
  return new Response(JSON.stringify(result.json),{status:result.status});
 }});
 const name='Моя\nКиби';const pairing=await client.startPairing({name});
 const claim=await f.call('/api/pairing/claim',{method:'POST',session,body:{code:pairing.code}});assert.equal(claim.status,200);
 const paired=await client.pollPairing(pairing);assert.equal(paired.device.name,name);client.setDeviceToken(paired.token);
 const body={title:'Title\nline',message:'Stored\u0000control\ntext'};
 assert.equal((await f.call(`/api/devices/${paired.device.id}/messages`,{method:'POST',session,body})).status,200);
 assert.equal((await client.getMessages()).messages[0].message,body.message);
});

test('SDK cancels bodies rejected before reading and bodies stalled past the deadline', async () => {
  for (const kind of ['length', 'url', 'status', 'timeout']) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: kind === 'status' ? 503 : 200, headers: kind === 'length' ? { 'Content-Length': '524289' } : {} });
    if (kind === 'url') Object.defineProperty(response, 'url', { value: 'https://other.invalid/api/device/messages' });
    const client = createKibiClient({ apiBase: 'https://kibi.example/', deviceToken: 'synthetic-device-token', timeoutMs: 15, fetchImpl: async () => response });
    await assert.rejects(client.getMessages(), error => error.code === (kind === 'timeout' ? 'timeout' : kind === 'status' ? 'http_error' : 'invalid_response'));
    await Promise.resolve();
    assert.equal(cancelled, true, kind);
  }
});

test('SDK rejects a response whose empty chunks exceed a bounded read budget', async () => {
  let chunks = 0, cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (++chunks <= 8193) controller.enqueue(new Uint8Array());
      else { controller.enqueue(new TextEncoder().encode('{"messages":[]}')); controller.close(); }
    },
    cancel() { cancelled = true; },
  }));
  const client = createKibiClient({ apiBase: 'https://kibi.example/', deviceToken: 'synthetic-device-token', fetchImpl: async () => response });
  await assert.rejects(client.getMessages(), { code: 'invalid_response' });
  assert.equal(cancelled, true);
});

test('Telegram rejects oversized responses and cancels rejected or stalled response bodies', async t => {
  let cancelled = false;
  const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, padding: 'x'.repeat(256 * 1024) }))); }, cancel() { cancelled = true; } }));
  assert.equal(await sendTelegram(telegram, 'Test', '', async () => oversized), false);
  assert.equal(cancelled, true);
  cancelled = false;
  const rejected = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  assert.equal(await sendTelegram(telegram, 'Test', '', async () => rejected), false);
  assert.equal(cancelled, true);
  cancelled = false;
  const stalled = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = sendTelegram(telegram, 'Test', '', async () => stalled);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(8001);
  assert.equal(await timeout, false);
  await Promise.resolve(); assert.equal(cancelled, true);
});
