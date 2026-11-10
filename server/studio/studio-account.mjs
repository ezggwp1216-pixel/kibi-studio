import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, resolve, parse, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export const STUDIO_ACCOUNT_SCOPES = Object.freeze(['pairing.claim', 'devices.list', 'voice.status', 'voice.activate', 'catalog.read']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^kibi_studio_[A-Za-z0-9_-]{43}$/;
const CODE = /^kibi_link_[A-Za-z0-9_-]{32}$/;
const LIFETIME = 90 * 24 * 60 * 60 * 1000;
const messages = {
  account_storage_error: 'Не удалось безопасно сохранить подключение Studio.',
  account_invalid_response: 'Сервер вернул неподходящий ответ.',
  account_invalid_input: 'Проверьте введённые данные.',
  account_link_invalid: 'Ключ подключения недействителен или уже использован.',
  account_network_error: 'Не удалось связаться с сервером.',
  account_timeout: 'Сервер не ответил вовремя.',
  account_server_error: 'Сервер не выполнил запрос.',
  account_session_changed: 'Подключение Studio изменилось. Повторите действие.',
  account_not_connected: 'Подключите аккаунт к Studio.',
  account_expired: 'Срок подключения истёк. Создайте новый ключ подключения.',
  account_revoked: 'Подключение отозвано. Создайте новый ключ подключения.',
  account_busy: 'Дождитесь завершения текущего действия.',
  account_closed: 'Подключение Studio закрыто.',
  account_voice_unavailable: 'Для этого аккаунта подключение голоса недоступно.',
};
class AccountError extends Error {
  constructor(code, status = 0) { super(messages[code] || messages.account_server_error); this.code = code; this.status = status; }
}
const fail = (code, status = 0) => new AccountError(code, status);
const owned = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validId = value => typeof value === 'string' && UUID.test(value);
const validTime = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validScopes = value => Array.isArray(value) && value.length === STUDIO_ACCOUNT_SCOPES.length && STUDIO_ACCOUNT_SCOPES.every((scope, index) => value[index] === scope);
const text = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
  && !/kibi_(?:studio_[A-Za-z0-9_-]{43}|link_[A-Za-z0-9_-]{32})/.test(value);
const eligibilityCodes = new Set(['studio_voice_not_approved', 'studio_voice_xiaozhi_required', 'xiaozhi_not_configured', 'voice_closed']);
const voiceCodes = new Set([...eligibilityCodes, 'tenant_voice_unavailable', 'voice_disabled', 'voice_not_configured', 'voice_tls_required', 'voice_tls_invalid', 'voice_listening', 'voice_connecting', 'voice_active', 'voice_error', 'voice_ready']);
const clone = value => value == null ? null : structuredClone(value);
const cancelBody = body => { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} };

async function unlinkedPath(input) {
  let path = resolve(input);
  if (process.platform === 'darwin') for (const prefix of ['/tmp', '/var']) {
    if ((path === prefix || path.startsWith(prefix + '/')) && await realpath(prefix) === '/private' + prefix) path = '/private' + path;
  }
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw fail('account_storage_error'); }
    catch (cause) { if (cause.code === 'ENOENT') break; throw cause; }
  }
  return path;
}
async function privateRead(path) {
  const file = await open(await unlinkedPath(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !owned(stat) || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw fail('account_storage_error');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
function safeAccount(value) {
  if (!object(value) || !validId(value.id) || value.role !== 'user' || !text(value.email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) throw fail('account_invalid_response');
  return { id: value.id, email: value.email, role: 'user' };
}
function safeConnection(value) {
  if (!object(value) || !validId(value.id) || !text(value.label, 64) || value.label !== value.label.trim()
    || !validTime(value.createdAt) || !validTime(value.expiresAt) || Date.parse(value.expiresAt) - Date.parse(value.createdAt) !== LIFETIME || !validScopes(value.scopes)) throw fail('account_invalid_response');
  return { id: value.id, label: value.label, createdAt: value.createdAt, expiresAt: value.expiresAt, scopes: [...STUDIO_ACCOUNT_SCOPES] };
}
function safeEligibility(value) {
  if (value == null) return null;
  if (!object(value)) throw fail('account_invalid_response');
  const result = {};
  for (const key of ['approved', 'canActivate', 'eligible']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (eligibilityCodes.has(value.code)) result.code = value.code;
  return result;
}
function safeVoice(value) {
  if (value == null) return null;
  if (!object(value)) throw fail('account_invalid_response');
  const result = {};
  for (const key of ['configured', 'enabled', 'tls', 'legacyConfigured', 'legacyReady']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (['disabled', 'not_configured', 'listening', 'connecting', 'active', 'error', 'closed'].includes(value.status)) result.status = value.status;
  if (voiceCodes.has(value.code)) result.code = value.code;
  if (['openai', 'xiaozhi'].includes(value.provider)) result.provider = value.provider;
  if (Number.isSafeInteger(value.activeSessions) && value.activeSessions >= 0 && value.activeSessions <= 1024) result.activeSessions = value.activeSessions;
  if (value.studioVoice != null) result.studioVoice = safeEligibility(value.studioVoice);
  return result;
}
function safeDevice(value, details = false) {
  if (!object(value) || !validId(value.id) || !text(value.name, 64)) throw fail('account_invalid_response');
  const result = { id: value.id, name: value.name };
  if (details) {
    if (!['not_seen', 'online', 'offline'].includes(value.status) || !validTime(value.createdAt)
      || !(value.lastSeenAt === null || validTime(value.lastSeenAt))) throw fail('account_invalid_response');
    Object.assign(result, { status: value.status, createdAt: value.createdAt, lastSeenAt: value.lastSeenAt });
  }
  return result;
}

// A standalone, closed diagnostic projection: never forward arbitrary server text.
const diagnosticCodes = new Set(['idle', 'connecting', 'connected', 'ready', 'closed', 'cancelled', 'configuration_required', 'unsupported_endpoint', 'device_protocol_invalid', 'codec_failed', 'input_backpressure', 'output_backpressure', 'authentication_required', 'quota_or_rate_limit', 'provider_error', 'provider_protocol_invalid', 'network_error', 'tls_failed', 'timeout', 'gateway_busy', 'gateway_closed', 'not_found', 'listening']);
const diagnosticMetrics = new Set(['inputPackets', 'inputPcmBytes', 'droppedInputPackets', 'outputPackets', 'outputPcmBytes', 'turnsCompleted', 'playbackRejections']);
function safeDiagnostics(value) {
  const invalid = () => { throw fail('account_invalid_response'); };
  if (!exact(value, ['schemaVersion', 'source', 'retentionSeconds', 'observed', 'updatedAt', 'connection', 'metrics', 'events'])
    || value.schemaVersion !== '1.0' || value.source !== 'server' || value.retentionSeconds !== 3600 || typeof value.observed !== 'boolean'
    || !Array.isArray(value.events) || value.events.length > 32) invalid();
  if (!value.observed) {
    if (value.updatedAt !== null || value.connection !== null || value.metrics !== null || value.events.length !== 0) invalid();
    return clone(value);
  }
  const stateFor = code => ['idle', 'connecting', 'connected', 'listening'].includes(code) ? 'connecting'
    : code === 'ready' ? 'ready' : ['closed', 'cancelled', 'gateway_closed'].includes(code) ? 'closed' : 'error';
  const validStage = stage => object(stage) && diagnosticCodes.has(stage.code) && stage.state === stateFor(stage.code);
  if (!validTime(value.updatedAt) || !exact(value.connection, ['state', 'code', 'active']) || !validStage(value.connection) || value.connection.active !== ['connecting', 'ready'].includes(value.connection.state)) invalid();
  if (value.metrics !== null) {
    if (!object(value.metrics) || Object.keys(value.metrics).length === 0) invalid();
    for (const [key, counter] of Object.entries(value.metrics)) {
      if (!diagnosticMetrics.has(key) || !(Number.isSafeInteger(counter) && counter >= 0)) invalid();
    }
  }
  for (const event of value.events) if (!exact(event, ['at', 'state', 'code']) || !validTime(event.at) || !validStage(event)) invalid();
  return clone(value);
}

// The trusted local server supplies root/apiBase. No HTTP/MCP input changes them.
export async function createStudioAccount({ root, apiBase = 'https://sldvkibi.ru/server/', fetchImpl = fetch, now = Date.now, timeoutMs = 15000 } = {}) {
  let base;
  try {
    base = new URL(apiBase);
    if (typeof apiBase !== 'string' || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/') || base.href !== apiBase
      || typeof root !== 'string' || !isAbsolute(root) || typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000) throw new Error();
  } catch { throw fail('account_invalid_input', 400); }
  const clock = () => { const time = now(); if (!Number.isSafeInteger(time) || Math.abs(time) > 8.64e15) throw fail('account_invalid_input'); return time; };
  let privateDir, path, persisted = null, saved = null;
  const parseSaved = raw => {
    let value;
    try { value = JSON.parse(raw); } catch { throw fail('account_storage_error'); }
    if (!exact(value, ['version', 'apiBase', 'record']) || value.version !== 1 || value.apiBase !== apiBase) throw fail('account_storage_error');
    if (value.record === null) return null;
    const record = value.record;
    if (!exact(record, ['token', 'account', 'connection', 'scopes']) || typeof record.token !== 'string' || !TOKEN.test(record.token) || !validScopes(record.scopes)
      || !exact(record.account, ['id', 'email', 'role']) || !exact(record.connection, ['id', 'label', 'createdAt', 'expiresAt', 'scopes'])) throw fail('account_storage_error');
    try { return { token: record.token, account: safeAccount(record.account), connection: safeConnection(record.connection), scopes: [...STUDIO_ACCOUNT_SCOPES] }; }
    catch { throw fail('account_storage_error'); }
  };
  async function checkDirectories() {
    for (const dir of [root, join(root, '.studio'), privateDir]) {
      const stat = await lstat(await unlinkedPath(dir));
      if (!stat.isDirectory() || !owned(stat) || (dir !== root && (stat.mode & 0o777) !== 0o700)) throw fail('account_storage_error');
    }
  }
  try {
    root = await unlinkedPath(root);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || !owned(rootStat)) throw fail('account_storage_error');
    privateDir = join(root, '.studio', 'private');
    await unlinkedPath(privateDir);
    await mkdir(join(root, '.studio'), { mode: 0o700 }).catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
    const studioStat = await lstat(await unlinkedPath(join(root, '.studio')));
    if (!studioStat.isDirectory() || !owned(studioStat) || (studioStat.mode & 0o777) !== 0o700) throw fail('account_storage_error');
    await mkdir(privateDir, { mode: 0o700 }).catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
    await checkDirectories();
    path = join(privateDir, 'account-connection.json');
    try { persisted = await privateRead(path); saved = parseSaved(persisted); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  } catch { throw fail('account_storage_error'); }
  let generation = 0, closed = false, changing = false, verified = false, status = saved ? 'saved' : 'disconnected', voice = null, voiceEligibility = null, expiryTimer;
  let writes = Promise.resolve();
  const active = new Set();
  const abortGeneration = () => { generation++; for (const controller of active) controller.abort(fail('account_session_changed')); };
  function expire() {
    clearTimeout(expiryTimer);
    if (!saved || closed) return;
    const remaining = Date.parse(saved.connection.expiresAt) - clock();
    if (remaining <= 0) {
      if (status !== 'expired') { status = 'expired'; verified = false; voice = null; voiceEligibility = null; abortGeneration(); }
      return;
    }
    expiryTimer = setTimeout(expire, Math.min(remaining, 2 ** 31 - 1));
    expiryTimer.unref();
  }
  expire();
  const snapshot = () => {
    expire();
    return { connected: !closed && saved !== null && status !== 'expired' && status !== 'revoked', status: closed ? 'closed' : status,
      verified: !closed && verified, apiBase, account: clone(saved?.account), connection: clone(saved?.connection),
      scopes: saved ? [...STUDIO_ACCOUNT_SCOPES] : [], voice: clone(voice), voiceEligibility: clone(voiceEligibility) };
  };
  async function checkPersisted() {
    await checkDirectories();
    try { if (await privateRead(path) !== persisted) throw fail('account_storage_error'); }
    catch (cause) { if (cause.code !== 'ENOENT' || persisted !== null) throw cause; }
  }
  function persist(record) {
    const operation = writes.then(async () => {
      const raw = JSON.stringify({ version: 1, apiBase, record });
      const temp = join(privateDir, `.account-connection-${randomBytes(16).toString('hex')}.tmp`);
      let handle, committed = false;
      try {
        await checkPersisted();
        handle = await open(temp, 'wx', 0o600);
        await handle.writeFile(raw, 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        await checkPersisted();
        await rename(temp, path);
        persisted = raw; committed = true;
      } catch { throw fail('account_storage_error'); }
      finally { if (handle) await handle.close().catch(() => {}); if (!committed) await rm(temp, { force: true }).catch(() => {}); }
    });
    writes = operation.catch(() => {});
    return operation;
  }
  async function request(endpoint, { method = 'GET', body, token: credential, expectedGeneration = generation } = {}) {
    if (closed) throw fail('account_closed', 503);
    if (active.size >= 16) throw fail('account_busy', 503);
    const controller = new AbortController();
    active.add(controller);
    let onAbort, reader;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason instanceof AccountError ? controller.signal.reason : fail('account_session_changed'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = setTimeout(() => controller.abort(fail('account_timeout', 504)), timeoutMs);
    const wait = value => Promise.race([Promise.resolve(value), aborted]);
    const url = new URL(endpoint, base).href;
    const headers = { Accept: 'application/json' };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      const fetching = Promise.resolve().then(() => fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal }));
      fetching.then(late => { if (controller.signal.aborted) cancelBody(late?.body); }, () => {});
      response = await wait(fetching);
      if (!response || response.redirected || (response.url && response.url !== url)) throw fail('account_invalid_response');
      const length = response.headers?.get('content-length');
      if ((length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > 65536))
        || !/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') ?? '')) throw fail('account_invalid_response');
      if (!response.body || typeof response.body.getReader !== 'function') throw fail('account_invalid_response');
      reader = response.body.getReader();
      let bytes = 0, chunks = 0;
      const buffers = [];
      for (;;) {
        const part = await wait(reader.read());
        if (part.done) break;
        if (++chunks > 256 || !(part.value instanceof Uint8Array) || (bytes += part.value.byteLength) > 65536) throw fail('account_invalid_response');
        buffers.push(Buffer.from(part.value));
      }
      let data;
      try { data = JSON.parse(Buffer.concat(buffers, bytes).toString('utf8')); } catch { throw fail('account_invalid_response'); }
      if (expectedGeneration !== null && expectedGeneration !== generation) throw fail('account_session_changed');
      if (!object(data)) throw fail('account_invalid_response');
      if (!response.ok || data.ok === false) {
        if (credential && response.status === 401) throw fail('account_revoked', 401);
        if (endpoint.endsWith('/redeem') && [400, 409, 410].includes(response.status)) throw fail('account_link_invalid', response.status);
        if (endpoint.endsWith('/voice/activate') && [403, 409].includes(response.status)) throw fail('account_voice_unavailable', response.status);
        throw fail('account_server_error', Number.isInteger(response.status) ? response.status : 0);
      }
      return data;
    } catch (cause) {
      if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} }
      else cancelBody(response?.body);
      if (cause instanceof AccountError) throw cause;
      if (controller.signal.aborted && controller.signal.reason instanceof AccountError) throw controller.signal.reason;
      throw fail('account_network_error');
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener('abort', onAbort);
      try { reader?.releaseLock(); } catch {}
      active.delete(controller);
    }
  }
  async function revokeCredential(credential) {
    try { await request('api/studio/session', { method: 'DELETE', token: credential, expectedGeneration: null }); return true; }
    catch { return false; }
  }
  function requireConnection() {
    if (closed) throw fail('account_closed', 503);
    expire();
    if (status === 'expired') throw fail('account_expired', 401);
    if (status === 'revoked') throw fail('account_revoked', 401);
    if (changing) throw fail('account_busy', 409);
    if (!saved) throw fail('account_not_connected', 401);
    return { record: saved, expectedGeneration: generation };
  }
  async function authorized(endpoint, options, consume) {
    const context = requireConnection();
    try {
      const data = await request(endpoint, { ...options, token: context.record.token, expectedGeneration: context.expectedGeneration });
      if (context.expectedGeneration !== generation) throw fail('account_session_changed');
      expire();
      if (context.expectedGeneration !== generation) throw fail('account_session_changed');
      return consume(data, context.record);
    } catch (cause) {
      if (cause.code === 'account_revoked' && context.expectedGeneration === generation) {
        status = 'revoked'; verified = false; voice = null; voiceEligibility = null;
        abortGeneration(); clearTimeout(expiryTimer);
        try { await persist(null); saved = null; } catch {}
      }
      throw cause instanceof AccountError ? cause : fail('account_server_error');
    }
  }
  return {
    publicInfo: snapshot,
    async connect(input) {
      if (closed) throw fail('account_closed', 503);
      if (changing) throw fail('account_busy', 409);
      if (!exact(input, ['code', 'label']) || typeof input.code !== 'string' || input.code.length > 128 || !CODE.test(input.code.trim()) || !text(input.label, 64) || !input.label.trim()) throw fail('account_invalid_input', 400);
      changing = true; abortGeneration();
      const expectedGeneration = generation, previous = saved;
      let candidate;
      try {
        const data = await request('api/studio/redeem', { method: 'POST', body: { code: input.code.trim(), label: input.label.trim() }, expectedGeneration });
        if (typeof data.token === 'string' && TOKEN.test(data.token)) candidate = data.token;
        if (!candidate || data.apiBase !== apiBase || !validScopes(data.scopes)) throw fail('account_invalid_response');
        const next = { token: candidate, account: safeAccount(data.account), connection: safeConnection(data.connection), scopes: [...STUDIO_ACCOUNT_SCOPES] };
        if (Date.parse(next.connection.expiresAt) <= clock() || Date.parse(next.connection.createdAt) > clock() + 60000) throw fail('account_invalid_response');
        if (expectedGeneration !== generation) throw fail('account_session_changed');
        await persist(next);
        saved = next; verified = true; status = 'connected'; voice = null; voiceEligibility = null; expire();
        candidate = null;
        if (previous && previous.token !== next.token) await revokeCredential(previous.token);
        return snapshot();
      } catch (cause) {
        if (candidate && candidate !== previous?.token) await revokeCredential(candidate);
        throw cause instanceof AccountError ? cause : fail('account_server_error');
      } finally { changing = false; }
    },
    refresh() {
      return authorized('api/studio/profile', {}, (data, record) => {
        const account = safeAccount(data.account), connection = safeConnection(data.connection);
        if (!validScopes(data.scopes) || account.id !== record.account.id || connection.id !== record.connection.id || connection.expiresAt !== record.connection.expiresAt || connection.createdAt !== record.connection.createdAt) throw fail('account_invalid_response');
        voice = safeVoice(data.voice); voiceEligibility = safeEligibility(data.voiceEligibility ?? data.voice?.studioVoice); verified = true; status = 'connected';
        return snapshot();
      });
    },
    async disconnect() {
      if (closed) throw fail('account_closed', 503);
      if (changing) throw fail('account_busy', 409);
      changing = true; abortGeneration();
      const previous = saved;
      try {
        await persist(null);
        saved = null; verified = false; status = 'disconnected'; voice = null; voiceEligibility = null; clearTimeout(expiryTimer);
        const revoked = previous ? await revokeCredential(previous.token) : true;
        return { ...snapshot(), revocationConfirmed: revoked };
      } finally { changing = false; }
    },
    listDevices() {
      return authorized('api/studio/devices', {}, data => {
        if (!Array.isArray(data.devices) || data.devices.length > 50) throw fail('account_invalid_response');
        const devices = data.devices.map(device => safeDevice(device, true));
        if (new Set(devices.map(device => device.id)).size !== devices.length) throw fail('account_invalid_response');
        return { devices };
      });
    },
    deviceDiagnostics(input) {
      if (!exact(input, ['deviceId']) || !validId(input.deviceId)) return Promise.reject(fail('account_invalid_input', 400));
      return authorized(`api/studio/devices/${input.deviceId}/voice-diagnostics`, {}, safeDiagnostics);
    },
    claimPairing(input) {
      if (!exact(input, ['code']) || typeof input.code !== 'string' || input.code.length > 32 || !/^[A-HJ-NP-Z2-9]{8}$/.test(input.code.replace(/[\s-]/g, '').toUpperCase())) return Promise.reject(fail('account_invalid_input', 400));
      return authorized('api/studio/pairing/claim', { method: 'POST', body: { code: input.code } }, data => {
        if (data.ok !== true) throw fail('account_invalid_response');
        return { ok: true, device: safeDevice(data.device) };
      });
    },
    activateVoice(input) {
      if (!exact(input, ['deviceId']) || !validId(input.deviceId)) return Promise.reject(fail('account_invalid_input', 400));
      return authorized('api/studio/voice/activate', { method: 'POST', body: { deviceId: input.deviceId } }, data => {
        if (data.ok !== true) throw fail('account_invalid_response');
        voice = safeVoice(data.voice); voiceEligibility = safeEligibility(data.voice?.studioVoice) ?? voiceEligibility;
        return { ok: true, voice: clone(voice) };
      });
    },
    async close() {
      closed = true; abortGeneration(); clearTimeout(expiryTimer); await writes;
    },
  };
}
