import { mkdir, chmod, lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isOwned, readPrivateFile, unlinkedPath } from './private-files.mjs';

const deriveKey = promisify(scrypt);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const localPart = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const kdfOptions = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

const error = (status, code) => Object.assign(new Error(code), { status, code });
const safeUser = ({ id, email, createdAt, role }) => ({ id, email, createdAt, role });
const hasKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[\x20-\x7e]+$/.test(value)) return null;
  const email = value.trim().toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  const labels = domain.split('.');
  if (local.length < 1 || local.length > 64 || !localPart.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || labels.length < 2 || !labels.every(label => domainLabel.test(label))) return null;
  return email;
}

const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 1024;

function parseRegistry(raw) {
  let value;
  try { value = JSON.parse(raw); }
  catch { throw error(500, 'invalid_accounts'); }
  if (!hasKeys(value, ['version', 'users']) || value.version !== 1 || !Array.isArray(value.users) || value.users.length > 128) {
    throw error(500, 'invalid_accounts');
  }
  const ids = new Set();
  const emails = new Set();
  for (const user of value.users) {
    if (!hasKeys(user, ['id', 'email', 'createdAt', 'role', 'password'])
      || typeof user.id !== 'string' || !uuid.test(user.id)
      || typeof user.email !== 'string' || normalizeEmail(user.email) !== user.email
      || user.role !== 'user' || typeof user.createdAt !== 'string' || user.createdAt.length !== 24
      || !Number.isFinite(Date.parse(user.createdAt)) || new Date(user.createdAt).toISOString() !== user.createdAt
      || !hasKeys(user.password, ['salt', 'hash'])
      || typeof user.password.salt !== 'string' || !/^[0-9a-f]{32}$/.test(user.password.salt)
      || typeof user.password.hash !== 'string' || !/^[0-9a-f]{64}$/.test(user.password.hash)
      || ids.has(user.id) || emails.has(user.email)) throw error(500, 'invalid_accounts');
    ids.add(user.id);
    emails.add(user.email);
  }
  return value.users;
}

// One server process owns a data directory. Hashing runs outside the small
// persistence queue; only a successful atomic replacement publishes a user.
export async function openAccounts(dataDir) {
  dataDir = await unlinkedPath(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(await unlinkedPath(dataDir));
  if (!directory.isDirectory() || !isOwned(directory)) throw error(500, 'invalid_data_directory');
  await chmod(dataDir, 0o700);
  const registryPath = join(dataDir, 'accounts.json');
  let persisted = null;
  let users = [];
  try {
    persisted = (await readPrivateFile(registryPath)).toString('utf8');
    users = parseRegistry(persisted);
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }

  const dummy = { salt: randomBytes(16).toString('hex'), hash: randomBytes(32).toString('hex') };
  let inFlight = 0;
  let pendingRegistrations = 0;
  let queue = Promise.resolve();

  async function hashPassword(password, salt) {
    if (inFlight >= 4) throw error(503, 'server_busy');
    inFlight++;
    try { return await deriveKey(password, Buffer.from(salt, 'hex'), 32, kdfOptions); }
    finally { inFlight--; }
  }

  async function checkPersisted() {
    await unlinkedPath(dataDir);
    try {
      const current = (await readPrivateFile(registryPath)).toString('utf8');
      if (current !== persisted) throw error(500, 'accounts_changed');
    } catch (cause) {
      if (cause.code !== 'ENOENT' || persisted !== null) throw cause;
    }
  }

  async function save(nextUsers) {
    await checkPersisted();
    const next = JSON.stringify({ version: 1, users: nextUsers });
    const tempPath = join(dataDir, `.accounts-${randomBytes(16).toString('hex')}.tmp`);
    let file;
    let committed = false;
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
  }

  return {
    list: () => users.map(safeUser),
    get: id => {
      const user = users.find(user => user.id === id);
      return user ? safeUser(user) : null;
    },
    dataDirFor(id) {
      if (typeof id !== 'string' || !uuid.test(id)) throw error(400, 'invalid_account');
      return join(dataDir, 'accounts', id);
    },
    async register(email, password) {
      email = normalizeEmail(email);
      if (!email || !validPassword(password)) throw error(400, 'invalid_registration');
      if (users.some(user => user.email === email)) throw error(409, 'account_unavailable');
      if (users.length >= 128) throw error(409, 'account_limit');
      if (pendingRegistrations >= 4) throw error(503, 'server_busy');
      pendingRegistrations++;
      try {
        const salt = randomBytes(16).toString('hex');
        const hash = (await hashPassword(password, salt)).toString('hex');
        const result = queue.then(async () => {
          if (users.some(user => user.email === email)) throw error(409, 'account_unavailable');
          if (users.length >= 128) throw error(409, 'account_limit');
          const user = { id: randomUUID(), email, createdAt: new Date().toISOString(), role: 'user', password: { salt, hash } };
          const nextUsers = [...users, user];
          await save(nextUsers);
          users = nextUsers;
          return safeUser(user);
        });
        queue = result.catch(() => {});
        return await result;
      } finally { pendingRegistrations--; }
    },
    async authenticate(email, password) {
      email = normalizeEmail(email);
      if (!email || !validPassword(password)) return null;
      const user = users.find(user => user.email === email);
      const stored = user?.password ?? dummy;
      const actual = await hashPassword(password, stored.salt);
      const matches = timingSafeEqual(actual, Buffer.from(stored.hash, 'hex'));
      return matches && user ? safeUser(user) : null;
    },
  };
}
