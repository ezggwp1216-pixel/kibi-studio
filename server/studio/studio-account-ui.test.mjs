import test from 'node:test';
import assert from 'node:assert/strict';
import { initStudioAccountUI } from './studio-account.js';

// A tiny document adapter keeps the real browser module and asynchronous API flow.
class Element {
  constructor(tag = 'div', attributes = {}) { this.tagName = tag.toUpperCase(); this.attributes = attributes; this.id = attributes.id || ''; this.children = []; this.listeners = {}; this.dataset = {}; this._value = attributes.value || ''; this._text = ''; this.hidden = 'hidden' in attributes; this.open = false; this.isConnected = true;
    for (const [key, value] of Object.entries(attributes)) if (key.startsWith('data-')) this.dataset[key.slice(5)] = value;
    this.classList = { toggle() {} }; }
  get elements() { return { namedItem: name => this.querySelector(`[name="${name}"]`) }; }
  set innerHTML(html) { this.children = []; const stack = [this]; for (const match of html.matchAll(/<(\/)?([a-z][\w-]*)([^>]*)>/gi)) { const [, close, tag, rest] = match; if (close) { while (stack.length > 1) if (stack.pop().tagName === tag.toUpperCase()) break; continue; } const attrs = {}; for (const attr of rest.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = attr[2] ?? ''; const node = new Element(tag, attrs); stack.at(-1).append(node); if (!['input','br','hr'].includes(tag)) stack.push(node); } }
  get value() { return this.tagName === 'SELECT' ? (this.children.some(child => child.value === this._value) ? this._value : this.children[0]?.value || '') : this._value; }
  set value(value) { this._value = value; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); }
  removeEventListener(name, callback) { this.listeners[name] = this.listeners[name]?.filter(value => value !== callback); }
  async fire(name) { for (const callback of this.listeners[name] || []) await callback({ preventDefault() {}, target: this, currentTarget: this }); }
  matches(selector) { const attr = /^\[([^=]+)="([^"]*)"\]$/.exec(selector); return attr ? this.attributes[attr[1]] === attr[2] : this.tagName === selector.toUpperCase(); }
  querySelectorAll(selector) { const result = []; const visit = node => { for (const child of node.children) { if (selector.split(',').some(value => child.matches(value.trim()))) result.push(child); visit(child); } }; visit(this); return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.fire('close'); }
  focus() {}
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deviceA = '11111111-1111-4111-8111-111111111111', deviceB = '22222222-2222-4222-8222-222222222222';
const empty = () => ({ schemaVersion: '1.0', source: 'server', retentionSeconds: 3600, observed: false, updatedAt: null, connection: null, metrics: null, events: [] });
const seen = () => ({ ...empty(), observed: true, updatedAt: '2026-11-10T00:00:00.000Z', connection: { state: 'ready', code: 'ready', active: true }, metrics: { inputPackets: 7 }, events: [{ at: '2026-11-10T00:00:00.000Z', state: 'ready', code: 'ready' }] });
async function fixture(t) {
  const document = new Element('document'); document.body = new Element('body'); document.createElement = tag => new Element(tag); document.append(document.body);
  const previous = globalThis.document; globalThis.document = document;
  t.after(() => { globalThis.document = previous; });
  let info = { connected: true, verified: true, account: { id: 'account-a', email: 'a@example.test' }, connection: { id: 'connection-a' } }, handler;
  const calls = [];
  const ui = initStudioAccountUI({ mount: document.body, api: async (path, options) => { calls.push({ path, options }); if (handler) { const result = handler(path, options); if (result !== undefined) return result; } if (path === '/api/account') return structuredClone(info); if (path === '/api/account/devices') return { devices: [{ id: deviceA, name: 'А', status: 'online' }, { id: deviceB, name: 'Б', status: 'not_seen' }] }; if (path === '/api/account/disconnect') return { connected: false }; throw Error('unexpected local request'); } });
  t.after(() => ui.destroy()); await ui.ready;
  return { ui, calls, part: name => ui.dialog.querySelector(`[data-part="${name}"]`), action: name => ui.dialog.querySelector(`[data-action="${name}"]`), select: () => ui.dialog.querySelector('[data-form="diagnostics"]').elements.namedItem('deviceId'), handle: fn => { handler = fn; }, account: next => { info = next; } };
}

test('account dialog diagnostics is manual, available without voice permission, and renders unknown measurements truthfully', async t => {
  const f = await fixture(t);
  assert.ok(f.action('diagnostics-refresh'));
  assert.equal(f.calls.some(call => call.path.includes('voice-diagnostics')), false);
  assert.equal(f.ui.dialog.querySelector('[data-form="diagnostics"]').hidden, false);
  f.handle(path => path.includes('/voice-diagnostics') ? empty() : undefined);
  await f.action('diagnostics-refresh').fire('click'); await flush();
  assert.match(f.part('diagnostics-status').textContent, /наблюдений|наблюдал/i);
  assert.equal(f.part('diagnostics-metrics').textContent, '');
  f.handle(path => path.includes('/voice-diagnostics') ? seen() : undefined);
  await f.action('diagnostics-refresh').fire('click'); await flush();
  assert.match(f.part('diagnostics-status').textContent, /ready/);
  assert.match(f.part('diagnostics-metrics').textContent, /7/);
  assert.match(f.part('diagnostics-metrics').textContent, /не измерено/);
  assert.equal(f.calls.filter(call => call.path.includes('voice-diagnostics')).length, 2);
  assert.ok(f.calls.every(call => !call.path.includes('/voice/activate') && !call.path.includes('provider')));
});

test('late diagnostics cannot repopulate another device, account, disconnected or destroyed dialog', async t => {
  for (const change of ['selection', 'account', 'disconnect', 'destroy', 'close']) {
    const f = await fixture(t); let resolve;
    assert.ok(f.action('diagnostics-refresh'));
    f.handle(path => path.includes('/voice-diagnostics') ? new Promise(done => { resolve = done; }) : undefined);
    await f.action('diagnostics-refresh').fire('click'); await flush();
    assert.match(f.part('diagnostics-status').textContent, /загруж|чита/i);
    if (change === 'selection') { f.select().value = deviceB; await f.select().fire('change'); }
    else if (change === 'account') { f.account({ connected: true, verified: true, account: { id: 'account-b', email: 'b@example.test' }, connection: { id: 'connection-b' } }); await f.ui.refresh(); }
    else if (change === 'disconnect') { await f.action('disconnect').fire('click'); await flush(); }
    else if (change === 'destroy') f.ui.destroy();
    else { f.ui.dialog.showModal(); f.ui.dialog.close(); }
    resolve(seen()); await flush();
    assert.doesNotMatch(f.part('diagnostics-status').textContent, /ready/);
    assert.doesNotMatch(f.part('diagnostics-metrics').textContent, /7/);
  }
});

test('diagnostics fixed error never displays server text and revoked account removes device data', async t => {
  const f = await fixture(t); assert.ok(f.action('diagnostics-refresh'));
  f.handle(path => path.includes('/voice-diagnostics') ? Promise.reject(Object.assign(Error('PRIVATE PROVIDER TEXT'), { code: 'account_revoked' })) : undefined);
  await f.action('diagnostics-refresh').fire('click'); await flush();
  assert.doesNotMatch(f.ui.dialog.textContent, /PRIVATE PROVIDER TEXT/);
  assert.equal(f.part('connected').hidden, true);
  assert.match(f.part('feedback').textContent, /отозвано/);
  assert.equal(f.select().children.length, 0);
});

test('closing and reopening immediately enables refresh while the abandoned diagnostic request remains pending', async t => {
  const f = await fixture(t); let resolve;
  await f.ui.button.fire('click');
  f.handle(path => path.includes('/voice-diagnostics') ? new Promise(done => { resolve = done; }) : undefined);
  await f.action('diagnostics-refresh').fire('click'); await flush();
  assert.equal(f.action('diagnostics-refresh').disabled, true);
  await f.action('close').fire('click');
  await f.ui.button.fire('click');
  assert.equal(f.ui.dialog.open, true);
  assert.equal(f.action('diagnostics-refresh').disabled, false);
  assert.equal(f.ui.dialog.attributes['aria-busy'], 'false');
  f.handle(path => path.includes('/voice-diagnostics') ? empty() : undefined);
  await f.action('diagnostics-refresh').fire('click'); await flush();
  assert.match(f.part('diagnostics-status').textContent, /наблюдений|наблюдал/i);
  resolve(seen()); await flush();
  assert.doesNotMatch(f.part('diagnostics-status').textContent, /ready/);
  assert.equal(f.action('diagnostics-refresh').disabled, false);
});
