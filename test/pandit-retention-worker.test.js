'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createPanditRetentionWorker } = require('../lib/pandit-retention-worker');
const { createPanditPrivateStorage } = require('../lib/pandit-private-storage');
const { initializePanditSchema, addDays, addYears } = require('../lib/pandit-onboarding');
const { createPanditStorageHarness, BUCKET } = require('./helpers/pandit-storage-harness');
const { createFetchHandler } = require('../lib/fetch-handler');
const { createApp } = require('../server');

const PDF = Buffer.from('%PDF-1.4\nSYNTHETIC RETENTION WORKER TEST ONLY\n%%EOF');
const POLICY = {
  approved_retention_years: 3,
  approved_retention_days: null,
  pending_evidence_retention_days: 90,
  rejected_evidence_retention_days: 90,
  rejected_background_check_retention_days: 90,
  rejected_education_retention_days: 90,
  appeal_days: 30,
  recheck_years: 2,
};

function databaseFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,role TEXT NOT NULL DEFAULT \'user\',disabled INTEGER NOT NULL DEFAULT 0);');
  initializePanditSchema(db);
  db.prepare(`UPDATE pandit_policy SET approved_retention_years=?,approved_retention_days=?,
    pending_evidence_retention_days=?,rejected_evidence_retention_days=?,
    rejected_background_check_retention_days=?,rejected_education_retention_days=?,appeal_days=?,recheck_years=?
    WHERE id=1`).run(...Object.values(POLICY));
  const transaction = async fn => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const tx = {
        one: async (sql, ...args) => db.prepare(sql).get(...args) || null,
        many: async (sql, ...args) => db.prepare(sql).all(...args),
        run: async (sql, ...args) => db.prepare(sql).run(...args),
      };
      const result = await fn(tx);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return { db, transaction };
}

function insertApplication(db, { id = randomUUID(), isSimulation = 0, status = 'ACTION_REQUIRED', activity, approvedAt = null, approvedUntil = null, rejectedAt = null, rejectedUntil = null, appealUntil = null }) {
  const userId = randomUUID();
  db.prepare('INSERT INTO users(id,email,role,disabled) VALUES(?,?,?,0)').run(userId, `${userId}@synthetic.example.test`, 'user');
  const created = activity || approvedAt || rejectedAt || '2035-01-01T00:00:00.000Z';
  db.prepare(`INSERT INTO pandit_applications(
    id,user_id,display_name,is_simulation,status,created_at,updated_at,last_activity_at,
    submitted_at,approved_at,approved_record_until,rejected_at,rejected_evidence_until,appeal_until
  ) VALUES(?,?,?, ?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, userId, 'SYNTHETIC TEST CASE - NOT A PERSON', isSimulation, status,
    created, created, activity || created, approvedAt, approvedAt, approvedUntil,
    rejectedAt, rejectedUntil, appealUntil,
  );
  return { id, user_id: userId, is_simulation: isSimulation, status, created_at: created,
    updated_at: created, last_activity_at: activity || created, approved_at: approvedAt,
    approved_record_until: approvedUntil, rejected_at: rejectedAt,
    rejected_evidence_until: rejectedUntil, appeal_until: appealUntil, submitted_at: approvedAt };
}

function insertEvidence(db, harness, application, { kind = 'GOVERNMENT_ID', basis = 'PENDING', deadline, id = randomUUID(), contentType = 'application/pdf' } = {}) {
  const storagePath = `${application.id}/${id}`;
  db.prepare(`INSERT INTO pandit_evidence(
    id,application_id,kind,content_type,content_base64,storage_path,verified,created_at,delete_after,retention_basis
  ) VALUES(?,?,?,?,NULL,?,0,?,?,?)`).run(id, application.id, kind, contentType, storagePath, application.created_at, deadline, basis);
  harness.seedObject(storagePath, PDF, contentType, BUCKET);
  return { id, application_id: application.id, kind, content_type: contentType,
    content_base64: null, storage_path: storagePath, delete_after: deadline, retention_basis: basis };
}

function worker({ db, transaction, harness, now, failRemoval = () => false, isProduction = true, enabled = true } = {}) {
  const base = createPanditPrivateStorage({
    storage: harness.storage('service').storage,
    isProduction,
    allowProductionEvidence: isProduction,
    allowSimulations: !isProduction,
    now: () => Date.parse(now()),
  });
  const privateEvidenceStorage = {
    ...base,
    async removeExpired(args) {
      if (failRemoval()) throw new Error('Synthetic Storage outage.');
      return base.removeExpired(args);
    },
  };
  return createPanditRetentionWorker({
    transaction, privateEvidenceStorage, isProduction, enabled,
    allowSimulations: !isProduction,
    acquireLock: async () => true,
    now,
  });
}

test('production-mode worker uses approved snapshots, cleans orphan uploads, excludes simulations, and retries Storage failures', async t => {
  const { db, transaction } = databaseFixture();
  t.after(() => db.close());
  let clock = '2035-02-28T23:59:59.999Z';
  const harness = createPanditStorageHarness();
  let failStorage = false;
  const run = worker({ db, transaction, harness, now: () => clock, failRemoval: () => failStorage });

  const approvalAt = '2032-03-01T00:00:00.000Z';
  const approvedUntil = addYears(approvalAt, 3);
  const approved = insertApplication(db, { status: 'APPROVED', approvedAt: approvalAt, approvedUntil });
  db.prepare(`INSERT INTO pandit_reviews(id,application_id,actor_id,event,from_status,to_status,feedback,created_at)
    VALUES(?,?,NULL,'REVIEW','PENDING_VERIFICATION','APPROVED','',?)`).run(randomUUID(), approved.id, approvalAt);
  const approvedEvidence = insertEvidence(db, harness, approved, { basis: 'APPROVED', deadline: approvedUntil });

  const activity = '2035-01-01T00:00:00.000Z';
  const pending = insertApplication(db, { activity });
  const pendingUntil = addDays(activity, 90);
  const pendingEvidence = insertEvidence(db, harness, pending, { basis: 'PENDING', deadline: pendingUntil });

  const rejectedAt = activity;
  const rejectedUntil = addDays(rejectedAt, 90);
  const rejected = insertApplication(db, {
    status: 'REJECTED', activity: rejectedAt, rejectedAt, rejectedUntil,
    appealUntil: addDays(rejectedAt, 30),
  });
  const rejectedRows = [
    insertEvidence(db, harness, rejected, { kind: 'GOVERNMENT_ID', basis: 'REJECTED_GOVERNMENT_ID', deadline: rejectedUntil }),
    insertEvidence(db, harness, rejected, { kind: 'BACKGROUND_CHECK', basis: 'REJECTED_BACKGROUND_CHECK', deadline: rejectedUntil }),
    insertEvidence(db, harness, rejected, { kind: 'EDUCATION', basis: 'REJECTED_EDUCATION', deadline: rejectedUntil }),
  ];

  const journalApp = insertApplication(db, { activity });
  const journalId = randomUUID(), journalPath = `${journalApp.id}/${journalId}`;
  db.prepare(`INSERT INTO pandit_storage_uploads(id,application_id,kind,content_type,storage_path,retention_basis,created_at,delete_after)
    VALUES(?,?,?,'application/pdf',?,'PENDING',?,?)`).run(journalId, journalApp.id, 'GOVERNMENT_ID', journalPath, activity, pendingUntil);
  harness.seedObject(journalPath, PDF);

  const simulation = insertApplication(db, { isSimulation: 1, activity });
  const simulationEvidence = insertEvidence(db, harness, simulation, { basis: 'PENDING', deadline: pendingUntil });

  clock = '2035-02-28T23:59:59.999Z';
  const beforeApproved = await run.runOnce();
  assert.equal(beforeApproved.deletedEvidence, 0, 'the exact 3-calendar-year boundary is not crossed early');
  assert.ok(harness.objects.has(`${BUCKET}/${approvedEvidence.storage_path}`));

  clock = approvedUntil;
  const approvedResult = await run.runOnce();
  assert.equal(approvedResult.deletedEvidence, 1);
  assert.equal(harness.objects.has(`${BUCKET}/${approvedEvidence.storage_path}`), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence WHERE application_id=?').get(approved.id).n, 0);
  assert.equal(db.prepare('SELECT status,approved_record_until FROM pandit_applications WHERE id=?').get(approved.id).status, 'ACTION_REQUIRED');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pandit_reviews WHERE application_id=? AND event='APPROVED_RETENTION_EXPIRED'").get(approved.id).n, 1);

  clock = '2035-03-31T23:59:59.999Z';
  const before90 = await run.runOnce();
  assert.equal(before90.deletedEvidence, 0, 'pending and rejected evidence remains one millisecond before 90 days');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence WHERE application_id=?').get(pending.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence WHERE application_id=?').get(rejected.id).n, 3);

  clock = pendingUntil;
  failStorage = true;
  await assert.rejects(() => run.runOnce(), /Synthetic Storage outage/);
  assert.equal(db.prepare('SELECT * FROM pandit_storage_uploads WHERE id=?').get(journalId).id, journalId);
  assert.ok(harness.objects.has(`${BUCKET}/${journalPath}`));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence WHERE application_id=?').get(pending.id).n, 1);
  assert.ok(harness.objects.has(`${BUCKET}/${pendingEvidence.storage_path}`));

  failStorage = false;
  const completed = await run.runOnce();
  assert.equal(completed.deletedReservations, 1);
  assert.equal(completed.deletedEvidence, 4);
  assert.equal(completed.skippedUnsafe, 0);
  assert.equal(db.prepare('SELECT * FROM pandit_storage_uploads WHERE id=?').get(journalId), undefined);
  assert.equal(db.prepare('SELECT * FROM pandit_evidence WHERE application_id=?').all(pending.id).length, 0);
  assert.equal(db.prepare('SELECT * FROM pandit_evidence WHERE application_id=?').all(rejected.id).length, 0);
  assert.equal(db.prepare('SELECT appeal_until,rejected_evidence_until,status FROM pandit_applications WHERE id=?').get(rejected.id).appeal_until, addDays(rejectedAt, 30));
  assert.equal(db.prepare('SELECT rejected_evidence_until,status FROM pandit_applications WHERE id=?').get(rejected.id).status, 'REJECTED');
  assert.equal(db.prepare('SELECT * FROM pandit_evidence WHERE id=?').get(simulationEvidence.id).id, simulationEvidence.id, 'production scope never selects synthetic simulation rows');
  assert.ok(harness.objects.has(`${BUCKET}/${simulationEvidence.storage_path}`));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pandit_reviews WHERE application_id=? AND event='REJECTED_EVIDENCE_PURGED'").get(rejected.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pandit_reviews WHERE application_id=? AND event='PENDING_EVIDENCE_PURGED'").get(pending.id).n, 1);
});

test('worker is inert when disabled and blocks until every owner-approved policy value is present', async () => {
  let transactions = 0;
  const disabled = createPanditRetentionWorker({
    transaction: async () => { transactions += 1; throw new Error('must not transact'); },
    isProduction: true, enabled: false,
  });
  assert.deepEqual(await disabled.runOnce(), { skipped: true, reason: 'worker-disabled' });
  assert.equal(transactions, 0);

  const { db, transaction } = databaseFixture();
  try {
    db.prepare('UPDATE pandit_policy SET approved_retention_years=NULL,pending_evidence_retention_days=NULL').run();
    const harness = createPanditStorageHarness();
    const blocked = worker({ db, transaction, harness, now: () => '2035-01-01T00:00:00.000Z' });
    const result = await blocked.runOnce();
    assert.deepEqual(result, { skipped: true, reason: 'approved-policy-not-ready', deletedEvidence: 0, deletedReservations: 0, skippedUnsafe: 0 });
    assert.equal(harness.calls.length, 0, 'policy gate runs before any Storage operation');
  } finally { db.close(); }
});

test('worker blocks cleanup when the approved two-year recheck policy has drifted', async t => {
  const { db, transaction } = databaseFixture();
  t.after(() => db.close());
  const harness = createPanditStorageHarness();
  const activity = '2035-01-01T00:00:00.000Z';
  const app = insertApplication(db, { activity });
  const evidence = insertEvidence(db, harness, app, { basis: 'PENDING', deadline: addDays(activity, 90) });
  db.exec('PRAGMA ignore_check_constraints=ON');
  db.prepare('UPDATE pandit_policy SET recheck_years=1 WHERE id=1').run();
  db.exec('PRAGMA ignore_check_constraints=OFF');

  const result = await worker({ db, transaction, harness, now: () => addDays(activity, 100) }).runOnce();
  assert.deepEqual(result, { skipped: true, reason: 'approved-policy-not-ready', deletedEvidence: 0, deletedReservations: 0, skippedUnsafe: 0 });
  assert.equal(harness.calls.length, 0, 'policy drift blocks before any Storage operation');
  assert.equal(db.prepare('SELECT id FROM pandit_evidence WHERE id=?').get(evidence.id).id, evidence.id);
});

test('production cleanup retains due evidence whose storage source is malformed', async t => {
  const { db, transaction } = databaseFixture();
  t.after(() => db.close());
  const harness = createPanditStorageHarness();
  const activity = '2035-01-01T00:00:00.000Z';
  const app = insertApplication(db, { activity });
  const evidence = insertEvidence(db, harness, app, { basis: 'PENDING', deadline: addDays(activity, 90) });
  db.exec('PRAGMA ignore_check_constraints=ON');
  db.prepare('UPDATE pandit_evidence SET storage_path=NULL,content_base64=NULL WHERE id=?').run(evidence.id);

  const result = await worker({ db, transaction, harness, now: () => addDays(activity, 100) }).runOnce();
  assert.equal(result.deletedEvidence, 0);
  assert.equal(result.skippedUnsafe, 1);
  assert.equal(harness.calls.length, 0, 'malformed source prevents Storage deletion');
  assert.equal(db.prepare('SELECT id FROM pandit_evidence WHERE id=?').get(evidence.id).id, evidence.id);
  assert.ok(harness.objects.has(`${BUCKET}/${evidence.storage_path}`));
});

test('Supabase Edge Function worker module cleans only due canonical synthetic evidence', async t => {
  const { createPanditRetentionWorker: createEdgeWorker } = await import('../supabase/functions/pandit-retention-cleanup/retention-worker.mjs');
  const { db, transaction } = databaseFixture();
  t.after(() => db.close());
  const harness = createPanditStorageHarness();
  const activity = '2035-01-01T00:00:00.000Z';
  const app = insertApplication(db, { activity });
  const evidence = insertEvidence(db, harness, app, { basis: 'PENDING', deadline: addDays(activity, 90) });
  const stamp = addDays(activity, 100);
  const privateEvidenceStorage = createPanditPrivateStorage({
    storage: harness.storage('service').storage,
    isProduction: true,
    allowProductionEvidence: true,
    now: () => Date.parse(stamp),
  });
  const run = createEdgeWorker({ transaction, privateEvidenceStorage, isProduction: true,
    enabled: true, allowSimulations: false, acquireLock: async () => true, now: () => stamp });

  const result = await run.runOnce();
  assert.equal(result.deletedEvidence, 1);
  assert.equal(result.skippedUnsafe, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence WHERE id=?').get(evidence.id).n, 0);
  assert.equal(harness.objects.has(`${BUCKET}/${evidence.storage_path}`), false);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].method, 'DELETE');
});

test('internal production worker hook stays disabled by default and Pandit routes remain guarded', async t => {
  const app = createApp({ nodeEnv: 'production', env: {} });
  t.after(() => app.closeDatabase());
  assert.deepEqual(await app.runPanditRetentionWorker(), { skipped: true, reason: 'worker-disabled' });
  const invoke = createFetchHandler(() => app);
  const cron = await invoke(new Request('http://localhost/api/internal/pandit-retention'));
  assert.equal(cron.status, 503, 'missing CRON_SECRET fails closed');
  const response = await invoke(new Request('http://localhost/api/pandits'));
  assert.equal(response.status, 503);
});

test('production cleanup invocation requires the exact bearer secret and explicit enable flag', async t => {
  const secret = 'synthetic-cron-secret-at-least-16-chars';
  const app = createApp({ nodeEnv: 'production', env: { CRON_SECRET: secret, PANDIT_RETENTION_WORKER_ENABLED: 'false' } });
  t.after(() => app.closeDatabase());
  const invoke = createFetchHandler(() => app);
  const url = 'http://localhost/api/internal/pandit-retention';

  let response = await invoke(new Request(url));
  assert.equal(response.status, 401);
  response = await invoke(new Request(url, { headers: { Authorization: 'Bearer wrong-secret' } }));
  assert.equal(response.status, 401);
  response = await invoke(new Request(url, { headers: { Authorization: `Bearer ${secret}` } }));
  assert.equal(response.status, 503, 'valid authentication cannot override the disabled worker flag');
  response = await invoke(new Request(url, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');

  const enabledApp = createApp({ nodeEnv: 'production', env: { CRON_SECRET: secret, PANDIT_RETENTION_WORKER_ENABLED: 'true' } });
  t.after(() => enabledApp.closeDatabase());
  const enabledInvoke = createFetchHandler(() => enabledApp);
  response = await enabledInvoke(new Request('http://localhost/api/pandits'));
  assert.equal(response.status, 503, 'the cleanup flag never opens the Pandit application routes');
  response = await enabledInvoke(new Request(url, { headers: { Authorization: `Bearer ${secret}` } }));
  assert.equal(response.status, 503, 'a missing production backend prevents the worker from running');
});

test('daily Cron route runs only when explicitly enabled and authenticated, with no real evidence records', async t => {
  const secret = 'synthetic-test-cron-secret-32-bytes';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-retention-cron-'));
  const app = createApp({ nodeEnv: 'test', env: {}, dataDir, enablePanditRetentionWorker: true,
    allowPanditSimulations: true, retentionCronSecret: secret });
  app.database.prepare('UPDATE pandit_policy SET recheck_years=? WHERE id=1').run(POLICY.recheck_years);
  t.after(() => {
    app.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const cronConfig = require('../vercel.json').crons ?? [];
  assert.deepEqual(cronConfig, [], 'the active Supabase schedule must not have a redundant Vercel Cron');
  const invoke = createFetchHandler(() => app);
  const url = 'http://localhost/api/internal/pandit-retention';
  let response = await invoke(new Request(url, { headers: { Authorization: 'Bearer invalid-secret' } }));
  assert.equal(response.status, 401);
  response = await invoke(new Request(url, { headers: { Authorization: `Bearer ${secret}` } }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.result.skipped, false);
  assert.equal(payload.result.deletedEvidence, 0);
  assert.equal(payload.result.deletedReservations, 0);
  for (const table of ['pandit_applications', 'pandit_evidence', 'pandit_storage_uploads']) {
    assert.equal(app.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} stays empty`);
  }
});
