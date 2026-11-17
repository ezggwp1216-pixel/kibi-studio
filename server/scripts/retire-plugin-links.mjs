#!/usr/bin/env node
// Offline rollback for the frozen Studio-links v1 contract. Never import the
// server, start a listener, load accounts/keys or open the plugin registry here.
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isOwned, readPrivateFile, unlinkedPath } from '../src/private-files.mjs';

const FIVE = ['pairing.claim', 'devices.list', 'voice.status', 'voice.activate', 'catalog.read'];
const SEVEN = [...FIVE, 'assistant.read', 'assistant.write'];
const TEN = [...SEVEN, 'plugins.read', 'plugins.publish', 'plugins.bind'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { rollbackCode: code }); };
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const time = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const duration = (value, expected) => time(value.createdAt) && time(value.expiresAt)
  && Date.parse(value.expiresAt) - Date.parse(value.createdAt) === expected;
const scopesMatch = (value, expected) => Array.isArray(value) && value.length === expected.length
  && expected.every((scope, index) => value[index] === scope);

function options(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--data-dir', '--apply', '--expected-sha256', '--backup', '--confirm-server-stopped'].includes(flag) || values.has(flag)) fail('invalid_arguments');
    if (['--apply', '--confirm-server-stopped'].includes(flag)) values.set(flag, true);
    else {
      const value = argv[++index];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) fail('invalid_arguments');
      values.set(flag, value);
    }
  }
  if (!values.has('--data-dir')) fail('explicit_data_dir_required');
  const apply = values.has('--apply');
  const acknowledgements = ['--expected-sha256', '--backup', '--confirm-server-stopped'];
  if (apply ? acknowledgements.some(flag => !values.has(flag)) : acknowledgements.some(flag => values.has(flag))) fail('apply_acknowledgements_required');
  if (apply && !DIGEST.test(values.get('--expected-sha256'))) fail('invalid_expected_sha256');
  return { dataDir: values.get('--data-dir'), apply, expected: values.get('--expected-sha256'), backup: values.get('--backup') };
}

async function privateDirectory(input) {
  const path = await unlinkedPath(input);
  const stat = await lstat(path);
  if (!stat.isDirectory() || !isOwned(stat) || (stat.mode & 0o777) !== 0o700) fail('unsafe_private_directory');
  return path;
}

// JSON.parse validates JSON grammar; this bounded walk records original source
// ranges and rejects duplicate keys. Retained records are copied from these
// ranges, without reserializing their whitespace, escaping or property order.
function ranges(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { fail('invalid_studio_links'); }
  let offset = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(raw[offset] ?? '') && offset < raw.length) offset++; };
  function string() {
    const start = offset++;
    while (offset < raw.length) {
      if (raw[offset] === '\\') offset += 2;
      else if (raw[offset++] === '"') return JSON.parse(raw.slice(start, offset));
    }
    fail('invalid_studio_links');
  }
  function walk(current, depth) {
    if (depth > 16) fail('invalid_studio_links');
    whitespace();
    const node = { value: current, start: offset };
    if (raw[offset] === '{') {
      node.fields = new Map();
      offset++;
      whitespace();
      while (raw[offset] !== '}') {
        const key = string();
        if (node.fields.has(key)) fail('invalid_studio_links');
        whitespace();
        offset++; // ':'; already checked by JSON.parse.
        node.fields.set(key, walk(current[key], depth + 1));
        whitespace();
        if (raw[offset] !== ',') break;
        offset++;
        whitespace();
      }
      offset++;
    } else if (raw[offset] === '[') {
      node.elements = [];
      offset++;
      whitespace();
      while (raw[offset] !== ']') {
        node.elements.push(walk(current[node.elements.length], depth + 1));
        whitespace();
        if (raw[offset] !== ',') break;
        offset++;
        whitespace();
      }
      offset++;
    } else if (raw[offset] === '"') string();
    else while (offset < raw.length && !/[\x20\t\r\n,\]}]/.test(raw[offset])) offset++;
    node.end = offset;
    return node;
  }
  const root = walk(value, 0);
  whitespace();
  if (offset !== raw.length) fail('invalid_studio_links');
  return root;
}

function plan(bytes) {
  let raw;
  try {
    if (bytes.length > 2 * 1024 * 1024) fail('invalid_studio_links');
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // TextDecoder normally removes a BOM; never silently modify source bytes.
    if (!Buffer.from(raw, 'utf8').equals(bytes)) fail('invalid_studio_links');
  } catch { fail('invalid_studio_links'); }
  const root = ranges(raw), registry = root.value;
  if (!exact(registry, ['version', 'accounts']) || registry.version !== 1 || !Array.isArray(registry.accounts) || registry.accounts.length > 128) fail('invalid_studio_links');
  const accountIds = new Set(), codeHashes = new Set(), connectionIds = new Set(), tokenHashes = new Set();
  const report = { registryFiles: 1, accounts: registry.accounts.length, preservedConnections: 0,
    revokedPluginConnections: 0, preservedPendingCodes: 0, revokedPluginPendingCodes: 0, changedFiles: 0,
    sourceSha256: sha(bytes), resultSha256: null };
  const edits = [];
  for (const accountNode of root.fields.get('accounts').elements) {
    const account = accountNode.value;
    if (!exact(account, ['id', 'code', 'connections']) || typeof account.id !== 'string' || !UUID.test(account.id) || accountIds.has(account.id)
      || !Array.isArray(account.connections) || account.connections.length > 8) fail('invalid_studio_links');
    accountIds.add(account.id);
    if (account.code !== null) {
      if (!(exact(account.code, ['codeHash', 'createdAt', 'expiresAt']) || (exact(account.code, ['codeHash', 'createdAt', 'expiresAt', 'pluginAccess']) && account.code.pluginAccess === true))
        || typeof account.code.codeHash !== 'string' || !DIGEST.test(account.code.codeHash) || !duration(account.code, 10 * 60 * 1000)
        || codeHashes.has(account.code.codeHash)) fail('invalid_studio_links');
      codeHashes.add(account.code.codeHash);
      if (account.code.pluginAccess === true) {
        const node = accountNode.fields.get('code');
        edits.push({ start: node.start, end: node.end, text: 'null' });
        report.revokedPluginPendingCodes++;
      } else report.preservedPendingCodes++;
    }
    const connectionArray = accountNode.fields.get('connections'), retained = [];
    for (const node of connectionArray.elements) {
      const item = node.value;
      if (!exact(item, ['id', 'label', 'createdAt', 'expiresAt', 'scopes', 'tokenHash']) || typeof item.id !== 'string' || !UUID.test(item.id) || connectionIds.has(item.id)
        || typeof item.label !== 'string' || item.label.length < 1 || item.label.length > 64 || item.label !== item.label.trim() || /[\x00-\x1f\x7f]/.test(item.label)
        || !duration(item, 90 * 24 * 60 * 60 * 1000) || typeof item.tokenHash !== 'string' || !DIGEST.test(item.tokenHash) || tokenHashes.has(item.tokenHash)
        || ![FIVE, SEVEN, TEN].some(expected => scopesMatch(item.scopes, expected))) fail('invalid_studio_links');
      connectionIds.add(item.id);
      tokenHashes.add(item.tokenHash);
      if (scopesMatch(item.scopes, TEN)) report.revokedPluginConnections++;
      else { retained.push(node); report.preservedConnections++; }
    }
    if (retained.length !== connectionArray.elements.length) edits.push({ start: connectionArray.start, end: connectionArray.end,
      text: `[${retained.map(node => raw.slice(node.start, node.end)).join(',')}]` });
  }
  let next = raw;
  for (const edit of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  const output = Buffer.from(next, 'utf8');
  report.resultSha256 = sha(output);
  return { report, output, changed: edits.length > 0 };
}

async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function checkCreatedPrivate(file) {
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || !isOwned(stat) || (stat.mode & 0o777) !== 0o600) fail('unsafe_private_file');
}
async function run(config) {
  const dataDir = await privateDirectory(config.dataDir), registryPath = join(dataDir, 'studio-links.json');
  let bytes;
  try { bytes = await readPrivateFile(registryPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { registryFiles: 0, accounts: 0, preservedConnections: 0, revokedPluginConnections: 0,
      preservedPendingCodes: 0, revokedPluginPendingCodes: 0, changedFiles: 0, sourceSha256: null, resultSha256: null };
  }
  const { report, output, changed } = plan(bytes);
  // No writes, backup checks or expected-hash failures for an already clean
  // registry: repeating the exact completed command is an idempotent no-op.
  if (!config.apply || !changed) return report;
  if (report.sourceSha256 !== config.expected) fail('registry_changed');
  async function current() {
    await privateDirectory(dataDir);
    let observed;
    try { observed = await readPrivateFile(registryPath); }
    catch (error) { if (error.code === 'ENOENT') fail('registry_changed'); throw error; }
    if (sha(observed) !== config.expected || !observed.equals(bytes)) fail('registry_changed');
  }
  const backupPath = await unlinkedPath(config.backup);
  const backupDir = await privateDirectory(dirname(backupPath));
  await current();
  let backup;
  try {
    backup = await open(backupPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await checkCreatedPrivate(backup);
    await backup.writeFile(bytes);
    await backup.sync();
  } finally { if (backup) await backup.close(); }
  await privateDirectory(backupDir);
  const backupBytes = await readPrivateFile(backupPath);
  if (!backupBytes.equals(bytes)) fail('backup_verification_failed');
  await syncDirectory(backupDir);
  await current();
  const tempPath = join(dataDir, `.studio-links-rollback-${randomBytes(16).toString('hex')}.tmp`);
  let temp, created = false, committed = false;
  try {
    temp = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await checkCreatedPrivate(temp);
    await temp.writeFile(output);
    await temp.sync();
    await temp.close();
    temp = null;
    await current();
    // Validate the temporary file's ownership/mode/link count once more before
    // rename; the stopped-server acknowledgement is required for this offline tool.
    if (!(await readPrivateFile(tempPath)).equals(output)) fail('temporary_file_changed');
    await privateDirectory(backupDir);
    if (!(await readPrivateFile(backupPath)).equals(bytes)) fail('backup_verification_failed');
    await current();
    await rename(tempPath, registryPath);
    committed = true;
    await syncDirectory(dataDir);
  } finally {
    if (temp) await temp.close();
    if (created && !committed) await rm(tempPath, { force: true });
  }
  return { ...report, changedFiles: 1, backupSha256: sha(backupBytes) };
}

try {
  const report = await run(options(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  // Never return exception bodies, paths or any registry field to the terminal.
  const known = new Set(['linked_private_path', 'unsafe_private_file']);
  const code = error.rollbackCode ?? (known.has(error.message) ? error.message : error.code === 'EEXIST' ? 'backup_exists' : 'rollback_failed');
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
