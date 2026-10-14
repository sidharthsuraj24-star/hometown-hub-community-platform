'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


test('Vercel entrypoint exports a lazy Fetch function and does not listen on import', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-hub-vercel-'));
  const envKeys = ['DATA_DIR', 'NODE_ENV', 'SUPABASE_DB_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PLATFORM_ADMIN_EMAIL', 'PLATFORM_ADMIN_PASSWORD'];
  const oldEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.NODE_ENV = 'development';
  process.env.DATA_DIR = dataDir;
  let app;
  try {
    const { default: handler, getApp } = await import('../api/index.mjs');
    assert.equal(typeof handler.fetch, 'function');
    assert.equal(typeof getApp, 'function');
    assert.equal(typeof require('../server.js').fetch, 'function');
    app = getApp();
    assert.equal(app.appOptions.dataDir, dataDir);
    const health = await handler.fetch(new Request('http://localhost/api/health'));
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-type'), /application\/json/);
    assert.equal(health.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
    assert.equal(health.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(health.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(health.headers.get('content-security-policy'), /style-src-attr 'none'/);
    assert.doesNotMatch(health.headers.get('content-security-policy'), /unsafe-inline/);
    const login = await handler.fetch(new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: '{}'
    }));
    assert.equal(login.status, 503);
    assert.match((await login.json()).error, /production backend is not configured/i);
  } finally {
    if (app) app.closeDatabase();
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Vercel routes API and private uploads to the function and secures static responses', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.equal(config.regions[0], 'bom1');
  assert.deepEqual(config.rewrites, [
    { source: '/api/:path*', destination: '/api/index.mjs' },
    { source: '/uploads/:path*', destination: '/api/index.mjs' }
  ]);
  assert.equal(config.functions['api/index.mjs'].maxDuration, 10);
  const headers = new Map(config.headers[0].headers.map(header => [header.key.toLowerCase(), header.value]));
  assert.equal(headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('x-dns-prefetch-control'), 'off');
  assert.equal(headers.get('x-permitted-cross-domain-policies'), 'none');
  assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(headers.get('content-security-policy'), /style-src-attr 'none'/);
  assert.doesNotMatch(headers.get('content-security-policy'), /unsafe-inline/);
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
  assert.doesNotMatch(appJs, /\sstyle=/i, 'the app must not depend on inline styles');
});

test('Supabase setup remains private and contains no bootstrap records or public bucket', () => {
  const storage = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/002_private_storage.sql'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/001_initial_schema.sql'), 'utf8');
  assert.match(storage, /public\s*=\s*false/i);
  assert.doesNotMatch(storage, /create\s+policy/i);
  assert.doesNotMatch(schema, /insert\s+into\s+(users|communities|events|posts)\b/i);
});

test('Fetch adapter ignores client-controlled forwarding headers for rate limits', async t => {
  const { createApp } = require('../server');
  const { createFetchHandler } = require('../lib/fetch-handler');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-hub-client-ip-'));
  const app = createApp({ dataDir, adminEmail: 'admin@example.test', adminPassword: 'test-admin-password-123' });
  const handler = createFetchHandler(() => app);
  t.after(() => { app.closeDatabase(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const attempt = headers => handler(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', ...headers },
    body: JSON.stringify({ email: 'unknown@example.test', password: 'incorrect-password' })
  }));

  for (let index = 0; index < 12; index += 1) {
    const response = await attempt({ 'X-Forwarded-For': `198.51.100.${index + 1}`, 'X-Real-IP': `203.0.113.${index + 1}` });
    assert.equal(response.status, 401);
  }
  assert.equal((await attempt({ 'X-Forwarded-For': '192.0.2.201', 'X-Real-IP': '192.0.2.202' })).status, 429,
    'changing generic forwarding headers must not bypass the shared unknown-IP bucket');

  for (let index = 0; index < 12; index += 1) {
    const response = await attempt({ 'X-Vercel-Forwarded-For': '198.51.100.44', 'X-Forwarded-For': `192.0.2.${index + 1}`, 'X-Real-IP': `203.0.113.${index + 1}` });
    assert.equal(response.status, 401);
  }
  assert.equal((await attempt({ 'X-Vercel-Forwarded-For': '198.51.100.44', 'X-Forwarded-For': '192.0.2.250', 'X-Real-IP': '203.0.113.250' })).status, 429,
    'only the Vercel-provided IP header should determine the bucket');
});
