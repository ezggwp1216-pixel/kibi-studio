import { mkdir, writeFile, rename, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { unlinkedPath, readPrivateFile, isOwned } from './private-files.mjs';

// One server process per data directory. All API state changes use exclusive().
export async function openStore(dataDir) {
  dataDir = await unlinkedPath(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(await unlinkedPath(dataDir));
  if (!directory.isDirectory() || !isOwned(directory)) throw new Error('invalid_data_directory');
  await chmod(dataDir, 0o700);
  const keyPath = join(dataDir, 'encryption.key');
  const statePath = join(dataDir, 'state.json');
  let key;
  try { key = await readPrivateFile(keyPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Losing the key must never silently replace it for existing encrypted data.
    try { await lstat(statePath); throw new Error('missing_encryption_key'); }
    catch (stateError) { if (stateError.code !== 'ENOENT') throw stateError; }
    key = randomBytes(32);
    await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 });
  }
  if (key.length !== 32) throw new Error('invalid_encryption_key');
  let state = { version: 1, devices: [], events: [], telegram: null, ai: null };
  try {
    state = JSON.parse((await readPrivateFile(statePath)).toString('utf8'));
    if (state.version !== 1 || !Array.isArray(state.devices) || !Array.isArray(state.events)) throw new Error('invalid_state');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const seal = value => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  };
  const unseal = value => {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8'));
  };
  if (state.telegram) unseal(state.telegram); // Fail closed on corrupt/incompatible secrets.
  if (state.ai) unseal(state.ai);
  if (state.xiaozhi) unseal(state.xiaozhi);
  let queue = Promise.resolve();
  let pending = 0;
  return {
    state,
    seal,
    telegram: () => state.telegram ? unseal(state.telegram) : null,
    ai: () => state.ai ? unseal(state.ai) : null,
    xiaozhi: () => state.xiaozhi ? unseal(state.xiaozhi) : null,
    async save() {
      const tempPath = join(dataDir, `.state-${randomBytes(8).toString('hex')}.tmp`);
      await writeFile(tempPath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      await rename(tempPath, statePath);
    },
    exclusive(fn) {
      if (pending >= 64) return Promise.reject(Object.assign(new Error('server_busy'), { status: 503, code: 'server_busy' }));
      pending++;
      const result = queue.then(fn).finally(() => { pending--; });
      queue = result.catch(() => {});
      return result;
    },
  };
}
