import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_IO = 65536, MAX_REQUEST = 512 * 1024, MAX_RESPONSE = 256 * 1024, FRAME_BYTES = 142080;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const statuses = Object.freeze({
  plugin_runtime_unavailable: 503, plugin_runtime_busy: 503, plugin_runtime_invalid_input: 400,
  plugin_runtime_failed: 502, plugin_runtime_invalid_output: 502, plugin_runtime_output_limit: 502,
  plugin_runtime_timeout: 504, plugin_invocation_cancelled: 409, plugin_runtime_cleanup_failed: 503,
  plugin_media_unavailable: 503, plugin_media_busy: 503, plugin_media_invalid_request: 400,
  plugin_media_invalid_frame: 502, plugin_media_timeout: 504, plugin_media_cancelled: 409, plugin_media_cleanup_failed: 503,
  plugin_media_provider_restricted: 424,
});
const fail = code => Object.assign(new Error(code), { code, status: statuses[code] ?? 503 });
const prefix = op => op === 'frame' ? 'plugin_media_' : 'plugin_runtime_';
const validErrorCode = (op, code) => Object.hasOwn(statuses, code) &&
  (op === 'status' ? code === 'plugin_runtime_invalid_input' : typeof code === 'string' && (code.startsWith(prefix(op)) || (op === 'invoke' && code === 'plugin_invocation_cancelled')));
const cancelled = op => op === 'frame' ? 'plugin_media_cancelled' : 'plugin_invocation_cancelled';
const validPath = value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0') && Buffer.byteLength(value) <= 100;
function runtimePayload(value) {
  if (!object(value) || Object.keys(value).some(key => !['source', 'handler', 'input', 'settings'].includes(key)) ||
    typeof value.source !== 'string' || !value.source.trim() || Buffer.byteLength(value.source) > MAX_IO ||
    !['onDeviceRequest', 'onDeviceEvent', 'onDeviceMessage'].includes(value.handler) ||
    !Object.hasOwn(value, 'input') || (value.settings !== undefined && !object(value.settings)) ||
    Buffer.byteLength(JSON.stringify({ input: value.input, settings: value.settings ?? {} })) > MAX_IO) throw fail('plugin_runtime_invalid_input');
  return { source: value.source, handler: value.handler, input: value.input, settings: value.settings ?? {} };
}
function mediaPayload(value) {
  if (!object(value) || Object.keys(value).some(key => !['videoId', 'fit'].includes(key)) ||
    typeof value.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value.videoId) ||
    (value.fit !== undefined && !['contain', 'cover'].includes(value.fit))) throw fail('plugin_media_invalid_request');
  return { videoId: value.videoId, fit: value.fit ?? 'contain' };
}
function snapshot(runtime, media) {
  const configured = runtime?.configured === true;
  const mediaConfigured = media?.configured === true || media?.enabled === true;
  const reason = ['ready', 'checking', 'disabled', 'unavailable', 'cleanup_failed', 'closed'].includes(runtime?.reason) ? runtime.reason : 'unavailable';
  const mediaState = ['ready', 'unverified', 'disabled', 'unavailable', 'cleanup_failed', 'closed'].includes(media?.status) ? media.status : 'unavailable';
  return {
    runtime: { configured, available: configured && runtime?.available === true, reason, isolation: 'docker', deadlineMs: 5000, maxInputBytes: MAX_IO, maxOutputBytes: MAX_IO, maxConcurrent: 4 },
    media: { configured: mediaConfigured, available: mediaConfigured && media?.available === true, status: mediaState },
  };
}
function frameResult(value, encoded = false) {
  if (!object(value) || value.width !== 240 || value.height !== 296 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw fail('plugin_media_invalid_frame');
  const rgb565 = encoded && typeof value.rgb565 === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value.rgb565) ? Buffer.from(value.rgb565, 'base64') : value.rgb565;
  if (!Buffer.isBuffer(rgb565) || rgb565.length !== FRAME_BYTES || createHash('sha256').update(rgb565).digest('hex') !== value.sha256) throw fail('plugin_media_invalid_frame');
  return { rgb565, width: 240, height: 296, sha256: value.sha256 };
}

// Shared wire validation has no execution imports and no process launch API.
export const brokerProtocol = Object.freeze({ MAX_IO, MAX_REQUEST, MAX_RESPONSE, object, exact, fail, prefix, cancelled, validPath, runtimePayload, mediaPayload, snapshot, frameResult, statuses, validErrorCode });

/** IPC-only facade for the account HTTP process. Never owns an executor. */
export function createPluginBrokerClient({ socketPath } = {}) {
  if (socketPath !== undefined && !validPath(socketPath)) throw fail('plugin_runtime_invalid_input');
  let closed = false, poisoned = false, sampledAt = 0, cache = snapshot(null, null), checking;
  const pending = new Set();
  function status(kind) {
    if (!closed && !poisoned && socketPath && !checking && Date.now() - sampledAt > 1000) void ready();
    const value = { ...cache[kind] };
    if (closed || poisoned || Date.now() - sampledAt > 5000) value.available = false;
    if (closed || poisoned) value[kind === 'runtime' ? 'reason' : 'status'] = closed ? 'closed' : 'cleanup_failed';
    return value;
  }
  function request(op, payload, signal) {
    const base = prefix(op), unavailable = base + 'unavailable';
    if (closed || poisoned || !socketPath) return Promise.reject(fail(unavailable));
    if (signal?.aborted) return Promise.reject(fail(cancelled(op)));
    if (pending.size >= 16) return Promise.reject(fail(base + 'busy'));
    let serialized;
    try { serialized = JSON.stringify({ version: 1, op, payload }) + '\n'; if (Buffer.byteLength(serialized) > MAX_REQUEST) throw fail(base + (op === 'frame' ? 'invalid_request' : 'invalid_input')); }
    catch { return Promise.reject(fail(base + (op === 'frame' ? 'invalid_request' : 'invalid_input'))); }
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    let socket, timer, sent = false, cancelSent = false, done = false, size = 0;
    const chunks = [];
    const entry = { result, cancel: () => cancel() };
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); pending.delete(entry); socket?.destroy();
      if (error) rejectResult(error); else resolveResult(value);
    };
    const uncertain = () => { if (op !== 'status' && sent) { poisoned = true; return fail(base + 'cleanup_failed'); } cache = snapshot(null, null); return fail(unavailable); };
    const cancel = () => {
      if (done || cancelSent) return;
      if (!sent) { finish(fail(cancelled(op))); return; }
      // The response acknowledges completed worker cleanup. Keep this socket
      // until it arrives; destroying it here would free the service lease early.
      cancelSent = true; socket.write('{"version":1,"cancel":true}\n', error => { if (error && !done) finish(uncertain()); });
    };
    pending.add(entry);
    timer = setTimeout(() => finish(uncertain()), 2000);
    try { socket = createConnection(socketPath); } catch { finish(fail(unavailable)); return result; }
    socket.on('error', () => finish(uncertain()));
    socket.on('close', () => { if (!done) finish(uncertain()); });
    socket.on('connect', () => {
      if (done) return;
      clearTimeout(timer); timer = setTimeout(() => finish(uncertain()), op === 'status' ? 2000 : op === 'frame' ? 25000 : 10000);
      sent = true; socket.write(serialized, error => { if (error && !done) finish(uncertain()); });
    });
    socket.on('data', chunk => {
      if (done) return; size += chunk.length;
      if (size > MAX_RESPONSE) { finish(uncertain()); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      let response;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) throw fail(unavailable);
        response = JSON.parse(text);
        if (!exact(response, response.ok === true ? ['ok', 'value', 'status'] : ['ok', 'code', 'status']) || typeof response.ok !== 'boolean' || !exact(response.status, ['runtime', 'media'])) throw fail(unavailable);
        cache = snapshot(response.status.runtime, response.status.media); sampledAt = Date.now();
        if (!response.ok) {
          if (!validErrorCode(op, response.code)) throw fail(unavailable);
          if (response.code.endsWith('_cleanup_failed')) poisoned = true;
          finish(fail(response.code)); return;
        }
        if (signal?.aborted) { finish(fail(cancelled(op))); return; }
        if (op === 'invoke' && (!object(response.value) || Buffer.byteLength(JSON.stringify(response.value)) > MAX_IO)) throw fail('plugin_runtime_invalid_output');
        finish(null, op === 'frame' ? frameResult(response.value, true) : response.value);
      } catch { finish(uncertain()); }
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    return result;
  }
  function ready() {
    if (checking) return checking;
    checking = request('status', {}).then(() => {}, () => {}).finally(() => { checking = undefined; }); return checking;
  }
  async function close() { closed = true; const jobs = [...pending]; for (const job of jobs) job.cancel(); await Promise.allSettled(jobs.map(job => job.result)); }
  function invoke(value = {}) {
    let payload;
    try { const { signal, ...ordinary } = value; payload = runtimePayload(ordinary); if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('plugin_runtime_invalid_input'); }
    catch { return Promise.reject(fail('plugin_runtime_invalid_input')); }
    return request('invoke', payload, value.signal);
  }
  function frame(value = {}) {
    let payload;
    try { const { signal, ...ordinary } = value; payload = mediaPayload(ordinary); if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('plugin_media_invalid_request'); }
    catch { return Promise.reject(fail('plugin_media_invalid_request')); }
    return request('frame', payload, value.signal);
  }
  return { runtime: { status: () => status('runtime'), ready, invoke, close }, media: { status: () => status('media'), frame, close }, ready, close };
}
