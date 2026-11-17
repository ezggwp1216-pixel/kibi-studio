import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, symlink, writeFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const loaded = await import('../src/plugins/registry.mjs').catch(() => ({}));
const open = (...args) => { assert.equal(typeof loaded.openPluginRegistry, 'function', 'plugin registry is implemented'); return loaded.openPluginRegistry(...args); };
const pack = (patch = {}) => { const packageText = JSON.stringify({ format: 'kibi-plugin', manifestVersion: 2, sdkVersion: '1.1', id: 'test.video', version: '1.0.0', name: 'Video', description: '', capabilities: ['request-handler'], permissions: ['media:youtube-frame'], settings: [{ key: 'videoId', label: 'Video', type: 'text', required: true }, { key: 'fit', label: 'Fit', type: 'text', default: 'contain' }], secrets: [], server: { language: 'javascript', source: 'throw new Error("DO NOT RUN")' }, ...patch }); return { packageText, sha256: createHash('sha256').update(packageText).digest('hex') }; };
async function setup(t) { const dir = await mkdtemp(join(tmpdir(), 'kibi-plugin-registry-')); t.after(() => rm(dir, { force: true, recursive: true })); const devices = new Set(['own']); const registry = await open(dir, { deviceExists: id => devices.has(id), now: () => 1700000000000 }); t.after(() => registry.close()); return { dir, devices, registry }; }
const config = (patch = {}) => ({ pluginId: 'test.video', version: '1.0.0', expectedRevision: 0, enabled: true, settings: { videoId: 'abcdefghijk' }, ...patch });

test('persists immutable packages, returns metadata without source, isolates tenant stores', async t => {
  const { dir, registry } = await setup(t);
  const published = await registry.publish(pack());
  assert.equal(published.id, 'test.video');
  assert.equal(JSON.stringify(registry.list()).includes('DO NOT RUN'), false);
  assert.equal(Object.hasOwn(published, 'server'), false);
  assert.equal(registry.get('test.video', '1.0.0').manifest.server.source, 'throw new Error("DO NOT RUN")');
  assert.deepEqual(await registry.publish(pack()), published);
  await assert.rejects(registry.publish(pack({ name: 'Changed' })), { code: 'plugin_version_conflict', status: 409 });
  await registry.close();
  const reopened = await open(dir, { deviceExists: () => true }); t.after(() => reopened.close());
  assert.deepEqual(reopened.list(), [published]);
  const otherDir = await mkdtemp(join(tmpdir(), 'kibi-plugin-other-')); t.after(() => rm(otherDir, { recursive: true, force: true }));
  const other = await open(otherDir, { deviceExists: () => true }); t.after(() => other.close());
  assert.equal(other.list().length, 0);
  assert.throws(() => other.get('test.video', '1.0.0'), { code: 'plugin_not_found' });
  assert.equal((await stat(join(dir, 'plugin-registry.json'))).mode & 0o777, 0o600);
});

test('serializes revision races, applies setting defaults and rolls back as a new revision', async t => {
  const { dir, registry } = await setup(t);
  await registry.publish(pack()); await registry.publish(pack({ version: '2.0.0' }));
  const first = await registry.bind('own', config());
  assert.equal(first.revision, 1); assert.equal(first.settings.fit, 'contain');
  const lease = registry.lease('own', 'test.video');
  const results = await Promise.allSettled([registry.bind('own', config({ version: '2.0.0', expectedRevision: 1 })), registry.bind('own', config({ expectedRevision: 1, enabled: false }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'plugin_revision_conflict');
  assert.equal(lease.signal.aborted, true); assert.throws(() => lease.assertCurrent(), { code: 'plugin_binding_changed' });
  const rollback = await registry.rollback('own', { pluginId: 'test.video', toRevision: 1, expectedRevision: 2 });
  assert.equal(rollback.revision, 3); assert.equal(rollback.version, '1.0.0');
  assert.equal(JSON.stringify(registry.bindings('own')).includes('DO NOT RUN'), false);
  await registry.close(); const again = await open(dir, { deviceExists: () => true }); t.after(() => again.close());
  assert.deepEqual(again.binding('own', 'test.video'), rollback);
});

test('foreign, deleted, disabled and closed bindings cannot retain invocation leases', async t => {
  const { registry, devices } = await setup(t); await registry.publish(pack());
  for (const operation of [() => registry.bindings('foreign'), () => registry.binding('foreign', 'test.video'), () => registry.lease('foreign', 'test.video')]) assert.throws(operation, { code: 'device_not_found' });
  await assert.rejects(registry.bind('foreign', config()), { code: 'device_not_found' });
  await registry.bind('own', config()); const lease = registry.lease('own', 'test.video');
  devices.delete('own'); assert.throws(() => lease.assertCurrent(), { code: 'device_not_found' }); assert.equal(lease.signal.aborted, true);
  devices.add('own'); await registry.bind('own', config({ expectedRevision: 1, enabled: false }));
  assert.throws(() => registry.lease('own', 'test.video'), { code: 'plugin_disabled' });
  await registry.bind('own', config({ expectedRevision: 2 })); const closingLease = registry.lease('own', 'test.video');
  await registry.close(); assert.equal(closingLease.signal.aborted, true);
  await assert.rejects(registry.publish(pack()), { code: 'plugin_registry_closed' });
});

test('rejects malformed settings and stale rollback requests without changing committed state', async t => {
  const { registry } = await setup(t); await registry.publish(pack());
  for (const settings of [{}, { videoId: 1 }, { videoId: 'x', injected: 'secret' }, JSON.parse('{"videoId":"x","__proto__":"bad"}')]) await assert.rejects(registry.bind('own', config({ settings })), { code: 'plugin_invalid_settings' });
  assert.equal(registry.bindings('own').length, 0);
  await registry.bind('own', config());
  await assert.rejects(registry.rollback('own', { pluginId: 'test.video', toRevision: 1, expectedRevision: 0 }), { code: 'plugin_revision_conflict' });
  assert.equal(registry.binding('own', 'test.video').revision, 1);
});

test('rejects symlinked paths, corrupt stored hashes and externally changed persistence', async t => {
  const { dir, registry } = await setup(t); await registry.publish(pack());
  const file = join(dir, 'plugin-registry.json'); const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('DO NOT RUN', 'MODIFIED!!'), { mode: 0o600 });
  await assert.rejects(registry.bind('own', config()), { code: 'plugin_registry_changed' });
  assert.equal(registry.bindings('own').length, 0); await registry.close();
  await assert.rejects(open(dir, { deviceExists: () => true }), { code: 'plugin_invalid_registry' });
  await writeFile(file, original); await chmod(file, 0o600); await rm(file);
  const outside = join(dir, 'outside.json'); await writeFile(outside, original, { mode: 0o600 }); await symlink(outside, file);
  await assert.rejects(open(dir, { deviceExists: () => true }));
  const linked = `${dir}-link`; await symlink(dir, linked); t.after(() => rm(linked, { force: true }));
  await assert.rejects(open(linked, { deviceExists: () => true }));
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
});

test('enforces package, version and per-device binding quotas', async t => {
  const { registry } = await setup(t);
  for (let i = 0; i < 8; i++) await registry.publish(pack({ version: `${i}.0.0` }));
  await assert.rejects(registry.publish(pack({ version: '8.0.0' })), { code: 'plugin_limit' });
  for (let i = 0; i < 24; i++) await registry.publish(pack({ id: `test.p${i}` }));
  await assert.rejects(registry.publish(pack({ id: 'test.excess' })), { code: 'plugin_limit' });
  for (let i = 0; i < 16; i++) await registry.bind('own', config({ pluginId: `test.p${i}` }));
  await assert.rejects(registry.bind('own', config({ pluginId: 'test.p16' })), { code: 'plugin_limit' });
});

test('keeps only the last sixteen rollback revisions and does not expose mutable internal state', async t => {
  const { registry } = await setup(t); await registry.publish(pack());
  for (let revision = 0; revision < 21; revision++) await registry.bind('own', config({ expectedRevision: revision, settings: { videoId: `video${revision}` } }));
  await assert.rejects(registry.rollback('own', { pluginId: 'test.video', expectedRevision: 21, toRevision: 1 }), { code: 'plugin_revision_not_found' });
  const rollback = await registry.rollback('own', { pluginId: 'test.video', expectedRevision: 21, toRevision: 5 });
  assert.equal(rollback.revision, 22); assert.equal(rollback.settings.videoId, 'video4');
  rollback.settings.videoId = 'mutated'; registry.list()[0].settings[0].key = 'mutated';
  assert.equal(registry.binding('own', 'test.video').settings.videoId, 'video4');
  assert.equal(registry.get('test.video', '1.0.0').manifest.settings[0].key, 'videoId');
});

test('rejects a state-budget overflow before writing an unreopenable registry', async t => {
  const { registry, dir } = await setup(t);
  const settings = Array.from({ length: 16 }, (_, i) => ({ key: `a${i}`, label: 'Text', type: 'text', default: '界'.repeat(2000) }));
  await registry.publish(pack({ settings })); await registry.close();
  const file = join(dir, 'plugin-registry.json'); const state = JSON.parse(await readFile(file, 'utf8'));
  const values = Object.fromEntries(settings.map(field => [field.key, field.default]));
  let persisted;
  for (let i = 0; i < 256; i++) {
    state.devices.push({ deviceId: `fixture${String(i).padStart(3, '0')}`, bindings: [{ current: { pluginId: 'test.video', version: '1.0.0', revision: 1, enabled: true, settings: values, updatedAt: '2023-11-14T22:13:20.000Z' }, history: [] }] });
    const next = JSON.stringify(state);
    if (Buffer.byteLength(next) > 8 * 1024 * 1024) { state.devices.pop(); break; }
    persisted = next;
  }
  await writeFile(file, persisted);
  const nearLimit = await open(dir, { deviceExists: () => true }); t.after(() => nearLimit.close());
  await assert.rejects(nearLimit.bind('own', config({ settings: {} })), { code: 'plugin_limit' });
  assert.equal(await readFile(file, 'utf8'), persisted); assert.deepEqual(nearLimit.bindings('own'), []);
});
