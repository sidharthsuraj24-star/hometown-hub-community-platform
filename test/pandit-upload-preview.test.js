'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createDisposablePreview, PROFILE, DUMMY_BASE64, SYNTHETIC_EMAIL, SYNTHETIC_PASSWORD } = require('../lib/pandit-upload-preview');

async function fixture(t) {
  const preview = createDisposablePreview({ ttlMs: 60_000 });
  const address = await preview.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => preview.cleanup());
  return { preview, base };
}
async function request(base, path, options = {}, client = {}) {
  const headers = { ...(options.headers || {}) };
  if (client.cookie) headers.Cookie = client.cookie;
  const response = await fetch(base + path, { ...options, headers, redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) client.cookie = setCookie.split(';')[0];
  return response;
}
async function json(response) { return response.json(); }
function postBody(base, path, body, client) { return request(base, path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, client); }

 test('preview automatically logs in, serves banner/dummy PDF, and hides simulation directory', async t => {
  const { base } = await fixture(t); const client = {};
  let response = await request(base, '/preview/start', {}, client);
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/?page=pandits'); assert.ok(client.cookie);
  response = await request(base, '/', {}, client); const html = await response.text();
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(html, /DISPOSABLE SIMULATION/); assert.match(html, /preview\/reset/); assert.match(html, /preview-dummy\.pdf/);
  response = await request(base, '/preview-dummy.pdf'); assert.equal(response.status, 200); assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), DUMMY_BASE64);
  response = await request(base, '/api/pandits', {}, client); assert.deepEqual((await json(response)).pandits, []);
 });

 test('only exact fixed profile and dummy evidence can be submitted and replaced', async t => {
  const { base, preview } = await fixture(t); const client = {};
  await request(base, '/preview/start', {}, client);
  let app = await json(await request(base, '/api/pandit-application', {}, client));
  assert.equal(app.application.is_simulation, 1); let revision = app.application.revision;
  const profile = { ...PROFILE, revision, action: 'save' };
  assert.equal((await postBody(base, '/api/pandit-application', profile, client)).status, 200);
  revision = (await json(await request(base, '/api/pandit-application', {}, client))).application.revision;
  for (const kind of ['GOVERNMENT_ID', 'BACKGROUND_CHECK', 'EDUCATION']) {
    const response = await postBody(base, '/api/pandit-application/evidence', { revision, kind, content_type: 'application/pdf', content_base64: DUMMY_BASE64 }, client);
    assert.equal(response.status, 200, await response.text()); revision = (await json(await request(base, '/api/pandit-application', {}, client))).application.revision;
    if (kind === 'GOVERNMENT_ID') {
      const replacement = await postBody(base, '/api/pandit-application/evidence', { revision, kind, content_type: 'application/pdf', content_base64: DUMMY_BASE64 }, client);
      assert.equal(replacement.status, 200); revision = (await json(await request(base, '/api/pandit-application', {}, client))).application.revision;
    }
  }
  const submit = await postBody(base, '/api/pandit-application', { ...PROFILE, revision, action: 'submit' }, client);
  assert.equal(submit.status, 200); assert.equal((await json(submit)).application.status, 'PENDING_VERIFICATION');
  assert.equal(preview.app.database.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, 3);
 });

 test('rejects arbitrary bytes before persistence and denies registration/admin/general writes', async t => {
  const { base, preview } = await fixture(t); const client = {};
  await request(base, '/preview/start', {}, client);
  let app = await json(await request(base, '/api/pandit-application', {}, client));
  const profile = { ...PROFILE, revision: app.application.revision, action: 'save' };
  assert.equal((await postBody(base, '/api/pandit-application', profile, client)).status, 200);
  app = await json(await request(base, '/api/pandit-application', {}, client));
  const bad = await postBody(base, '/api/pandit-application/evidence', { revision: app.application.revision, kind: 'EDUCATION', content_type: 'application/pdf', content_base64: Buffer.from('real document').toString('base64') }, client);
  assert.equal(bad.status, 400); assert.equal(preview.app.database.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, 0);
  assert.equal((await postBody(base, '/api/auth/register', { name: 'Nope', email: 'nope@example.test', password: 'long-password-123' }, client)).status, 403);
  assert.equal((await postBody(base, '/api/communities', { name: 'Nope', location: 'Nope', description: 'No general mutations in preview', category: 'General', tags: [] }, client)).status, 403);
  assert.equal((await request(base, '/api/admin/pandits', {}, client)).status, 403);
  assert.equal((await postBody(base, '/api/auth/login', { email: 'normal@example.test', password: 'not-allowed' }, {})).status, 403);
  assert.equal((await postBody(base, '/api/auth/login', { email: SYNTHETIC_EMAIL, password: SYNTHETIC_PASSWORD }, {})).status, 200);
 });

 test('denies production and removes the isolated database on cleanup', async () => {
  assert.throws(() => createDisposablePreview({ nodeEnv: 'production' }), /NODE_ENV=production/);
  const preview = createDisposablePreview({ ttlMs: 60_000 }); const dataDir = preview.dataDir; await preview.cleanup();
  assert.equal(fs.existsSync(dataDir), false);
 });

test('normal UI payload works without an explicit simulation flag and unsafe changes stay blocked', async t => {
  const { base, preview } = await fixture(t); const client = {};
  await request(base, '/preview/start', {}, client);
  const { is_simulation, ...uiFields } = PROFILE;
  const body = { ...uiFields, revision: 1, action: 'save' };
  let response = await postBody(base, '/api/pandit-application', body, client);
  assert.equal(response.status, 200);
  const a = (await json(response)).application;
  assert.equal(a.is_simulation, 1);
  response = await postBody(base, '/api/pandit-application', { ...body, revision: a.revision, display_name: 'Not the fixed fixture' }, client);
  assert.equal(response.status, 400);
  response = await postBody(base, '/api/pandit-application', { ...body, revision: a.revision, is_simulation: false }, client);
  assert.equal(response.status, 400);
  response = await request(base, '/api/pandit-application/evidence', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: a.revision, kind: 'EDUCATION', content_type: 'application/pdf', content_base64: DUMMY_BASE64 }) }, client);
  assert.equal(response.status, 403);
  assert.equal(preview.app.database.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, 0);
});

const path = require('node:path');
const crypto = require('node:crypto');
// Retention work must never read or reuse the owner's attached PDF. Keep the
// original allowlist regressions available separately, without weakening them.
const syntheticOnly = process.env.PANDIT_SYNTHETIC_ONLY === '1';
const ownerFixtureOptions = { skip: syntheticOnly ? 'Owner PDF excluded: synthetic-only retention validation' : false };
const OWNER_DUMMY = syntheticOnly ? null : fs.readFileSync(path.join(__dirname, 'fixtures/pandit-owner-dummy1.pdf'));
const OWNER_DUMMY_BASE64 = OWNER_DUMMY?.toString('base64');

test('reviewed owner dummy1 PDF uploads unchanged in all three categories and submits via normal UI payload', ownerFixtureOptions, async t => {
  assert.equal(OWNER_DUMMY.length, 26579);
  assert.equal(crypto.createHash('sha256').update(OWNER_DUMMY).digest('hex'), '0bb15882d995136445b62bcd31b618a6fcd3e623b3bac59497a4d07411839131');
  const { base, preview } = await fixture(t); const client = {};
  await request(base, '/preview/start', {}, client);
  let application = (await json(await request(base, '/api/pandit-application', {}, client))).application;
  const { is_simulation, ...uiFields } = PROFILE;
  let response = await postBody(base, '/api/pandit-application', { ...uiFields, revision: application.revision, action: 'save' }, client);
  assert.equal(response.status, 200);
  application = (await json(response)).application;
  for (const kind of ['GOVERNMENT_ID', 'BACKGROUND_CHECK', 'EDUCATION', 'EDUCATION']) {
    response = await postBody(base, '/api/pandit-application/evidence', { revision: application.revision, kind, content_type: 'application/pdf', content_base64: OWNER_DUMMY_BASE64 }, client);
    assert.equal(response.status, 200);
    application = (await json(response)).application;
  }
  response = await postBody(base, '/api/pandit-application', { ...uiFields, revision: application.revision, action: 'submit' }, client);
  assert.equal(response.status, 200);
  assert.equal((await json(response)).application.status, 'PENDING_VERIFICATION');
  assert.equal(preview.app.database.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, 3);
  const html = await (await request(base, '/', {}, client)).text();
  assert.match(html, /exact owner-supplied dummy1\.pdf/);
  assert.match(html, /Never upload real personal documents/);
});

test('owner allowlist denies modified files, altered types, malformed encodings, extra fields and bad kinds before persistence', ownerFixtureOptions, async t => {
  const { base, preview } = await fixture(t); const client = {};
  await request(base, '/preview/start', {}, client);
  const application = (await json(await request(base, '/api/pandit-application', {}, client))).application;
  const good = { revision: application.revision, kind: 'EDUCATION', content_type: 'application/pdf', content_base64: OWNER_DUMMY_BASE64 };
  const changed = Buffer.from(OWNER_DUMMY); changed[changed.length - 1] ^= 1;
  for (const change of [
    { content_base64: changed.toString('base64') },
    { content_base64: Buffer.concat([OWNER_DUMMY, Buffer.from('\n')]).toString('base64') },
    { content_base64: Buffer.from('%PDF-1.4\nAnother placeholder\n%%EOF').toString('base64') },
    { content_base64: OWNER_DUMMY_BASE64 + '\n' },
    { content_base64: null },
    { content_type: 'image/png' },
    { kind: 'OTHER' },
    { filename: 'dummy1.pdf' }
  ]) {
    const response = await postBody(base, '/api/pandit-application/evidence', { ...good, ...change }, client);
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, /exact inspected owner-supplied dummy1\.pdf/);
    assert.equal(preview.app.database.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, 0);
  }
});

const vm = require('node:vm');
test('preview-only UI distinguishes missing uploads from awaiting review without exposing contents', async t => {
  const { base } = await fixture(t);
  const response = await request(base, '/app.js?v=preview-status');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const source = await response.text();
  const context = vm.createContext({ document: { querySelector: () => ({}), querySelectorAll: () => [], addEventListener() {} }, window: { addEventListener() {} }, URL, location: { origin: base, href: base } });
  vm.runInContext(source.slice(0, source.indexOf('(async function boot()')) + source.slice(source.lastIndexOf('\nfunction evidenceList(a, role)')), context);
  const render = application => { context.application = application; return vm.runInContext('evidenceList(application)', context); };
  assert.equal((render({ is_simulation: 1, evidence: [] }).match(/NOT UPLOADED/g) || []).length, 3);
  const application = { is_simulation: 1, status: 'ACTION_REQUIRED', evidence: ['GOVERNMENT_ID','BACKGROUND_CHECK','EDUCATION'].map(kind => ({ kind, verified: 0, content_base64: 'NEVER-RENDER-CONTENTS' })) };
  const uploaded = render(application);
  assert.equal((uploaded.match(/UPLOADED — AWAITING REVIEW/g) || []).length, 3);
  assert.match(uploaded, /Next: Submit for review/);
  assert.doesNotMatch(uploaded, /NOT UPLOADED|NEVER-RENDER-CONTENTS/);
  assert.match(render({ ...application, status: 'PENDING_VERIFICATION' }), /Application submitted — pending review/);
  assert.match(render({ evidence: [{ kind: 'EDUCATION', verified: 0 }] }), /NOT VERIFIED/, 'non-simulation UI retains its existing wording');
  assert.match(source, /No file chosen.*does not mean the upload is missing/);
  assert.match(source, /uploaded — awaiting review/);
});

test('a rejected replacement leaves all successful owner uploads and pending review unchanged', ownerFixtureOptions, async t => {
  const { base, preview } = await fixture(t); const client = {};
  await request(base, '/preview/start', {}, client);
  let application = (await json(await request(base, '/api/pandit-application', {}, client))).application;
  for (const kind of ['GOVERNMENT_ID','BACKGROUND_CHECK','EDUCATION']) {
    const response = await postBody(base, '/api/pandit-application/evidence', { revision: application.revision, kind, content_type: 'application/pdf', content_base64: OWNER_DUMMY_BASE64 }, client);
    assert.equal(response.status, 200);
    application = (await json(response)).application;
    assert.equal(application.evidence.find(e => e.kind === kind).verified, 0);
  }
  const { is_simulation, ...uiFields } = PROFILE;
  const submitted = await postBody(base, '/api/pandit-application', { ...uiFields, revision: application.revision, action: 'submit' }, client);
  assert.equal(submitted.status, 200);
  application = (await json(submitted)).application;
  assert.equal(application.status, 'PENDING_VERIFICATION');
  const rejected = await postBody(base, '/api/pandit-application/evidence', { revision: application.revision, kind: 'EDUCATION', content_type: 'application/pdf', content_base64: Buffer.concat([OWNER_DUMMY, Buffer.from('\n')]).toString('base64') }, client);
  assert.equal(rejected.status, 400);
  assert.match((await json(rejected)).error, /This attempt was rejected; previously uploaded evidence is unchanged/);
  assert.deepEqual((await json(await request(base, '/api/pandit-application', {}, client))).application, application);
  assert.equal(preview.app.database.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, 3);
});
