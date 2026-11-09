// Structural validation only. No import, eval, Function, vm, or plugin execution.
const MAX_PACKAGE_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const capabilities = new Set(['event-handler', 'message-handler']);
const permissions = new Set(['events:read', 'messages:read', 'messages:write', 'notifications:create']);
const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, min = 1) => typeof value === 'string' && value.length >= min && value.length <= max && (min === 0 || value.trim().length > 0);
const key = value => typeof value === 'string' && /^[a-z][A-Za-z0-9_]{0,47}$/.test(value) && !reservedKeys.has(value);

/** Validate a UTF-8 JSON package string. This never validates JavaScript safety. */
export function validatePlugin(input) {
  const errors = [];
  const fail = (path, code = 'invalid_value') => { if (errors.length < 32) errors.push({ path, code }); };
  const bad = () => ({ ok: false, errors });
  if (typeof input !== 'string') { fail('$', 'json_text_required'); return bad(); }
  if (encoder.encode(input).byteLength > MAX_PACKAGE_BYTES) { fail('$', 'package_too_large'); return bad(); }
  let manifest;
  try { manifest = JSON.parse(input); } catch { fail('$', 'invalid_json'); return bad(); }
  if (!record(manifest)) { fail('$', 'object_required'); return bad(); }
  const fields = (object, allowed, required, path) => {
    if (!record(object)) { fail(path, 'object_required'); return false; }
    if (Object.keys(object).some(name => !allowed.includes(name))) fail(path, 'unknown_field');
    for (const name of required) if (!Object.hasOwn(object, name)) fail(`${path}.${name}`, 'required');
    return true;
  };
  fields(manifest, ['format', 'manifestVersion', 'sdkVersion', 'id', 'version', 'name', 'description', 'capabilities', 'permissions', 'settings', 'secrets', 'server'],
    ['format', 'manifestVersion', 'sdkVersion', 'id', 'version', 'name', 'description', 'capabilities', 'permissions', 'settings', 'secrets'], '$');
  if (manifest.format !== 'kibi-plugin') fail('$.format');
  if (manifest.manifestVersion !== 1) fail('$.manifestVersion', 'unsupported_version');
  if (manifest.sdkVersion !== '1.0') fail('$.sdkVersion', 'unsupported_version');
  if (!text(manifest.id, 64) || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(manifest.id)) fail('$.id');
  if (!text(manifest.version, 64) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) fail('$.version');
  if (!text(manifest.name, 80)) fail('$.name');
  if (!text(manifest.description, 1000, 0)) fail('$.description');
  for (const [name, allowlist] of [['capabilities', capabilities], ['permissions', permissions]]) {
    const list = manifest[name];
    if (!Array.isArray(list) || list.length > allowlist.size || list.some(value => !allowlist.has(value))) fail(`$.${name}`);
    else if (new Set(list).size !== list.length) fail(`$.${name}`, 'duplicate_key');
  }
  const declared = new Set();
  for (const name of ['settings', 'secrets']) {
    const list = manifest[name];
    if (!Array.isArray(list) || list.length > 16) { fail(`$.${name}`); continue; }
    for (const [index, field] of list.entries()) {
      const path = `$.${name}[${index}]`;
      const isSecret = name === 'secrets';
      if (!fields(field, isSecret ? ['key', 'label', 'required'] : ['key', 'label', 'type', 'required', 'default'], isSecret ? ['key', 'label', 'required'] : ['key', 'label', 'type'], path)) continue;
      if (!key(field.key)) fail(`${path}.key`);
      else if (declared.has(field.key)) fail(`${path}.key`, 'duplicate_key');
      else declared.add(field.key);
      if (!text(field.label, 120)) fail(`${path}.label`);
      if (Object.hasOwn(field, 'required') && typeof field.required !== 'boolean') fail(`${path}.required`);
      if (isSecret) continue;
      if (!['text', 'boolean', 'number'].includes(field.type)) fail(`${path}.type`);
      if (Object.hasOwn(field, 'default')) {
        const valid = field.type === 'text' ? text(field.default, 2000, 0)
          : field.type === 'boolean' ? typeof field.default === 'boolean'
            : field.type === 'number' && typeof field.default === 'number' && Number.isFinite(field.default);
        if (!valid) fail(`${path}.default`);
      }
    }
  }
  if (Object.hasOwn(manifest, 'server')) {
    if (fields(manifest.server, ['language', 'source'], ['language', 'source'], '$.server')) {
      if (manifest.server.language !== 'javascript') fail('$.server.language');
      if (!text(manifest.server.source, MAX_SOURCE_BYTES) || encoder.encode(manifest.server.source).byteLength > MAX_SOURCE_BYTES) fail('$.server.source');
    }
  }
  return errors.length ? bad() : { ok: true, manifest, requiresRuntime: Object.hasOwn(manifest, 'server'), runtimeSupported: false };
}
