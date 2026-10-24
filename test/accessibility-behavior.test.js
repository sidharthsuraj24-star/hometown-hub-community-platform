'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const app = { inert: false, querySelectorAll() { return []; } };
  let modal = null;
  const document = {
    activeElement: null,
    body: { append(node) { modal = node; } },
    querySelector(selector) { return selector === '#app' ? app : selector === '#modal-root' ? modal : null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() {
      return {
        innerHTML: '', listeners: {},
        addEventListener(name, fn) { this.listeners[name] = fn; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        remove() { modal = null; }
      };
    }
  };
  const sandbox = { document, window: { addEventListener() {} }, URL,
    location: { origin: 'http://localhost', href: 'http://localhost/' },
    fetch: async () => { throw new Error('Synthetic network failure'); } };
  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('(async function boot()')), context);
  vm.runInContext('globalThis.api = { associateFormLabels, enhancePageSemantics, focusMainContent, showModal, closeModal, request, adminAnalyticsContent, state };', context);
  return { api: context.api, document, app, context };
}
function field(label, control) {
  return { querySelector(selector) { return selector === 'label' ? label : control; } };
}

test('label association is unique, idempotent, and preserves explicit and wrapping labels', () => {
  const { api } = fixture();
  const labels = [{}, {}, {}, {}, { htmlFor: 'explicit' }, { contains: () => true }];
  const controls = [{}, {}, { id: 'existing-control' }, {}, { id: 'explicit' }, {}];
  const fields = labels.map((label, index) => field(label, controls[index]));
  const root = { querySelectorAll() { return [...fields, field(null, {})]; } };
  api.associateFormLabels(root);
  assert.equal(labels[0].htmlFor, controls[0].id);
  assert.equal(labels[1].htmlFor, controls[1].id);
  assert.notEqual(controls[0].id, controls[1].id);
  assert.equal(labels[2].htmlFor, 'existing-control');
  assert.equal(labels[4].htmlFor, 'explicit');
  assert.equal(labels[5].htmlFor, undefined);
  const before = controls.map(control => control.id);
  api.associateFormLabels(root);
  assert.deepEqual(controls.map(control => control.id), before);
});

test('all rendered navigation variants receive and clear current-page semantics', () => {
  const { api, app } = fixture();
  function button(page) {
    return { dataset: { page }, attributes: { 'aria-current': 'page' },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; } };
  }
  const buttons = [button('events'), button('feed'), button('events'), button('events')];
  app.querySelectorAll = selector => selector === 'nav [data-page]' ? buttons : [];
  api.state.page = 'events';
  api.enhancePageSemantics();
  assert.deepEqual(buttons.map(button => button.attributes['aria-current']), ['page', undefined, 'page', 'page']);
});

test('modal isolates the app and restores prior focus when closed', () => {
  const { api, document, app } = fixture();
  const opener = { closest() { return null; }, focus() { document.activeElement = this; } };
  document.activeElement = opener;
  api.showModal('Synthetic dialog', '', '<button>Close</button>');
  assert.equal(app.inert, true);
  document.activeElement = null;
  api.closeModal();
  assert.equal(app.inert, false);
  assert.equal(document.activeElement, opener);
});

test('navigation focus targets the new heading with a main fallback', () => {
  const { api, document } = fixture();
  const target = { setAttribute(name, value) { this[name] = value; }, focus() { document.activeElement = this; } };
  document.querySelector = selector => selector === '.main-column h1' ? target : null;
  api.focusMainContent();
  assert.equal(target.tabindex, '-1');
  assert.equal(document.activeElement, target);
  document.activeElement = null;
  document.querySelector = selector => selector === '#main' ? target : null;
  api.focusMainContent();
  assert.equal(document.activeElement, target);
});

test('chart has a complete escaped tabular alternative outside the image role', () => {
  const { api } = fixture();
  const html = api.adminAnalyticsContent({ dau: 4, daily_active_trend: [
    { day: '2026-10-18', active_users: 2 }, { day: '2026-10-19', active_users: 4 }
  ] });
  assert.match(html, /role="img"/);
  assert.match(html, /<\/div><details class="analytics-data">/);
  assert.match(html, /<caption>Daily active members \(UTC\)<\/caption>/);
  assert.match(html, /<th scope="row">2026-10-18<\/th><td>2<\/td>/);
  assert.match(html, /<th scope="row">2026-10-19<\/th><td>4<\/td>/);
  assert.match(api.adminAnalyticsContent({}), /<td colspan="2">No activity has been recorded yet\./);
});

test('request failures and invalid success payloads fail clearly and the next request recovers', async () => {
  const { api, context } = fixture();
  await assert.rejects(api.request('/api/meta'), /Synthetic network failure/);
  for (const value of [null, [], 'not-an-object']) {
    context.fetch = async () => ({ ok: true, status: 200, json: async () => value });
    await assert.rejects(api.request('/api/meta'), /invalid response/);
  }
  context.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('SYNTHETIC_PRIVATE_PARSE_DETAIL'); } });
  await assert.rejects(api.request('/api/meta'), /^Error: The server returned an invalid response\. Please try again\.$/);
  context.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('SYNTHETIC_PRIVATE_PARSE_DETAIL'); } });
  await assert.rejects(api.request('/api/meta'), /^Error: Request failed \(502\)$/);
  context.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'Synthetic access denied' }) });
  await assert.rejects(api.request('/api/meta'), /Synthetic access denied/);
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ categories: ['General'] }) });
  assert.deepEqual(await api.request('/api/meta'), { categories: ['General'] });
});
