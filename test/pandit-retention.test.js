'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server');
const { initializePanditSchema, SQLITE_SCHEMA } = require('../lib/pandit-onboarding');
const SYNTHETIC = 'SYNTHETIC RETENTION FIXTURE - NOT A PERSON';
const PDF = Buffer.from('%PDF-1.4\nSYNTHETIC TEST ONLY - NOT A DOCUMENT\n%%EOF').toString('base64');
const POLICY = { approved_retention_years: 3, approved_retention_days: null, pending_evidence_retention_days: 90, rejected_evidence_retention_days: 90, rejected_background_check_retention_days: 90, rejected_education_retention_days: 90, appeal_days: 30, recheck_years: 1 };
async function fixture(t, allowPanditSimulations = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-retention-'));
  const server = createApp({ dataDir: dir, nodeEnv: 'test', env: {}, allowPanditSimulations, panditInlineSimulationEvidence: true, panditNow: () => '2035-03-01T00:00:00.000Z', adminEmail: 'admin@example.test', adminPassword: 'synthetic-admin-password-123' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (client, route, method = 'GET', body) => {
    const headers = { ...(client.cookie ? { Cookie: client.cookie } : {}), ...(method !== 'GET' ? { Origin: base, 'Content-Type': 'application/json' } : {}) };
    const response = await fetch(base + route, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}) });
    const cookie = response.headers.get('set-cookie'); if (cookie) client.cookie = cookie.split(';')[0];
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  const owner = {}; assert.equal((await request(owner, '/api/auth/login', 'POST', { email: 'admin@example.test', password: 'synthetic-admin-password-123' })).status, 200);
  const member = {}; const r = await request(member, '/api/auth/register', 'POST', { name: SYNTHETIC, email: 'synthetic-retention@example.test', password: 'synthetic-member-password-123' }); assert.equal(r.status, 201); member.id = r.data.user.id;
  return { server, request, owner, member };
}

test('legacy local schema adopts approved defaults once without backfilling synthetic case deadlines', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,role TEXT);');
    db.exec(SQLITE_SCHEMA.replace(' approved_retention_years INTEGER,\n', '').replace(',\n evidence_expired_at TEXT', ''));
    db.prepare('UPDATE pandit_policy SET approved_retention_days=10,rejected_evidence_retention_days=3,appeal_days=2').run();
    db.prepare('INSERT INTO users(id,email,role) VALUES(?,?,?)').run('synthetic-user', 'synthetic-upgrade@example.test', 'user');
    db.prepare("INSERT INTO pandit_applications(id,user_id,is_simulation,status,created_at,updated_at,approved_record_until) VALUES(?,?,1,'APPROVED',?,?,?)").run('synthetic-case', 'synthetic-user', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '2030-01-11T00:00:00.000Z');
    db.prepare('INSERT INTO pandit_evidence(id,application_id,kind,content_type,content_base64,created_at,delete_after) VALUES(?,?,?,?,?,?,?)').run('synthetic-evidence', 'synthetic-case', 'GOVERNMENT_ID', 'application/pdf', PDF, '2030-01-01T00:00:00.000Z', '2030-01-11T00:00:00.000Z');
    const before = { ...db.prepare('SELECT * FROM pandit_applications').get() };
    initializePanditSchema(db); initializePanditSchema(db);
    assert.deepEqual({ ...db.prepare('SELECT approved_retention_years,approved_retention_days,pending_evidence_retention_days,rejected_evidence_retention_days,rejected_background_check_retention_days,rejected_education_retention_days,appeal_days,recheck_years FROM pandit_policy').get() }, { ...POLICY, approved_retention_years: null, approved_retention_days: 10, rejected_evidence_retention_days: 3, appeal_days: 2 });
    const after = { ...db.prepare('SELECT * FROM pandit_applications').get() }; delete after.evidence_expired_at; delete before.evidence_expired_at; assert.deepEqual(after, before);
    assert.equal(db.prepare('SELECT delete_after FROM pandit_evidence').get().delete_after, before.approved_record_until);
    db.prepare('UPDATE pandit_policy SET approved_retention_years=4,approved_retention_days=NULL').run(); initializePanditSchema(db);
    assert.equal(db.prepare('SELECT approved_retention_years FROM pandit_policy').get().approved_retention_years, 4);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('policy rejects ambiguous units, retains valid legacy days, and null stays fail-closed across initialization', async t => {
  const f = await fixture(t);
  for (const [body, expected] of [[{ ...POLICY, approved_retention_years: 4 }, 200], [{ ...POLICY, approved_retention_years: null, approved_retention_days: 10 }, 200], [{ ...POLICY, approved_retention_years: 4, approved_retention_days: 10 }, 400], [{ ...POLICY, approved_retention_years: 1.5 }, 400]]) assert.equal((await f.request(f.owner, '/api/admin/pandits/policy', 'PUT', body)).status, expected);
  assert.deepEqual({ ...f.server.database.prepare('SELECT approved_retention_years,approved_retention_days FROM pandit_policy').get() }, { approved_retention_years: null, approved_retention_days: 10 });
  assert.equal((await f.request(f.owner, '/api/admin/pandits/policy', 'PUT', { ...POLICY, approved_retention_years: null })).status, 200);
  initializePanditSchema(f.server.database);
  assert.equal(f.server.database.prepare('SELECT approved_retention_years FROM pandit_policy').get().approved_retention_years, null);
  const saved = await f.request(f.member, '/api/pandit-application', 'POST', { is_simulation: true, revision: 0, action: 'save', display_name: SYNTHETIC, experience_years: 0 }); assert.equal(saved.status, 200);
  assert.equal((await f.request(f.member, '/api/pandit-application/evidence', 'POST', { revision: saved.data.application.revision, kind: 'GOVERNMENT_ID', content_type: 'application/pdf', content_base64: PDF })).status, 503);
  assert.equal(f.server.database.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, 0);
});

test('normal local mode cannot expire overdue explicitly synthetic private fixtures', async t => {
  const f = await fixture(t, false); const db = f.server.database; const stamp = '2030-01-01T00:00:00.000Z';
  db.prepare("INSERT INTO pandit_applications(id,user_id,display_name,is_simulation,status,created_at,updated_at,approved_record_until,reverify_at) VALUES(?,?,?,1,'APPROVED',?,?,?,?)").run('synthetic-disabled-case', f.member.id, SYNTHETIC, stamp, stamp, '2033-01-01T00:00:00.000Z', '2031-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO pandit_evidence(id,application_id,kind,content_type,content_base64,created_at,delete_after) VALUES(?,?,?,?,?,?,?)').run('synthetic-disabled-evidence', 'synthetic-disabled-case', 'GOVERNMENT_ID', 'application/pdf', PDF, stamp, '2033-01-01T00:00:00.000Z');
  const before = db.prepare('SELECT * FROM pandit_applications').all(), evidenceBefore = db.prepare('SELECT * FROM pandit_evidence').all();
  for (let i = 0; i < 3; i++) assert.equal((await f.request(f.member, '/api/pandit-application')).status, 200);
  assert.deepEqual(db.prepare('SELECT * FROM pandit_applications').all(), before); assert.deepEqual(db.prepare('SELECT * FROM pandit_evidence').all(), evidenceBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pandit_reviews').get().n, 0);
  assert.equal((await f.request(f.member, '/api/pandits')).data.pandits.length, 0);
});
