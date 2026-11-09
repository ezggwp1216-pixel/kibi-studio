import { mkdir, lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isOwned, readPrivateFile, unlinkedPath } from './private-files.mjs';

// voice.activate authorizes only the route's separately checked ordinary-account
// request; the server still checks owner-approved eligibility and device ownership.
export const STUDIO_SCOPES = Object.freeze(['pairing.claim', 'devices.list', 'voice.status', 'voice.activate', 'catalog.read']);
const SCOPES = STUDIO_SCOPES;
const CODE_TTL = 10 * 60 * 1000;
const TOKEN_TTL = 90 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE = /^kibi_link_[A-Za-z0-9_-]{32}$/;
const TOKEN = /^kibi_studio_[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const hash = (kind, value) => createHash('sha256').update(`${kind}\0${value}`).digest('hex');
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validId = id => typeof id === 'string' && UUID.test(id);
const validLabel = label => typeof label === 'string' && label.length >= 1 && label.length <= 64
  && label === label.trim() && !/[\x00-\x1f\x7f]/.test(label);
const validTime = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const validDuration = (value, duration) => validTime(value.createdAt) && validTime(value.expiresAt)
  && Date.parse(value.expiresAt) - Date.parse(value.createdAt) === duration;
const descriptor = connection => ({ id: connection.id, label: connection.label,
  createdAt: connection.createdAt, expiresAt: connection.expiresAt, scopes: [...SCOPES] });

function parseRegistry(raw) {
  const invalid = () => { throw fail(500, 'invalid_studio_links'); };
  let value;
  try { value = JSON.parse(raw); } catch { invalid(); }
  if (!exact(value, ['version', 'accounts']) || value.version !== 1
    || !Array.isArray(value.accounts) || value.accounts.length > 128) invalid();
  const accountIds = new Set(), codeHashes = new Set(), connectionIds = new Set(), tokenHashes = new Set();
  for (const account of value.accounts) {
    if (!exact(account, ['id', 'code', 'connections']) || !validId(account.id) || accountIds.has(account.id)
      || !Array.isArray(account.connections) || account.connections.length > 8) invalid();
    accountIds.add(account.id);
    if (account.code !== null) {
      if (!exact(account.code, ['codeHash', 'createdAt', 'expiresAt'])
        || typeof account.code.codeHash !== 'string' || !DIGEST.test(account.code.codeHash)
        || !validDuration(account.code, CODE_TTL) || codeHashes.has(account.code.codeHash)) invalid();
      codeHashes.add(account.code.codeHash);
    }
    for (const connection of account.connections) {
      if (!exact(connection, ['id', 'label', 'createdAt', 'expiresAt', 'scopes', 'tokenHash'])
        || !validId(connection.id) || connectionIds.has(connection.id) || !validLabel(connection.label)
        || !validDuration(connection, TOKEN_TTL) || typeof connection.tokenHash !== 'string'
        || !DIGEST.test(connection.tokenHash) || tokenHashes.has(connection.tokenHash)
        || !Array.isArray(connection.scopes) || connection.scopes.length !== SCOPES.length
        || !SCOPES.every((scope, index) => connection.scopes[index] === scope)) invalid();
      connectionIds.add(connection.id);
      tokenHashes.add(connection.tokenHash);
    }
  }
  return value.accounts;
}

// One process owns this directory. accountExists is a trusted synchronous
// predicate over ordinary registered accounts; browser input cannot supply it.
export async function openStudioLinks(dataDir, { now = Date.now, accountExists = () => true } = {}) {
  if (typeof now !== 'function' || typeof accountExists !== 'function') throw fail(500, 'invalid_studio_links_options');
  dataDir = await unlinkedPath(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  async function checkDirectory() {
    const directory = await lstat(await unlinkedPath(dataDir));
    if (!directory.isDirectory() || !isOwned(directory) || (directory.mode & 0o777) !== 0o700) {
      throw fail(500, 'invalid_data_directory');
    }
  }
  await checkDirectory();
  const registryPath = join(dataDir, 'studio-links.json');
  let persisted = null, accounts = [];
  try {
    persisted = (await readPrivateFile(registryPath)).toString('utf8');
    accounts = parseRegistry(persisted);
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }

  let queue = Promise.resolve(), pending = 0, closed = false;
  const index = new Map(), cancellations = new Map();
  const exists = id => {
    if (!validId(id)) return false;
    try { return accountExists(id) === true; } catch { return false; }
  };
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || !Number.isFinite(Date.parse(new Date(value).toISOString()))) {
      throw fail(500, 'invalid_studio_links_clock');
    }
    return value;
  };
  const ensureOpen = () => { if (closed) throw fail(503, 'studio_links_closed'); };
  function requireAccount(id) {
    ensureOpen();
    if (!exists(id)) throw fail(403, 'studio_account_unavailable');
  }
  function cancel(id) {
    const entry = cancellations.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.controller.abort();
    cancellations.delete(id);
  }
  function signalFor(connection) {
    let entry = cancellations.get(connection.id);
    if (!entry) {
      entry = { controller: new AbortController(), timer: null };
      cancellations.set(connection.id, entry);
      const expire = () => {
        const remaining = Date.parse(connection.expiresAt) - clock();
        if (remaining <= 0) { cancel(connection.id); return; }
        entry.timer = setTimeout(expire, Math.min(remaining, 2 ** 31 - 1));
        entry.timer.unref();
      };
      expire();
    }
    return entry.controller.signal;
  }
  function publish(next) {
    accounts = next;
    index.clear();
    const retained = new Set();
    for (const account of accounts) for (const connection of account.connections) {
      index.set(connection.tokenHash, { accountId: account.id, connection });
      retained.add(connection.id);
    }
    for (const id of cancellations.keys()) if (!retained.has(id)) cancel(id);
  }
  publish(accounts);

  async function checkPersisted() {
    await checkDirectory();
    try {
      const current = (await readPrivateFile(registryPath)).toString('utf8');
      if (current !== persisted) throw fail(500, 'studio_links_changed');
    } catch (cause) { if (cause.code !== 'ENOENT' || persisted !== null) throw cause; }
  }
  async function save(nextAccounts) {
    await checkPersisted();
    const next = JSON.stringify({ version: 1, accounts: nextAccounts });
    const tempPath = join(dataDir, `.studio-links-${randomBytes(16).toString('hex')}.tmp`);
    let file, committed = false;
    try {
      file = await open(tempPath, 'wx', 0o600);
      await file.writeFile(next, 'utf8');
      await file.sync();
      await file.close();
      file = null;
      await checkPersisted();
      await rename(tempPath, registryPath);
      committed = true;
      persisted = next;
    } finally {
      if (file) await file.close();
      if (!committed) await rm(tempPath, { force: true });
    }
    publish(nextAccounts);
  }
  function enqueue(operation) {
    if (closed) return Promise.reject(fail(503, 'studio_links_closed'));
    if (pending >= 64) return Promise.reject(fail(503, 'server_busy'));
    pending++;
    const result = queue.then(() => { ensureOpen(); return operation(); }).finally(() => { pending--; });
    queue = result.catch(() => {});
    return result;
  }
  function pruned(time) {
    return accounts.filter(account => exists(account.id)).map(account => ({ ...account,
      code: account.code && Date.parse(account.code.expiresAt) > time ? account.code : null,
      connections: account.connections.filter(connection => Date.parse(connection.expiresAt) > time),
    })).filter(account => account.code || account.connections.length);
  }
  function authenticate(token) {
    if (closed || typeof token !== 'string' || !TOKEN.test(token)) return null;
    const found = index.get(hash('studio-token', token));
    if (!found) return null;
    const { accountId, connection } = found;
    if (!exists(accountId) || Date.parse(connection.expiresAt) <= clock()) {
      cancel(connection.id);
      return null;
    }
    return { kind: 'studio', accountId, role: 'user', connectionId: connection.id,
      expiresAt: connection.expiresAt, scopes: [...SCOPES], signal: signalFor(connection) };
  }

  return {
    issue(accountId) {
      return enqueue(async () => {
        requireAccount(accountId);
        const time = clock(), next = pruned(time);
        let account = next.find(account => account.id === accountId);
        if (!account) {
          if (next.length >= 128) throw fail(409, 'studio_account_limit');
          account = { id: accountId, code: null, connections: [] };
          next.push(account);
        }
        let code, codeHash;
        do {
          code = `kibi_link_${randomBytes(24).toString('base64url')}`;
          codeHash = hash('studio-code', code);
        } while (next.some(account => account.code?.codeHash === codeHash));
        account.code = { codeHash, createdAt: new Date(time).toISOString(), expiresAt: new Date(time + CODE_TTL).toISOString() };
        await save(next);
        return { code, expiresAt: account.code.expiresAt };
      });
    },
    redeem(input) {
      return enqueue(async () => {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'invalid_studio_link');
        const { code, label } = input;
        if (typeof code !== 'string' || code.length > 128 || !CODE.test(code.trim())) throw fail(400, 'invalid_studio_link');
        if (typeof label !== 'string' || label.length > 64 || !validLabel(label.trim())) throw fail(400, 'invalid_studio_label');
        const time = clock(), next = pruned(time), codeHash = hash('studio-code', code.trim());
        const account = next.find(account => account.code?.codeHash === codeHash);
        if (!account) throw fail(410, 'studio_link_not_found');
        if (account.connections.length >= 8) throw fail(409, 'studio_connection_limit');
        let token, tokenHash;
        do {
          token = `kibi_studio_${randomBytes(32).toString('base64url')}`;
          tokenHash = hash('studio-token', token);
        } while (index.has(tokenHash));
        const connection = { id: randomUUID(), label: label.trim(), createdAt: new Date(time).toISOString(),
          expiresAt: new Date(time + TOKEN_TTL).toISOString(), scopes: [...SCOPES], tokenHash };
        account.code = null;
        account.connections = [...account.connections, connection];
        await save(next);
        return { token, connection: descriptor(connection) };
      });
    },
    authenticate,
    list(accountId) {
      requireAccount(accountId);
      const time = clock();
      const account = accounts.find(account => account.id === accountId);
      return (account?.connections ?? []).filter(connection => {
        if (Date.parse(connection.expiresAt) > time) return true;
        cancel(connection.id);
        return false;
      }).map(descriptor);
    },
    revoke(accountId, connectionId) {
      return enqueue(async () => {
        requireAccount(accountId);
        if (!validId(connectionId)) throw fail(400, 'invalid_studio_connection');
        const next = pruned(clock()), account = next.find(account => account.id === accountId);
        if (!account?.connections.some(connection => connection.id === connectionId)) return false;
        account.connections = account.connections.filter(connection => connection.id !== connectionId);
        await save(next);
        return true;
      });
    },
    disconnect(token) {
      return enqueue(async () => {
        const principal = authenticate(token);
        if (!principal) return false;
        const next = pruned(clock()), account = next.find(account => account.id === principal.accountId);
        account.connections = account.connections.filter(connection => connection.id !== principal.connectionId);
        await save(next);
        return true;
      });
    },
    // Hold this registry's queue through the trusted local operation. A queued
    // revoke runs either before authorization or after the operation completes.
    // The callback must not call queued Studio-link methods (that would deadlock).
    withAuthorization(token, scope, operation) {
      return enqueue(async () => {
        const principal = authenticate(token);
        if (!principal) throw fail(401, 'studio_unauthorized');
        if (!SCOPES.includes(scope)) throw fail(403, 'studio_scope_denied');
        if (typeof operation !== 'function') throw fail(500, 'invalid_studio_operation');
        return operation(principal);
      });
    },
    async close() {
      closed = true;
      for (const id of cancellations.keys()) cancel(id);
      await queue;
      for (const id of cancellations.keys()) cancel(id);
    },
  };
}
