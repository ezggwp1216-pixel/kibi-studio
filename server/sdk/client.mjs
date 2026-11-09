const MAX_RESPONSE_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, min = 1) => typeof value === 'string' && value.length >= min && value.length <= max && (min === 0 || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
const messageText = value => typeof value === 'string' && value.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const secret = value => typeof value === 'string' && /^[A-Za-z0-9._~+/-]{1,510}={0,2}$/.test(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const messages = {
  invalid_base: 'Укажите точный HTTPS-адрес своего сервера.',
  invalid_argument: 'Неверные параметры запроса SDK.',
  token_required: 'Сначала сохраните токен устройства.',
  invalid_response: 'Сервер вернул неподходящий ответ.',
  http_error: 'Сервер отклонил запрос.',
  network_error: 'Не удалось связаться с сервером.',
  timeout: 'Время ожидания сервера истекло.',
};

export class KibiSdkError extends Error {
  constructor(code, status) {
    super(messages[code] ?? messages.invalid_response);
    this.name = 'KibiSdkError';
    this.code = Object.hasOwn(messages, code) ? code : 'invalid_response';
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}
const fail = (code, status) => { throw new KibiSdkError(code, status); };

function normalizeBase(value, allowLocalhostHttp) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\%?#]/.test(value)) fail('invalid_base');
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/.exec(value);
  if (!match) fail('invalid_base');
  const path = match[3] ?? '/';
  if (!/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) fail('invalid_base');
  let url;
  try { url = new URL(value); } catch { fail('invalid_base'); }
  if (url.username || url.password || url.search || url.hash) fail('invalid_base');
  if (url.protocol === 'http:') {
    // Compare the original authority too: URL() canonicalizes 127.1 and hex IPs.
    if (!allowLocalhostHttp || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(match[2])) fail('invalid_base');
  } else if (url.protocol !== 'https:') fail('invalid_base');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

async function readJson(response) {
  if (response.headers?.get) {
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) fail('invalid_response');
  }
  let raw;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); fail('invalid_response'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid_response'); }
  } else {
    raw = await response.text();
    if (encoder.encode(raw).byteLength > MAX_RESPONSE_BYTES) fail('invalid_response');
  }
  try { return JSON.parse(raw); } catch { fail('invalid_response'); }
}

function safeDevice(value) {
  if (!record(value) || !text(value.id, 256) || !text(value.name, 64)) fail('invalid_response');
  const device = { id: value.id, name: value.name };
  for (const field of ['createdAt', 'lastSeenAt']) {
    if (Object.hasOwn(value, field)) {
      if (!(iso(value[field]) || (field === 'lastSeenAt' && value[field] === null))) fail('invalid_response');
      device[field] = value[field];
    }
  }
  if (Object.hasOwn(value, 'status')) {
    if (!['not_seen', 'online', 'offline'].includes(value.status)) fail('invalid_response');
    device.status = value.status;
  }
  return device;
}

/** Explicit calls only. The token stays in this closure; persistence is the caller's job. */
export function createKibiClient({ apiBase, deviceToken, fetchImpl = globalThis.fetch, allowLocalhostHttp = false, timeoutMs = 10000 } = {}) {
  const base = normalizeBase(apiBase, allowLocalhostHttp === true);
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('invalid_argument');
  let token;
  const setDeviceToken = value => { if (!secret(value)) fail('invalid_argument'); token = value; };
  if (deviceToken !== undefined) setDeviceToken(deviceToken);
  const request = async (path, method, body, authenticated, expectedStatus = 200) => {
    if (authenticated && !token) fail('token_required');
    const url = new URL(`api/${path}`, base).href;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new KibiSdkError('timeout')); controller.abort(); }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url, {
          method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
        });
        if (!response || !Number.isInteger(response.status)) fail('invalid_response');
        if (response.redirected || (response.url && response.url !== url)) fail('invalid_response');
        if (response.status !== expectedStatus) { void response.body?.cancel?.().catch(() => {}); fail('http_error', response.status); }
        return await readJson(response);
      })()]);
    } catch (error) {
      if (timedOut) fail('timeout');
      if (error instanceof KibiSdkError) throw new KibiSdkError(error.code, error.status);
      fail('network_error');
    } finally { clearTimeout(timer); }
  };
  return Object.freeze({
    setDeviceToken,
    clearDeviceToken() { token = undefined; },
    async startPairing(input) {
      if (!record(input) || !text(input.name, 64)) fail('invalid_argument');
      const value = await request('pairing/start', 'POST', { name: input.name }, false, 201);
      if (!record(value) || !text(value.pairingId, 256) || !/^[A-Z0-9-]{4,32}$/.test(value.code) || !secret(value.pollToken) || !iso(value.expiresAt) || value.intervalSeconds !== 3) fail('invalid_response');
      return { pairingId: value.pairingId, code: value.code, pollToken: value.pollToken, expiresAt: value.expiresAt, intervalSeconds: 3 };
    },
    async pollPairing(input) {
      if (!record(input) || !text(input.pairingId, 256) || !secret(input.pollToken)) fail('invalid_argument');
      const value = await request('pairing/poll', 'POST', { pairingId: input.pairingId, pollToken: input.pollToken }, false);
      if (!record(value)) fail('invalid_response');
      if (value.status === 'pending' && iso(value.expiresAt)) return { status: 'pending', expiresAt: value.expiresAt };
      if (value.status !== 'paired' || !secret(value.token)) fail('invalid_response');
      let returnedBase;
      try { returnedBase = normalizeBase(value.apiBase, allowLocalhostHttp === true); } catch { fail('invalid_response'); }
      if (returnedBase !== base) fail('invalid_response');
      return { status: 'paired', device: safeDevice(value.device), token: value.token, apiBase: base };
    },
    async sendEvent(input) {
      if (!record(input) || !text(input.title, 120) || (input.message !== undefined && !messageText(input.message)) ||
        (input.eventId !== undefined && (typeof input.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(input.eventId)))) fail('invalid_argument');
      const value = await request('device/events', 'POST', { title: input.title, message: input.message ?? '', ...(input.eventId !== undefined ? { eventId: input.eventId } : {}) }, true);
      if (!record(value) || value.ok !== true || !text(value.eventId, 256) || typeof value.duplicate !== 'boolean') fail('invalid_response');
      return { ok: true, eventId: value.eventId, duplicate: value.duplicate };
    },
    async getMessages() {
      const value = await request('device/messages', 'GET', undefined, true);
      if (!record(value) || !Array.isArray(value.messages) || value.messages.length > 50) fail('invalid_response');
      return { messages: value.messages.map(message => {
        if (!record(message) || !text(message.id, 256) || !text(message.title, 120) || !messageText(message.message) || !iso(message.createdAt)) fail('invalid_response');
        return { id: message.id, title: message.title, message: message.message, createdAt: message.createdAt };
      }) };
    },
    async acknowledge(input) {
      if (!record(input) || !text(input.messageId, 256)) fail('invalid_argument');
      const value = await request('device/ack', 'POST', { messageId: input.messageId }, true);
      if (!record(value) || value.ok !== true) fail('invalid_response');
      return { ok: true };
    },
  });
}
