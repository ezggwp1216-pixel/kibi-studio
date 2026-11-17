import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const loaded = await import('../src/plugins/docker-runtime.mjs').catch(() => ({}));
const create = options => { assert.equal(typeof loaded.createDockerPluginRuntime, 'function', 'isolated runtime is implemented'); return loaded.createDockerPluginRuntime(options); };
const qualifiedDaemon = { securityOptions: ['name=rootless'], cgroupVersion: '2', cgroupDriver: 'systemd' };
function transport(run, { daemon = () => qualifiedDaemon } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); let input = '';
    child.stdin = new Writable({ write(chunk, encoding, callback) { input += chunk.toString(); callback(); } });
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
    const call = { command, args, options, child, input: () => input }; calls.push(call);
    if (args[0] === 'info') queueMicrotask(() => { child.stdout.write(JSON.stringify(daemon())); child.emit('close', 0); });
    else if (args[0] === 'image' || args[0] === 'rm') queueMicrotask(() => child.emit('close', 0));
    else child.stdin.on('finish', () => run(call));
    return child;
  };
  return { calls, spawnImpl };
}
const invocation = { source: 'throw new Error("NEVER EXECUTE IN HOST")', handler: 'onDeviceRequest', input: { hello: true }, settings: {} };

test('is fail-closed by default without spawning a process', async () => {
  let spawned = false; const runtime = create({ spawnImpl: () => { spawned = true; throw new Error('private'); } });
  assert.deepEqual({ configured: runtime.status().configured, available: runtime.status().available }, { configured: false, available: false });
  await assert.rejects(runtime.invoke(invocation), { code: 'plugin_runtime_unavailable', status: 503 });
  assert.equal(spawned, false); await runtime.close();
});

test('passes bounded JSON to a fixed unprivileged, networkless, mountless container', async () => {
  const injected = transport(call => { call.child.stdout.write('{"effects":[]}'); call.child.emit('close', 0); });
  const runtime = create({ enabled: true, spawnImpl: injected.spawnImpl }); await runtime.ready();
  assert.equal(runtime.status().available, true); assert.deepEqual(await runtime.invoke(invocation), { effects: [] });
  const call = injected.calls.find(call => call.args[0] === 'run');
  for (const flag of ['--read-only', '--network', '--user', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus', '--name', '--pull=never']) assert.equal(call.args.includes(flag), true, flag);
  for (const value of ['none', '65534:65534', 'ALL', 'no-new-privileges', '32', '128m', '0.5']) assert.equal(call.args.includes(value), true, value);
  assert.equal(call.args.some(arg => ['-v', '--volume', '--mount', '-e', '--env', '--privileged'].includes(arg)), false);
  assert.equal(call.options.shell, false); assert.equal(Object.hasOwn(call.options.env, 'HOME'), false);
  assert.deepEqual(JSON.parse(call.input()), invocation); await runtime.close();
});

test('removes the named container on deadline, cancellation and excess output', async () => {
  for (const mode of ['deadline', 'abort', 'output']) {
    const injected = transport(call => { if (mode === 'output') call.child.stdout.write('x'.repeat(65537)); });
    const runtime = create({ enabled: true, spawnImpl: injected.spawnImpl, timeoutMs: 15 }); await runtime.ready();
    const controller = new AbortController(); const pending = runtime.invoke({ ...invocation, signal: controller.signal });
    if (mode === 'abort') { await new Promise(resolve => setImmediate(resolve)); controller.abort(); }
    await assert.rejects(pending, { code: mode === 'deadline' ? 'plugin_runtime_timeout' : mode === 'abort' ? 'plugin_invocation_cancelled' : 'plugin_runtime_output_limit' });
    const run = injected.calls.find(call => call.args[0] === 'run');
    const name = run.args[run.args.indexOf('--name') + 1];
    assert.equal(injected.calls.some(call => call.args[0] === 'rm' && call.args.includes(name) && call.args.includes('--force')), true);
    await runtime.close();
  }
});

test('caps invocations globally at four and closes active containers', async () => {
  const injected = transport(() => {});
  const one = create({ enabled: true, spawnImpl: injected.spawnImpl }); const two = create({ enabled: true, spawnImpl: injected.spawnImpl });
  await Promise.all([one.ready(), two.ready()]);
  const running = Array.from({ length: 4 }, (_, i) => (i % 2 ? one : two).invoke(invocation));
  const outcomes = Promise.allSettled(running);
  await assert.rejects(one.invoke(invocation), { code: 'plugin_runtime_busy' });
  await Promise.all([one.close(), two.close()]);
  assert.equal((await outcomes).every(result => result.status === 'rejected' && result.reason.code === 'plugin_invocation_cancelled'), true);
  assert.equal(injected.calls.filter(call => call.args[0] === 'rm').length, 4);
});

test('rejects malformed, oversized or failed worker responses without exposing diagnostics', async () => {
  for (const mode of ['invalid', 'failed', 'stderr']) {
    const injected = transport(call => { if (mode === 'stderr') call.child.stderr.write('x'.repeat(65537)); else { call.child.stdout.write(mode === 'invalid' ? 'not JSON private error' : '{}'); call.child.stderr.write('private provider credential'); call.child.emit('close', mode === 'failed' ? 1 : 0); } });
    const runtime = create({ enabled: true, spawnImpl: injected.spawnImpl }); await runtime.ready();
    await assert.rejects(runtime.invoke(invocation), error => { assert.equal(error.message.includes('private'), false); return error.code === (mode === 'invalid' ? 'plugin_runtime_invalid_output' : mode === 'failed' ? 'plugin_runtime_failed' : 'plugin_runtime_output_limit'); });
    assert.equal(JSON.stringify(runtime.status()).includes('private'), false); await runtime.close();
  }
});

test('bounds source and input and rejects arbitrary handlers before creating a container', async () => {
  const injected = transport(() => {}); const runtime = create({ enabled: true, spawnImpl: injected.spawnImpl }); await runtime.ready();
  for (const patch of [{ source: 'x'.repeat(65537) }, { input: 'x'.repeat(65537) }, { handler: '../../private' }, { settings: { token: 'x'.repeat(65537) } }]) await assert.rejects(runtime.invoke({ ...invocation, ...patch }), { code: 'plugin_runtime_invalid_input' });
  assert.equal(injected.calls.some(call => call.args[0] === 'run'), false); await runtime.close();
});

test('a missing Docker transport is an honest unavailable state', async () => {
  const runtime = create({ enabled: true, spawnImpl: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', Object.assign(new Error('private path'), { code: 'ENOENT' }))); return child; } });
  await runtime.ready(); assert.equal(runtime.status().available, false);
  await assert.rejects(runtime.invoke(invocation), { code: 'plugin_runtime_unavailable' }); await runtime.close();
});

test('an ordinary handler failure does not disable execution after --rm already removed its container', async () => {
  let runs = 0;
  const injected = transport(call => {
    runs++;
    call.child.stdout.write(runs === 1 ? '' : '{"effects":[]}');
    call.child.emit('close', runs === 1 ? 1 : 0);
  });
  const spawnImpl = (command, args, options) => {
    if (args[0] !== 'rm' && args[0] !== 'ps') return injected.spawnImpl(command, args, options);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } }); child.kill = () => true;
    queueMicrotask(() => { if (args[0] === 'rm') child.stderr.write('No such container'); child.emit('close', args[0] === 'rm' ? 1 : 0); });
    return child;
  };
  const runtime = create({ enabled: true, spawnImpl }); await runtime.ready();
  try {
    await assert.rejects(runtime.invoke(invocation), { code: 'plugin_runtime_failed' });
    assert.equal(runtime.status().available, true);
    assert.deepEqual(await runtime.invoke(invocation), { effects: [] });
  } finally { await runtime.close(); }
});

test('failed removal disables execution unless a successful daemon query proves absence', async () => {
  for (const mode of ['daemon-error', 'still-present', 'unrelated-output']) {
    const injected = transport(call => { call.child.emit('close', 1); });
    const spawnImpl = (command, args, options) => {
      if (args[0] !== 'rm' && args[0] !== 'ps') return injected.spawnImpl(command, args, options);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } }); child.kill = () => true;
      queueMicrotask(() => {
        if (args[0] === 'ps' && mode !== 'daemon-error') child.stdout.write(mode === 'still-present' ? 'kibi-plugin-still-present\n' : 'daemon diagnostic');
        child.emit('close', args[0] === 'rm' || mode === 'daemon-error' ? 1 : 0);
      });
      return child;
    };
    const runtime = create({ enabled: true, spawnImpl }); await runtime.ready();
    try {
      await assert.rejects(runtime.invoke(invocation), { code: 'plugin_runtime_cleanup_failed' });
      assert.equal(runtime.status().available, false, mode);
      assert.equal(runtime.status().reason, 'cleanup_failed', mode);
      await assert.rejects(runtime.invoke(invocation), { code: 'plugin_runtime_unavailable' });
    } finally { await runtime.close(); }
  }
});

test('the standalone runner calls the canonical two-argument handler contract', async () => {
  // This source is a fixed trusted test fixture, never an uploaded package. This
  // verifies the runner protocol only and is not evidence of Docker isolation.
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/plugins/runner.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  child.stdin.end(JSON.stringify({ source: 'export async function onDeviceRequest(input, context) { return { value: input.value, fit: context.settings.fit }; }', handler: 'onDeviceRequest', input: { value: 42 }, settings: { fit: 'contain' } }));
  assert.equal(await done, 0, stderr); assert.deepEqual(JSON.parse(stdout), { value: 42, fit: 'contain' });
});

test('cancellation waits for the Docker CLI to close before proving container absence', async () => {
  let killed, run;
  const hasKilled = new Promise(resolve => { killed = resolve; });
  const injected = transport(call => { run = call; call.child.kill = () => { killed(); return true; }; });
  const runtime = create({ enabled: true, spawnImpl: injected.spawnImpl }); await runtime.ready();
  const controller = new AbortController(); let settled = false;
  const pending = runtime.invoke({ ...invocation, signal: controller.signal }).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, { code: 'plugin_invocation_cancelled' });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await hasKilled;
  await new Promise(resolve => setTimeout(resolve, 10));
  try { assert.equal(settled, false); }
  finally { run.child.emit('close', null, 'SIGKILL'); await rejected; await runtime.close(); }
});

test('an unclosed cleanup control cannot be masked by an empty daemon listing or free repeated slots', async () => {
  const { createDockerPluginRuntime } = await import('../src/plugins/docker-runtime.mjs?control-overflow-regression');
  const calls = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
    child.kill = () => { child.killRequested = true; return true; }; calls.push({ args, child });
    queueMicrotask(() => {
      if (args[0] === 'rm') child.stderr.write('x'.repeat(65537));
      else { if (args[0] === 'info') child.stdout.write(JSON.stringify(qualifiedDaemon)); if (args[0] === 'run') child.stdout.write('invalid output'); child.emit('close', 0); }
    });
    return child;
  };
  const runtime = createDockerPluginRuntime({ enabled: true, spawnImpl }); await runtime.ready();
  try {
    const outcomes = [];
    for (let i = 0; i < 5; i++) { try { await runtime.invoke(invocation); outcomes.push('unexpected_success'); } catch (error) { outcomes.push(error.code); } }
    assert.deepEqual(outcomes, ['plugin_runtime_cleanup_failed', ...Array(4).fill('plugin_runtime_unavailable')]);
    assert.equal(calls.filter(call => call.args[0] === 'rm').length, 1);
    assert.equal(calls.some(call => call.args[0] === 'ps'), false, 'no daemon query can settle an unclosed rm command');
    assert.equal(runtime.status().available, false);
    assert.equal(runtime.status().reason, 'cleanup_failed');
  } finally { await runtime.close(); }
});

test('a killed cleanup control must actually close before fallback can prove absence', async () => {
  const { createDockerPluginRuntime } = await import('../src/plugins/docker-runtime.mjs?control-close-regression');
  let killed, removal;
  const hasKilled = new Promise(resolve => { killed = resolve; });
  const injected = transport(call => { call.child.emit('close', 1); });
  const spawnImpl = (command, args, options) => {
    if (args[0] !== 'rm' && args[0] !== 'ps') return injected.spawnImpl(command, args, options);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
    child.kill = () => { killed(); return true; };
    if (args[0] === 'rm') { removal = child; queueMicrotask(() => child.stderr.write('x'.repeat(65537))); }
    else queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const runtime = createDockerPluginRuntime({ enabled: true, spawnImpl }); await runtime.ready();
  let settled = false;
  const pending = runtime.invoke(invocation).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, { code: 'plugin_runtime_failed' });
  await hasKilled; await new Promise(resolve => setTimeout(resolve, 10));
  try { assert.equal(settled, false); }
  finally { removal.emit('close', null, 'SIGKILL'); await rejected; await runtime.close(); }
});

test('runtime close cancels and drains a readiness control rather than abandoning its CLI', async () => {
  const { createDockerPluginRuntime } = await import('../src/plugins/docker-runtime.mjs?control-shutdown-regression');
  let child, killed;
  const hasKilled = new Promise(resolve => { killed = resolve; });
  const runtime = createDockerPluginRuntime({ enabled: true, spawnImpl: (_file, args) => {
    const current = new EventEmitter(); current.stdout = new PassThrough(); current.stderr = new PassThrough();
    current.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
    current.kill = () => { killed(); return true; };
    if (args[0] === 'image') queueMicrotask(() => current.emit('close', 0)); else child = current;
    return current;
  } });
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  try {
    await Promise.race([hasKilled, new Promise((resolve, reject) => setTimeout(() => reject(new Error('close must cancel readiness control')), 100))]);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, false);
  } finally { child.emit('close', null, 'SIGKILL'); await closing; }
});


test('runtime requires rootless Docker with cgroup v2 and the systemd driver before becoming available', async () => {
  for (const daemon of [
    { ...qualifiedDaemon, securityOptions: ['name=seccomp'] },
    { ...qualifiedDaemon, cgroupVersion: '1' },
    { ...qualifiedDaemon, cgroupDriver: 'none' },
    { ...qualifiedDaemon, cgroupDriver: 'cgroupfs' },
    { securityOptions: ['name=rootless'] },
    null,
  ]) {
    const injected = transport(call => { call.child.stdout.write('{}'); call.child.emit('close', 0); }, { daemon: () => daemon });
    const runtime = create({ enabled: true, spawnImpl: injected.spawnImpl });
    try {
      await runtime.ready();
      assert.equal(runtime.status().available, false);
      await assert.rejects(runtime.invoke(invocation), { code: 'plugin_runtime_unavailable' });
      assert.equal(injected.calls.some(call => call.args[0] === 'run'), false);
    } finally { await runtime.close(); }
  }
});

test('runtime rechecks daemon isolation before execution after successful readiness', async () => {
  let daemon = qualifiedDaemon;
  const injected = transport(call => { call.child.stdout.write('{}'); call.child.emit('close', 0); }, { daemon: () => daemon });
  const runtime = create({ enabled: true, spawnImpl: injected.spawnImpl });
  try {
    await runtime.ready(); assert.equal(runtime.status().available, true);
    daemon = { ...qualifiedDaemon, securityOptions: ['name=seccomp'] };
    await assert.rejects(runtime.invoke(invocation), { code: 'plugin_runtime_unavailable' });
    assert.equal(runtime.status().available, false);
    assert.equal(injected.calls.some(call => call.args[0] === 'run'), false);
  } finally { await runtime.close(); }
});
