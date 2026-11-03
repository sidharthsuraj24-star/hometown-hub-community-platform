'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server');

const SYNTHETIC = 'SYNTHETIC TEST PROFILE — NOT A PERSON';
const PROFILE = {
  is_simulation: true, display_name: SYNTHETIC, location: 'Synthetic Test Township',
  description: 'Synthetic test profile used only for automated workflow assertions.',
  traditions: 'Synthetic tradition', languages: 'Test language', ritual_skills: 'Synthetic ritual', experience_years: 12
};
const PDF = Buffer.from('%PDF-1.4\n% SYNTHETIC TEST ONLY — NOT AN ID OR CERTIFICATE\nsynthetic fixture bytes\n').toString('base64');

async function fixture(t, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-pandit-test-'));
  const server = createApp({ dataDir, adminEmail: 'admin@example.test', adminPassword: 'test-admin-password-123', nodeEnv: 'test', allowPanditSimulations: true, panditInlineSimulationEvidence: true, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ctx = { server, base: `http://127.0.0.1:${server.address().port}` };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server.closeDatabase(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return ctx;
}
async function call(ctx, client, url, method = 'GET', body) {
  const headers = {}; if (client.cookie) headers.Cookie = client.cookie;
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers.Origin = ctx.base; }
  const response = await fetch(ctx.base + url, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) });
  const setCookie = response.headers.get('set-cookie'); if (setCookie) client.cookie = setCookie.split(';')[0];
  const data = method === 'GET' && response.headers.get('content-type')?.startsWith('application/json') === false ? null : await response.json().catch(() => ({}));
  return { response, data };
}
async function register(ctx, email, name = 'Synthetic User') {
  const c = { cookie: '' }; const r = await call(ctx, c, '/api/auth/register', 'POST', { name, email, password: 'member-password-123' });
  assert.equal(r.response.status, 202, JSON.stringify(r.data));
  assert.equal(r.response.headers.get('set-cookie'), null);
  const login = await call(ctx, c, '/api/auth/login', 'POST', { email, password: 'member-password-123' });
  assert.equal(login.response.status, 200, JSON.stringify(login.data)); c.userId = login.data.user.id; return c;
}
async function loginAdmin(ctx) { const c = { cookie: '' }; const r = await call(ctx, c, '/api/auth/login', 'POST', { email: 'admin@example.test', password: 'test-admin-password-123' }); assert.equal(r.response.status, 200); c.userId = r.data.user.id; return c; }
function profile(revision, action = 'save', extra = {}) { return { ...PROFILE, revision, action, is_simulation: true, ...extra }; }
async function configure(ctx, admin, extra = {}) { return call(ctx, admin, '/api/admin/pandits/policy', 'PUT', { approved_retention_days: 10, rejected_evidence_retention_days: 3, appeal_days: 2, recheck_years: 2, ...extra }); }
async function evidence(ctx, c, revision, kind, extra = {}) { return call(ctx, c, '/api/pandit-application/evidence', 'POST', { revision, kind, content_type: 'application/pdf', content_base64: PDF, ...extra }); }

 test('updated Pandit workflow: privacy, three roles, immutable simulation designation, concurrency and bounded transitions', async t => {
  const ctx = await fixture(t); const admin = await loginAdmin(ctx); const applicant = await register(ctx, 'synthetic-applicant@example.test'); const other = await register(ctx, 'synthetic-other@example.test');
  const checker = await register(ctx, 'synthetic-checker@example.test'); const compliance = await register(ctx, 'synthetic-compliance@example.test');
  assert.equal((await call(ctx, applicant, '/api/pandit-application')).response.status, 200);
  assert.equal((await call(ctx, applicant, '/api/pandits')).response.status, 200);
  assert.equal((await call(ctx, { cookie: '' }, '/api/pandit-application')).response.status, 401);
  assert.equal((await configure(ctx, admin)).response.status, 200);
  for (const [user, role] of [[checker, 'CHECKER'], [compliance, 'COMPLIANCE']]) assert.equal((await call(ctx, admin, '/api/admin/pandits/roles', 'POST', { user_id: user.userId, role })).response.status, 200);
  assert.equal((await call(ctx, admin, '/api/admin/pandits/roles', 'POST', { user_id: admin.userId, role: 'CHECKER' })).response.status, 403);
  assert.equal((await call(ctx, checker, '/api/admin/pandits')).response.status, 200);
  assert.equal((await call(ctx, other, '/api/admin/pandits')).response.status, 403);

  // Owner policy gates evidence collection and submission; exact positive periods and only 1/2-year recheck are accepted.
  assert.equal((await configure(ctx, admin, { approved_retention_years: null, approved_retention_days: null })).response.status, 200);
  assert.equal((await call(ctx, applicant, '/api/pandit-application', 'POST', profile(0))).response.status, 200);
  assert.equal((await evidence(ctx, applicant, 1, 'GOVERNMENT_ID')).response.status, 503);
  assert.equal((await configure(ctx, admin)).response.status, 200);
  assert.equal((await evidence(ctx, applicant, 1, 'GOVERNMENT_ID')).response.status, 200);
  assert.equal((await evidence(ctx, applicant, 2, 'BACKGROUND_CHECK')).response.status, 200);
  assert.equal((await evidence(ctx, applicant, 3, 'EDUCATION')).response.status, 200);
  const saved = await call(ctx, applicant, '/api/pandit-application'); assert.equal(saved.data.application.evidence.length, 3);
  assert.equal((await call(ctx, applicant, '/api/pandit-application', 'POST', profile(saved.data.application.revision, 'save', { bank_account: 'never store' }))).response.status, 400);
  assert.equal((await call(ctx, applicant, '/api/pandit-application', 'POST', profile(saved.data.application.revision, 'submit'))).response.status, 200);
  let app = (await call(ctx, applicant, '/api/pandit-application')).data.application; assert.equal(app.status, 'PENDING_VERIFICATION');
  const appId = app.id;
  assert.equal((await call(ctx, applicant, '/api/pandit-application', 'POST', profile(app.revision, 'save', { is_simulation: false }))).response.status, 400);
  assert.equal((await call(ctx, other, '/api/pandit-application')).data.application, null);
  assert.equal((await call(ctx, admin, '/api/admin/pandits')).data.applications.length, 0, 'Super Admin sees no applicant/evidence queue');

  const queue = await call(ctx, checker, '/api/admin/pandits'); assert.equal(queue.data.applications.length, 1); assert.equal(queue.data.applications[0].is_simulation, 1);
  const ids = queue.data.applications[0].evidence.map(e => e.id);
  assert.equal((await call(ctx, checker, `/api/admin/pandits/${appId}/evidence/${ids[0]}`)).response.status, 200);
  assert.equal((await call(ctx, admin, `/api/admin/pandits/${appId}/evidence/${ids[0]}`)).response.status, 403);
  for (const id of ids) { app = (await call(ctx, applicant, '/api/pandit-application')).data.application; assert.equal((await call(ctx, checker, `/api/admin/pandits/${appId}/evidence/${id}/verify`, 'POST', { revision: app.revision, verified: true })).response.status, 200); }
  app = (await call(ctx, applicant, '/api/pandit-application')).data.application;
  assert.equal((await call(ctx, checker, `/api/admin/pandits/${appId}/review`, 'POST', { revision: app.revision, status: 'PENDING_VERIFICATION', feedback: 'Checker recommends compliance review.' })).response.status, 200);
  app = (await call(ctx, applicant, '/api/pandit-application')).data.application;
  assert.equal((await call(ctx, checker, `/api/admin/pandits/${appId}/review`, 'POST', { revision: app.revision, status: 'APPROVED', feedback: 'Not permitted.' })).response.status, 403);
  assert.equal((await call(ctx, compliance, `/api/admin/pandits/${appId}/evidence/${ids[0]}/verify`, 'POST', { revision: app.revision, verified: true })).response.status, 403);
  assert.equal((await call(ctx, admin, '/api/admin/pandits/roles', 'POST', { user_id: checker.userId, role: 'COMPLIANCE' })).response.status, 200);
  assert.equal((await call(ctx, checker, `/api/admin/pandits/${appId}/review`, 'POST', { revision: app.revision, status: 'APPROVED', feedback: 'A checker cannot become an independent final reviewer.' })).response.status, 403, 'role switching cannot evade independent approval');
  assert.equal((await call(ctx, compliance, `/api/admin/pandits/${appId}/review`, 'POST', { revision: app.revision, status: 'APPROVED', feedback: 'Compliance approved this synthetic test profile.' })).response.status, 200);
  const directory = await call(ctx, applicant, '/api/pandits'); assert.equal(directory.data.pandits.length, 0, 'simulation profiles never enter public directory');
  const own = await call(ctx, applicant, '/api/pandit-application'); assert.equal(Object.hasOwn(own.data.application, 'content_base64'), false); assert.equal(Object.hasOwn(own.data.reviews.at(-1), 'private_note'), false);
  const auditRows = ctx.server.database.prepare('SELECT feedback,event FROM pandit_reviews WHERE application_id=?').all(appId); assert.ok(auditRows.every(row => row.feedback === '' && !JSON.stringify(row).includes(PDF)), 'audit metadata never contains feedback or private evidence bytes');
  // Approved records may intentionally enter bounded re-review; rejected records
  // below cannot use withdraw/save/reverify to bypass appeal controls.
  assert.equal((await call(ctx, applicant, '/api/pandit-application/withdraw', 'POST', { revision: own.data.application.revision })).response.status, 200);

  // Optimistic revisions serialize concurrent writes; disabled applicants cannot be reviewed.
  const draft = await call(ctx, other, '/api/pandit-application', 'POST', profile(0)); assert.equal(draft.response.status, 200);
  const raceRevision = draft.data.application.revision; const race = await Promise.all([call(ctx, other, '/api/pandit-application', 'POST', profile(raceRevision, 'save')), call(ctx, other, '/api/pandit-application', 'POST', profile(raceRevision, 'save'))]); assert.deepEqual(race.map(x => x.response.status).sort(), [200, 409]);
  const currentRevision = (await call(ctx, applicant, '/api/pandit-application')).data.application.revision;
  const db = ctx.server.database; db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(applicant.userId); assert.equal((await call(ctx, compliance, `/api/admin/pandits/${appId}/review`, 'POST', { revision: currentRevision, status: 'APPROVED', feedback: 'Another compliance decision.' })).response.status, 409);
 });

 test('rejection, appeal, recheck, retention sweep and no sensitive storage', async t => {
  let clock = Date.parse('2030-01-01T00:00:00.000Z'); const ctx = await fixture(t, { panditNow: () => new Date(clock).toISOString() }); const admin = await loginAdmin(ctx); const checker = await register(ctx, 'synthetic-checker2@example.test'); const compliance = await register(ctx, 'synthetic-compliance2@example.test'); const applicant = await register(ctx, 'synthetic-applicant2@example.test');
  assert.equal((await configure(ctx, admin, { recheck_years: 2 })).response.status, 200); for (const [u, role] of [[checker, 'CHECKER'], [compliance, 'COMPLIANCE']]) assert.equal((await call(ctx, admin, '/api/admin/pandits/roles', 'POST', { user_id: u.userId, role })).response.status, 200);
  let r = await call(ctx, applicant, '/api/pandit-application', 'POST', profile(0)); assert.equal(r.response.status, 200); let rev = r.data.application.revision;
  for (const kind of ['GOVERNMENT_ID','BACKGROUND_CHECK','EDUCATION']) { r = await evidence(ctx, applicant, rev, kind); assert.equal(r.response.status, 200); rev = r.data.application.revision; }
  r = await call(ctx, applicant, '/api/pandit-application', 'POST', profile(rev, 'submit')); assert.equal(r.response.status, 200); let a = r.data.application;
  const ids = (await call(ctx, checker, '/api/admin/pandits')).data.applications[0].evidence.map(e => e.id); for (const id of ids) { r = await call(ctx, checker, `/api/admin/pandits/${a.id}/evidence/${id}/verify`, 'POST', { revision: a.revision, verified: true }); assert.equal(r.response.status, 200); a = (await call(ctx, applicant, '/api/pandit-application')).data.application; }
  r = await call(ctx, compliance, `/api/admin/pandits/${a.id}/review`, 'POST', { revision: a.revision, status: 'REJECTED', feedback: 'Please correct the synthetic test submission.' }); assert.equal(r.response.status, 200); a = (await call(ctx, applicant, '/api/pandit-application')).data.application; assert.equal(a.status, 'REJECTED');
  assert.equal((await call(ctx, applicant, '/api/pandit-application', 'POST', profile(a.revision, 'save'))).response.status, 409); assert.equal((await call(ctx, applicant, '/api/pandit-application/withdraw', 'POST', { revision: a.revision })).response.status, 409); assert.equal((await call(ctx, applicant, '/api/pandit-application/appeal', 'POST', { revision: a.revision })).response.status, 200);
  a = (await call(ctx, applicant, '/api/pandit-application')).data.application; assert.equal((await call(ctx, applicant, '/api/pandit-application/reverify', 'POST', { revision: a.revision, reason: 'BANK_DETAILS_CHANGED', bank_details: 'forbidden' })).response.status, 400);
  clock += 4 * 86400000; await call(ctx, applicant, '/api/pandit-application'); a = (await call(ctx, applicant, '/api/pandit-application')).data.application; assert.equal(a.evidence.length, 2, 'explicit synthetic government-ID policy is 3 days; background and education keep their independent 90-day deadlines'); assert.equal((await call(ctx, applicant, '/api/pandit-application/appeal', 'POST', { revision: a.revision })).response.status, 409);
  assert.equal((await configure(ctx, admin, { approved_retention_days: 1, rejected_evidence_retention_days: 1, appeal_days: 1 })).response.status, 200);
  // Direct disposable DB state tests retention and periodic re-verification without fabricating public people/documents.
  const stamp = new Date(clock).toISOString(); const until = new Date(clock + 86400000).toISOString(); const uid = 'retention-user'; dbInsertUser(ctx.server.database, uid); ctx.server.database.prepare("INSERT INTO pandit_applications(id,user_id,display_name,status,revision,created_at,updated_at,approved_record_until,reverify_at,is_simulation) VALUES(?,?,?,?,?,?,?,?,?,1)").run('retention-app', uid, SYNTHETIC, 'APPROVED', 1, stamp, stamp, until, new Date(clock + 10 * 86400000).toISOString());
  clock += 2 * 86400000; const anon = await register(ctx, 'synthetic-sweeper@example.test'); await call(ctx, anon, '/api/pandits'); assert.ok(ctx.server.database.prepare("SELECT id FROM pandit_applications WHERE id='retention-app'").get(), 'retention sweep preserves the profile/application');
 });

function dbInsertUser(db, id) { const { salt, hash } = require('../server').passwordHash('synthetic-password-123'); db.prepare('INSERT INTO users(id,email,name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(id, `${id}@example.test`, SYNTHETIC, salt, hash, new Date().toISOString()); }

test('production Pandit endpoints stay locked when the dedicated storage connector is absent', async t => {
  const ctx = await fixture(t, { nodeEnv: 'production', env: {}, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-prod-test-')) });
  for (const [url, method] of [['/api/pandits','GET'], ['/api/pandit-application','GET'], ['/api/admin/pandits','GET'], ['/api/pandit-application','POST']]) assert.equal((await call(ctx, { cookie: '' }, url, method, profile(0))).response.status, 503);
});

test('simulation flag is denied outside explicit test mode', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-nonsim-test-')); const server = createApp({ dataDir, adminEmail: 'admin@example.test', adminPassword: 'test-admin-password-123', nodeEnv: 'development' }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const ctx = { server, base: `http://127.0.0.1:${server.address().port}` }; t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server.closeDatabase(); fs.rmSync(dataDir, { recursive: true, force: true }); }); const user = await register(ctx, 'synthetic-normal@example.test'); const admin = await loginAdmin(ctx); await configure(ctx, admin); assert.equal((await call(ctx, user, '/api/pandit-application', 'POST', profile(0))).response.status, 403);
});

async function readyApplication(ctx, applicant) {
  let result = await call(ctx, applicant, '/api/pandit-application', 'POST', profile(0));
  assert.equal(result.response.status, 200);
  for (const kind of ['GOVERNMENT_ID', 'BACKGROUND_CHECK', 'EDUCATION']) {
    result = await evidence(ctx, applicant, result.data.application.revision, kind);
    assert.equal(result.response.status, 200);
  }
  result = await call(ctx, applicant, '/api/pandit-application', 'POST', profile(result.data.application.revision, 'submit'));
  assert.equal(result.response.status, 200);
  return result.data.application;
}
async function assign(ctx, admin, user, role) {
  assert.equal((await call(ctx, admin, '/api/admin/pandits/roles', 'POST', { user_id: user.userId, role })).response.status, 200);
}

test('periodic and immediate reverification invalidate every checked evidence item', async t => {
  let clock = Date.parse('2031-01-01T00:00:00.000Z');
  const ctx = await fixture(t, { panditNow: () => new Date(clock).toISOString() });
  const admin = await loginAdmin(ctx);
  const applicant = await register(ctx, 'synthetic-recheck@example.test');
  const checker = await register(ctx, 'synthetic-recheck-checker@example.test');
  const compliance = await register(ctx, 'synthetic-recheck-compliance@example.test');
  await configure(ctx, admin, { approved_retention_days: 2000 }); // Disposable test policy, not an owner/legal default.
  await assign(ctx, admin, checker, 'CHECKER');
  await assign(ctx, admin, compliance, 'COMPLIANCE');
  let a = await readyApplication(ctx, applicant);
  const approve = async () => {
    for (const e of a.evidence) {
      const checked = await call(ctx, checker, `/api/admin/pandits/${a.id}/evidence/${e.id}/verify`, 'POST', { revision: a.revision, verified: true });
      assert.equal(checked.response.status, 200);
      a = (await call(ctx, applicant, '/api/pandit-application')).data.application;
    }
    assert.equal((await call(ctx, compliance, `/api/admin/pandits/${a.id}/review`, 'POST', { revision: a.revision, status: 'APPROVED', feedback: 'Synthetic checks completed independently.' })).response.status, 200);
    a = (await call(ctx, applicant, '/api/pandit-application')).data.application;
  };
  await approve();
  assert.equal(a.reverify_at, '2033-01-01T00:00:00.000Z');
  clock = Date.parse(a.reverify_at);
  a = (await call(ctx, applicant, '/api/pandit-application')).data.application;
  assert.equal(a.status, 'ACTION_REQUIRED');
  assert.ok(a.evidence.every(e => e.verified === 0));
  for (const reason of ['BANK_DETAILS_CHANGED', 'OFFICIAL_ID_CHANGED']) {
    a = (await call(ctx, applicant, '/api/pandit-application', 'POST', profile(a.revision, 'submit'))).data.application;
    await approve();
    const triggered = await call(ctx, applicant, '/api/pandit-application/reverify', 'POST', { revision: a.revision, reason });
    assert.equal(triggered.response.status, 200);
    a = triggered.data.application;
    assert.equal(a.status, 'ACTION_REQUIRED');
    assert.equal(a.approved_at, null);
    assert.ok(a.evidence.every(e => e.verified === 0));
  }
  const columns = ctx.server.database.prepare('PRAGMA table_info(pandit_applications)').all().map(c => c.name);
  assert.ok(columns.every(c => !/bank|aadhaar|pan_number/.test(c)));
});

test('self-review, evidence confidentiality, action requests and expired appeals are enforced', async t => {
  let clock = Date.parse('2030-03-01T00:00:00.000Z');
  const ctx = await fixture(t, { panditNow: () => new Date(clock).toISOString() });
  const admin = await loginAdmin(ctx);
  const checker = await register(ctx, 'synthetic-self-review@example.test');
  const compliance = await register(ctx, 'synthetic-expiry-manager@example.test');
  const outsider = await register(ctx, 'synthetic-evidence-outsider@example.test');
  await configure(ctx, admin);
  await assign(ctx, admin, checker, 'CHECKER');
  await assign(ctx, admin, compliance, 'COMPLIANCE');
  let a = await readyApplication(ctx, checker);
  const url = `/api/admin/pandits/${a.id}/evidence/${a.evidence[0].id}`;
  for (const c of [checker, outsider, admin]) assert.equal((await call(ctx, c, url)).response.status, 403);
  assert.equal((await call(ctx, { cookie: '' }, url)).response.status, 401);
  const privateDownload = await call(ctx, compliance, url);
  assert.equal(privateDownload.response.status, 200);
  assert.equal(privateDownload.response.headers.get('cache-control'), 'no-store');
  assert.match(privateDownload.response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await privateDownload.response.text(), Buffer.from(PDF, 'base64').toString());
  assert.equal((await call(ctx, checker, `/api/admin/pandits/${a.id}/review`, 'POST', { revision: a.revision, status: 'ACTION_REQUIRED', feedback: 'Synthetic request for corrected evidence.' })).response.status, 403);
  await assign(ctx, admin, outsider, 'CHECKER');
  assert.equal((await call(ctx, outsider, `/api/admin/pandits/${a.id}/review`, 'POST', { revision: a.revision, status: 'ACTION_REQUIRED', feedback: 'Synthetic request for corrected evidence.' })).response.status, 200);
  a = (await call(ctx, checker, '/api/pandit-application')).data.application;
  assert.equal(a.status, 'ACTION_REQUIRED');
  a = (await call(ctx, checker, '/api/pandit-application', 'POST', profile(a.revision, 'submit'))).data.application;
  assert.equal((await call(ctx, compliance, `/api/admin/pandits/${a.id}/review`, 'POST', { revision: a.revision, status: 'APPROVED', feedback: 'Must not approve unchecked evidence.' })).response.status, 409);
  assert.equal((await call(ctx, compliance, `/api/admin/pandits/${a.id}/review`, 'POST', { revision: a.revision, status: 'REJECTED', feedback: 'Synthetic evidence needs replacement.' })).response.status, 200);
  a = (await call(ctx, checker, '/api/pandit-application')).data.application;
  clock = Date.parse(a.appeal_until);
  assert.equal((await call(ctx, checker, '/api/pandit-application/appeal', 'POST', { revision: a.revision })).response.status, 409);
  assert.equal((await call(ctx, checker, '/api/pandit-application/reverify', 'POST', { revision: a.revision, reason: 'OFFICIAL_ID_CHANGED' })).response.status, 409);
});

test('missing policy, invalid periods, forged roles and malformed private evidence fail safely', async t => {
  const ctx = await fixture(t);
  const admin = await loginAdmin(ctx);
  const applicant = await register(ctx, 'synthetic-validation@example.test');
  const checker = await register(ctx, 'synthetic-policy-checker@example.test');
  await assign(ctx, admin, checker, 'CHECKER');
  let a = (await call(ctx, applicant, '/api/pandit-application', 'POST', profile(0))).data.application;
  for (const extra of [{ approved_retention_days: 0 }, { appeal_days: -1 }, { appeal_days: 1.5 }, { recheck_years: 1 }, { recheck_years: 3 }]) {
    assert.equal((await configure(ctx, admin, extra)).response.status, 400);
  }
  assert.equal((await configure(ctx, checker)).response.status, 403);
  assert.equal((await call(ctx, admin, '/api/admin/pandits/roles', 'POST', { user_id: applicant.userId, role: 'SUPER_ADMIN' })).response.status, 400);
  assert.equal((await call(ctx, applicant, '/api/admin/pandits/roles', 'POST', { user_id: applicant.userId, role: 'CHECKER' })).response.status, 403);
  await configure(ctx, admin, { approved_retention_years: null, approved_retention_days: null });
  assert.equal((await call(ctx, applicant, '/api/pandit-application', 'POST', profile(a.revision, 'submit'))).response.status, 503);
  ctx.server.database.prepare('DELETE FROM pandit_policy').run();
  assert.equal((await evidence(ctx, applicant, a.revision, 'GOVERNMENT_ID')).response.status, 503);
  ctx.server.database.prepare('INSERT INTO pandit_policy(id) VALUES(1)').run();
  await configure(ctx, admin);
  for (const extra of [{ content_base64: 'invalid!' }, { content_type: 'text/html' }, { content_base64: Buffer.from('SYNTHETIC NOT A PDF').toString('base64') }]) {
    assert.equal((await evidence(ctx, applicant, a.revision, 'GOVERNMENT_ID', extra)).response.status, 400);
  }
  assert.equal((await call(ctx, applicant, '/api/pandit-application', 'POST', profile(a.revision, 'submit'))).response.status, 400);
  assert.equal((await call(ctx, applicant, '/api/pandit-application', 'POST', profile(a.revision, 'save', { government_id_number: 'SYNTHETIC-FORBIDDEN-FIELD' }))).response.status, 400);
  assert.equal((fs.statSync(ctx.server.appOptions.dbPath).mode & 0o777), 0o600);
  assert.equal(ctx.server.database.prepare('PRAGMA secure_delete').get().secure_delete, 1);
});

test('local legacy schema upgrades without seeds, obsolete sensitive fields, or grandfathered approvals', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,role TEXT);
      CREATE TABLE pandit_applications (
        id TEXT PRIMARY KEY,user_id TEXT,display_name TEXT,location TEXT,description TEXT,
        traditions TEXT,languages TEXT,experience_years INTEGER,vetting_details TEXT,
        status TEXT,revision INTEGER,review_feedback TEXT,private_note TEXT,
        created_at TEXT,updated_at TEXT,submitted_at TEXT,approved_at TEXT
      );
      CREATE TABLE pandit_reviews (
        id TEXT PRIMARY KEY,application_id TEXT,actor_id TEXT,from_status TEXT,to_status TEXT,
        feedback TEXT,private_note TEXT,created_at TEXT
      );`);
    const { initializePanditSchema } = require('../lib/pandit-onboarding');
    initializePanditSchema(db);
    initializePanditSchema(db); // Idempotent startup.
    const columns = db.prepare('PRAGMA table_info(pandit_applications)').all().map(c => c.name);
    assert.ok(columns.includes('ritual_skills'));
    assert.ok(columns.includes('is_simulation'));
    assert.ok(!columns.includes('vetting_details') && !columns.includes('private_note'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pandit_applications').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pandit_evidence').get().count, 0);
    assert.deepEqual({ ...db.prepare('SELECT approved_retention_years,approved_retention_days,pending_evidence_retention_days,rejected_evidence_retention_days,rejected_background_check_retention_days,rejected_education_retention_days,appeal_days,recheck_years FROM pandit_policy').get() }, { approved_retention_years: 3, approved_retention_days: null, pending_evidence_retention_days: 90, rejected_evidence_retention_days: 90, rejected_background_check_retention_days: 90, rejected_education_retention_days: 90, appeal_days: 30, recheck_years: 2 });
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='pandit_applications'").get().sql, /'ACTION_REQUIRED'/);
  } finally { db.close(); }
});

test('replacing appeal evidence removes the old version without extending unchanged rejected evidence retention', async t => {
  let clock = Date.parse('2030-04-01T00:00:00.000Z');
  const ctx = await fixture(t, { panditNow: () => new Date(clock).toISOString() });
  const admin = await loginAdmin(ctx);
  const applicant = await register(ctx, 'synthetic-evidence-version@example.test');
  const compliance = await register(ctx, 'synthetic-evidence-version-manager@example.test');
  await configure(ctx, admin);
  await assign(ctx, admin, compliance, 'COMPLIANCE');
  let a = await readyApplication(ctx, applicant);
  assert.equal((await call(ctx, compliance, `/api/admin/pandits/${a.id}/review`, 'POST', { revision: a.revision, status: 'REJECTED', feedback: 'Synthetic rejected evidence must be replaced.' })).response.status, 200);
  a = (await call(ctx, applicant, '/api/pandit-application')).data.application;
  a = (await call(ctx, applicant, '/api/pandit-application/appeal', 'POST', { revision: a.revision })).data.application;
  const originalId = a.evidence.find(e => e.kind === 'GOVERNMENT_ID').id;
  clock += 86400000;
  a = (await evidence(ctx, applicant, a.revision, 'GOVERNMENT_ID')).data.application;
  const replacementId = a.evidence.find(e => e.kind === 'GOVERNMENT_ID').id;
  assert.notEqual(originalId, replacementId);
  clock += 3 * 86400000;
  a = (await call(ctx, applicant, '/api/pandit-application')).data.application;
  assert.equal(a.evidence.length, 3, 'replacing ID retains unrelated background and education evidence');
  assert.equal(a.evidence.find(e => e.kind === 'GOVERNMENT_ID').id, replacementId);
  assert.equal(ctx.server.database.prepare('SELECT id FROM pandit_evidence WHERE id=?').get(originalId), undefined);
});
