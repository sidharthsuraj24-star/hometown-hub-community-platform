'use strict';

const STATUSES = ['PENDING_VERIFICATION', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED'];
const KINDS = ['GOVERNMENT_ID', 'BACKGROUND_CHECK', 'EDUCATION'];
const DAY = 86400000;
const APPROVED_POLICY = Object.freeze({ approved_retention_years: 3, approved_retention_days: null, pending_evidence_retention_days: 90, rejected_evidence_retention_days: 90, rejected_background_check_retention_days: 90, rejected_education_retention_days: 90, appeal_days: 30, recheck_years: 2 });
const addDays = (timestamp, days) => new Date(Date.parse(timestamp) + days * DAY).toISOString();
// Calendar anniversaries in UTC: a leap-day anniversary clamps to February 28.
function addYears(timestamp, years) {
  const date = new Date(timestamp), month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + years);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString();
}
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pandit_applications (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 display_name TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
 traditions TEXT NOT NULL DEFAULT '', languages TEXT NOT NULL DEFAULT '', ritual_skills TEXT NOT NULL DEFAULT '',
 experience_years INTEGER NOT NULL DEFAULT 0 CHECK(experience_years BETWEEN 0 AND 80),
 status TEXT NOT NULL DEFAULT 'ACTION_REQUIRED' CHECK(status IN ('PENDING_VERIFICATION','ACTION_REQUIRED','APPROVED','REJECTED')),
 revision INTEGER NOT NULL DEFAULT 1, review_feedback TEXT NOT NULL DEFAULT '',
 is_simulation INTEGER NOT NULL DEFAULT 0 CHECK(is_simulation IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT, approved_at TEXT,
 rejected_at TEXT, appeal_until TEXT, reverify_at TEXT, approved_record_until TEXT, rejected_evidence_until TEXT,
 last_activity_at TEXT, evidence_expired_at TEXT
);
CREATE TABLE IF NOT EXISTS pandit_evidence (
 id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES pandit_applications(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('GOVERNMENT_ID','BACKGROUND_CHECK','EDUCATION')),
 content_type TEXT NOT NULL, content_base64 TEXT, storage_path TEXT,
 retention_basis TEXT CHECK(retention_basis IN ('APPROVED','PENDING','REJECTED_GOVERNMENT_ID','REJECTED_BACKGROUND_CHECK','REJECTED_EDUCATION')),
 verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
 verified_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, delete_after TEXT,
 CHECK((storage_path IS NULL) <> (content_base64 IS NULL)),
 CHECK(retention_basis <> 'REJECTED_GOVERNMENT_ID' OR kind='GOVERNMENT_ID'),
 CHECK(retention_basis <> 'REJECTED_BACKGROUND_CHECK' OR kind='BACKGROUND_CHECK'),
 CHECK(retention_basis <> 'REJECTED_EDUCATION' OR kind='EDUCATION'),
 UNIQUE(application_id,kind)
);
-- Local integration outbox only. Reserved before Storage upload, then removed in
-- the same transaction that commits evidence metadata. Never contains bytes.
CREATE TABLE IF NOT EXISTS pandit_storage_uploads (
 id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES pandit_applications(id),
 kind TEXT NOT NULL, content_type TEXT NOT NULL, storage_path TEXT NOT NULL UNIQUE,
 retention_basis TEXT NOT NULL CHECK(retention_basis='PENDING'),
 created_at TEXT NOT NULL, delete_after TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pandit_roles (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('CHECKER','COMPLIANCE','SUPER_ADMIN'))
);
CREATE TABLE IF NOT EXISTS pandit_policy (
 id INTEGER PRIMARY KEY CHECK(id=1), approved_retention_days INTEGER,
 approved_retention_years INTEGER,
 rejected_evidence_retention_days INTEGER, appeal_days INTEGER,
 pending_evidence_retention_days INTEGER DEFAULT 90 CHECK(pending_evidence_retention_days > 0),
 rejected_background_check_retention_days INTEGER DEFAULT 90 CHECK(rejected_background_check_retention_days > 0),
 rejected_education_retention_days INTEGER DEFAULT 90 CHECK(rejected_education_retention_days > 0),
 recheck_years INTEGER NOT NULL DEFAULT ${APPROVED_POLICY.recheck_years} CHECK(recheck_years = ${APPROVED_POLICY.recheck_years})
);
INSERT OR IGNORE INTO pandit_policy(id) VALUES(1);
CREATE TABLE IF NOT EXISTS pandit_reviews (
 id TEXT PRIMARY KEY, application_id TEXT REFERENCES pandit_applications(id) ON DELETE SET NULL,
 actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, event TEXT NOT NULL,
 from_status TEXT NOT NULL DEFAULT '', to_status TEXT NOT NULL DEFAULT '',
 feedback TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pandit_status ON pandit_applications(status,updated_at);
CREATE INDEX IF NOT EXISTS idx_pandit_reviews ON pandit_reviews(application_id,created_at);
`;

// Local schema upgrade preserves profile/audit history, but never grandfather-approves
// previously unverified profiles or retains obsolete, unstructured sensitive notes.
function initializePanditSchema(db, bootstrapEmail) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pandit_applications'").get();
  const policyExisted = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pandit_policy'").get();
  const policyRowExisted = policyExisted && db.prepare('SELECT id FROM pandit_policy WHERE id=1').get();
  const legacy = exists && !db.prepare('PRAGMA table_info(pandit_applications)').all().some(c => c.name === 'ritual_skills');
  if (legacy) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TEMP TABLE old_pandit_profiles AS SELECT * FROM pandit_applications;
        CREATE TEMP TABLE old_pandit_reviews AS SELECT * FROM pandit_reviews;
        DROP TABLE pandit_reviews; DROP TABLE pandit_applications;`);
      db.exec(SQLITE_SCHEMA);
      db.exec(`INSERT INTO pandit_applications(id,user_id,display_name,location,description,traditions,languages,experience_years,status,revision,review_feedback,created_at,updated_at,submitted_at)
        SELECT id,user_id,display_name,location,description,traditions,languages,experience_years,
        'ACTION_REQUIRED',
        revision+1,'',created_at,updated_at,NULL FROM old_pandit_profiles;
        INSERT INTO pandit_reviews(id,application_id,actor_id,event,from_status,to_status,created_at)
        SELECT id,application_id,actor_id,'LEGACY_REVIEW',
        CASE from_status WHEN 'pending' THEN 'PENDING_VERIFICATION' WHEN 'in_review' THEN 'PENDING_VERIFICATION' WHEN 'approved' THEN 'APPROVED' WHEN 'rejected' THEN 'REJECTED' ELSE 'ACTION_REQUIRED' END,
        CASE to_status WHEN 'pending' THEN 'PENDING_VERIFICATION' WHEN 'in_review' THEN 'PENDING_VERIFICATION' WHEN 'approved' THEN 'APPROVED' WHEN 'rejected' THEN 'REJECTED' ELSE 'ACTION_REQUIRED' END,created_at FROM old_pandit_reviews;
        DROP TABLE old_pandit_profiles; DROP TABLE old_pandit_reviews;`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } else db.exec(SQLITE_SCHEMA);
  if (!db.prepare('PRAGMA table_info(pandit_evidence)').all().some(c => c.name === 'delete_after')) db.exec('ALTER TABLE pandit_evidence ADD COLUMN delete_after TEXT');
  if (!db.prepare('PRAGMA table_info(pandit_applications)').all().some(c => c.name === 'evidence_expired_at')) db.exec('ALTER TABLE pandit_applications ADD COLUMN evidence_expired_at TEXT');
  if (!db.prepare('PRAGMA table_info(pandit_applications)').all().some(c => c.name === 'last_activity_at')) db.exec('ALTER TABLE pandit_applications ADD COLUMN last_activity_at TEXT');
  for (const field of ['storage_path','retention_basis']) {
    if (!db.prepare('PRAGMA table_info(pandit_evidence)').all().some(c => c.name === field)) db.exec(`ALTER TABLE pandit_evidence ADD COLUMN ${field} TEXT`);
  }
  // SQLite cannot alter a CHECK constraint. Rebuild only this local table when an
  // older enum lacks the kind bindings; copy every row and preserve invalid legacy
  // labels as NULL rather than dropping data or touching unrelated tables.
  const evidenceSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pandit_evidence'").get()?.sql || '';
  if (!/retention_basis\s+TEXT\s+CHECK\(retention_basis IN \([^)]*REJECTED_BACKGROUND_CHECK[^)]*REJECTED_EDUCATION/i.test(evidenceSql) || !/REJECTED_BACKGROUND_CHECK.*kind\s*=\s*'BACKGROUND_CHECK'/i.test(evidenceSql) || !/REJECTED_EDUCATION.*kind\s*=\s*'EDUCATION'/i.test(evidenceSql)) {
    db.exec('BEGIN IMMEDIATE');
    try {
    db.exec(`ALTER TABLE pandit_evidence RENAME TO pandit_evidence_old;
      CREATE TABLE pandit_evidence (
       id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES pandit_applications(id) ON DELETE CASCADE,
       kind TEXT NOT NULL CHECK(kind IN ('GOVERNMENT_ID','BACKGROUND_CHECK','EDUCATION')),
       content_type TEXT NOT NULL, content_base64 TEXT, storage_path TEXT,
       retention_basis TEXT CHECK(retention_basis IN ('APPROVED','PENDING','REJECTED_GOVERNMENT_ID','REJECTED_BACKGROUND_CHECK','REJECTED_EDUCATION')),
       verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)), verified_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, delete_after TEXT,
       CHECK((storage_path IS NULL) <> (content_base64 IS NULL)),
       CHECK(retention_basis <> 'REJECTED_GOVERNMENT_ID' OR kind='GOVERNMENT_ID'),
       CHECK(retention_basis <> 'REJECTED_BACKGROUND_CHECK' OR kind='BACKGROUND_CHECK'),
       CHECK(retention_basis <> 'REJECTED_EDUCATION' OR kind='EDUCATION'), UNIQUE(application_id,kind)
      );
      INSERT INTO pandit_evidence(id,application_id,kind,content_type,content_base64,storage_path,retention_basis,verified,verified_by,created_at,delete_after)
      SELECT id,application_id,kind,content_type,content_base64,storage_path,
       CASE WHEN retention_basis IN ('APPROVED','PENDING') OR (retention_basis='REJECTED_GOVERNMENT_ID' AND kind='GOVERNMENT_ID') OR (retention_basis='REJECTED_BACKGROUND_CHECK' AND kind='BACKGROUND_CHECK') OR (retention_basis='REJECTED_EDUCATION' AND kind='EDUCATION') THEN retention_basis ELSE NULL END,
       verified,verified_by,created_at,delete_after FROM pandit_evidence_old;
      DROP TABLE pandit_evidence_old;`);
    db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  for (const field of ['pending_evidence_retention_days','rejected_background_check_retention_days','rejected_education_retention_days']) {
    if (!db.prepare('PRAGMA table_info(pandit_policy)').all().some(c => c.name === field)) db.exec(`ALTER TABLE pandit_policy ADD COLUMN ${field} INTEGER DEFAULT 90 CHECK(${field} > 0)`);
  }
  const upgradedPolicy = !db.prepare('PRAGMA table_info(pandit_policy)').all().some(c => c.name === 'approved_retention_years');
  if (upgradedPolicy) db.exec('ALTER TABLE pandit_policy ADD COLUMN approved_retention_years INTEGER');
  // Apply the owner's approved local policy once. Do not rewrite case deadlines,
  // seed applications, or overwrite subsequent explicit Super Admin settings.
  if (!policyExisted || !policyRowExisted) {
    db.prepare('UPDATE pandit_policy SET approved_retention_years=CASE WHEN approved_retention_years IS NULL AND approved_retention_days IS NULL THEN 3 ELSE approved_retention_years END,rejected_evidence_retention_days=COALESCE(rejected_evidence_retention_days,90),appeal_days=COALESCE(appeal_days,30),pending_evidence_retention_days=COALESCE(pending_evidence_retention_days,90),rejected_background_check_retention_days=COALESCE(rejected_background_check_retention_days,90),rejected_education_retention_days=COALESCE(rejected_education_retention_days,90) WHERE id=1').run();
  }
  // Normalize the prior local one-year default to the approved two-year cadence.
  db.prepare('UPDATE pandit_policy SET recheck_years=? WHERE id=1 AND recheck_years<>?').run(APPROVED_POLICY.recheck_years, APPROVED_POLICY.recheck_years);
  if (bootstrapEmail) db.prepare("INSERT OR IGNORE INTO pandit_roles(user_id,role) SELECT id,'SUPER_ADMIN' FROM users WHERE email=? AND role='admin'").run(bootstrapEmail);
}

const OWNER_FIELDS = 'id,user_id,display_name,location,description,traditions,languages,ritual_skills,experience_years,status,revision,review_feedback,is_simulation,created_at,updated_at,submitted_at,approved_at,rejected_at,appeal_until,reverify_at,approved_record_until,rejected_evidence_until,last_activity_at,evidence_expired_at';
function createPanditRoutes({ one, many, transaction, requireUser, send, fail, uuid, now, isProduction, allowSimulations = false, allowProductionEvidence = false, afterPurge = () => {}, privateEvidenceStorage = null, allowInlineSimulationEvidence = false }) {
  let queue = Promise.resolve();
  const mutate = (fn, afterCommit = () => {}) => { const result = queue.then(async () => { const value = await transaction(fn); await afterCommit(); return value; }); queue = result.catch(() => {}); return result; };
  const policy = (tx = { one }) => tx.one('SELECT approved_retention_years,approved_retention_days,rejected_evidence_retention_days,appeal_days,recheck_years,pending_evidence_retention_days,rejected_background_check_retention_days,rejected_education_retention_days FROM pandit_policy WHERE id=1');
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const configured = p => Boolean(p) && ((positive(p.approved_retention_years) && p.approved_retention_days == null) || (positive(p.approved_retention_days) && p.approved_retention_years == null)) && ['pending_evidence_retention_days','rejected_evidence_retention_days','rejected_background_check_retention_days','rejected_education_retention_days','appeal_days'].every(k => positive(p[k])) && Number(p.recheck_years) === APPROVED_POLICY.recheck_years;
  const requirePolicy = async tx => { const p = await policy(tx); if (!configured(p)) fail(503, 'Owner must configure exact retention and appeal periods before evidence collection or review.'); return p; };
  const refreshPendingEvidence = async (tx, id, stamp, configuredPolicy = null) => {
    const p = configuredPolicy || await policy(tx);
    if (positive(p?.pending_evidence_retention_days)) {
      const deadline = addDays(stamp, p.pending_evidence_retention_days);
      await tx.run("UPDATE pandit_evidence SET delete_after=? WHERE application_id=? AND retention_basis='PENDING'", deadline, id);
      await tx.run('UPDATE pandit_storage_uploads SET delete_after=? WHERE application_id=?', deadline, id);
    }
  };
  // Production evidence is allowed only by the production adapter after its dedicated connector is configured.
  // Otherwise, only explicitly enabled disposable simulations may proceed.
  const requireSimulation = a => {
    const realProductionEvidence = isProduction && allowProductionEvidence && a && Number(a.is_simulation) === 0;
    if (!realProductionEvidence && (!allowSimulations || !a || Number(a.is_simulation) !== 1)) {
      fail(503, 'Real evidence is disabled pending release and migration authorization.');
    }
  };
  const roleOf = async user => (await one('SELECT role FROM pandit_roles WHERE user_id=?', user.id))?.role || null;
  const staff = async (req, roles) => { const user = await requireUser(req); const role = await roleOf(user); if (!roles.includes(role)) fail(403, 'This operation requires an assigned Pandit reviewer role.'); return { user, role }; };
  const revision = body => { if (!Number.isInteger(body.revision) || body.revision < 0) fail(400, 'Provide the current application revision.'); return body.revision; };
  const bounded = (value, max, label) => { if (value === undefined) return ''; if (typeof value !== 'string' || value.trim().length > max) fail(400, `${label} must be text of at most ${max} characters.`); return value.trim(); };
  // Feedback stays on the applicant-owned case only; audit is metadata-only by design.
  const audit = (tx, application, actor, event, status = application?.status || '', feedback = '') => tx.run('INSERT INTO pandit_reviews(id,application_id,actor_id,event,from_status,to_status,feedback,created_at) VALUES(?,?,?,?,?,?,?,?)', uuid(), application?.id || null, actor?.id || null, event, application?.status || '', status, '', now());
  const evidenceMetadata = id => many('SELECT id,kind,verified,delete_after FROM pandit_evidence WHERE application_id=? ORDER BY kind', id);
  const decorate = async a => {
    a.evidence = await evidenceMetadata(a.id);
    const appealed = a.rejected_at && await one("SELECT id FROM pandit_reviews WHERE application_id=? AND event='APPEALED' AND created_at>=? LIMIT 1", a.id, a.rejected_at);
    a.appeal_status = !a.appeal_until ? 'NOT_APPLICABLE' : appealed && a.status !== 'REJECTED' ? 'OPENED' : a.status === 'REJECTED' && a.appeal_until > now() ? 'OPEN' : 'CLOSED';
    return a;
  };
  const own = async userId => { const a = await one(`SELECT ${OWNER_FIELDS} FROM pandit_applications WHERE user_id=?`, userId); return a ? decorate(a) : null; };
  const activeOwner = async (tx, user) => {
    const current = await tx.one('SELECT disabled FROM users WHERE id=?', user.id);
    if (!current || current.disabled) fail(403, 'This account is no longer authorized.');
  };
  const sameRevision = (a, expected) => { if ((a?.revision || 0) !== expected) fail(409, 'This application changed. Refresh before continuing.'); };
  const applicationForReview = async (tx, id, user, expected) => {
    const a = await tx.one('SELECT * FROM pandit_applications WHERE id=?', id);
    if (!a) fail(404, 'Application not found.');
    if (a.user_id === user.id) fail(403, 'You cannot inspect or review your own application as staff.');
    requireSimulation(a);
    sameRevision(a, expected);
    const applicant = await tx.one('SELECT disabled FROM users WHERE id=?', a.user_id);
    if (!applicant || applicant.disabled) fail(409, 'Disabled accounts cannot be reviewed.');
    return a;
  };
  const resetEvidence = (tx, id) => tx.run('UPDATE pandit_evidence SET verified=0,verified_by=NULL WHERE application_id=?', id);
  const sweep = async () => {
    // This local task authorizes automatic mutation of disposable simulations only.
    // Normal local records and every production adapter remain untouched.
    if (isProduction || !allowSimulations) return;
    let purged = false;
    await mutate(async tx => {
      const stamp = now();
      // A committed reservation survives upload success followed by DB rollback.
      // Failed/ambiguous uploads keep this binding until the pending deadline.
      const abandoned = await tx.many('SELECT j.* FROM pandit_storage_uploads j JOIN pandit_applications a ON a.id=j.application_id WHERE a.is_simulation=1 AND j.delete_after<=?', stamp);
      for (const evidence of abandoned) {
        if (await tx.one('SELECT id FROM pandit_evidence WHERE id=?', evidence.id)) fail(503, 'Upload cleanup binding requires investigation; metadata retained.');
        if (!privateEvidenceStorage) fail(503, 'Private evidence storage is unavailable; upload cleanup retained.');
        const application = await tx.one('SELECT * FROM pandit_applications WHERE id=?', evidence.application_id);
        await privateEvidenceStorage.removeExpired({ application, evidence, now: stamp });
        await tx.run('DELETE FROM pandit_storage_uploads WHERE id=?', evidence.id);
        purged = true;
      }
      const expired = await tx.many(`SELECT * FROM pandit_applications a WHERE a.is_simulation=1 AND
        (a.approved_record_until<=? OR a.rejected_evidence_until<=? OR EXISTS
        (SELECT 1 FROM pandit_evidence e WHERE e.application_id=a.id AND e.delete_after<=?))`, stamp, stamp, stamp);
      for (const a of expired) {
        const candidates = await tx.many('SELECT * FROM pandit_evidence WHERE application_id=? AND delete_after<=?', a.id, stamp);
        // Never interpret a bare expiry as authorization to purge an undecided class.
        // Legacy local snapshots are recognized only by their matching case deadline.
        const basisKind = { REJECTED_GOVERNMENT_ID: 'GOVERNMENT_ID', REJECTED_BACKGROUND_CHECK: 'BACKGROUND_CHECK', REJECTED_EDUCATION: 'EDUCATION' };
        const due = candidates.filter(e => e.retention_basis === 'APPROVED' || e.retention_basis === 'PENDING' ||
          (basisKind[e.retention_basis] === e.kind) ||
          e.retention_basis == null && (a.approved_record_until === e.delete_after ||
            e.kind === 'GOVERNMENT_ID' && a.rejected_evidence_until === e.delete_after));
        const approvedDue = a.approved_record_until && a.approved_record_until <= stamp;
        const rejectedDue = a.rejected_evidence_until && a.rejected_evidence_until <= stamp;
        for (const evidence of due) {
          if (evidence.storage_path) {
            if (!privateEvidenceStorage) fail(503, 'Private evidence storage is unavailable; metadata retained for deletion retry.');
            await privateEvidenceStorage.removeExpired({ application: a, evidence: { ...evidence, retention_basis: evidence.retention_basis || (a.approved_record_until === evidence.delete_after ? 'APPROVED' : 'REJECTED_GOVERNMENT_ID') }, now: stamp });
          }
          // Remove the blob first; failed storage calls preserve retryable metadata.
          await tx.run('DELETE FROM pandit_evidence WHERE id=? AND application_id=? AND delete_after<=? AND EXISTS (SELECT 1 FROM pandit_applications WHERE id=? AND is_simulation=1)', evidence.id, a.id, stamp, a.id);
          purged = true;
        }
        const status = (a.status === 'APPROVED' || due.some(e => e.retention_basis === 'PENDING')) && (approvedDue || due.length) ? 'ACTION_REQUIRED' : a.status;
        if (!due.length && !approvedDue && !rejectedDue) continue;
        await tx.run(`UPDATE pandit_applications SET status=?,revision=revision+1,updated_at=?,
          approved_record_until=?,rejected_evidence_until=?,evidence_expired_at=?,
          review_feedback=CASE WHEN ?=1 THEN '' ELSE review_feedback END WHERE id=? AND is_simulation=1`,
        status, stamp, approvedDue ? null : a.approved_record_until, rejectedDue ? null : a.rejected_evidence_until,
        due.length ? stamp : a.evidence_expired_at, due.length || approvedDue || rejectedDue ? 1 : 0, a.id);
        if (status !== a.status) await resetEvidence(tx, a.id);
        if (approvedDue) await audit(tx, a, null, 'APPROVED_RETENTION_EXPIRED', status);
        if (rejectedDue) await audit(tx, a, null, 'REJECTED_EVIDENCE_PURGED', status);
        if (due.length && !approvedDue && !rejectedDue) await audit(tx, a, null, due.some(e => e.retention_basis === 'PENDING') ? 'PENDING_EVIDENCE_PURGED' : 'EVIDENCE_RETENTION_EXPIRED', status);
      }
      for (const a of await tx.many("SELECT * FROM pandit_applications WHERE is_simulation=1 AND status='APPROVED' AND reverify_at<=?", stamp)) {
        await tx.run("UPDATE pandit_applications SET status='ACTION_REQUIRED',revision=revision+1,updated_at=? WHERE id=? AND is_simulation=1", stamp, a.id);
        await resetEvidence(tx, a.id);
        await audit(tx, a, null, 'PERIODIC_REVERIFICATION', 'ACTION_REQUIRED');
      }
    }, async () => { if (purged) await afterPurge(); });
  };
  const forbiddenFields = body => {
    if (Object.keys(body).some(k => /bank|aadhaar|aadhar|pan_number|government_id_number|private_note|vetting_details/i.test(k))) fail(400, 'Do not submit bank details, ID numbers, or unstructured sensitive notes.');
    if (Object.hasOwn(body, 'is_simulation') && typeof body.is_simulation !== 'boolean') fail(400, 'is_simulation must be a boolean.');
    if (body.is_simulation === true && !allowSimulations) fail(403, 'Simulation data is accepted only in explicitly enabled disposable tests.');
  };
  return async function panditRoutes(req, res, parts, body) {
    const relevant = ['pandits','pandit-application'].includes(parts[1]) || (parts[1] === 'admin' && parts[2] === 'pandits');
    if (!relevant) return false;
    if (isProduction && !allowProductionEvidence) fail(503, 'Pandit evidence Storage is not enabled for production.');
    const user = await requireUser(req);
    await sweep();
    const method = req.method;
    if (method !== 'GET') forbiddenFields(body);
    if (parts[1] === 'pandits' && parts.length === 2 && method === 'GET') {
      const pandits = await many("SELECT p.id,p.display_name,p.location,p.description,p.traditions,p.languages,p.ritual_skills,p.experience_years,p.approved_at FROM pandit_applications p JOIN users u ON u.id=p.user_id WHERE p.status='APPROVED' AND p.reverify_at>? AND p.is_simulation=0 AND u.disabled=false ORDER BY p.display_name,p.id", now());
      send(res, 200, { pandits }); return true;
    }
    if (parts[1] === 'pandit-application' && parts.length === 2 && method === 'GET') {
      const application = await own(user.id);
      const reviews = application ? await many("SELECT from_status,to_status,feedback,created_at FROM pandit_reviews WHERE application_id=? AND event IN ('REVIEW','SUBMITTED','APPEALED','REVERIFICATION','PERIODIC_REVERIFICATION') ORDER BY created_at,id", application.id) : [];
      send(res, 200, { application, reviews, policy: await policy(), capabilities: { role: await roleOf(user) } }); return true;
    }
    if (parts[1] === 'pandit-application' && parts.length === 2 && method === 'POST') {
      const expected = revision(body);
      if (!['save','submit'].includes(body.action)) fail(400, 'Choose save or submit.');
      if (body.action === 'submit') await requirePolicy();
      const names = ['display_name','location','description','traditions','languages','ritual_skills'];
      const fields = names.map((name,i) => bounded(body[name], [80,120,1200,300,200,600][i], name));
      const years = body.experience_years;
      if (!Number.isInteger(years) || years < 0 || years > 80) fail(400, 'Experience must be a whole number from 0 to 80.');
      if (body.action === 'submit' && fields.some((v,i) => v.length < [2,2,20,2,2,2][i])) fail(400, 'Complete all profile fields and list the rituals you are trained to perform.');
      const status = body.action === 'submit' ? 'PENDING_VERIFICATION' : 'ACTION_REQUIRED';
      await mutate(async tx => {
        await activeOwner(tx,user);
        if (body.action === 'submit') await requirePolicy(tx);
        const existing = await tx.one('SELECT * FROM pandit_applications WHERE user_id=?', user.id);
        sameRevision(existing, expected);
        if (existing?.status === 'REJECTED') fail(409, 'Use the appeal process before changing a rejected application.');
        if (existing && Object.hasOwn(body,'is_simulation') && Number(body.is_simulation) !== existing.is_simulation) fail(400, 'Simulation designation cannot be changed.');
        if (status === 'PENDING_VERIFICATION') {
          requireSimulation(existing);
          const evidence = existing ? await tx.many('SELECT kind FROM pandit_evidence WHERE application_id=?', existing.id) : [];
          if (!KINDS.every(k => evidence.some(e => e.kind === k))) fail(400, 'Provide private government ID, background-check and education evidence before submitting.');
        }
        const stamp = now();
        if (!existing) {
          await tx.run('INSERT INTO pandit_applications(id,user_id,display_name,location,description,traditions,languages,ritual_skills,experience_years,status,is_simulation,created_at,updated_at,last_activity_at,submitted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', uuid(), user.id, ...fields, years, status, body.is_simulation === true ? 1 : 0, stamp, stamp, stamp, status === 'PENDING_VERIFICATION' ? stamp : null);
        } else {
          const updated = await tx.one('UPDATE pandit_applications SET display_name=?,location=?,description=?,traditions=?,languages=?,ritual_skills=?,experience_years=?,status=?,revision=revision+1,updated_at=?,last_activity_at=?,submitted_at=?,review_feedback=\'\',approved_at=NULL,reverify_at=NULL WHERE id=? AND revision=? RETURNING id', ...fields, years, status, stamp, stamp, status === 'PENDING_VERIFICATION' ? stamp : null, existing.id, expected);
          if (!updated) fail(409, 'Refresh before continuing.');
          await resetEvidence(tx, existing.id);
          await refreshPendingEvidence(tx, existing.id, stamp);
          await audit(tx, existing, user, status === 'PENDING_VERIFICATION' ? 'SUBMITTED' : 'PROFILE_SAVED', status);
        }
      });
      send(res, 200, { application: await own(user.id) }); return true;
    }
    if (parts[1] === 'pandit-application' && parts[2] === 'evidence' && parts.length === 3 && method === 'POST') {
      await requirePolicy();
      const expected = revision(body);
      if (!KINDS.includes(body.kind)) fail(400, 'Choose a supported evidence category.');
      if (!['application/pdf','image/png','image/jpeg'].includes(body.content_type)) fail(400, 'Only PDF, PNG and JPEG evidence is accepted.');
      if (typeof body.content_base64 !== 'string' || body.content_base64.length > 1400000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content_base64)) fail(400, 'Evidence must be base64 encoded and at most 1 MiB.');
      const bytes = Buffer.from(body.content_base64,'base64');
      const valid = body.content_type === 'application/pdf' ? bytes.subarray(0,5).toString() === '%PDF-' : body.content_type === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!valid || bytes.length > 1048576) fail(400, 'Evidence content does not match its declared file type or size.');
      const evidence = { id: uuid(), kind: body.kind, content_type: body.content_type };
      if (privateEvidenceStorage?.put) await mutate(async tx => {
        await activeOwner(tx, user);
        const p = await requirePolicy(tx);
        const a = await tx.one('SELECT * FROM pandit_applications WHERE user_id=?', user.id);
        if (!a) fail(404, 'Save a profile before uploading private evidence.');
        sameRevision(a, expected);
        requireSimulation(a);
        if (a.status !== 'ACTION_REQUIRED' || a.submitted_at) fail(409, 'Withdraw or open a permitted appeal before uploading evidence.');
        if ((await tx.one('SELECT storage_path FROM pandit_evidence WHERE application_id=? AND kind=?', a.id, body.kind))?.storage_path) fail(409, 'Stored evidence cannot be replaced before its authorized deletion.');
        // Preflight has no object writes; a missing guard/config must not leave a reservation.
        if (privateEvidenceStorage.preflight) await privateEvidenceStorage.preflight();
        evidence.application_id = a.id;
        const activity = a.last_activity_at || a.updated_at || a.created_at;
        if (!Number.isFinite(Date.parse(activity))) fail(503, 'Pending evidence retention cannot be evaluated safely.');
        const deadline = addDays(activity, p.pending_evidence_retention_days);
        if (deadline <= now()) fail(409, 'Save the profile before uploading after inactivity.');
        await tx.run('INSERT INTO pandit_storage_uploads(id,application_id,kind,content_type,storage_path,retention_basis,created_at,delete_after) VALUES(?,?,?,?,?,?,?,?)', evidence.id, a.id, body.kind, body.content_type, `${a.id}/${evidence.id}`, 'PENDING', now(), deadline);
      });
      await mutate(async tx => {
        await activeOwner(tx,user);
        await requirePolicy(tx);
        const a = await tx.one('SELECT * FROM pandit_applications WHERE user_id=?',user.id);
        if (!a) fail(404, 'Save a profile before uploading private evidence.');
        sameRevision(a, expected);
        requireSimulation(a);
        if (a.status === 'REJECTED') fail(409, 'Open a permitted appeal before replacing evidence.');
        const previous = await tx.one('SELECT storage_path FROM pandit_evidence WHERE application_id=? AND kind=?',a.id,body.kind);
        if (previous?.storage_path) fail(409, 'Stored evidence cannot be replaced before its authorized deletion; no blob or metadata was changed.');
        if (!privateEvidenceStorage?.put && !allowInlineSimulationEvidence) fail(503, 'Private evidence storage is unavailable.');
        evidence.application_id = a.id;
        if (privateEvidenceStorage?.put && !await tx.one('SELECT id FROM pandit_storage_uploads WHERE id=? AND application_id=? AND delete_after>?', evidence.id, a.id, now())) fail(409, 'Upload reservation expired; refresh before continuing.');
        const storagePath = privateEvidenceStorage?.put ? await privateEvidenceStorage.put({ application: a, evidence, actor: { ...user, disabled: false }, bytes }) : null;
        if (privateEvidenceStorage?.put && storagePath !== `${a.id}/${evidence.id}`) fail(503, 'Private evidence storage returned an invalid binding.');
        await tx.run('INSERT INTO pandit_evidence(id,application_id,kind,content_type,content_base64,storage_path,created_at,delete_after,retention_basis) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(application_id,kind) DO UPDATE SET id=excluded.id,content_type=excluded.content_type,content_base64=excluded.content_base64,storage_path=excluded.storage_path,verified=0,verified_by=NULL,created_at=excluded.created_at,delete_after=excluded.delete_after,retention_basis=excluded.retention_basis', evidence.id, a.id, body.kind, body.content_type, storagePath ? null : body.content_base64, storagePath, now(), addDays(now(), (await policy(tx)).pending_evidence_retention_days), 'PENDING');
        if (storagePath) await tx.run('DELETE FROM pandit_storage_uploads WHERE id=?', evidence.id);
        const stamp = now();
        await tx.run("UPDATE pandit_applications SET status='ACTION_REQUIRED',submitted_at=NULL,approved_at=NULL,reverify_at=NULL,revision=revision+1,updated_at=?,last_activity_at=? WHERE id=?",stamp,stamp,a.id);
        await refreshPendingEvidence(tx, a.id, stamp);
        // Aggregate dates describe current retained versions, never a replaced ID.
        if (a.approved_record_until && !await tx.one('SELECT id FROM pandit_evidence WHERE application_id=? AND delete_after=? LIMIT 1',a.id,a.approved_record_until)) {
          await tx.run('UPDATE pandit_applications SET approved_record_until=NULL WHERE id=?',a.id);
        }
        await resetEvidence(tx,a.id);
        await audit(tx,a,user,'EVIDENCE_REPLACED','ACTION_REQUIRED');
      });
      send(res,200,{application:await own(user.id)}); return true;
    }
    if (parts[1] === 'pandit-application' && ['withdraw','reverify','appeal'].includes(parts[2]) && parts.length === 3 && method === 'POST') {
      const expected = revision(body), action = parts[2];
      if (action === 'appeal') await requirePolicy();
      if (action === 'reverify' && !['BANK_DETAILS_CHANGED','OFFICIAL_ID_CHANGED'].includes(body.reason)) fail(400,'Choose a reverification trigger without supplying any bank or ID details.');
      await mutate(async tx => {
        await activeOwner(tx,user);
        if (action === 'appeal') await requirePolicy(tx);
        const a = await tx.one('SELECT * FROM pandit_applications WHERE user_id=?',user.id);
        if (!a) fail(404,'Application not found.');
        sameRevision(a,expected);
        if (a.status === 'REJECTED' && action !== 'appeal') fail(409,'Use the permitted appeal process.');
        if (action === 'appeal' && (a.status !== 'REJECTED' || !a.appeal_until || a.appeal_until <= now())) fail(409,'No open appeal window.');
        const stamp = now();
        await tx.run("UPDATE pandit_applications SET status='ACTION_REQUIRED',submitted_at=NULL,approved_at=NULL,reverify_at=NULL,revision=revision+1,updated_at=?,last_activity_at=? WHERE id=?",stamp,stamp,a.id);
        await refreshPendingEvidence(tx, a.id, stamp);
        await resetEvidence(tx,a.id);
        await audit(tx,a,user,action === 'appeal' ? 'APPEALED' : action === 'reverify' ? 'REVERIFICATION' : 'WITHDRAWN','ACTION_REQUIRED');
      });
      send(res,200,{application:await own(user.id)}); return true;
    }
    if (parts[1] === 'admin' && parts[2] === 'pandits') {
      const { user: reviewer, role } = await staff(req,['CHECKER','COMPLIANCE','SUPER_ADMIN']);
      const assertRole = async tx => {
        const current = await tx.one('SELECT r.role,u.disabled FROM pandit_roles r JOIN users u ON u.id=r.user_id WHERE r.user_id=?',reviewer.id);
        if (!current || current.disabled || current.role !== role) fail(403,'Reviewer permission changed. Refresh before continuing.');
      };
      if (parts.length === 3 && method === 'GET') {
        const applications = role === 'SUPER_ADMIN' ? [] : await many(`SELECT ${OWNER_FIELDS.split(',').map(f=>`p.${f}`).join(',')} FROM pandit_applications p JOIN users u ON u.id=p.user_id WHERE p.submitted_at IS NOT NULL AND p.user_id<>? AND u.disabled=false ORDER BY p.updated_at,p.id`,reviewer.id);
        for (const a of applications) await decorate(a);
        const reviews = role === 'SUPER_ADMIN' ? await many('SELECT id,application_id,actor_id,event,from_status,to_status,created_at FROM pandit_reviews ORDER BY created_at,id') : [];
        send(res,200,{applications,reviews,role,policy:await policy()}); return true;
      }
      if (parts[3] === 'policy' && parts.length === 4 && method === 'PUT') {
        if (role !== 'SUPER_ADMIN') fail(403,'Only Super Admins manage policy.');
        const keys = ['approved_retention_days','rejected_evidence_retention_days','appeal_days'];
        const undecided = ['pending_evidence_retention_days','rejected_background_check_retention_days','rejected_education_retention_days'];
        for (const k of undecided) if (body[k] != null && (!Number.isSafeInteger(body[k]) || body[k] < 1 || body[k] > 36500)) fail(400,'Undecided retention periods must be positive whole days or null.');
        for (const k of keys) if (body[k] !== null && (!Number.isSafeInteger(body[k]) || body[k] < 1 || body[k] > 36500)) fail(400,'Set explicit positive day counts or null; no legal periods are assumed.');
        const years = body.approved_retention_years ?? null;
        if (years !== null && (!Number.isSafeInteger(years) || years < 1 || years > 100)) fail(400,'Approved retention years must be a whole number from 1 to 100, or null.');
        if (years !== null && body.approved_retention_days !== null) fail(400,'Choose calendar years or legacy days, not both.');
        if (body.recheck_years !== APPROVED_POLICY.recheck_years) fail(400,'Reverification is fixed at every 2 years.');
        await mutate(async tx => {
          await assertRole(tx);
          await tx.run('INSERT INTO pandit_policy(id,approved_retention_days,rejected_evidence_retention_days,appeal_days,recheck_years,approved_retention_years) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET approved_retention_days=excluded.approved_retention_days,rejected_evidence_retention_days=excluded.rejected_evidence_retention_days,appeal_days=excluded.appeal_days,recheck_years=excluded.recheck_years,approved_retention_years=excluded.approved_retention_years',...keys.map(k=>body[k]),body.recheck_years,years);
          // Omission preserves prior settings; null explicitly leaves a decision open.
          for (const k of undecided) if (Object.hasOwn(body,k)) await tx.run(`UPDATE pandit_policy SET ${k}=? WHERE id=1`,body[k] ?? null);
          await audit(tx,null,reviewer,'POLICY_CHANGED');
        });
        send(res,200,{policy:await policy()}); return true;
      }
      if (parts[3] === 'roles' && parts.length === 4 && method === 'POST') {
        if (role !== 'SUPER_ADMIN') fail(403,'Only Super Admins assign reviewer roles.');
        if (body.user_id === reviewer.id) fail(403,'Self-role changes are prohibited.');
        if (![null,'CHECKER','COMPLIANCE'].includes(body.role)) fail(400,'Super Admin provisioning is not available through application requests.');
        await mutate(async tx => {
          await assertRole(tx);
          const target = await tx.one('SELECT id,disabled FROM users WHERE id=?',body.user_id);
          if (!target || target.disabled) fail(404,'Active user not found.');
          if ((await tx.one('SELECT role FROM pandit_roles WHERE user_id=?',body.user_id))?.role === 'SUPER_ADMIN') fail(403,'Super Admin roles require separate provisioning.');
          if (body.role === null) await tx.run('DELETE FROM pandit_roles WHERE user_id=?',body.user_id);
          else await tx.run('INSERT INTO pandit_roles(user_id,role) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role',body.user_id,body.role);
          // Minimal non-sensitive authorization target/role is retained, never evidence content.
          await audit(tx,null,reviewer,`ROLE_${body.role || 'REMOVED'}:${target.id}`);
        });
        send(res,200,{ok:true}); return true;
      }
      if (parts[4] === 'evidence' && parts[5] && (parts.length === 6 && method === 'GET' || parts.length === 7 && parts[6] === 'verify' && method === 'POST')) {
        if (role === 'SUPER_ADMIN') fail(403,'Super Admins do not automatically receive evidence access.');
        if (method === 'POST' && role !== 'CHECKER') fail(403,'Checkers verify evidence; Compliance makes final decisions.');
        if (method === 'POST') await requirePolicy();
        let evidence;
        await mutate(async tx => {
          await assertRole(tx);
          const a = await tx.one('SELECT * FROM pandit_applications WHERE id=?',parts[3]);
          if (!a || !a.submitted_at) fail(404,'Submitted application not found.');
          await applicationForReview(tx,a.id,reviewer,method === 'POST' ? revision(body) : a.revision);
          evidence = await tx.one('SELECT * FROM pandit_evidence WHERE application_id=? AND id=?',a.id,parts[5]);
          if (!evidence) fail(404,'Evidence not found.');
          if (evidence.delete_after && evidence.delete_after <= now()) fail(410,'This evidence has expired and is unavailable.');
          if (method === 'GET') {
            if (evidence.storage_path) {
              if (!privateEvidenceStorage) fail(503,'Private evidence storage is unavailable.');
              evidence.bytes = await privateEvidenceStorage.get({ application: a, evidence, actor: reviewer, role, now: now() });
            } else {
              if (!allowInlineSimulationEvidence) fail(503,'Inline evidence is unavailable outside explicit disposable fixtures.');
              evidence.bytes = Buffer.from(evidence.content_base64,'base64');
            }
          }
          if (method === 'POST') {
            await requirePolicy(tx);
            if (a.status !== 'PENDING_VERIFICATION') fail(409,'Only pending evidence can be checked.');
            if (typeof body.verified !== 'boolean') fail(400,'Record whether this evidence passed the check.');
            await tx.run('UPDATE pandit_evidence SET verified=?,verified_by=? WHERE id=?',body.verified ? 1 : 0,reviewer.id,evidence.id);
            await tx.run('UPDATE pandit_applications SET revision=revision+1,updated_at=? WHERE id=?',now(),a.id);
          }
          await audit(tx,a,reviewer,method === 'GET' ? 'EVIDENCE_ACCESSED' : body.verified ? `EVIDENCE_VERIFIED:${evidence.kind}` : `EVIDENCE_FAILED:${evidence.kind}`);
        });
        if (method === 'GET') {
          // Attachment only: no browser embedding or executable inline document context.
          res.writeHead(200,{'Content-Type':evidence.content_type,'Content-Disposition':`attachment; filename="private-${evidence.kind.toLowerCase()}.${evidence.content_type === 'application/pdf' ? 'pdf' : evidence.content_type === 'image/png' ? 'png' : 'jpg'}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Referrer-Policy':'no-referrer'});
          res.end(evidence.bytes);
        } else send(res,200,{ok:true});
        return true;
      }
      if (parts[3] && parts[4] === 'review' && parts.length === 5 && method === 'POST') {
        let p = await requirePolicy();
        const expected = revision(body), status = body.status;
        if (!STATUSES.includes(status)) fail(400,'Choose an exact verification status.');
        if (role === 'SUPER_ADMIN' || role === 'CHECKER' && !['ACTION_REQUIRED','PENDING_VERIFICATION'].includes(status) || role === 'COMPLIANCE' && !['APPROVED','REJECTED'].includes(status)) fail(403,'This decision is outside your reviewer role.');
        const feedback = bounded(body.feedback,1000,'Applicant feedback');
        if (feedback.length < 10) fail(400,'Provide useful applicant feedback without sensitive identifiers.');
        await mutate(async tx => {
          await assertRole(tx);
          p = await requirePolicy(tx);
          const a = await applicationForReview(tx,parts[3],reviewer,expected);
          if (a.status !== 'PENDING_VERIFICATION') fail(409,'Only submitted pending applications can be reviewed.');
          if (['APPROVED','PENDING_VERIFICATION'].includes(status)) {
            const evidence = await tx.many('SELECT kind,verified,verified_by FROM pandit_evidence WHERE application_id=?',a.id);
            if (!KINDS.every(k => evidence.some(e => e.kind === k && e.verified))) fail(409,'All three evidence categories must first pass Checker verification.');
            if (status === 'APPROVED' && evidence.some(e => e.verified_by === reviewer.id)) fail(403,'Final approval must be independent of the evidence Checker.');
          }
          const stamp = now();
          const approvedUntil = status === 'APPROVED' ? p.approved_retention_years ? addYears(stamp,p.approved_retention_years) : addDays(stamp,p.approved_retention_days) : a.approved_record_until;
          const rejectedUntil = status === 'REJECTED' ? addDays(stamp,p.rejected_evidence_retention_days) : status === 'APPROVED' ? null : a.rejected_evidence_until;
          await tx.run('UPDATE pandit_applications SET status=?,revision=revision+1,review_feedback=?,updated_at=?,approved_at=?,reverify_at=?,approved_record_until=?,rejected_at=?,appeal_until=?,rejected_evidence_until=? WHERE id=? AND revision=?',status,feedback,stamp,status === 'APPROVED' ? stamp : null,status === 'APPROVED' ? addYears(stamp,p.recheck_years) : null,approvedUntil,status === 'REJECTED' ? stamp : status === 'APPROVED' ? null : a.rejected_at,status === 'REJECTED' ? addDays(stamp,p.appeal_days) : status === 'APPROVED' ? null : a.appeal_until,rejectedUntil,a.id,expected);
          // Each rejected version gets its kind-specific deadline from this rejection timestamp.
          // Existing rejected versions are immutable: appeal/edit/GET cannot extend or shorten them.
          if (status === 'REJECTED') {
            const periods = { GOVERNMENT_ID: p.rejected_evidence_retention_days, BACKGROUND_CHECK: p.rejected_background_check_retention_days, EDUCATION: p.rejected_education_retention_days };
            for (const kind of KINDS) {
              const until = addDays(stamp, periods[kind]);
              await tx.run("UPDATE pandit_evidence SET delete_after=CASE WHEN retention_basis LIKE 'REJECTED_%' AND delete_after IS NOT NULL THEN delete_after ELSE ? END,retention_basis=? WHERE application_id=? AND kind=?", until, `REJECTED_${kind}`, a.id, kind);
            }
            const aggregate = await tx.one("SELECT MAX(delete_after) AS until FROM pandit_evidence WHERE application_id=? AND retention_basis LIKE 'REJECTED_%'",a.id);
            await tx.run('UPDATE pandit_applications SET rejected_evidence_until=? WHERE id=?',aggregate?.until || rejectedUntil,a.id);
          }
          if (status === 'APPROVED') await tx.run("UPDATE pandit_evidence SET delete_after=?,retention_basis='APPROVED' WHERE application_id=?",approvedUntil,a.id);
          await audit(tx,a,reviewer,'REVIEW',status,feedback);
          await tx.run('INSERT INTO notifications(id,user_id,type,message,link,created_at) VALUES(?,?,?,?,?,?)',uuid(),a.user_id,'pandit_review','Your Pandit application review was updated.','/?page=pandits',stamp);
        });
        send(res,200,{ok:true}); return true;
      }
    }
    fail(404,'Pandit endpoint not found.');
  };
}

module.exports = { SQLITE_SCHEMA, initializePanditSchema, createPanditRoutes, STATUSES, KINDS, APPROVED_POLICY, addDays, addYears };
