'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor(document, tag = 'div') {
    this.document = document;
    this.tagName = tag.toUpperCase();
    this.listeners = {};
    this.focusables = [];
    this.innerHTML = '';
    this.removed = false;
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelector(selector) {
    if (selector.includes('input') || selector.includes('textarea') || selector.includes('select') || selector.includes('button')) return this.focusables[0] || null;
    return null;
  }
  querySelectorAll() { return this.focusables; }
  append() {}
  remove() { this.removed = true; if (this.document.modal === this) this.document.modal = null; }
  focus() { this.document.activeElement = this; }
  closest() { return null; }
}

function ui() {
  const document = {
    activeElement: null,
    modal: null,
    listeners: {},
    body: {
      append(node) { document.modal = node; },
    },
    querySelector(selector) {
      if (selector === '#app') return new FakeElement(document, 'main');
      if (selector === '#modal-root') return document.modal;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    createElement(tag) { return new FakeElement(document, tag); },
  };
  const context = vm.createContext({ document, window: { addEventListener() {} }, URL, location: { origin: 'http://localhost', href: 'http://localhost/' }, FormData: class {} });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('(async function boot()')), context);
  vm.runInContext('globalThis.api = { state, showModal, closeModal, navButton };', context);
  return { context, document, api: context.api };
}

test('modal describes subtitles, traps Tab, closes on Escape, and restores invoking focus', () => {
  const { document, api } = ui();
  const opener = new FakeElement(document, 'button');
  opener.focus();
  api.showModal('Synthetic dialog', 'A synthetic subtitle', '<button>First</button><button>Last</button>');
  const modal = document.modal;
  assert.match(modal.innerHTML, /role="dialog"[^>]*aria-describedby="modal-subtitle"/);
  assert.match(modal.innerHTML, /id="modal-subtitle">A synthetic subtitle/);
  const first = new FakeElement(document, 'button');
  const last = new FakeElement(document, 'button');
  modal.focusables = [first, last];
  last.focus();
  const forward = { key: 'Tab', shiftKey: false, preventDefault() { this.prevented = true; } };
  modal.listeners.keydown(forward);
  assert.equal(forward.prevented, true);
  assert.equal(document.activeElement, first);
  first.focus();
  const backward = { key: 'Tab', shiftKey: true, preventDefault() { this.prevented = true; } };
  modal.listeners.keydown(backward);
  assert.equal(backward.prevented, true);
  assert.equal(document.activeElement, last);
  const escape = { key: 'Escape', preventDefault() { this.prevented = true; } };
  modal.listeners.keydown(escape);
  assert.equal(escape.prevented, true);
  assert.equal(document.modal, null);
  assert.equal(document.activeElement, opener);
});

test('active primary navigation and profile icon expose accessible names', () => {
  const { api } = ui();
  api.state.page = 'events';
  const nav = api.navButton('events', 'Events', 'calendar');
  assert.match(nav, /class="nav-button active"/);
  assert.match(nav, /aria-current="page"/);
  api.state.user = { role: 'user', name: 'Synthetic User' };
  api.state.notifications = [];
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(source, /data-action="open-profile" title="Edit profile" aria-label="Edit profile"/);
});

test('CSS provides visible keyboard focus and a 44px dialog close target', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.close-button[^}]*width:44px[^}]*height:44px/);
  assert.match(css.trim(), /:focus-visible\{outline:3px solid #245b86;outline-offset:2px\}$/);
  const luminance = hex => {
    const rgb = hex.match(/../g).map(component => parseInt(component, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const ring = luminance('245b86');
  for (const background of ['ffffff', 'fffefa', 'f7f6f1', 'e8f0f8']) {
    assert.ok((luminance(background) + 0.05) / (ring + 0.05) >= 3, background);
  }
});
