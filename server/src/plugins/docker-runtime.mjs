import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DAEMON_POLICY_ARGS, hasRequiredDaemonIsolation } from './daemon-policy.mjs';

const MAX_IO = 64 * 1024;
const CONTROL_CLOSE_GRACE_MS = 400;
const HANDLERS = new Set(['onDeviceRequest', 'onDeviceEvent', 'onDeviceMessage']);
const fail = (status, code) => Object.assign(new Error(code), { status, code });
let globalActive = 0;

/** Optional isolated executor. No uploaded source is imported by this process. */
export function createDockerPluginRuntime({ enabled = false, spawnImpl = spawn, dockerPath = 'docker', image = 'kibi-plugin-js:local', timeoutMs = 5000 } = {}) {
  if (typeof enabled !== 'boolean' || typeof spawnImpl !== 'function' || typeof dockerPath !== 'string' || !dockerPath || dockerPath.includes('\0')
    || typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/.test(image)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw fail(500, 'plugin_runtime_invalid_options');
  let available = false, closed = false, reason = enabled ? 'checking' : 'disabled';
  const active = new Set(), controls = new Set();
  // The Docker client gets a fixed search path, and no provider credentials or
  // environment overrides. No environment flags are passed into the container.
  const options = () => ({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin' } });
  function kill(child) { try { child?.kill('SIGKILL'); } catch {} }
  function control(args, deadline = 2000, requireEmptyOutput = false) {
    let child, done = false, failed = false, closeObserved = false, bytes = 0, stdoutBytes = 0, timer, closeTimer, resolveResult, markClosed;
    const output = [];
    const result = new Promise(resolve => { resolveResult = resolve; });
    const closedResult = new Promise(resolve => { markClosed = resolve; });
    const entry = { result, cancel: stop, async drain() {
      stop(); await result;
      if (!closeObserved && child) {
        // Keep unconfirmed children visible to shutdown, including a command
        // whose original bounded close grace already expired.
        let drainTimer;
        kill(child);
        await Promise.race([closedResult, new Promise(resolve => { drainTimer = setTimeout(resolve, CONTROL_CLOSE_GRACE_MS); })]);
        clearTimeout(drainTimer);
      }
    } };
    controls.add(entry);
    function finish(ok, stopped) {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(closeTimer);
      if (stopped) controls.delete(entry);
      else { available = false; reason = 'cleanup_failed'; }
      resolveResult({ ok, stopped, output: Buffer.concat(output) });
    }
    function stop() {
      if (done || failed) return; failed = true; clearTimeout(timer);
      closeTimer = setTimeout(() => finish(false, false), Math.min(CONTROL_CLOSE_GRACE_MS, deadline));
      kill(child);
    }
    try { child = spawnImpl(dockerPath, args, options()); }
    catch { markClosed(); closeObserved = true; finish(false, true); return result; }
    // Reserve termination confirmation inside the existing control deadline.
    timer = setTimeout(stop, Math.max(1, deadline - CONTROL_CLOSE_GRACE_MS));
    child.on('error', stop);
    child.on('close', code => { closeObserved = true; markClosed(); controls.delete(entry); finish(!failed && code === 0 && (!requireEmptyOutput || stdoutBytes === 0), true); });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { if (done || failed) return; bytes += chunk.length; if (stream === child.stdout) { stdoutBytes += chunk.length; if (bytes <= MAX_IO) output.push(Buffer.from(chunk)); } if (bytes > MAX_IO) stop(); });
    child.stdin?.on('error', stop);
    try { child.stdin?.end(); } catch { stop(); }
    return result;
  }
  const ready = enabled ? Promise.all([control(DAEMON_POLICY_ARGS), control(['image', 'inspect', image, '--format', '{{.Id}}'])]).then(([policy, inspected]) => {
    if (!closed) {
      const stopped = policy.stopped && inspected.stopped;
      available = stopped && policy.ok && inspected.ok && hasRequiredDaemonIsolation(policy.output);
      reason = !stopped ? 'cleanup_failed' : available ? 'ready' : 'unavailable';
    }
  }) : Promise.resolve();

  function invoke({ source, handler, input, settings = {}, signal } = {}) {
    let payload;
    try {
      if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > MAX_IO || !HANDLERS.has(handler)
        || settings === null || typeof settings !== 'object' || Array.isArray(settings)
        || (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')))
        throw new Error('invalid');
      const ordinaryInput = JSON.stringify({ input, settings });
      if (!ordinaryInput || Buffer.byteLength(ordinaryInput) > MAX_IO) throw new Error('invalid');
      // Source and ordinary input have independent 64 KiB limits. JSON escaping
      // can expand the transport envelope; it is bounded separately in runner.
      payload = JSON.stringify({ source, handler, input, settings });
      if (Buffer.byteLength(payload) > 512 * 1024) throw new Error('invalid');
    } catch { return Promise.reject(fail(400, 'plugin_runtime_invalid_input')); }
    return ready.then(async () => {
      if (closed || !available) throw fail(503, 'plugin_runtime_unavailable');
      if (signal?.aborted) throw fail(409, 'plugin_invocation_cancelled');
      // The socket may now refer to a restarted/replaced daemon. Recheck before
      // every container; startup metadata alone cannot authorize execution.
      const policy = await control(DAEMON_POLICY_ARGS);
      if (!policy.stopped) throw fail(503, 'plugin_runtime_cleanup_failed');
      if (!policy.ok || !hasRequiredDaemonIsolation(policy.output)) { available = false; reason = 'unavailable'; }
      if (closed || !available) throw fail(503, 'plugin_runtime_unavailable');
      if (signal?.aborted) throw fail(409, 'plugin_invocation_cancelled');
      if (globalActive >= 4) throw fail(503, 'plugin_runtime_busy');
      globalActive++;
      const name = `kibi-plugin-${randomBytes(16).toString('hex')}`;
      const args = ['run', '--rm', '--pull=never', '--name', name, '--network', 'none', '--read-only', '--user', '65534:65534',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m', '--memory-swap', '128m',
        '--cpus', '0.5', '--ulimit', 'nofile=64:64', '--ipc', 'none', '--log-driver', 'none', '-i', image];
      let child, timer, finished = false, bytes = 0;
      let markCliClosed;
      const cliClosed = new Promise(resolve => { markCliClosed = resolve; });
      const output = [];
      let resolveResult, rejectResult;
      const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      const entry = { cancel: () => finish(fail(409, 'plugin_invocation_cancelled'), null, true), result };
      async function finish(error, value, remove = false) {
        if (finished) return;
        finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        let quarantined = false;
        if (remove) {
          kill(child);
          // Do not query absence while a still-live docker CLI could submit a
          // late create request. Cleanup remains bounded if termination stalls.
          let closeTimer;
          const cliStopped = await Promise.race([cliClosed, new Promise(resolve => { closeTimer = setTimeout(() => resolve(false), 400); })]);
          clearTimeout(closeTimer);
          // Killing a docker CLI does not stop its container. Always remove the
          // server-generated name; disable this executor if cleanup is uncertain.
          const removal = await control(['rm', '--force', name]);
          let removed = removal.ok && removal.stopped;
          // --rm can win the race after an ordinary handler error. A failed rm
          // alone cannot distinguish an absent container from daemon failure.
          // Only a successful daemon listing with precisely empty stdout proves
          // absence; never infer it from localized CLI exception/stderr text.
          if (!removed && removal.stopped) { const absence = await control(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], 2000, true); removed = absence.ok && absence.stopped; }
          if (!removed || !cliStopped) { available = false; reason = 'cleanup_failed'; error = fail(503, 'plugin_runtime_cleanup_failed'); quarantined = true; }
        }
        // An uncertain container consumes its slot until process restart.
        if (!quarantined) globalActive--; active.delete(entry);
        if (error) rejectResult(error); else resolveResult(value);
      }
      const abort = () => finish(fail(409, 'plugin_invocation_cancelled'), null, true);
      active.add(entry);
      try { child = spawnImpl(dockerPath, args, options()); }
      catch { markCliClosed(true); finish(fail(503, 'plugin_runtime_failed'), null, true); return result; }
      child.once('close', () => markCliClosed(true));
      child.on('error', () => finish(fail(503, 'plugin_runtime_failed'), null, true));
      child.stdin?.on('error', () => finish(fail(503, 'plugin_runtime_failed'), null, true));
      const consume = (chunk, stdout) => {
        if (finished) return; bytes += chunk.length;
        if (bytes > MAX_IO) { finish(fail(502, 'plugin_runtime_output_limit'), null, true); return; }
        if (stdout) output.push(Buffer.from(chunk));
      };
      child.stdout?.on('data', chunk => consume(chunk, true)); child.stderr?.on('data', chunk => consume(chunk, false));
      child.on('close', code => {
        if (finished) return;
        if (code !== 0) { finish(fail(502, 'plugin_runtime_failed'), null, true); return; }
        let value;
        try {
          value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output)));
          if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
        } catch { finish(fail(502, 'plugin_runtime_invalid_output'), null, true); return; }
        finish(null, value);
      });
      timer = setTimeout(() => finish(fail(504, 'plugin_runtime_timeout'), null, true), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return result; }
      try { child.stdin.end(payload); } catch { finish(fail(503, 'plugin_runtime_failed'), null, true); }
      return result;
    });
  }
  return {
    ready: () => ready,
    status: () => ({ configured: enabled, available: available && !closed, reason, isolation: 'docker', deadlineMs: 5000, maxInputBytes: MAX_IO, maxOutputBytes: MAX_IO, maxConcurrent: 4 }),
    invoke,
    async close() {
      closed = true; available = false; reason = 'closed';
      const running = [...active]; for (const entry of running) entry.cancel();
      for (const entry of controls) entry.cancel();
      await Promise.allSettled(running.map(entry => entry.result)); await ready;
      await Promise.allSettled([...controls].map(entry => entry.drain()));
    },
  };
}
