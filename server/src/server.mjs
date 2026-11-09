import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { openStore } from './store.mjs';
import { sendTelegram, validTelegramCredentials } from './telegram.mjs';
import { askAi, DEFAULT_MODEL, validApiKey, validModel } from './ai.mjs';
import { readPrivateFile } from './private-files.mjs';
import { startVoiceModule } from './voice.mjs';
import { createIdentityServer } from './identity.mjs';

const VERSION = '0.1.0';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/assets/Manrope.ttf', ['assets/Manrope.ttf', 'font/ttf']],
  ['/assets/OFL.txt', ['assets/OFL.txt', 'text/plain; charset=utf-8']],
  ['/assets/kibi.png', ['assets/kibi.png', 'image/png']],
]);
const sha = text => createHash('sha256').update(text).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(sha(a), 'hex'), Buffer.from(sha(b), 'hex'));
const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.length <= max;
const content = body => {
  if (!text(body.title, 1, 120) || !text(body.message, 0, 2000)) throw fail(400, 'invalid_input');
  return { title: body.title, message: body.message };
};

async function bodyOf(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'json_required');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw fail(413, 'body_too_large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw fail(400, 'invalid_json'); }
}

export async function createKibiServer(options = {}) {
  return createIdentityServer(options, createTenantServer);
}

async function createTenantServer({ dataDir, adminPassword, publicOrigin, fetchImpl = fetch, webRoot = fileURLToPath(new URL('../web/', import.meta.url)), voiceConfig, cookiePath = process.env.KIBI_COOKIE_PATH || '/', sessionResolver, ordinaryUser = false, onDevicesChanged = () => {} } = {}) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Error('invalid_public_origin'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== publicOrigin) throw new Error('invalid_public_origin');
  if (typeof dataDir !== 'string' || !text(adminPassword, 12, 1024)) throw new Error('invalid_configuration');
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(cookiePath)) throw new Error('invalid_cookie_path');
  const store = await openStore(dataDir);
  const state = store.state;
  const voice = ordinaryUser ? {
    status: () => ({configured:false,enabled:false,status:'disabled',code:'tenant_voice_unavailable',model:null,endpoint:null,tls:false,legacyConfigured:false,legacyReady:false,activeSessions:0}),
    reconcile() {}, close:async()=>{},
  } : await startVoiceModule({ store, publicOrigin, registrationFetch: fetchImpl, ...(voiceConfig ? { config: voiceConfig } : {}) });
  const salt = randomBytes(16);
  const passwordHash = sessionResolver ? null : scryptSync(adminPassword, salt, 32);
  adminPassword = undefined;
  const sessions = new Map(); const rates = new Map();
  const started = Date.now();
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const rate = (key, limit) => {
    const now = Date.now();
    for (const [k, bucket] of rates) if (bucket.until <= now) rates.delete(k);
    let bucket = rates.get(key);
    if (!bucket) {
      if (rates.size >= 1000) throw fail(429, 'rate_limited');
      bucket = { count: 0, until: now + 60000 }; rates.set(key, bucket);
    }
    if (++bucket.count > limit) throw fail(429, 'rate_limited');
  };
  const sessionOf = sessionResolver || (req => {
    const now = Date.now();
    for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
    const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('kibi_session='));
    if (!cookie) return null;
    return sessions.get(sha(cookie.slice('kibi_session='.length))) || null;
  });
  const requireOrigin = req => { if (req.headers.origin !== publicOrigin) throw fail(403, 'origin_forbidden'); };
  const admin = (req, mutation = false) => {
    const session = sessionOf(req);
    if (!session) throw fail(401, 'unauthorized');
    if (mutation) {
      requireOrigin(req);
      if (!safeEqual(req.headers['x-csrf-token'], session.csrf)) throw fail(403, 'csrf_forbidden');
    }
    rate(`admin:${session.key}`, 240);
    return session;
  };
  const deviceOf = req => {
    const auth = req.headers.authorization || '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw fail(401, 'unauthorized');
    const hash = sha(auth.slice(7));
    const device = state.devices.find(x => safeEqual(x.tokenHash, hash));
    if (!device) throw fail(401, 'unauthorized');
    rate(`device:${device.id}`, 120);
    device.lastSeenAt = new Date().toISOString();
    return device;
  };
  const viewDevice = d => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt,
    status: !d.lastSeenAt ? 'not_seen' : Date.now() - Date.parse(d.lastSeenAt) <= 90000 ? 'online' : 'offline' });
  const viewEvent = ({ clientEventId, ...event }) => event;
  const createDevice = async name => store.exclusive(async () => {
    if (!text(name, 1, 64)) throw fail(400, 'invalid_input');
    if (state.devices.length >= 50) throw fail(409, 'device_limit');
    const token = secret();
    const device = { id: randomUUID(), name: name.trim(), createdAt: new Date().toISOString(), lastSeenAt: null, tokenHash: sha(token), messages: [] };
    state.devices.push(device);
    await store.save(); // The store rolls back to its last committed state on failure.
    onDevicesChanged(state.devices.map(d=>d.tokenHash));
    return {device:viewDevice(device),token};
  });
  const telegramStatus = () => {
    const credentials = store.telegram();
    return { configured: !!credentials, enabled: !!credentials?.enabled };
  };
  const aiStatus = () => {
    const credentials = store.ai();
    return { configured: !!credentials, enabled: !!credentials?.enabled, provider: 'openai', model: credentials?.model || DEFAULT_MODEL, systemPrompt: credentials?.systemPrompt || '' };
  };
  let activeProviders = 0;
  const withProvider = async fn => {
    if (activeProviders >= 8) throw fail(503, 'server_busy');
    activeProviders++;
    try { return await fn(); } finally { activeProviders--; }
  };
  const prepareChat = (body, fromDevice = false) => {
    if (!text(body.text, 1, 2000)) throw fail(400, 'invalid_input');
    const credentials = store.ai();
    if (!credentials) throw fail(409, 'ai_not_configured');
    if (fromDevice && !credentials.enabled) throw fail(409, 'ai_disabled');
    return async () => withProvider(async () => {
      const result = await askAi(credentials, body.text, fetchImpl);
      if (result.code) throw fail(502, result.code);
      return { ok: true, text: result.text };
    });
  };
  const cookie = (value, maxAge) => `kibi_session=${value}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.protocol === 'https:' ? '; Secure' : ''}`;
  const addEvent = async (input, deviceId = null, clientEventId) => {
    const event = { id: randomUUID(), ...input, deviceId, createdAt: new Date().toISOString(), delivery: 'local', ...(clientEventId ? { clientEventId } : {}) };
    state.events.unshift(event); state.events.length = Math.min(state.events.length, 200);
    await store.save(); // Local event survives a downstream Telegram failure or crash.
    return event;
  };
  const deliverEvent = (event, credentials) => async () => {
    if (credentials?.enabled) {
      let sent = false;
      try { sent = await withProvider(() => sendTelegram(credentials, event.title, event.message, fetchImpl)); } catch {}
      await store.exclusive(async () => { event.delivery = sent ? 'telegram_sent' : 'telegram_failed'; await store.save(); });
    }
    return event;
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      const path = new URL(req.url, publicOrigin).pathname;
      const method = req.method;
      if (method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, name: 'kibi-server', version: VERSION });
      if (method === 'GET' && path === '/api/session') {
        const session = sessionOf(req);
        return json(res, 200, session ? { authenticated: true, csrfToken: session.csrf } : { authenticated: false });
      }
      if (method === 'POST' && path === '/api/login') {
        requireOrigin(req);
        rate(`login:${req.socket.remoteAddress}`, 10);
        const body = await bodyOf(req);
        if (!text(body.password, 1, 1024) || !timingSafeEqual(scryptSync(body.password, salt, 32), passwordHash)) throw fail(401, 'invalid_credentials');
        const previous = sessionOf(req); if (previous) sessions.delete(previous.key);
        if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
        const token = secret(); const key = sha(token); const csrf = secret();
        sessions.set(key, { key, csrf, expires: Date.now() + SESSION_TTL });
        res.setHeader('Set-Cookie', cookie(token, SESSION_TTL / 1000));
        return json(res, 200, { ok: true, csrfToken: csrf });
      }
      if (method === 'POST' && path === '/api/logout') {
        const session = admin(req, true); sessions.delete(session.key);
        res.setHeader('Set-Cookie', cookie('', 0)); return json(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/overview') {
        admin(req);
        const telegram = telegramStatus();
        return json(res, 200, { server: { status: 'ready', version: VERSION, uptimeSeconds: Math.floor((Date.now() - started) / 1000) },
          devices: state.devices.map(viewDevice), events: state.events.map(viewEvent), modules: [
            { id: 'ai', name: 'Текстовый ИИ', status: aiStatus().configured ? 'configured' : 'not_configured', configured: aiStatus().configured },
            { id: 'notifications', name: 'Уведомления', status: 'ready' },
            { id: 'telegram', name: 'Telegram', status: telegram.configured ? 'configured' : 'not_configured', configured: telegram.configured },
            { id: 'voice', name: 'Голосовой ИИ', ...voice.status() }, { id: 'schedules', name: 'Расписания', status: 'planned' },
          ] });
      }
      if (method === 'GET' && path === '/api/settings') { admin(req); return json(res, 200, { telegram: telegramStatus(), ai: aiStatus(), voice: voice.status() }); }
      if (method === 'GET' && path === '/api/settings/xiaozhi') { admin(req); if(ordinaryUser)throw fail(409,'tenant_voice_unavailable'); return json(res, 200, voice.registration.snapshot()); }
      if (path.startsWith('/api/')) {
        // Authentication and body bounds occur before waiting for the persistence
        // queue. This prevents queued slow bodies from blocking other clients.
        const isDevice = path.startsWith('/api/device/');
        if (!isDevice) admin(req, method !== 'GET');
        const authenticatedDevice = isDevice ? deviceOf(req) : null;
        let body;
        const needsBody = method === 'POST' && !['/api/modules/telegram/test'].includes(path);
        if (needsBody) body = await bodyOf(req);
        if (ordinaryUser && (path === '/api/settings/voice' || path.startsWith('/api/settings/xiaozhi/'))) throw fail(409,'tenant_voice_unavailable');
        // Network setup and its private writes run outside the store queue.
        if (!isDevice && method === 'POST' && path === '/api/settings/voice') {
          const selected = await voice.selectProvider(body); return json(res, 200, {ok:true,voice:selected});
        }
        if (!isDevice && method === 'POST' && ['/api/settings/xiaozhi/prepare','/api/settings/xiaozhi/activate'].includes(path)) {
          rate('xiaozhi-setup',12);
          try { const setup = await voice.registration[path.endsWith('/prepare')?'prepare':'activate'](); voice.reconcile(); return json(res,200,{ok:true,registration:setup,voice:voice.status()}); }
          catch(error) { const allowed=new Set(['xiaozhi_not_configured','xiaozhi_pending','xiaozhi_challenge_expired','xiaozhi_invalid_response','xiaozhi_untrusted_endpoint','xiaozhi_mqtt_unsupported','xiaozhi_provider_failed','xiaozhi_timeout','xiaozhi_closed','xiaozhi_busy','xiaozhi_storage_failed','xiaozhi_storage_invalid']); return json(res,502,{ok:false,code:allowed.has(error?.code)?error.code:'xiaozhi_provider_failed'}); }
        }
        const outcome = await store.exclusive(async () => {
          if (isDevice) {
            const device = authenticatedDevice;
            if (!state.devices.includes(device)) throw fail(401, 'unauthorized');
            if (method === 'POST' && path === '/api/device/chat') {
              const send = prepareChat(body, true);
              await store.save();
              return async () => json(res, 200, await send());
            }
            if (method === 'POST' && path === '/api/device/events') {
              const input = content(body);
              if (body.eventId !== undefined && (typeof body.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.eventId))) throw fail(400, 'invalid_input');
              const duplicate = body.eventId && state.events.find(x => x.deviceId === device.id && x.clientEventId === body.eventId);
              if (duplicate) { await store.save(); return json(res, 200, { ok: true, eventId: duplicate.id, duplicate: true }); }
              const event = await addEvent(input, device.id, body.eventId);
              const deliver = deliverEvent(event, store.telegram());
              return async () => { await deliver(); return json(res, 200, { ok: true, eventId: event.id, duplicate: false }); };
            }
            if (method === 'GET' && path === '/api/device/messages') { await store.save(); return json(res, 200, { messages: device.messages }); }
            if (method === 'POST' && path === '/api/device/ack') {
              if (typeof body.messageId !== 'string') throw fail(400, 'invalid_input');
              const index = device.messages.findIndex(x => x.id === body.messageId);
              if (index < 0) throw fail(404, 'message_not_found');
              device.messages.splice(index, 1); await store.save(); return json(res, 200, { ok: true });
            }
          } else {
            // Re-check after queueing: logout/revocation may have occurred while waiting.
            if (!sessionOf(req)) throw fail(401, 'unauthorized');
            if (method === 'POST' && path === '/api/settings/ai') {
              if (typeof body.enabled !== 'boolean' || !validModel(body.model) || !text(body.systemPrompt, 0, 4000) || (body.apiKey !== undefined && typeof body.apiKey !== 'string')) throw fail(400, 'invalid_input');
              const previous = store.ai();
              const apiKey = body.apiKey || previous?.apiKey;
              if (!validApiKey(apiKey)) throw fail(400, 'ai_invalid_key');
              state.ai = store.seal({ apiKey, model: body.model, systemPrompt: body.systemPrompt, enabled: body.enabled });
              await store.save(); voice.reconcile(); return json(res, 200, { ok: true, ai: aiStatus(), voice: voice.status() });
            }
            if (method === 'DELETE' && path === '/api/settings/ai') { state.ai = null; await store.save(); voice.reconcile(); return json(res, 200, { ok: true }); }
            if (method === 'POST' && path === '/api/modules/ai/test') {
              const send = prepareChat(body);
              return async () => json(res, 200, await send());
            }
            if (method === 'POST' && path === '/api/devices') {
              if (!text(body.name, 1, 64)) throw fail(400, 'invalid_input');
              if (state.devices.length >= 50) throw fail(409, 'device_limit');
              const token = secret();
              const device = { id: randomUUID(), name: body.name.trim(), createdAt: new Date().toISOString(), lastSeenAt: null, tokenHash: sha(token), messages: [] };
              state.devices.push(device); await store.save(); onDevicesChanged(state.devices.map(d=>d.tokenHash)); return json(res, 200, { device: viewDevice(device), token });
            }
            const match = /^\/api\/devices\/([A-Za-z0-9-]+)(\/messages)?$/.exec(path);
            if (match) {
              const index = state.devices.findIndex(x => x.id === match[1]);
              if (index < 0) throw fail(404, 'device_not_found');
              const device = state.devices[index];
              if (method === 'DELETE' && !match[2]) { state.devices.splice(index, 1); await store.save(); onDevicesChanged(state.devices.map(d=>d.tokenHash)); voice.reconcile(); return json(res, 200, { ok: true }); }
              if (method === 'POST' && match[2]) {
                const input = content(body);
                if (device.messages.length >= 50) throw fail(409, 'message_limit');
                const message = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
                device.messages.push(message); await store.save(); return json(res, 200, { ok: true, messageId: message.id });
              }
            }
            if (method === 'POST' && path === '/api/events') {
              const event = await addEvent(content(body));
              const deliver = deliverEvent(event, store.telegram());
              return async () => json(res, 200, { ok: true, event: viewEvent(await deliver()) });
            }
            if (method === 'POST' && path === '/api/settings/telegram') {
              if (typeof body.enabled !== 'boolean' || (body.token !== undefined && typeof body.token !== 'string') || (body.chatId !== undefined && typeof body.chatId !== 'string')) throw fail(400, 'invalid_input');
              const previous = store.telegram();
              const credentials = { token: body.token || previous?.token, chatId: body.chatId || previous?.chatId, enabled: body.enabled };
              if (!validTelegramCredentials(credentials.token, credentials.chatId)) throw fail(400, 'invalid_telegram_credentials');
              state.telegram = store.seal(credentials); await store.save(); return json(res, 200, { ok: true, telegram: telegramStatus() });
            }
            if (method === 'DELETE' && path === '/api/settings/telegram') { state.telegram = null; await store.save(); return json(res, 200, { ok: true }); }
            if (method === 'POST' && path === '/api/modules/telegram/test') {
              const credentials = store.telegram();
              if (!credentials) throw fail(409, 'telegram_not_configured');
              return async () => {
                const sent = await withProvider(() => sendTelegram(credentials, 'Киби: тест уведомлений', 'Сервер отправляет сообщения в Telegram.', fetchImpl));
                if (!sent) throw fail(502, 'telegram_failed');
                return json(res, 200, { ok: true });
              };
            }
          }
          throw fail(404, 'not_found');
        });
        return typeof outcome === 'function' ? await outcome() : outcome;
      }
      const asset = STATIC.get(path);
      if (!asset || !['GET', 'HEAD'].includes(method)) throw fail(404, 'not_found');
      let data;
      try { data = await readFile(resolve(webRoot, asset[0])); } catch { throw fail(404, 'not_found'); }
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': data.length }); res.end(method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { ok: false, code: error.status ? error.code : 'internal_error' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  server.maxConnections = 256;
  // Internal dispatcher contract, never exposed through HTTP or static files.
  server.kibiContext = {
    tokenHashes: () => state.devices.map(d=>d.tokenHash),
    createDevice,
    close: () => voice.close(),
  };
  const closeHttp = server.close.bind(server);
  server.close = callback => {
    const closingVoice = voice.close();
    closeHttp(error => { closingVoice.then(() => callback?.(error), () => callback?.(error || new Error('voice_close_failed'))); });
    return server;
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const dataDir = process.env.KIBI_DATA_DIR || '.data';
    const adminPassword = (await readPrivateFile(process.env.KIBI_ADMIN_PASSWORD_FILE || resolve(dataDir, 'admin-password'))).toString('utf8').replace(/\r?\n$/, '');
    const port = Number(process.env.KIBI_PORT || 4391);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
    const server = await createKibiServer({ dataDir, adminPassword, publicOrigin: process.env.KIBI_PUBLIC_ORIGIN || 'http://127.0.0.1:4391' });
    server.on('error', () => { console.error('Kibi Server: не удалось запустить сервер.'); server.close(); process.exitCode = 1; });
    server.listen(port, process.env.KIBI_HOST || '127.0.0.1', () => console.log(`Kibi Server ${VERSION}: сервер запущен.`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  } catch { console.error('Kibi Server: проверьте настройки запуска и приватные файлы.'); process.exitCode = 1; }
}
