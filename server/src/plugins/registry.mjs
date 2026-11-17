import { mkdir, lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkedPath, readPrivateFile, isOwned } from '../private-files.mjs';
import { validateExecutablePackage } from './manifest.mjs';

const fail = (status, code) => Object.assign(new Error(code), { status, code });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validDeviceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const clone = value => structuredClone(value);
const validTime = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const metadata = entry => { const { id, version, name, description, manifestVersion, sdkVersion, capabilities, permissions, settings } = entry.manifest;
  return clone({ id, version, name, description, manifestVersion, sdkVersion, capabilities, permissions, settings, sha256: entry.sha256, createdAt: entry.createdAt }); };

function settingsFor(manifest, settings) {
  if (!record(settings) || Object.keys(settings).length > 16 || Object.keys(settings).some(key => !manifest.settings.some(field => field.key === key))) throw fail(400, 'plugin_invalid_settings');
  const result = {};
  for (const field of manifest.settings) {
    const present = Object.hasOwn(settings, field.key), hasDefault = Object.hasOwn(field, 'default');
    if (!present && !hasDefault) { if (field.required) throw fail(400, 'plugin_invalid_settings'); continue; }
    const value = present ? settings[field.key] : field.default;
    const valid = field.type === 'text' ? typeof value === 'string' && value.length <= 2000
      : field.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'number' && Number.isFinite(value);
    if (!valid) throw fail(400, 'plugin_invalid_settings');
    result[field.key] = value;
  }
  return result;
}

/** One registry per trusted tenant directory; deviceExists is a trusted synchronous ownership predicate. */
export async function openPluginRegistry(dataDir, { deviceExists, now = Date.now } = {}) {
  if (typeof deviceExists !== 'function' || typeof now !== 'function') throw fail(500, 'plugin_invalid_registry_options');
  dataDir = await unlinkedPath(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'plugin-registry.json');
  async function checkDirectory() {
    const stat = await lstat(await unlinkedPath(dataDir));
    if (!stat.isDirectory() || !isOwned(stat) || (stat.mode & 0o777) !== 0o700) throw fail(500, 'plugin_unsafe_registry_directory');
  }
  await checkDirectory();
  let persisted = null, packages = [], devices = [], closed = false, pending = 0, queue = Promise.resolve();
  const leases = new Map();
  const ensureOpen = () => { if (closed) throw fail(503, 'plugin_registry_closed'); };
  const keyFor = (deviceId, pluginId) => `${deviceId}\0${pluginId}`;
  function cancel(deviceId, pluginId) { const key = keyFor(deviceId, pluginId); const controller = leases.get(key); if (controller) { controller.abort(); leases.delete(key); } }
  function requireDevice(deviceId) {
    ensureOpen();
    let exists = false; try { exists = validDeviceId(deviceId) && deviceExists(deviceId) === true; } catch {}
    if (!exists) { for (const key of leases.keys()) if (key.startsWith(`${deviceId}\0`)) { leases.get(key).abort(); leases.delete(key); } throw fail(404, 'device_not_found'); }
  }
  const findPackage = (id, version, entries = packages) => { const entry = entries.find(item => item.manifest.id === id && item.manifest.version === version); if (!entry) throw fail(404, 'plugin_not_found'); return entry; };
  const findBinding = (deviceId, pluginId) => devices.find(device => device.deviceId === deviceId)?.bindings.find(item => item.current.pluginId === pluginId);
  const time = () => { const value = now(); if (!Number.isSafeInteger(value) || !Number.isFinite(value) || Math.abs(value) > 8640000000000000) throw fail(500, 'plugin_invalid_clock'); return new Date(value).toISOString(); };
  function validateBinding(value, entries) {
    if (!exact(value, ['pluginId', 'version', 'revision', 'enabled', 'settings', 'updatedAt']) || !validRevision(value.revision) || value.revision < 1 || typeof value.enabled !== 'boolean' || !validTime(value.updatedAt)) throw new Error('invalid_binding');
    const normalized = settingsFor(findPackage(value.pluginId, value.version, entries).manifest, value.settings);
    if (JSON.stringify(normalized) !== JSON.stringify(value.settings)) throw new Error('invalid_binding_settings');
  }
  try {
    const raw = await readPrivateFile(path);
    if (raw.byteLength > 8 * 1024 * 1024) throw new Error('too_large');
    persisted = raw.toString('utf8');
    const state = JSON.parse(persisted);
    if (!exact(state, ['version', 'packages', 'devices']) || state.version !== 1 || !Array.isArray(state.packages) || state.packages.length > 32 || !Array.isArray(state.devices) || state.devices.length > 256) throw new Error('invalid_state');
    const ids = new Map();
    packages = state.packages.map(entry => {
      if (!exact(entry, ['packageText', 'sha256', 'createdAt']) || !validTime(entry.createdAt)) throw new Error('invalid_package');
      const verified = validateExecutablePackage(entry.packageText, entry.sha256);
      const versions = ids.get(verified.manifest.id) ?? new Set();
      if (versions.has(verified.manifest.version) || versions.size >= 8) throw new Error('duplicate_package');
      versions.add(verified.manifest.version); ids.set(verified.manifest.id, versions);
      return { ...entry, manifest: verified.manifest };
    });
    const seenDevices = new Set();
    for (const device of state.devices) {
      if (!exact(device, ['deviceId', 'bindings']) || !validDeviceId(device.deviceId) || seenDevices.has(device.deviceId) || !Array.isArray(device.bindings) || device.bindings.length > 16) throw new Error('invalid_device');
      seenDevices.add(device.deviceId); const seenPlugins = new Set();
      for (const binding of device.bindings) {
        if (!exact(binding, ['current', 'history']) || !Array.isArray(binding.history) || binding.history.length > 16) throw new Error('invalid_history');
        validateBinding(binding.current, packages);
        if (seenPlugins.has(binding.current.pluginId)) throw new Error('duplicate_binding');
        seenPlugins.add(binding.current.pluginId); let previous = 0;
        for (const item of binding.history) { validateBinding(item, packages); if (item.pluginId !== binding.current.pluginId || item.revision <= previous || item.revision >= binding.current.revision) throw new Error('invalid_revision'); previous = item.revision; }
      }
    }
    devices = state.devices;
  } catch (error) { if (error.code !== 'ENOENT') { if (error.message === 'linked_private_path' || error.message === 'unsafe_private_file') throw error; throw fail(500, 'plugin_invalid_registry'); } }

  async function checkPersisted() {
    await checkDirectory();
    try { const current = (await readPrivateFile(path)).toString('utf8'); if (current !== persisted) throw fail(500, 'plugin_registry_changed'); }
    catch (error) { if (error.code !== 'ENOENT' || persisted !== null) throw error; }
  }
  async function save(nextPackages, nextDevices, assertAuthorized = () => {}) {
    await checkPersisted();
    const serialized = JSON.stringify({ version: 1, packages: nextPackages.map(({ packageText, sha256, createdAt }) => ({ packageText, sha256, createdAt })), devices: nextDevices });
    if (Buffer.byteLength(serialized, 'utf8') > 8 * 1024 * 1024) throw fail(409, 'plugin_limit');
    const temp = join(dataDir, `.plugin-registry-${randomBytes(16).toString('hex')}.tmp`);
    let file, committed = false;
    try {
      file = await open(temp, 'wx', 0o600); await file.writeFile(serialized, 'utf8'); await file.sync(); await file.close(); file = null;
      await checkPersisted(); ensureOpen(); assertAuthorized();
      await rename(temp, path); committed = true; persisted = serialized; packages = nextPackages; devices = nextDevices;
    } finally { if (file) await file.close(); if (!committed) await rm(temp, { force: true }); }
  }
  function enqueue(operation) {
    if (closed) return Promise.reject(fail(503, 'plugin_registry_closed'));
    if (pending >= 64) return Promise.reject(fail(503, 'plugin_registry_busy'));
    pending++;
    const result = queue.then(() => { ensureOpen(); return operation(); }).finally(() => { pending--; }); queue = result.catch(() => {}); return result;
  }
  async function update(deviceId, input, rollback) {
    requireDevice(deviceId);
    if (!record(input) || typeof input.pluginId !== 'string' || !validRevision(input.expectedRevision)) throw fail(400, 'plugin_invalid_binding');
    const existing = findBinding(deviceId, input.pluginId);
    if (input.expectedRevision !== (existing?.current.revision ?? 0)) throw fail(409, 'plugin_revision_conflict');
    if (existing?.current.revision >= Number.MAX_SAFE_INTEGER) throw fail(409, 'plugin_revision_conflict');
    let selected;
    if (rollback) {
      if (!validRevision(input.toRevision) || !existing) throw fail(404, 'binding_not_found');
      selected = existing.history.find(item => item.revision === input.toRevision);
      if (!selected) throw fail(404, 'plugin_revision_not_found');
    } else {
      if (typeof input.enabled !== 'boolean') throw fail(400, 'plugin_invalid_binding');
      selected = { version: input.version, enabled: input.enabled, settings: input.settings ?? {} };
    }
    const entry = findPackage(input.pluginId, selected.version);
    const settings = settingsFor(entry.manifest, selected.settings);
    const current = { pluginId: input.pluginId, version: selected.version, revision: (existing?.current.revision ?? 0) + 1, enabled: selected.enabled, settings, updatedAt: time() };
    const nextDevices = clone(devices);
    let device = nextDevices.find(item => item.deviceId === deviceId);
    if (!device) { if (nextDevices.length >= 256) throw fail(409, 'plugin_limit'); device = { deviceId, bindings: [] }; nextDevices.push(device); }
    const index = device.bindings.findIndex(item => item.current.pluginId === input.pluginId);
    if (index < 0 && device.bindings.length >= 16) throw fail(409, 'plugin_limit');
    const next = { current, history: existing ? [...clone(existing.history), clone(existing.current)].slice(-16) : [] };
    if (index < 0) device.bindings.push(next); else device.bindings[index] = next;
    await save(packages, nextDevices, () => requireDevice(deviceId));
    cancel(deviceId, input.pluginId);
    return clone(current);
  }
  return {
    publish(input) { return enqueue(async () => {
      if (!exact(input, ['packageText', 'sha256'])) throw fail(400, 'plugin_invalid_package');
      const verified = validateExecutablePackage(input.packageText, input.sha256);
      const existing = packages.find(item => item.manifest.id === verified.manifest.id && item.manifest.version === verified.manifest.version);
      if (existing) { if (existing.sha256 !== verified.sha256) throw fail(409, 'plugin_version_conflict'); return metadata(existing); }
      if (packages.length >= 32 || packages.filter(item => item.manifest.id === verified.manifest.id).length >= 8) throw fail(409, 'plugin_limit');
      const entry = { ...input, manifest: verified.manifest, createdAt: time() }; await save([...packages, entry], devices); return metadata(entry);
    }); },
    list() { ensureOpen(); return packages.map(metadata); },
    get(id, version) { ensureOpen(); const entry = findPackage(id, version); return Object.freeze({ manifest: entry.manifest, sha256: entry.sha256 }); },
    bindings(deviceId) { requireDevice(deviceId); return clone(devices.find(device => device.deviceId === deviceId)?.bindings.map(item => item.current) ?? []); },
    binding(deviceId, pluginId) { requireDevice(deviceId); const found = findBinding(deviceId, pluginId); if (!found) throw fail(404, 'binding_not_found'); return clone(found.current); },
    bind(deviceId, input) { const snapshot = clone(input); return enqueue(() => update(deviceId, snapshot, false)); },
    rollback(deviceId, input) { const snapshot = clone(input); return enqueue(() => update(deviceId, snapshot, true)); },
    lease(deviceId, pluginId) {
      requireDevice(deviceId); const found = findBinding(deviceId, pluginId); if (!found) throw fail(404, 'binding_not_found');
      if (!found.current.enabled) throw fail(409, 'plugin_disabled');
      const key = keyFor(deviceId, pluginId); let controller = leases.get(key);
      if (!controller) { controller = new AbortController(); leases.set(key, controller); }
      const revision = found.current.revision;
      const assertCurrent = () => {
        requireDevice(deviceId);
        if (controller.signal.aborted || findBinding(deviceId, pluginId)?.current.revision !== revision) { controller.abort(); throw fail(409, 'plugin_binding_changed'); }
        return true;
      };
      return { binding: clone(found.current), signal: controller.signal, assertCurrent,
        // Linearize a trusted effect commit with bind/disable/rollback. A change
        // acknowledges only after an already admitted commit has finished.
        commit(operation) {
          if (typeof operation !== 'function') return Promise.reject(fail(500, 'plugin_invalid_commit'));
          return enqueue(async () => { assertCurrent(); return operation(assertCurrent); });
        }
      };
    },
    async close() { if (!closed) { closed = true; for (const controller of leases.values()) controller.abort(); leases.clear(); } await queue; },
  };
}
