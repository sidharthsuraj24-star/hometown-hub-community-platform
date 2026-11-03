'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../server');
const { createFetchHandler } = require('../lib/fetch-handler');
const { createPanditStorageHarness, BUCKET, MAX_FILE_SIZE } = require('./helpers/pandit-storage-harness');

const NOW = '2035-01-01T00:00:00.000Z';
const PDF = Buffer.from('%PDF-1.4\nSYNTHETIC ROUTE TEST ONLY\n%%EOF\n');
const PNG = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const JPEG = Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1]);
const PASSWORD = 'synthetic-pandit-route-password-123';
const PROFILE = { display_name: 'Synthetic Pandit', location: 'Synthetic town', description: 'A synthetic profile with enough description for route tests.', traditions: 'Synthetic tradition', languages: 'Synthetic language', ritual_skills: 'Synthetic rituals', experience_years: 5 };
const POLICY = { approved_retention_years: 3, approved_retention_days: null, rejected_evidence_retention_days: 90, appeal_days: 30, recheck_years: 2, pending_evidence_retention_days: 90, rejected_background_check_retention_days: 90, rejected_education_retention_days: 90 };

function base64(bytes) { return Buffer.from(bytes).toString('base64'); }
function noSecrets(value) { const text = JSON.stringify(value); assert.equal(text.includes('mock-service-key'), false); assert.equal(text.includes('supabase.test'), false); assert.equal(text.includes(BUCKET), false); }

async function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandit-storage-routes-'));
  const harness = createPanditStorageHarness();
  const api = options.panditStorageApi || { serviceRoleKey: 'mock-service-key', fetch: harness.fetch, assertMockIsolation: async () => !harness.policies.object && !harness.policies.list };
  const appOptions = { nodeEnv: 'test', dataDir: dir, allowPanditSimulations: true, panditNow: () => NOW, adminEmail: 'admin@example.test', adminPassword: PASSWORD, panditStorageApi: api, ...options, env: {} };
  if (options.omitStorageApi) delete appOptions.panditStorageApi;
  const app = createApp(appOptions);
  const invoke = createFetchHandler(() => app);
  t.after(() => { app.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = async (client, route, method = 'GET', body) => {
    const headers = { ...(client.cookie ? { Cookie: client.cookie } : {}) };
    if (method !== 'GET') Object.assign(headers, { Origin: 'http://localhost', 'Content-Type': 'application/json' });
    const response = await invoke(new Request('http://localhost' + route, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}) }));
    if (response.headers.get('set-cookie')) client.cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json().catch(() => ({}));
    return { response, status: response.status, data };
  };
  const login = async (client, email, password = PASSWORD) => { const r = await call(client, '/api/auth/login', 'POST', { email, password }); assert.equal(r.status, 200); return r; };
  const register = async (email, name) => { const client = {}; const r = await call(client, '/api/auth/register', 'POST', { email, name, password: PASSWORD }); assert.equal(r.status, 202); assert.equal(r.response.headers.get('set-cookie'), null); const signedIn = await login(client, email); client.id = signedIn.data.user.id; return client; };
  const admin = {}; await login(admin, 'admin@example.test');
  const owner = await register('synthetic-route-owner@example.test', 'Synthetic route owner');
  const checker = await register('synthetic-route-checker@example.test', 'Synthetic route checker');
  const compliance = await register('synthetic-route-compliance@example.test', 'Synthetic route compliance');
  const superAdmin = await register('synthetic-route-super@example.test', 'Synthetic route super admin');
  // Provision roles through the real local admin route; super admin is provisioned directly as in production bootstrap.
  app.database.prepare("INSERT OR REPLACE INTO pandit_roles(user_id,role) VALUES(?, 'SUPER_ADMIN')").run(superAdmin.id);
  assert.equal((await call(admin, '/api/admin/pandits/roles', 'POST', { user_id: checker.id, role: 'CHECKER' })).status, 200);
  assert.equal((await call(admin, '/api/admin/pandits/roles', 'POST', { user_id: compliance.id, role: 'COMPLIANCE' })).status, 200);
  assert.equal((await call(admin, '/api/admin/pandits/policy', 'PUT', POLICY)).status, 200);
  return { app, db: app.database, api, harness, invoke, call, login, register, admin, owner, checker, compliance, superAdmin };
}

async function createDraft(f) {
  let r = await f.call(f.owner, '/api/pandit-application', 'POST', { ...PROFILE, revision: 0, action: 'save', is_simulation: true });
  assert.equal(r.status, 200); return r.data.application;
}
async function upload(f, application, kind, bytes = PDF, contentType = 'application/pdf') {
  const r = await f.call(f.owner, '/api/pandit-application/evidence', 'POST', { revision: application.revision, kind, content_type: contentType, content_base64: base64(bytes) });
  assert.equal(r.status, 200); return r.data.application;
}
async function prepareSubmitted(f) {
  let application = await createDraft(f);
  for (const kind of ['GOVERNMENT_ID', 'BACKGROUND_CHECK', 'EDUCATION']) application = await upload(f, application, kind);
  const submitted = await f.call(f.owner, '/api/pandit-application', 'POST', { ...PROFILE, revision: application.revision, action: 'submit', is_simulation: true });
  assert.equal(submitted.status, 200);
  return submitted.data.application;
}
function storageCalls(f, method) { return f.harness.calls.filter(call => call.method === method); }
function evidenceRow(f, applicationId, kind = 'GOVERNMENT_ID') { return f.db.prepare('SELECT * FROM pandit_evidence WHERE application_id=? AND kind=?').get(applicationId, kind); }


test('configured service adapter uses synthetic Supabase wire contract for upload and stores no base64 or URLs', async t => {
  const f = await setup(t); const application = await createDraft(f); const before = f.harness.calls.length;
  const next = await upload(f, application, 'GOVERNMENT_ID');
  const row = evidenceRow(f, next.id);
  assert.equal(row.content_base64, null); assert.equal(row.storage_path, `${next.id}/${row.id}`); assert.equal(row.revision, undefined);
  assert.ok(storageCalls(f, 'GET').some(call => call.url === `http://supabase.test/storage/v1/bucket/${BUCKET}`));
  assert.ok(storageCalls(f, 'POST').some(call => call.url.includes(`/storage/v1/object/${BUCKET}/${next.id}/`)));
  assert.equal(f.harness.objects.size, 1); assert.ok(f.harness.calls.length > before);
  noSecrets(next); noSecrets(f.db.prepare('SELECT * FROM pandit_reviews').all());
  assert.equal(JSON.stringify(next).includes('storage_path'), false); assert.equal(JSON.stringify(next).includes('content_base64'), false);
  assert.ok(f.harness.calls.every(call => !/\/object\/(public|sign)\//.test(call.url)));
});

test('owner upload, submitted checker/compliance download, and super-admin/owner/unauthorized denials use actual sessions', async t => {
  const f = await setup(t); const application = await prepareSubmitted(f); const row = evidenceRow(f, application.id);
  for (const client of [{}, f.owner, f.superAdmin]) assert.ok([401, 403, 409].includes((await f.call(client, `/api/admin/pandits/${application.id}/evidence/${row.id}`)).status));
  assert.equal((await f.call(f.checker, `/api/admin/pandits/${application.id}/evidence/${row.id}`)).status, 200);
  assert.equal((await f.call(f.compliance, `/api/admin/pandits/${application.id}/evidence/${row.id}`)).status, 200);
  assert.equal((await f.call(f.owner, '/api/pandit-application/evidence', 'POST', { revision: application.revision, kind: 'GOVERNMENT_ID', content_type: 'application/pdf', content_base64: base64(PDF) })).status, 409);
  const audits = f.db.prepare("SELECT event,feedback FROM pandit_reviews WHERE event='EVIDENCE_ACCESSED'").all(); assert.equal(audits.length, 2); assert.ok(audits.every(a => a.feedback === ''));
  noSecrets(audits); assert.ok(f.harness.calls.every(call => !/\/object\/(public|sign)\//.test(call.url)));
});

test('disabled applicants, revoked roles, cross-applicants, expired and absent auth cannot download', async t => {
  const f = await setup(t); const application = await prepareSubmitted(f); const row = evidenceRow(f, application.id);
  f.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.owner.id); assert.ok([403, 404, 409].includes((await f.call(f.checker, `/api/admin/pandits/${application.id}/evidence/${row.id}`)).status)); f.db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(f.owner.id);
  assert.equal((await f.call(f.admin, '/api/admin/pandits/roles', 'POST', { user_id: f.checker.id, role: null })).status, 200); assert.ok([403, 404, 409].includes((await f.call(f.checker, `/api/admin/pandits/${application.id}/evidence/${row.id}`)).status));
  const other = await f.register('synthetic-route-other@example.test', 'Synthetic cross applicant');
  assert.ok([403, 404, 409].includes((await f.call(other, `/api/admin/pandits/${application.id}/evidence/${row.id}`)).status));
  assert.equal(f.harness.calls.filter(c => c.method === 'GET' && c.url.includes('/object/')).length, 0);
});

test('runtime isolation, credentials, bucket verification and production guards fail closed before object operations', async t => {
  const f = await setup(t); const submitted = await prepareSubmitted(f); const row = evidenceRow(f, submitted.id); const objectCalls = () => f.harness.calls.filter(c => /\/storage\/v1\/object\//.test(c.url)).length;
  for (const bad of [async () => false, async () => { throw new Error('isolation'); }, undefined]) {
    f.api.assertMockIsolation = bad; const n = objectCalls(); const r = await f.call(f.checker, `/api/admin/pandits/${submitted.id}/evidence/${row.id}`); assert.equal(r.status, 503); assert.equal(objectCalls(), n);
  }
  f.api.assertMockIsolation = async () => true;
  for (const badKey of ['', 'wrong-key', undefined]) { f.api.serviceRoleKey = badKey; const n = objectCalls(); const r = await f.call(f.checker, `/api/admin/pandits/${submitted.id}/evidence/${row.id}`); assert.equal(r.status, 503); assert.equal(objectCalls(), n); }
  f.api.serviceRoleKey = 'mock-service-key'; f.harness.configure({ bucket: { public: true } }); const n = objectCalls(); assert.equal((await f.call(f.checker, `/api/admin/pandits/${submitted.id}/evidence/${row.id}`)).status, 503); assert.equal(objectCalls(), n);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandit-production-')); const prodHarness = createPanditStorageHarness(); const prod = createApp({ env: {}, nodeEnv: 'production', dataDir: dir, allowPanditSimulations: true, panditStorageApi: { serviceRoleKey: 'mock-service-key', fetch: prodHarness.fetch, assertMockIsolation: async () => true } }); const invoke = createFetchHandler(() => prod);
  const response = await invoke(new Request('http://localhost/api/pandit-application/evidence', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: '{}' })); assert.equal(response.status, 503); assert.equal(prodHarness.calls.length, 0); prod.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true });
});

test('PDF PNG JPEG magic, exact 1 MiB boundary, empty and mismatch validation happen before storage or metadata mutation', async t => {
  for (const [contentType, magic] of [['application/pdf', PDF], ['image/png', PNG], ['image/jpeg', JPEG]]) {
    const f = await setup(t); let a = await createDraft(f); const accepted = await upload(f, a, 'GOVERNMENT_ID', magic, contentType); assert.equal(evidenceRow(f, accepted.id).content_type, contentType);
  }
  for (const [contentType, bytes] of [['application/pdf', Buffer.from('not pdf')], ['image/png', PDF], ['image/jpeg', PNG], ['application/pdf', Buffer.alloc(0)], ['image/png', Buffer.alloc(MAX_FILE_SIZE + 1, 1)]]) {
    const f = await setup(t); const a = await createDraft(f); const before = f.db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n; const calls = f.harness.calls.length; const r = await f.call(f.owner, '/api/pandit-application/evidence', 'POST', { revision: a.revision, kind: 'GOVERNMENT_ID', content_type: contentType, content_base64: base64(bytes) }); assert.ok([400, 503].includes(r.status)); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, before); assert.equal(f.harness.calls.length, calls);
  }
  const f = await setup(t); const a = await createDraft(f); const exact = Buffer.alloc(MAX_FILE_SIZE); PDF.copy(exact); const accepted = await upload(f, a, 'GOVERNMENT_ID', exact); assert.equal(evidenceRow(f, accepted.id).content_base64, null);
});

test('retention sweep deletes through adapter only after due time, preserves metadata on failure, then succeeds idempotently', async t => {
  const f = await setup(t); const application = await prepareSubmitted(f); const row = evidenceRow(f, application.id); f.db.prepare("UPDATE pandit_evidence SET delete_after=?, retention_basis='APPROVED' WHERE id=?").run(NOW, row.id); f.db.prepare("UPDATE pandit_applications SET status='APPROVED', approved_record_until=? WHERE id=?").run(NOW, application.id);
  const originalFetch = f.api.fetch; let fail = true; f.api.fetch = async (input, init) => { const req = input instanceof Request ? input : new Request(input, init); if (req.method === 'DELETE') { if (fail) return new Response(JSON.stringify({ error: 'synthetic outage' }), { status: 503, headers: { 'content-type': 'application/json' } }); } return originalFetch(input, init); };
  const first = await f.call(f.owner, '/api/pandit-application'); assert.equal(first.status, 503); assert.ok(f.db.prepare('SELECT id FROM pandit_evidence WHERE id=?').get(row.id));
  fail = false; const second = await f.call(f.owner, '/api/pandit-application'); assert.equal(second.status, 200); assert.equal(f.db.prepare('SELECT id FROM pandit_evidence WHERE id=?').get(row.id), undefined); const third = await f.call(f.owner, '/api/pandit-application'); assert.equal(third.status, 200);
  assert.ok(f.harness.calls.filter(c => c.method === 'DELETE').length >= 1); assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pandit_reviews WHERE event='APPROVED_RETENTION_EXPIRED'").get().n, 1); noSecrets(f.db.prepare('SELECT * FROM pandit_reviews').all());
});

test('legacy injected private storage remains available when configured API option is absent', async t => {
  const f = await setup(t, { omitStorageApi: true, panditPrivateStorage: { put: async () => 'legacy/path', get: async () => Buffer.from('legacy'), removeExpired: async () => 'legacy/path' } });
  assert.ok(f.app); assert.equal((await f.call(f.owner, '/api/pandit-application')).status, 200);
});

test('missing API option blocks upload and does not let seeded inline evidence bypass the runtime storage guard', async t => {
  const f = await setup(t, { omitStorageApi: true });
  const draft = await createDraft(f);
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n;
  const uploadResponse = await f.call(f.owner, '/api/pandit-application/evidence', 'POST', { revision: draft.revision, kind: 'GOVERNMENT_ID', content_type: 'application/pdf', content_base64: base64(PDF) });
  assert.equal(uploadResponse.status, 503); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, before);
  const evidenceId = randomUUID();
  f.db.prepare('UPDATE pandit_applications SET submitted_at=?,status=? WHERE id=?').run(NOW, 'PENDING_VERIFICATION', draft.id);
  f.db.prepare('INSERT INTO pandit_evidence(id,application_id,kind,content_type,content_base64,created_at,delete_after,retention_basis) VALUES(?,?,?,?,?,?,?,?)').run(evidenceId, draft.id, 'GOVERNMENT_ID', 'application/pdf', base64(PDF), NOW, '2035-02-01T00:00:00.000Z', 'PENDING');
  assert.equal((await f.call(f.checker, `/api/admin/pandits/${draft.id}/evidence/${evidenceId}`)).status, 503);
  assert.equal(f.harness.calls.filter(c => /\/storage\/v1\/object\//.test(c.url)).length, 0);
});

test('failed evidence metadata commit leaves a durable upload journal, then sweep removes the blob and journal after the pending deadline', async t => {
  let clock = new Date(NOW);
  const f = await setup(t, { panditNow: () => clock.toISOString() });
  const draft = await createDraft(f);
  f.db.exec("CREATE TRIGGER synthetic_evidence_abort BEFORE INSERT ON pandit_evidence BEGIN SELECT RAISE(ABORT, 'synthetic metadata failure'); END");
  const response = await f.call(f.owner, '/api/pandit-application/evidence', 'POST', { revision: draft.revision, kind: 'GOVERNMENT_ID', content_type: 'application/pdf', content_base64: base64(PDF) });
  assert.notEqual(response.status, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, 0);
  const journal = f.db.prepare('SELECT * FROM pandit_storage_uploads').get(); assert.ok(journal); assert.equal(journal.retention_basis, 'PENDING');
  assert.equal(f.harness.objects.size, 1); const reservedPath = journal.storage_path;
  const beforeSweep = f.harness.objects.size;
  clock = new Date('2035-04-01T00:00:00.000Z');
  const swept = await f.call(f.owner, '/api/pandit-application');
  assert.equal(swept.status, 200); assert.equal(f.harness.objects.size, beforeSweep - 1); assert.equal(f.harness.objects.has(`${BUCKET}/${reservedPath}`), false);
  assert.equal(f.db.prepare('SELECT * FROM pandit_storage_uploads WHERE id=?').get(journal.id), undefined);
  assert.equal(f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(journal.id), undefined);
});

test('uploads reject every unsafe bucket/credential/guard configuration without evidence or journal mutation', async t => {
  const f = await setup(t); const draft = await createDraft(f);
  const originalBucket = structuredClone(f.harness.buckets.get(BUCKET));
  const failures = [
    () => { f.api.serviceRoleKey = undefined; },
    () => { f.api.serviceRoleKey = 'mock-anon-key'; },
    () => { f.api.serviceRoleKey = 'mock-authenticated-key'; },
    () => { f.api.fetch = undefined; },
    () => { f.api.assertMockIsolation = undefined; },
    () => { f.api.assertMockIsolation = async () => false; },
    () => { f.harness.configure({ policies: { object: true } }); },
    ...[{ id: 'wrong' }, { name: 'wrong' }, { public: true }, { public: undefined },
      { file_size_limit: MAX_FILE_SIZE + 1 }, { file_size_limit: MAX_FILE_SIZE - 1 },
      { allowed_mime_types: ['application/pdf'] },
      { allowed_mime_types: ['application/pdf', 'image/png', 'image/jpeg', 'text/html'] },
      { allowed_mime_types: ['application/pdf', 'image/png', 'image/png'] }].map(bucket => () => f.harness.configure({ bucket })),
  ];
  for (const configure of failures) {
    Object.assign(f.api, { serviceRoleKey: 'mock-service-key', fetch: f.harness.fetch,
      assertMockIsolation: async () => !f.harness.policies.object && !f.harness.policies.list });
    f.harness.configure({ bucket: originalBucket, policies: { object: false, list: false } });
    configure(); const before = f.harness.objects.size;
    const r = await f.call(f.owner, '/api/pandit-application/evidence', 'POST', { revision: draft.revision, kind: 'GOVERNMENT_ID', content_type: 'application/pdf', content_base64: base64(PDF) });
    assert.equal(r.status, 503); noSecrets(r.data);
    assert.equal(f.harness.objects.size, before);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM pandit_evidence').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM pandit_storage_uploads').get().n, 0);
    assert.equal(f.db.prepare('SELECT revision FROM pandit_applications WHERE id=?').get(draft.id).revision, draft.revision);
  }
});

test('attachment bytes have defensive headers, and corrupt or oversized stored data is never released', async t => {
  const f = await setup(t); const a = await prepareSubmitted(f); const row = evidenceRow(f, a.id);
  const url = `http://localhost/api/admin/pandits/${a.id}/evidence/${row.id}`;
  const get = () => f.invoke(new Request(url, { headers: { Cookie: f.checker.cookie } }));
  const response = await get(); assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PDF);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('location'), null);
  for (const bytes of [Buffer.from('<html>not a PDF</html>'), Buffer.alloc(MAX_FILE_SIZE + 1)]) {
    f.harness.seedObject(row.storage_path, bytes);
    const denied = await get(); assert.equal(denied.status, 503); noSecrets(await denied.json());
  }
});

test('unauthenticated, disabled, non-owner and self-review actors cannot use upload/download routes', async t => {
  const f = await setup(t); const a = await createDraft(f);
  const body = { revision: a.revision, kind: 'GOVERNMENT_ID', content_type: 'application/pdf', content_base64: base64(PDF), application_id: a.id, user_id: f.owner.id };
  assert.equal((await f.call({}, '/api/pandit-application/evidence', 'POST', body)).status, 401);
  assert.equal((await f.call(f.checker, '/api/pandit-application/evidence', 'POST', body)).status, 404);
  f.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.owner.id);
  assert.equal((await f.call(f.owner, '/api/pandit-application/evidence', 'POST', body)).status, 401);
  assert.equal(f.harness.objects.size, 0);
  f.db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(f.owner.id);
  await f.login(f.owner, 'synthetic-route-owner@example.test');
  const next = await upload(f, a, 'GOVERNMENT_ID'); const row = evidenceRow(f, a.id);
  f.db.prepare("INSERT INTO pandit_roles(user_id,role) VALUES(?,'CHECKER')").run(f.owner.id);
  f.db.prepare("UPDATE pandit_applications SET submitted_at=?,status='PENDING_VERIFICATION' WHERE id=?").run(NOW, a.id);
  assert.equal((await f.call(f.owner, `/api/admin/pandits/${next.id}/evidence/${row.id}`)).status, 403);
  f.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.checker.id);
  assert.equal((await f.call(f.checker, `/api/admin/pandits/${next.id}/evidence/${row.id}`)).status, 401);
  assert.equal(f.harness.calls.filter(c => c.method === 'GET' && c.url.includes('/object/')).length, 0);
});

test('unsafe configuration blocks retention deletion and preserves exact retry metadata', async t => {
  const f = await setup(t); const a = await prepareSubmitted(f); const row = evidenceRow(f, a.id);
  f.db.prepare("UPDATE pandit_evidence SET delete_after=? WHERE id=?").run(NOW, row.id);
  const before = f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(row.id);
  for (const change of [() => { f.api.serviceRoleKey = ''; }, () => { f.api.assertMockIsolation = undefined; }, () => { f.harness.configure({ bucket: { public: true } }); }]) {
    f.api.serviceRoleKey = 'mock-service-key'; f.api.assertMockIsolation = async () => true;
    f.harness.configure({ bucket: { public: false } }); change();
    assert.equal((await f.call({}, '/api/pandit-application')).status, 401);
    assert.equal((await f.call(f.owner, '/api/pandit-application')).status, 503);
    assert.deepEqual(f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(row.id), before);
    assert.ok(f.harness.objects.has(`${BUCKET}/${row.storage_path}`));
  }
  assert.equal(f.harness.calls.filter(c => c.method === 'DELETE').length, 0);
});
