import { open } from 'node:fs/promises';
import { validatePlugin } from './manifest.mjs';

// Read at most the package limit plus one byte, even if an input file grows.
let result;
let file;
try {
  if (process.argv.length !== 3 || !process.argv[2].endsWith('.kibiplugin')) throw new Error();
  file = await open(process.argv[2], 'r');
  const buffer = Buffer.alloc(128 * 1024 + 1);
  let used = 0;
  while (used < buffer.length) {
    const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
    if (!bytesRead) break;
    used += bytesRead;
  }
  result = used === buffer.length ? { ok: false, errors: [{ path: '$', code: 'package_too_large' }] }
    : validatePlugin(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used)));
} catch {
  result = { ok: false, errors: [{ path: '$', code: 'package_unreadable' }] };
} finally { await file?.close(); }
const output = result.ok
  ? { ok: true, requiresRuntime: result.requiresRuntime, runtimeSupported: false }
  : result;
process.stdout.write(`${JSON.stringify(output)}\n`);
process.exitCode = result.ok ? 0 : 1;
