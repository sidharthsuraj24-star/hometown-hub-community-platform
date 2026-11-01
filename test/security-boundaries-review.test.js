'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-security-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t, options = {}) {
  const root = temporary(t);
  const server = createApp({ dataDir: root, nodeEnv: 'test', env: {}, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server.closeDatabase();
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, client, pathName, method = 'GET', body, extra = {}) {
  const { omitOrigin = false, ...extraHeaders } = extra;
  const headers = { ...(client?.cookie ? { Cookie: client.cookie } : {}), ...extraHeaders };
  if (method !== 'GET' && method !== 'HEAD') {
    if (omitOrigin) delete headers.Origin;
    else headers.Origin ??= base;
    headers['Content-Type'] ??= 'application/json';
  }
  const response = await fetch(`${base}${pathName}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie && client) client.cookie = setCookie.split(';')[0];
  return response;
}

async function register(base, client, email = 'synthetic-member@example.test') {
  const password = 'synthetic-member-password-123';
  const response = await request(base, client, '/api/auth/register', 'POST', {
    name: 'Synthetic Member', email, password
  });
  const payload = await response.json();
  assert.equal(response.status, 202, JSON.stringify(payload));
  assert.equal(response.headers.get('set-cookie'), null);
  const loggedIn = await request(base, client, '/api/auth/login', 'POST', { email, password });
  assert.equal(loggedIn.status, 200);
  return loggedIn.json();
}

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test('state-changing requests reject missing, foreign, cross-scheme, and cross-site origins before mutation', async t => {
  const { server, base } = await fixture(t);
  const before = server.database.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const body = { name: 'Should Not Persist', email: 'foreign@example.test', password: 'synthetic-password-123' };
  const foreign = await request(base, null, '/api/auth/register', 'POST', body, { Origin: 'https://attacker.example.test' });
  assert.equal(foreign.status, 403);
  assert.match((await foreign.json()).error, /origin/i);
  const missing = await request(base, null, '/api/auth/register', 'POST', body, { omitOrigin: true });
  assert.equal(missing.status, 403);
  const wrongScheme = await request(base, null, '/api/auth/register', 'POST', body, { 'x-forwarded-proto': 'https' });
  assert.equal(wrongScheme.status, 403);
  const crossSite = await request(base, null, '/api/auth/register', 'POST', body, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.equal(server.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, before);
});

test('new and duplicate signup addresses receive the same response and neither receives a session', async t => {
  const { server, base } = await fixture(t);
  const email = 'registration-privacy@example.test';
  const first = await request(base, null, '/api/auth/register', 'POST', {
    name: 'Synthetic First', email, password: 'synthetic-member-password-123'
  });
  const firstPayload = await first.json();
  assert.equal(first.status, 202);
  assert.equal(first.headers.get('set-cookie'), null);
  const retry = await request(base, null, '/api/auth/register', 'POST', {
    name: 'Synthetic Second', email, password: 'different-synthetic-password-456'
  });
  assert.equal(retry.status, 202);
  assert.equal(retry.headers.get('set-cookie'), null);
  assert.deepEqual(await retry.json(), firstPayload);
  assert.equal(server.database.prepare('SELECT COUNT(*) AS n FROM users WHERE email=?').get(email).n, 1);
  assert.equal((await request(base, null, '/api/auth/login', 'POST', { email, password: 'synthetic-member-password-123' })).status, 200);
  assert.equal((await request(base, null, '/api/auth/login', 'POST', { email, password: 'different-synthetic-password-456' })).status, 401);
});

test('API write actions receive a shared per-route rate limit', async t => {
  const { base } = await fixture(t);
  const statuses = [];
  for (let attempt = 0; attempt < 61; attempt += 1) {
    const response = await request(base, null, '/api/profile', 'POST', { name: 'No session', hometown: '', bio: '' });
    statuses.push(response.status);
    await response.arrayBuffer();
  }
  assert.deepEqual(statuses.slice(0, 60), Array(60).fill(401));
  assert.equal(statuses[60], 429);
});

test('authentication failures do not disclose account existence and cookies are hardened', async t => {
  const { base } = await fixture(t);
  const client = {};
  await register(base, client);
  const unknown = await request(base, null, '/api/auth/login', 'POST', {
    email: 'unknown@example.test', password: 'wrong-password'
  });
  const wrong = await request(base, null, '/api/auth/login', 'POST', {
    email: 'synthetic-member@example.test', password: 'wrong-password'
  });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await unknown.json(), await wrong.json());
  const loggedIn = await request(base, null, '/api/auth/login', 'POST', {
    email: 'synthetic-member@example.test', password: 'synthetic-member-password-123'
  });
  assert.equal(loggedIn.status, 200);
  assert.match(loggedIn.headers.get('set-cookie'), /HttpOnly/);
  assert.match(loggedIn.headers.get('set-cookie'), /SameSite=Lax/);
  assert.match(loggedIn.headers.get('set-cookie'), /Path=\//);
});

test('pandit evidence rejects forbidden fields, invalid signatures, and oversized payloads without persistence', async t => {
  const { server, base } = await fixture(t, { allowPanditSimulations: true, panditInlineSimulationEvidence: true });
  const client = {};
  await register(base, client, 'pandit-owner@example.test');
  let response = await request(base, client, '/api/pandit-application', 'POST', {
    action: 'save', revision: 0, is_simulation: true,
    display_name: 'Synthetic Pandit', location: 'Test locality', description: 'Synthetic profile for boundary testing only.',
    traditions: 'Tradition', languages: 'English', ritual_skills: 'Ceremony', experience_years: 4
  });
  const profilePayload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(profilePayload));
  let application = profilePayload.application;
  const evidenceCount = () => server.database.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n;

  response = await request(base, client, '/api/pandit-application/evidence', 'POST', {
    revision: application.revision, kind: 'EDUCATION', content_type: 'image/png', content_base64: png.toString('base64'),
    private_note: 'synthetic private note that must not be accepted'
  });
  assert.equal(response.status, 400);
  assert.equal(evidenceCount(), 0);

  response = await request(base, client, '/api/pandit-application/evidence', 'POST', {
    revision: application.revision, kind: 'EDUCATION', content_type: 'image/png', content_base64: Buffer.from('not-a-png').toString('base64')
  });
  assert.equal(response.status, 400);
  assert.equal(evidenceCount(), 0);

  response = await request(base, client, '/api/pandit-application/evidence', 'POST', {
    revision: application.revision, kind: 'EDUCATION', content_type: 'image/png', content_base64: Buffer.concat([png, Buffer.alloc(1048577)]).toString('base64')
  });
  assert.equal(response.status, 400);
  assert.equal(evidenceCount(), 0);
});

test('pandit application and evidence metadata remain owner-private', async t => {
  const { base } = await fixture(t, { allowPanditSimulations: true, panditInlineSimulationEvidence: true });
  const owner = {}, stranger = {};
  await register(base, owner, 'owner-private@example.test');
  await register(base, stranger, 'stranger-private@example.test');
  let response = await request(base, owner, '/api/pandit-application', 'POST', {
    action: 'save', revision: 0, is_simulation: true,
    display_name: 'Owner Profile', location: 'Test locality', description: 'Synthetic private profile with enough descriptive text.',
    traditions: 'Tradition', languages: 'English', ritual_skills: 'Ceremony', experience_years: 2
  });
  assert.equal(response.status, 200);
  let application = (await response.json()).application;
  response = await request(base, owner, '/api/pandit-application/evidence', 'POST', {
    revision: application.revision, kind: 'EDUCATION', content_type: 'image/png', content_base64: png.toString('base64')
  });
  assert.equal(response.status, 200);
  application = (await response.json()).application;
  const evidenceId = application.evidence[0].id;

  response = await request(base, stranger, '/api/pandit-application');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).application, null);
  response = await request(base, stranger, `/api/admin/pandits/${application.id}/evidence/${evidenceId}`);
  assert.equal(response.status, 403);

  response = await request(base, owner, '/api/pandit-application');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).application.evidence[0].content_base64, undefined);
});

test('malformed percent-encoded API paths return client errors without unexpected logs and recover', async t => {
  const { base } = await fixture(t);
  const original = console.error;
  const logs = [];
  try {
    console.error = (...args) => logs.push(args);
    for (const pathName of ['/api/%E0%A4%A', '/api/%FF', '/api/%']) {
      const response = await fetch(base + pathName, { headers: { Accept: 'application/json' } });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'The request path is malformed.' });
    }
  } finally { console.error = original; }
  assert.deepEqual(logs, []);
  const recovered = await fetch(base + '/api/health');
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).ok, true);
});
