'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

/**
 * These are intentionally narrow static regressions for the accessibility review.
 * They guard the local low-risk markup enhancements alongside behavioral tests.
 */
test('generated controls have explicit label associations or accessible names', () => {
  assert.match(app, /function associateFormLabels\(/,
    'dynamic forms need a single helper that associates legacy labels with controls');
  assert.match(app, /associateFormLabels\([^)]*\)/,
    'the form-label association helper should be invoked after generated markup is inserted');
  assert.match(app, /name="body"[^>]*(?:aria-label|id)=|(?:aria-label|id)=[^>]*name="body"/,
    'comment/message controls should expose a programmatic name beyond placeholder text');
  assert.match(app, /name="name"[^>]*aria-label="New category name"/,
    'admin category input should have an accessible name');
  assert.match(app, /name="name"[^>]*aria-label="New tag"/,
    'admin tag input should have an accessible name');
});

test('application shell is not a broad live region and chart exposes data alternative', () => {
  assert.doesNotMatch(html, /<div id="app"[^>]*aria-live=/,
    'whole-page replacement should not be announced as one large live region');
  assert.match(app, /View daily activity data|<table[^>]*>[^]*daily_active_trend|aria-describedby="[^"]*chart/,
    'analytics chart should provide a navigable tabular/text alternative');
});

test('mobile and secondary navigation expose current page state', () => {
  assert.match(app, /function enhancePageSemantics\([\s\S]*nav \[data-page\][\s\S]*aria-current/,
    'mobile and sidebar navigation should identify their current page after enhancement');
});

// Header overflow was reproduced at a 768px embedded viewport with synthetic names.
test('tablet header navigation can shrink and scroll without hiding destinations', () => {
  const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
  assert.match(css, /\.top-nav\{min-width:0;overflow-x:auto\}/);
  assert.match(css, /\.top-nav \.nav-button\{flex-shrink:0;white-space:nowrap\}/);
});
