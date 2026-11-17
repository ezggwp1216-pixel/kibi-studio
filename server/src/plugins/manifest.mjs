import { createHash } from 'node:crypto';

const CAPABILITIES = new Set(['request-handler', 'event-handler', 'message-handler']);
const PERMISSIONS = new Set(['media:youtube-frame', 'notifications:create']);
const KEYS = ['format', 'manifestVersion', 'sdkVersion', 'id', 'version', 'name', 'description', 'capabilities', 'permissions', 'settings', 'secrets', 'server'];
const RESERVED = new Set(['constructor', 'prototype', '__proto__']);
const invalid = () => Object.assign(new Error('plugin_invalid_package'), { code: 'plugin_invalid_package', status: 400 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, allowed, required = allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const text = (value, max, min = 1) => typeof value === 'string' && value.length >= min && value.length <= max && (min === 0 || value.trim().length > 0);
const scalar = (value, type) => type === 'text' ? text(value, 2000, 0) : type === 'boolean' ? typeof value === 'boolean' : type === 'number' && typeof value === 'number' && Number.isFinite(value);
const list = (value, allowed, min = 0) => Array.isArray(value) && value.length >= min && value.length <= allowed.size && value.every(item => allowed.has(item)) && new Set(value).size === value.length;
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }

/** Structural validation and integrity only: uploaded source is never evaluated here. */
export function validateExecutablePackage(packageText, expectedSha256) {
  if (typeof packageText !== 'string' || Buffer.byteLength(packageText, 'utf8') > 128 * 1024) throw invalid();
  let manifest;
  try { manifest = JSON.parse(packageText); } catch { throw invalid(); }
  if (!exact(manifest, KEYS) || manifest.format !== 'kibi-plugin' || manifest.manifestVersion !== 2 || manifest.sdkVersion !== '1.1'
    || !text(manifest.id, 64) || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(manifest.id)
    || !text(manifest.version, 64) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)
    || !text(manifest.name, 80) || !text(manifest.description, 1000, 0)
    || !list(manifest.capabilities, CAPABILITIES, 1) || !list(manifest.permissions, PERMISSIONS)
    || !Array.isArray(manifest.settings) || manifest.settings.length > 16
    || !Array.isArray(manifest.secrets) || manifest.secrets.length !== 0
    || !exact(manifest.server, ['language', 'source']) || manifest.server.language !== 'javascript'
    || !text(manifest.server.source, 64 * 1024) || Buffer.byteLength(manifest.server.source, 'utf8') > 64 * 1024) throw invalid();
  const declared = new Set();
  for (const field of manifest.settings) {
    if (!exact(field, ['key', 'label', 'type', 'required', 'default'], ['key', 'label', 'type'])
      || typeof field.key !== 'string' || !/^[a-z][A-Za-z0-9_]{0,47}$/.test(field.key) || RESERVED.has(field.key) || declared.has(field.key)
      || !text(field.label, 120) || !['text', 'boolean', 'number'].includes(field.type)
      || (Object.hasOwn(field, 'required') && typeof field.required !== 'boolean')
      || (Object.hasOwn(field, 'default') && !scalar(field.default, field.type))) throw invalid();
    declared.add(field.key);
  }
  const sha256 = createHash('sha256').update(packageText, 'utf8').digest('hex');
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256) || sha256 !== expectedSha256) {
    throw Object.assign(new Error('plugin_sha_mismatch'), { code: 'plugin_sha_mismatch', status: 400 });
  }
  return Object.freeze({ manifest: freeze(manifest), sha256 });
}
