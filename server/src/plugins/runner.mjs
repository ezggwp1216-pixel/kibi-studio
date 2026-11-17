// CONTAINER ENTRYPOINT ONLY. Never import this file in the HTTP process.
// The host adapter enforces the deadline, container restrictions and IO limits.
const LIMIT = 64 * 1024;
const handlers = new Set(['onDeviceRequest', 'onDeviceEvent', 'onDeviceMessage']);
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error('input_limit');
    chunks.push(chunk);
  }
  const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  const { source, handler, input, settings } = envelope;
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > LIMIT || !handlers.has(handler)
    || !settings || typeof settings !== 'object' || Array.isArray(settings) || Buffer.byteLength(JSON.stringify({ input, settings })) > LIMIT) throw new Error('invalid_input');
  // This import exists only in the fixed, secret-free and networkless image.
  const module = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);
  if (typeof module[handler] !== 'function') throw new Error('handler_missing');
  const value = await module[handler](input, { settings });
  const result = JSON.stringify(value);
  if (typeof result !== 'string' || Buffer.byteLength(result) > LIMIT) throw new Error('output_limit');
  process.stdout.write(result, () => process.exit(0));
} catch {
  // Never return source, stack traces, environment values or raw diagnostics.
  process.stderr.write('plugin_execution_failed', () => process.exit(1));
}
