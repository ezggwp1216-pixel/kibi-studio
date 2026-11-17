import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const loaded = await import('../src/plugins/manifest.mjs').catch(() => ({}));
const validate = (...args) => { assert.equal(typeof loaded.validateExecutablePackage, 'function', 'executable validator is implemented'); return loaded.validateExecutablePackage(...args); };
const fixture = (patch = {}) => ({ format: 'kibi-plugin', manifestVersion: 2, sdkVersion: '1.1', id: 'test.video', version: '1.0.0', name: 'Video', description: '', capabilities: ['request-handler'], permissions: ['media:youtube-frame'], settings: [{ key: 'videoId', label: 'Video', type: 'text', required: true }], secrets: [], server: { language: 'javascript', source: 'export async function onDeviceRequest() { return {}; }' }, ...patch });
const check = value => { const text = JSON.stringify(value); return validate(text, createHash('sha256').update(text).digest('hex')); };

test('validates and deeply freezes a v2 executable without evaluating its source', () => {
  const source = 'throw new Error("MUST NEVER RUN IN API")';
  const result = check(fixture({ server: { language: 'javascript', source } }));
  assert.equal(result.manifest.server.source, source);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(result.manifest.server), true);
  assert.equal(Object.isFrozen(result.manifest.settings[0]), true);
  assert.throws(() => { result.manifest.id = 'changed'; }, TypeError);
});

test('requires the exact package SHA and bounded UTF-8 JSON', () => {
  const text = JSON.stringify(fixture());
  assert.throws(() => validate(text, '0'.repeat(64)), { code: 'plugin_sha_mismatch', status: 400 });
  for (const input of [null, '[]', '{', 'x'.repeat(128 * 1024 + 1)]) assert.throws(() => validate(input, 'a'.repeat(64)), { code: 'plugin_invalid_package' });
});

test('rejects unrecognized execution capabilities, permissions, secrets and source formats', () => {
  const invalid = [
    { manifestVersion: 1, sdkVersion: '1.0' }, { sdkVersion: '2.0' }, { capabilities: [] },
    { capabilities: ['request-handler', 'request-handler'] }, { permissions: ['network:*'] },
    { secrets: [{ key: 'token', label: 'Token', required: true }] }, { server: null },
    { server: { language: 'python', source: 'pass' } }, { extra: 'unrecognized' },
    { server: { language: 'javascript', source: 'я'.repeat(32769) } },
    { id: '../escape' }, { version: '1.0' },
  ];
  for (const patch of invalid) assert.throws(() => check(fixture(patch)), { code: 'plugin_invalid_package' });
});

test('enforces bounded, unique scalar setting declarations', () => {
  const invalid = [
    [{ key: '__proto__', label: 'Bad', type: 'text' }],
    [{ key: 'constructor', label: 'Bad', type: 'text' }],
    [{ key: 'x', label: 'X', type: 'number', default: '1' }],
    [{ key: 'x', label: 'X', type: 'text', default: 'x'.repeat(2001) }],
    [{ key: 'x', label: 'X', type: 'boolean', required: 'yes' }],
    [{ key: 'x', label: 'X', type: 'text' }, { key: 'x', label: 'X', type: 'text' }],
    Array.from({ length: 17 }, (_, n) => ({ key: `a${n}`, label: 'X', type: 'text' })),
  ];
  for (const settings of invalid) assert.throws(() => check(fixture({ settings })), { code: 'plugin_invalid_package' });
});
