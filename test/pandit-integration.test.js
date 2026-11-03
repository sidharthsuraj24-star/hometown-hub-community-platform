'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../server');
const { createFetchHandler } = require('../lib/fetch-handler');
const { initializePanditSchema } = require('../lib/pandit-onboarding');
const PDF = Buffer.from('%PDF-1.4\nSYNTHETIC INTEGRATION TEST ONLY - NOT A DOCUMENT\n%%EOF').toString('base64');
const STAMP = '2035-01-01T00:00:00.000Z';
const DUE = '2034-12-31T00:00:00.000Z';
const POLICY = { approved_retention_years: 3, approved_retention_days: null, pending_evidence_retention_days: 90, rejected_evidence_retention_days: 90, rejected_background_check_retention_days: 90, rejected_education_retention_days: 90, appeal_days: 30, recheck_years: 2 };
const OPEN = ['pending_evidence_retention_days','rejected_background_check_retention_days','rejected_education_retention_days'];
async function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandit-integration-'));
  const app = createApp({ env: {}, nodeEnv: 'test', dataDir: dir, allowPanditSimulations: true, panditInlineSimulationEvidence: true, panditNow: () => STAMP, adminEmail: 'admin@example.test', adminPassword: 'synthetic-admin-password-123', ...options });
  t.after(() => { app.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
  const invoke = createFetchHandler(() => app);
  const call = async (client, route, method = 'GET', body) => {
    const response = await invoke(new Request('http://localhost' + route, { method, headers: { ...(client.cookie ? { Cookie: client.cookie } : {}), ...(method !== 'GET' ? { Origin: 'http://localhost', 'Content-Type': 'application/json' } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}) }));
    if (response.headers.get('set-cookie')) client.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  const admin = {}, member = {};
  assert.equal((await call(admin, '/api/auth/login', 'POST', { email: 'admin@example.test', password: 'synthetic-admin-password-123' })).status, 200);
  const registered = await call(member, '/api/auth/register', 'POST', { name: 'SYNTHETIC INTEGRATION ACTOR - NOT A PERSON', email: 'synthetic-integration@example.test', password: 'synthetic-member-password-123' });
  assert.equal(registered.status, 202); assert.equal(registered.data.message, 'If an account can be created with these details, sign in with this email and password. If you already have an account, use the password you previously set.');
  const signedIn = await call(member, '/api/auth/login', 'POST', { email: 'synthetic-integration@example.test', password: 'synthetic-member-password-123' });
  assert.equal(signedIn.status, 200); member.id = signedIn.data.user.id;
  return { app, db: app.database, call, admin, member, invoke };
}
function seed(f, { simulation = 1, status = 'ACTION_REQUIRED', approved = null, rejected = null } = {}) {
  const id = randomUUID();
  f.db.prepare('INSERT INTO pandit_applications(id,user_id,is_simulation,status,display_name,review_feedback,created_at,updated_at,approved_record_until,rejected_evidence_until) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, f.member.id, simulation, status, 'SYNTHETIC CASE - NOT A PERSON', 'Synthetic private feedback to remove on evidence expiry', STAMP, STAMP, approved, rejected);
  return id;
}
function evidence(f, application, kind, basis = null, storagePath = null) {
  const id = randomUUID();
  f.db.prepare('INSERT INTO pandit_evidence(id,application_id,kind,content_type,content_base64,storage_path,retention_basis,verified,verified_by,created_at,delete_after) VALUES(?,?,?,?,?,?,?,1,?,?,?)').run(id, application, kind, 'application/pdf', storagePath ? null : PDF, storagePath, basis, f.member.id, STAMP, DUE);
  return id;
}

test('undecided retention stays null/configurable without opening real evidence collection', async t => {
  const f = await setup(t);
  let p = (await f.call(f.member, '/api/pandit-application')).data.policy;
  for (const field of OPEN) assert.equal(p[field], 90);
  for (const field of OPEN) {
    assert.equal((await f.call(f.admin, '/api/admin/pandits/policy', 'PUT', { ...POLICY, [field]: -1 })).status, 400);
    assert.equal((await f.call(f.admin, '/api/admin/pandits/policy', 'PUT', { ...POLICY, [field]: 1.5 })).status, 400);
  }
  const configured = Object.fromEntries(OPEN.map(field => [field, 7])); // Synthetic settings, not owner decisions.
  assert.equal((await f.call(f.admin, '/api/admin/pandits/policy', 'PUT', { ...POLICY, ...configured })).status, 200);
  const omittedOpenFields = (({ pending_evidence_retention_days, rejected_background_check_retention_days, rejected_education_retention_days, ...rest }) => rest)(POLICY);
  assert.equal((await f.call(f.admin, '/api/admin/pandits/policy', 'PUT', omittedOpenFields)).status, 200);
  p = (await f.call(f.member, '/api/pandit-application')).data.policy;
  for (const field of OPEN) assert.equal(p[field], 7, 'omission preserves an explicit setting');
  assert.equal((await f.call(f.admin, '/api/admin/pandits/policy', 'PUT', { ...POLICY, ...Object.fromEntries(OPEN.map(field => [field, null])) })).status, 200);
  initializePanditSchema(f.db);
  for (const field of OPEN) assert.equal(f.db.prepare(`SELECT ${field} FROM pandit_policy`).get()[field], null);
  const id = seed(f, { simulation: 0 });
  const response = await f.call(f.member, '/api/pandit-application/evidence', 'POST', { revision: 1, kind: 'GOVERNMENT_ID', content_type: 'application/pdf', content_base64: PDF });
  assert.equal(response.status, 503);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence WHERE application_id=?').get(id).n, 0);
});

test('an arbitrary expiry does not authorize deletion of pending or rejected undecided evidence', async t => {
  const f = await setup(t); const id = seed(f, { status: 'REJECTED', rejected: DUE });
  const government = evidence(f, id, 'GOVERNMENT_ID', 'REJECTED_GOVERNMENT_ID');
  const background = evidence(f, id, 'BACKGROUND_CHECK');
  const education = evidence(f, id, 'EDUCATION');
  assert.equal((await f.call(f.member, '/api/pandit-application')).status, 200);
  assert.equal(f.db.prepare('SELECT id FROM pandit_evidence WHERE id=?').get(government), undefined);
  assert.deepEqual(f.db.prepare('SELECT id FROM pandit_evidence ORDER BY id').all().map(e => e.id), [background, education].sort());
  assert.equal(f.db.prepare('SELECT review_feedback FROM pandit_applications WHERE id=?').get(id).review_feedback, '');
  const revision = f.db.prepare('SELECT revision FROM pandit_applications').get().revision;
  await f.call(f.member, '/api/pandit-application');
  assert.equal(f.db.prepare('SELECT revision FROM pandit_applications').get().revision, revision, 'unapproved candidates do not cause repeated audit/revision churn');
  assert.ok(f.db.prepare('SELECT * FROM pandit_reviews').all().every(row => row.feedback === '' && !JSON.stringify(row).includes(PDF)));
});

test('private blob deletion failure preserves metadata; successful retry cleans evidence and leaves minimal audit once', async t => {
  let fail = true; const attempts = [];
  const f = await setup(t, { panditPrivateStorage: { removeExpired: async ({ application, evidence: e }) => { attempts.push({ application: application.id, evidence: e.id, path: e.storage_path }); if (fail) throw new Error('Synthetic storage outage'); } } });
  const id = seed(f, { status: 'APPROVED', approved: DUE });
  const blob = evidence(f, id, 'EDUCATION', 'APPROVED', 'synthetic-private-path');
  assert.equal((await f.call(f.member, '/api/pandit-application')).status, 500);
  assert.equal(f.db.prepare('SELECT storage_path FROM pandit_evidence WHERE id=?').get(blob).storage_path, 'synthetic-private-path');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_reviews').get().n, 0);
  fail = false;
  const response = await f.call(f.member, '/api/pandit-application'); assert.equal(response.status, 200);
  assert.equal(response.data.application.status, 'ACTION_REQUIRED');
  assert.equal(response.data.application.evidence_expired_at, STAMP);
  assert.equal(response.data.application.review_feedback, '');
  assert.equal(f.db.prepare('SELECT id FROM pandit_evidence WHERE id=?').get(blob), undefined);
  assert.equal(attempts.length, 2);
  await f.call(f.member, '/api/pandit-application'); assert.equal(attempts.length, 2);
  const audit = f.db.prepare('SELECT * FROM pandit_reviews').all();
  assert.equal(audit.length, 1); assert.equal(audit[0].event, 'APPROVED_RETENTION_EXPIRED');
  assert.ok(!JSON.stringify(audit).includes('synthetic-private-path')); assert.equal(audit[0].feedback, '');
});

test('structured storage failure with not-found text preserves evidence metadata until a successful retry', async t => {
  const { createPanditPrivateStorage } = require('../lib/pandit-private-storage');
  let failure = true; let attempts = 0;
  const helper = createPanditPrivateStorage({ allowSimulations: true, storage: { from: () => ({
    upload: async () => { throw new Error('No upload expected'); },
    download: async () => { throw new Error('No download expected'); },
    remove: async () => { attempts += 1; return failure ? { error: { status: 500, message: 'Storage dependency not found' } } : { data: [], error: null }; },
  }) } });
  const f = await setup(t, { panditPrivateStorage: helper });
  const id = seed(f, { status: 'APPROVED', approved: DUE });
  const eid = evidence(f, id, 'EDUCATION', 'APPROVED');
  const key = `${id}/${eid}`;
  f.db.prepare('UPDATE pandit_evidence SET content_base64=NULL,storage_path=? WHERE id=?').run(key, eid);
  const before = f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(eid);
  const applicationBefore = f.db.prepare('SELECT * FROM pandit_applications WHERE id=?').get(id);
  assert.equal((await f.call(f.member, '/api/pandit-application')).status, 500);
  assert.deepEqual(f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(eid), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM pandit_applications WHERE id=?').get(id), applicationBefore);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_reviews').get().n, 0);
  failure = false;
  assert.equal((await f.call(f.member, '/api/pandit-application')).status, 200);
  assert.equal(f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(eid), undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_reviews').get().n, 1);
  await f.call(f.member, '/api/pandit-application');
  assert.equal(attempts, 2);
});

test('non-simulation rows are not deleted even when explicitly enabled simulation sweeps run', async t => {
  const f = await setup(t); const id = seed(f, { simulation: 0, status: 'APPROVED', approved: DUE });
  const eid = evidence(f, id, 'GOVERNMENT_ID', 'APPROVED');
  const before = f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(eid);
  await f.call(f.member, '/api/pandit-application');
  assert.deepEqual(f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(eid), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_reviews').get().n, 0);
});

test('private object downloads use current reviewer authorization, no public URL, and attachment-only responses', async t => {
  const { createPanditPrivateStorage, BUCKET } = require('../lib/pandit-private-storage');
  const calls = [];
  const bytes = Buffer.from('%PDF-1.4\nSYNTHETIC PRIVATE ATTACHMENT ONLY\n%%EOF');
  const helper = createPanditPrivateStorage({ allowSimulations: true, storage: { from: bucket => {
    assert.equal(bucket, BUCKET);
    return { upload: async () => { throw new Error('No upload expected'); }, remove: async () => { throw new Error('No removal expected'); }, download: async key => { calls.push(key); return { data: new Blob([bytes]), error: null }; } };
  } } });
  const f = await setup(t, { panditPrivateStorage: helper });
  const id = seed(f, { status: 'PENDING_VERIFICATION' });
  f.db.prepare('UPDATE pandit_applications SET submitted_at=? WHERE id=?').run(STAMP, id);
  const eid = evidence(f, id, 'EDUCATION');
  const key = `${id}/${eid}`;
  f.db.prepare('UPDATE pandit_evidence SET content_base64=NULL,storage_path=?,delete_after=NULL WHERE id=?').run(key, eid);
  const reviewer = {};
  const r = await f.call(reviewer, '/api/auth/register', 'POST', { name: 'SYNTHETIC CHECKER - NOT A PERSON', email: 'synthetic-private-checker@example.test', password: 'synthetic-checker-password-123' });
  assert.equal(r.status, 202);
  assert.equal(r.data.message, 'If an account can be created with these details, sign in with this email and password. If you already have an account, use the password you previously set.');
  const signedIn = await f.call(reviewer, '/api/auth/login', 'POST', { email: 'synthetic-private-checker@example.test', password: 'synthetic-checker-password-123' });
  assert.equal(signedIn.status, 200); reviewer.id = signedIn.data.user.id;
  const route = `/api/admin/pandits/${id}/evidence/${eid}`;
  for (const client of [f.admin, f.member, reviewer]) assert.equal((await f.call(client, route)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await f.call(f.admin, '/api/admin/pandits/roles', 'POST', { user_id: reviewer.id, role: 'CHECKER' })).status, 200);
  const response = await f.invoke(new Request('http://localhost' + route, { headers: { Cookie: reviewer.cookie } }));
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(calls, [key]);
  assert.equal((await f.call(f.admin, '/api/admin/pandits/roles', 'POST', { user_id: reviewer.id, role: null })).status, 200);
  assert.equal((await f.call(reviewer, route)).status, 403); assert.equal(calls.length, 1);
  const audit = f.db.prepare("SELECT * FROM pandit_reviews WHERE event='EVIDENCE_ACCESSED'").all();
  assert.equal(audit.length, 1); assert.equal(audit[0].feedback, '');
  assert.ok(!JSON.stringify(audit).includes(key));
});

test('retention expiry clears private feedback even when evidence rows are already absent', async t => {
  const f = await setup(t); const id = seed(f, { status: 'APPROVED', approved: DUE });
  assert.equal((await f.call(f.member, '/api/pandit-application')).status, 200);
  const row = f.db.prepare('SELECT status,review_feedback,approved_record_until FROM pandit_applications WHERE id=?').get(id);
  assert.equal(row.status, 'ACTION_REQUIRED'); assert.equal(row.review_feedback, ''); assert.equal(row.approved_record_until, null);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pandit_reviews WHERE event='APPROVED_RETENTION_EXPIRED'").get().n, 1);
});

test('object-success/metadata-failure rolls back metadata then retries a missing object exactly once', async t => {
  const { createPanditPrivateStorage } = require('../lib/pandit-private-storage');
  let exists = true; let attempts = 0;
  const helper = createPanditPrivateStorage({ allowSimulations: true, storage: { from: () => ({
    upload: async () => { throw new Error('Unexpected upload'); },
    download: async () => { throw new Error('Unexpected fetch'); },
    remove: async () => {
      attempts++;
      if (!exists) return { error: { status: 404 } };
      exists = false;
      return { data: [], error: null };
    },
  }) } });
  const f = await setup(t, { panditPrivateStorage: helper });
  const id = seed(f, { status: 'APPROVED', approved: DUE });
  const eid = evidence(f, id, 'EDUCATION', 'APPROVED');
  f.db.prepare('UPDATE pandit_evidence SET content_base64=NULL,storage_path=? WHERE id=?').run(`${id}/${eid}`, eid);
  const before = f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(eid);
  f.db.exec("CREATE TRIGGER synthetic_metadata_failure BEFORE DELETE ON pandit_evidence BEGIN SELECT RAISE(ABORT, 'Synthetic metadata failure'); END");
  assert.equal((await f.call(f.member, '/api/pandit-application')).status, 500);
  assert.equal(exists, false);
  assert.deepEqual(f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(eid), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_reviews').get().n, 0);
  f.db.exec('DROP TRIGGER synthetic_metadata_failure');
  assert.equal((await f.call(f.member, '/api/pandit-application')).status, 200);
  assert.equal(f.db.prepare('SELECT id FROM pandit_evidence WHERE id=?').get(eid), undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_reviews').get().n, 1);
  await f.call(f.member, '/api/pandit-application');
  assert.equal(attempts, 2);
});

test('malformed or forbidden storage deletion never discards retryable evidence metadata', async t => {
  const { createPanditPrivateStorage } = require('../lib/pandit-private-storage');
  let result = {}; let attempts = 0;
  const helper = createPanditPrivateStorage({ allowSimulations: true, storage: { from: () => ({
    upload: async () => ({}), download: async () => ({}), remove: async () => { attempts++; return result; },
  }) } });
  const f = await setup(t, { panditPrivateStorage: helper });
  const id = seed(f, { status: 'APPROVED', approved: DUE });
  const eid = evidence(f, id, 'EDUCATION', 'APPROVED');
  f.db.prepare('UPDATE pandit_evidence SET content_base64=NULL,storage_path=? WHERE id=?').run(`${id}/${eid}`, eid);
  const before = f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(eid);
  for (const failure of [{}, { data: [], error: undefined }, { error: { status: 403, message: 'Object not found' } }]) {
    result = failure;
    assert.equal((await f.call(f.member, '/api/pandit-application')).status, 500);
    assert.deepEqual(f.db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(eid), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pandit_reviews').get().n, 0);
  }
  result = { data: [], error: null };
  assert.equal((await f.call(f.member, '/api/pandit-application')).status, 200);
  assert.equal(f.db.prepare('SELECT id FROM pandit_evidence WHERE id=?').get(eid), undefined);
  assert.equal(attempts, 4);
});
