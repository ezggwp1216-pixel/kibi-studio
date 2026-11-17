import { createServer } from 'node:net';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { brokerProtocol as wire } from './broker-client.mjs';

const unavailable = () => Object.assign(new Error('plugin_broker_unavailable'), { code: 'plugin_broker_unavailable' });

/** Trusted execution process. Receives no account credentials, paths or shell
 * options. Its only operations are isolated handlers, typed frames and status. */
export function createPluginBrokerServer({ socketPath, runtime, media, runtimeDeadlineMs = 5000, mediaDeadlineMs = 20000, cleanupGraceMs = 4500, startupDeadlineMs = 2500 } = {}) {
  if (!wire.validPath(socketPath) || !Number.isInteger(runtimeDeadlineMs) || runtimeDeadlineMs < 1 || runtimeDeadlineMs > 5000 ||
    !Number.isInteger(mediaDeadlineMs) || mediaDeadlineMs < 1 || mediaDeadlineMs > 20000 || !Number.isInteger(cleanupGraceMs) || cleanupGraceMs < 1 || cleanupGraceMs > 4500 ||
    !Number.isInteger(startupDeadlineMs) || startupDeadlineMs < 1 || startupDeadlineMs > 2500) throw unavailable();
  let started = false, closed = false, listening, closing, active = 0;
  const sockets = new Set(), jobs = new Set(), poisoned = new Set();
  function status() {
    let rt, mt; try { rt = runtime?.status?.(); } catch {} try { mt = media?.status?.(); } catch {}
    const value = wire.snapshot(rt, mt);
    for (const kind of poisoned) { value[kind].available = false; value[kind][kind === 'runtime' ? 'reason' : 'status'] = 'cleanup_failed'; }
    return value;
  }
  function boundedJob(op, payload, controller) {
    const kind = op === 'frame' ? 'media' : 'runtime', base = wire.prefix(op), adapter = op === 'frame' ? media : runtime;
    if (closed || poisoned.has(kind) || !status()[kind].configured || (kind === 'runtime' && !status()[kind].available) || typeof adapter?.[op === 'frame' ? 'frame' : 'invoke'] !== 'function') return Promise.reject(wire.fail(base + 'unavailable'));
    if (active >= 4) return Promise.reject(wire.fail(base + 'busy'));
    active++;
    let deadline, grace, settled = false, timedOut = false, resolveResult, rejectResult;
    const promise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const job = { controller, promise }; jobs.add(job);
    function finish(error, value) {
      if (settled) return; settled = true; clearTimeout(deadline); clearTimeout(grace); controller.signal.removeEventListener('abort', onAbort); jobs.delete(job);
      if (error?.code === base + 'cleanup_failed') poisoned.add(kind); else active--;
      if (error) rejectResult(error); else resolveResult(value);
    }
    function onAbort() {
      if (grace || settled) return;
      grace = setTimeout(() => finish(wire.fail(base + 'cleanup_failed')), cleanupGraceMs);
    }
    controller.signal.addEventListener('abort', onAbort, { once: true });
    deadline = setTimeout(() => { timedOut = true; controller.abort(); }, op === 'frame' ? mediaDeadlineMs : runtimeDeadlineMs);
    if (controller.signal.aborted) onAbort();
    Promise.resolve().then(() => adapter[op === 'frame' ? 'frame' : 'invoke']({ ...payload, signal: controller.signal })).then(value => {
      if (controller.signal.aborted) { finish(wire.fail(timedOut ? base + 'timeout' : wire.cancelled(op))); return; }
      try {
        if (op === 'frame') { const frame = wire.frameResult(value); finish(null, { ...frame, rgb565: frame.rgb565.toString('base64') }); }
        else { if (!wire.object(value)) throw wire.fail('plugin_runtime_invalid_output'); if (Buffer.byteLength(JSON.stringify(value)) > wire.MAX_IO) throw wire.fail('plugin_runtime_output_limit'); finish(null, value); }
      } catch (error) { finish(wire.fail(wire.validErrorCode(op, error?.code) ? error.code : base + (op === 'frame' ? 'invalid_frame' : 'invalid_output'))); }
    }, error => {
      const code = wire.validErrorCode(op, error?.code) ? error.code : base + (op === 'frame' ? 'unavailable' : 'failed');
      finish(wire.fail(code.endsWith('_cleanup_failed') ? code : controller.signal.aborted ? timedOut ? base + 'timeout' : wire.cancelled(op) : code));
    });
    return promise;
  }
  const server = createServer(socket => {
    if (closed || sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket); const controller = new AbortController();
    let buffer = Buffer.alloc(0), bytes = 0, dispatched = false, cancelled = false, answered = false;
    const timer = setTimeout(() => socket.destroy(), 2000);
    const abort = () => { clearTimeout(timer); controller.abort(); };
    socket.on('error', abort); socket.on('end', abort); socket.on('close', () => { sockets.delete(socket); abort(); });
    const reply = value => {
      if (answered || socket.destroyed) return; answered = true;
      let output; try { output = JSON.stringify({ ...value, status: status() }) + '\n'; } catch { socket.destroy(); return; }
      if (Buffer.byteLength(output) > wire.MAX_RESPONSE) { socket.destroy(); return; }
      // Bound unread response lifetime as well as incoming bytes.
      socket.setTimeout(2000, () => socket.destroy()); socket.end(output);
    };
    const invalid = () => { controller.abort(); reply({ ok: false, code: 'plugin_runtime_invalid_input' }); };
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > wire.MAX_REQUEST + 32) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.includes(10)) {
        const index = buffer.indexOf(10), line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
        let request;
        try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { invalid(); return; }
        if (dispatched) {
          if (cancelled || !wire.exact(request, ['version', 'cancel']) || request.version !== 1 || request.cancel !== true) { invalid(); return; }
          cancelled = true; controller.abort(); continue;
        }
        dispatched = true; clearTimeout(timer);
        if (!wire.exact(request, ['version', 'op', 'payload']) || request.version !== 1 || !['status', 'invoke', 'frame'].includes(request.op)) { invalid(); return; }
        if (request.op === 'status') { if (!wire.exact(request.payload, [])) invalid(); else reply({ ok: true, value: {} }); continue; }
        let payload;
        try { payload = request.op === 'frame' ? wire.mediaPayload(request.payload) : wire.runtimePayload(request.payload); }
        catch { invalid(); return; }
        boundedJob(request.op, payload, controller).then(value => reply({ ok: true, value }), error => reply({ ok: false, code: error.code }));
      }
      if (!dispatched && bytes > wire.MAX_REQUEST) socket.destroy();
    });
  });
  // All socket errors are fixed at this boundary; no paths or daemon output.
  server.on('error', () => {});
  async function listen() {
    if (closed) throw unavailable(); if (listening) return listening;
    listening = (async () => {
      try {
        const parent = dirname(socketPath); await mkdir(parent, { mode: 0o700, recursive: true });
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o027) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw unavailable();
        try { await lstat(socketPath); throw unavailable(); } catch (error) { if (error.code !== 'ENOENT') throw unavailable(); }
        await Promise.all([['runtime', runtime], ['media', media]].map(async ([kind, adapter]) => {
          if (!adapter?.ready) return;
          let timer;
          try { await Promise.race([Promise.resolve().then(() => adapter.ready()), new Promise((resolve, reject) => { timer = setTimeout(() => reject(unavailable()), startupDeadlineMs); })]); }
          catch { poisoned.add(kind); } finally { clearTimeout(timer); }
        }));
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); }); });
        started = true; await chmod(socketPath, 0o600);
      } catch { if (started) await new Promise(resolve => server.close(resolve)); throw unavailable(); }
    })();
    return listening;
  }
  async function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await listening?.catch(() => {});
      const stopping = started ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      for (const job of jobs) job.controller.abort();
      await Promise.allSettled([...jobs].map(job => job.promise));
      for (const socket of sockets) socket.destroy();
      await stopping;
      let timer;
      await Promise.race([Promise.allSettled([Promise.resolve().then(() => runtime?.close?.()), Promise.resolve().then(() => media?.close?.())]), new Promise(resolve => { timer = setTimeout(resolve, cleanupGraceMs); })]);
      clearTimeout(timer);
    })(); return closing;
  }
  return { listen, start: listen, close };
}
