'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { addYears, addDays } = require('../lib/pandit-onboarding');
const PDF = Buffer.from('%PDF-1.4\nSYNTHETIC LIFECYCLE PLACEHOLDER ONLY - NOT A DOCUMENT\n%%EOF').toString('base64');
const KINDS = ['GOVERNMENT_ID', 'BACKGROUND_CHECK', 'EDUCATION'];
const POLICY = { approved_retention_years: 3, approved_retention_days: null, pending_evidence_retention_days: 90, rejected_evidence_retention_days: 90, rejected_background_check_retention_days: 90, rejected_education_retention_days: 90, appeal_days: 30, recheck_years: 2 };
const PROFILE = { is_simulation: true, display_name: 'SYNTHETIC LIFECYCLE FIXTURE - NOT A PERSON', location: 'Synthetic test locality', description: 'Synthetic lifecycle assertions only; not a real applicant.', traditions: 'Synthetic', languages: 'Synthetic', ritual_skills: 'Synthetic', experience_years: 0 };
async function setup(t, start = '2032-02-29T12:34:56.789Z') {
  let clock = Date.parse(start);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandit-policy-lifecycle-'));
  const server = createApp({ env: {}, nodeEnv: 'test', dataDir: dir, allowPanditSimulations: true, panditInlineSimulationEvidence: true, panditNow: () => new Date(clock).toISOString(), adminEmail: 'admin@example.test', adminPassword: 'synthetic-admin-password-123' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (client, route, method = 'GET', body) => {
    const headers = { ...(client.cookie ? { Cookie: client.cookie } : {}), ...(method !== 'GET' ? { Origin: base, 'Content-Type': 'application/json' } : {}) };
    const r = await fetch(base + route, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}) });
    const cookie = r.headers.get('set-cookie'); if (cookie) client.cookie = cookie.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
  };
  const register = async label => { const c = {}; const email = `synthetic-${label}@example.test`; const password = 'synthetic-member-password-123'; const r = await call(c, '/api/auth/register', 'POST', { name: 'SYNTHETIC TEST ACTOR - NOT A PERSON', email, password }); assert.equal(r.status, 202); assert.equal(r.headers.get('set-cookie'), null); const login = await call(c, '/api/auth/login', 'POST', { email, password }); assert.equal(login.status, 200); c.id = login.data.user.id; return c; };
  const admin = {}; assert.equal((await call(admin, '/api/auth/login', 'POST', { email: 'admin@example.test', password: 'synthetic-admin-password-123' })).status, 200);
  const checker = await register('checker'), compliance = await register('compliance');
  for (const [actor, role] of [[checker, 'CHECKER'], [compliance, 'COMPLIANCE']]) assert.equal((await call(admin, '/api/admin/pandits/roles', 'POST', { user_id: actor.id, role })).status, 200);
  const own = async client => { const r = await call(client, '/api/pandit-application'); assert.equal(r.status, 200); return r.data.application; };
  const upload = async (client, a, kind) => { const r = await call(client, '/api/pandit-application/evidence', 'POST', { revision: a.revision, kind, content_type: 'application/pdf', content_base64: PDF }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.application; };
  const ready = async label => { const client = await register(label); let r = await call(client, '/api/pandit-application', 'POST', { ...PROFILE, revision: 0, action: 'save' }); assert.equal(r.status, 200); let a = r.data.application; for (const kind of KINDS) a = await upload(client, a, kind); r = await call(client, '/api/pandit-application', 'POST', { ...PROFILE, revision: a.revision, action: 'submit' }); assert.equal(r.status, 200); return { client, a: r.data.application }; };
  const review = async (client, status) => { let a = await own(client); if (status === 'APPROVED') for (const e of a.evidence) { const r = await call(checker, `/api/admin/pandits/${a.id}/evidence/${e.id}/verify`, 'POST', { revision: a.revision, verified: true }); assert.equal(r.status, 200); a = await own(client); } const r = await call(compliance, `/api/admin/pandits/${a.id}/review`, 'POST', { revision: a.revision, status, feedback: 'Synthetic lifecycle decision only; no sensitive details.' }); assert.equal(r.status, 200, JSON.stringify(r.data)); return own(client); };
  return { server, call, own, ready, review, upload, admin, checker, compliance, at: value => { clock = typeof value === 'number' ? value : Date.parse(value); }, start };
}

test('UTC year anniversaries clamp leap days, including century boundaries; day windows are elapsed UTC', () => {
  assert.equal(addYears('2032-02-29T12:34:56.789Z', 3), '2035-02-28T12:34:56.789Z');
  assert.equal(addYears('2096-02-29T12:34:56.789Z', 4), '2100-02-28T12:34:56.789Z');
  assert.equal(addYears('2032-02-29T12:34:56.789Z', 4), '2036-02-29T12:34:56.789Z');
  assert.equal(addDays('2032-02-29T12:34:56.789Z', 30), '2032-03-30T12:34:56.789Z');
  assert.equal(addDays('2032-02-29T12:34:56.789Z', 90), '2032-05-29T12:34:56.789Z');
});

test('actual independent approval snapshots three calendar years and expires evidence, not the profile, exactly once', async t => {
  const f = await setup(t); const { client } = await f.ready('approval'); let a = await f.review(client, 'APPROVED');
  assert.equal(a.is_simulation, 1); assert.equal(a.status, 'APPROVED');
  assert.equal(a.approved_record_until, '2035-02-28T12:34:56.789Z');
  assert.equal(a.reverify_at, '2034-02-28T12:34:56.789Z');
  assert.ok(a.evidence.every(e => e.delete_after === a.approved_record_until && e.verified === 1));
  assert.equal((await f.call(client, '/api/pandits')).data.pandits.length, 0);
  assert.equal((await f.call(f.admin, `/api/admin/pandits/${a.id}/evidence/${a.evidence[0].id}`)).status, 403);
  assert.equal((await f.call(f.admin, '/api/admin/pandits/policy', 'PUT', { ...POLICY, recheck_years: 1 })).status, 400);
  assert.equal((await f.call(f.admin, '/api/admin/pandits/policy', 'PUT', { ...POLICY, approved_retention_years: 4 })).status, 200);
  assert.equal((await f.own(client)).approved_record_until, a.approved_record_until, 'policy edits never backfill existing decisions');
  const deadline = Date.parse(a.approved_record_until); f.at(deadline - 1); a = await f.own(client);
  assert.equal(a.status, 'ACTION_REQUIRED', 'two-year reverification is due before the three-year evidence expiry'); assert.equal(a.evidence.length, 3);
  f.at(deadline); const results = await Promise.all(Array.from({ length: 6 }, () => f.own(client)));
  assert.ok(results.every(x => x.evidence.length === 0 && x.id === a.id && x.status === 'ACTION_REQUIRED'));
  a = await f.own(client); assert.equal(a.evidence_expired_at, '2035-02-28T12:34:56.789Z'); assert.equal(a.approved_record_until, null);
  const revision = a.revision; f.at(deadline + 1); assert.equal((await f.own(client)).revision, revision);
  const events = f.server.database.prepare('SELECT event,feedback FROM pandit_reviews WHERE application_id=?').all(a.id);
  assert.equal(events.filter(e => e.event === 'APPROVED_RETENTION_EXPIRED').length, 1);
  assert.ok(events.every(e => e.feedback === '' && !JSON.stringify(e).includes(PDF)));
  assert.equal(f.server.database.prepare('SELECT COUNT(*) AS n FROM pandit_applications WHERE is_simulation<>1').get().n, 0);
});

test('rejection permits appeals only before 30 days and purges all unchanged rejected evidence at 90 days', async t => {
  const f = await setup(t); const cases = [];
  for (const label of ['appeal-before', 'appeal-exact', 'appeal-after', 'appeal-replaced']) { const { client } = await f.ready(label); cases.push({ client, a: await f.review(client, 'REJECTED') }); }
  for (const c of cases) {
    assert.equal(c.a.appeal_until, '2032-03-30T12:34:56.789Z'); assert.equal(c.a.rejected_evidence_until, '2032-05-29T12:34:56.789Z'); assert.equal(c.a.appeal_status, 'OPEN');
    assert.ok(c.a.evidence.every(e => e.delete_after === c.a.rejected_evidence_until), 'all three rejected evidence kinds receive the 90-day deadline');
  }
  const appealDeadline = Date.parse(cases[0].a.appeal_until), expiry = Date.parse(cases[0].a.rejected_evidence_until);
  f.at(appealDeadline - 1);
  for (const index of [0, 3]) { const c = cases[index]; const r = await f.call(c.client, '/api/pandit-application/appeal', 'POST', { revision: c.a.revision }); assert.equal(r.status, 200); c.a = r.data.application; assert.equal(c.a.status, 'ACTION_REQUIRED'); assert.equal(c.a.appeal_status, 'OPENED'); }
  const replaced = cases[3]; const oldId = replaced.a.evidence.find(e => e.kind === 'GOVERNMENT_ID').id;
  replaced.a = await f.upload(replaced.client, replaced.a, 'GOVERNMENT_ID'); assert.equal(replaced.a.rejected_evidence_until, '2032-05-29T12:34:56.789Z');
  assert.notEqual(replaced.a.evidence.find(e => e.kind === 'GOVERNMENT_ID').id, oldId); assert.ok(replaced.a.evidence.find(e => e.kind === 'GOVERNMENT_ID').delete_after);
  f.at(appealDeadline); assert.equal((await f.call(cases[1].client, '/api/pandit-application/appeal', 'POST', { revision: cases[1].a.revision })).status, 409);
  f.at(appealDeadline + 1); assert.equal((await f.call(cases[2].client, '/api/pandit-application/appeal', 'POST', { revision: cases[2].a.revision })).status, 409);
  assert.equal((await f.own(cases[1].client)).appeal_status, 'CLOSED');
  f.at(expiry - 1); assert.equal((await f.own(cases[0].client)).evidence.length, 3);
  f.at(expiry); await Promise.all(cases.map(c => f.own(c.client)));
  for (const c of cases.slice(0, 3)) { const a = await f.own(c.client); assert.deepEqual(a.evidence, []); assert.equal(a.status, c === cases[0] ? 'ACTION_REQUIRED' : 'REJECTED'); assert.equal(a.rejected_evidence_until, null); const revision = a.revision; f.at(expiry + 1); assert.equal((await f.own(c.client)).revision, revision); assert.equal(f.server.database.prepare("SELECT COUNT(*) AS n FROM pandit_reviews WHERE application_id=? AND event='REJECTED_EVIDENCE_PURGED'").get(a.id).n, 1); }
  assert.equal((await f.own(replaced.client)).evidence.length, 1, 'replacement remains as a new pending version after old rejected rows expire');
  assert.equal(f.server.database.prepare("SELECT COUNT(*) AS n FROM pandit_reviews WHERE application_id=? AND event='REJECTED_EVIDENCE_PURGED'").get(replaced.a.id).n, 1, 'remaining unchanged background and education rows produce one legitimate purge audit');
  assert.equal(f.server.database.prepare('SELECT COUNT(*) AS n FROM pandit_applications WHERE is_simulation<>1').get().n, 0);
});

test('production and disabled-simulation expiry fail closed before mutation; every enabled sweep selection is simulation-filtered', async () => {
  const { createPanditRoutes } = require('../lib/pandit-onboarding');
  const make = overrides => {
    const effects = { transactions: 0, queries: [], sends: [] };
    const deps = {
      one: async () => { throw new Error('Unexpected adapter read'); },
      many: async sql => { effects.queries.push(sql); assert.match(sql, /p\.is_simulation=0/); return []; },
      transaction: async fn => { effects.transactions++; return fn({ many: async sql => { effects.queries.push(sql); assert.match(sql, /\bis_simulation=1\b/, 'every expiry candidate selection excludes non-simulation rows'); return []; }, run: async () => { throw new Error('Empty synthetic adapter must never mutate'); }, one: async () => { throw new Error('Unexpected transaction read'); } }); },
      requireUser: async () => ({ id: 'synthetic-test-actor' }), send: (_res, status, data) => effects.sends.push({ status, data }),
      fail: (status, message) => { throw Object.assign(new Error(message), { status }); }, uuid: () => 'synthetic-audit-event', now: () => '2035-02-28T12:34:56.789Z', isProduction: false, allowSimulations: false,
      ...overrides
    };
    return { effects, route: createPanditRoutes(deps) };
  };
  const disabled = make({}); await disabled.route({ method: 'GET' }, {}, ['', 'pandits'], {}); assert.equal(disabled.effects.transactions, 0); assert.equal(disabled.effects.sends[0].status, 200);
  const production = make({ isProduction: true, allowSimulations: true, requireUser: async () => { throw new Error('Production gate must precede auth and adapters'); } });
  await assert.rejects(production.route({ method: 'GET' }, {}, ['', 'pandits'], {}), error => error.status === 503); assert.equal(production.effects.transactions, 0); assert.deepEqual(production.effects.queries, []);
  const released = make({ isProduction: true, allowProductionEvidence: true });
  await released.route({ method: 'GET' }, {}, ['', 'pandits'], {});
  assert.equal(released.effects.sends[0].status, 200, 'the production handler opens only with its explicit storage-backed release flag');
  assert.match(released.effects.queries[0], /p\.is_simulation=0/, 'the production directory excludes synthetic records');
  assert.equal(released.effects.transactions, 0, 'production reads never invoke the synthetic retention sweep');
  const enabled = make({ allowSimulations: true }); await enabled.route({ method: 'GET' }, {}, ['', 'pandits'], {}); assert.equal(enabled.effects.transactions, 1); assert.equal(enabled.effects.queries.filter(sql => /\bis_simulation=1\b/.test(sql)).length, 3);
});

test('production evidence scope requires the connector flag and excludes simulation records', async () => {
  const { createPanditRoutes } = require('../lib/pandit-onboarding');
  const owner = { id: 'synthetic-production-owner' };
  const retentionPolicy = { approved_retention_years: 3, approved_retention_days: null, pending_evidence_retention_days: 90,
    rejected_evidence_retention_days: 90, rejected_background_check_retention_days: 90, rejected_education_retention_days: 90,
    appeal_days: 30, recheck_years: 2 };
  const body = { revision: 1, action: 'submit', display_name: 'Synthetic Applicant', location: 'Synthetic town',
    description: 'Synthetic description long enough for the route check.', traditions: 'Synthetic tradition',
    languages: 'Synthetic language', ritual_skills: 'Synthetic ritual skills', experience_years: 5 };
  const makeRoute = (allowProductionEvidence, isSimulation) => {
    const effects = { transactions: 0, writes: 0 };
    const application = { id: 'synthetic-application', user_id: owner.id, is_simulation: isSimulation, status: 'ACTION_REQUIRED', revision: 1 };
    const tx = {
      one: async sql => {
        if (sql.includes('FROM pandit_policy')) return retentionPolicy;
        if (sql.includes('SELECT disabled FROM users')) return { disabled: false };
        if (sql.includes('SELECT * FROM pandit_applications WHERE user_id=?')) return application;
        throw new Error(`Unexpected synthetic query: ${sql}`);
      },
      many: async sql => {
        if (sql.includes('SELECT kind FROM pandit_evidence')) return [];
        throw new Error(`Unexpected synthetic query: ${sql}`);
      },
      run: async () => { effects.writes += 1; return { rowCount: 1 }; },
    };
    const route = createPanditRoutes({
      one: async sql => { if (sql.includes('FROM pandit_policy')) return retentionPolicy; throw new Error(`Unexpected synthetic query: ${sql}`); },
      many: async () => [], transaction: async callback => { effects.transactions += 1; return callback(tx); },
      requireUser: async () => owner, send: () => {}, fail: (status, message) => { throw Object.assign(new Error(message), { status }); },
      uuid: () => 'synthetic-audit-id', now: () => '2035-02-28T12:34:56.789Z', isProduction: true,
      allowProductionEvidence, allowSimulations: false,
    });
    return { effects, route };
  };

  const locked = makeRoute(false, 0);
  await assert.rejects(locked.route({ method: 'POST' }, {}, ['', 'pandit-application'], body), error => error.status === 503);
  assert.equal(locked.effects.transactions, 0);

  const releasedRealRecord = makeRoute(true, 0);
  await assert.rejects(releasedRealRecord.route({ method: 'POST' }, {}, ['', 'pandit-application'], body), error => error.status === 400);
  assert.equal(releasedRealRecord.effects.writes, 0, 'missing private evidence blocks submission without persistence');

  const releasedSimulation = makeRoute(true, 1);
  await assert.rejects(releasedSimulation.route({ method: 'POST' }, {}, ['', 'pandit-application'], body), error => error.status === 503);
  assert.equal(releasedSimulation.effects.writes, 0, 'production access never admits synthetic applications');
});

test('pending evidence uses the last successful applicant mutation and expires at exact 90 elapsed UTC days', async t => {
  const f = await setup(t, '2032-01-01T00:00:00.000Z');
  const { client, a } = await f.ready('pending-boundary');
  const activity = Date.parse(a.last_activity_at);
  const deadline = activity + 90 * 86400000;
  f.at(deadline - 1); let current = await f.own(client);
  assert.equal(current.evidence.length, 3, 'one millisecond before deadline retains pending evidence');
  f.at(deadline); current = await f.own(client);
  assert.equal(current.status, 'ACTION_REQUIRED');
  assert.equal(current.evidence.length, 0, 'deadline sweep purges pending evidence');
  assert.equal(f.server.database.prepare("SELECT COUNT(*) AS n FROM pandit_reviews WHERE application_id=? AND event='PENDING_EVIDENCE_PURGED'").get(current.id).n, 1);
  f.at(deadline + 1); current = await f.own(client);
  assert.equal(current.evidence.length, 0, 'one millisecond after deadline remains purged');
});

test('successful applicant save/upload resets pending activity; GET and reviewer reads do not', async t => {
  const f = await setup(t, '2032-01-01T00:00:00.000Z');
  const { client, a } = await f.ready('pending-activity');
  const initial = a.last_activity_at;
  f.at('2032-01-10T00:00:00.000Z');
  assert.equal((await f.own(client)).last_activity_at, initial, 'applicant GET is not activity');
  assert.equal((await f.call(f.checker, '/api/admin/pandits')).status, 200, 'reviewer queue read succeeds');
  assert.equal((await f.own(client)).last_activity_at, initial, 'reviewer GET does not reset applicant activity');
  assert.equal((await f.call(f.checker, `/api/admin/pandits/${a.id}/evidence/${a.evidence[0].id}/verify`, 'POST', { revision: a.revision, verified: true })).status, 200);
  const checked = await f.own(client);
  assert.equal(checked.last_activity_at, initial, 'reviewer verification is not applicant activity');
  assert.deepEqual(checked.evidence.map(e => e.delete_after), a.evidence.map(e => e.delete_after), 'reviewer mutation cannot extend pending retention');
  let r = await f.call(client, '/api/pandit-application', 'POST', { ...PROFILE, revision: checked.revision, action: 'save' });
  assert.equal(r.status, 200); const afterSave = r.data.application;
  assert.equal(afterSave.last_activity_at, '2032-01-10T00:00:00.000Z');
  assert.ok(afterSave.evidence.every(e => e.delete_after === addDays(afterSave.last_activity_at, 90)), 'save refreshes every pending deadline');
  f.at('2032-01-20T00:00:00.000Z');
  r = await f.upload(client, afterSave, 'GOVERNMENT_ID');
  assert.equal(r.last_activity_at, '2032-01-20T00:00:00.000Z', 'successful upload resets pending activity');
  assert.ok(r.evidence.every(e => e.delete_after === addDays(r.last_activity_at, 90)), 'upload refreshes unchanged pending categories too');
});

test('rejected evidence deadlines start at the later rejection timestamp and survive appeal and applicant edits', async t => {
  const f = await setup(t, '2032-01-01T00:00:00.000Z');
  const { client, a: submitted } = await f.ready('rejection-clock');
  const uploadAt = f.server.database.prepare('SELECT created_at FROM pandit_evidence WHERE application_id=?').all(submitted.id).map(e => e.created_at);
  f.at('2032-01-02T00:00:00.000Z');
  let rejected = await f.review(client, 'REJECTED');
  const persistedRejection = f.server.database.prepare('SELECT rejected_at FROM pandit_applications WHERE id=?').get(rejected.id).rejected_at;
  assert.ok(Date.parse(persistedRejection) > Math.max(...uploadAt.map(Date.parse)), 'rejection is later than upload');
  assert.equal(rejected.rejected_evidence_until, '2032-04-01T00:00:00.000Z');
  const oldDeadlines = Object.fromEntries(rejected.evidence.map(e => [e.kind, e.delete_after]));
  f.at('2032-01-03T00:00:00.000Z');
  rejected = (await f.call(client, '/api/pandit-application/appeal', 'POST', { revision: rejected.revision })).data.application;
  assert.deepEqual(Object.fromEntries(rejected.evidence.map(e => [e.kind, e.delete_after])), oldDeadlines, 'appeal does not extend rejected evidence');
  f.at('2032-01-04T00:00:00.000Z');
  rejected = await f.upload(client, rejected, 'GOVERNMENT_ID');
  assert.equal(rejected.evidence.find(e => e.kind === 'BACKGROUND_CHECK').delete_after, oldDeadlines.BACKGROUND_CHECK);
  assert.equal(rejected.evidence.find(e => e.kind === 'EDUCATION').delete_after, oldDeadlines.EDUCATION);
  const cutoff = Date.parse(oldDeadlines.BACKGROUND_CHECK);
  f.at(cutoff - 1);
  assert.deepEqual((await f.own(client)).evidence.map(e => e.kind).sort(), [...KINDS].sort());
  f.at(cutoff);
  const expired = await f.own(client);
  assert.deepEqual(expired.evidence.map(e => e.kind), ['GOVERNMENT_ID'], 'rejected background and education purge exactly at rejection plus 90 days');
  const revision = expired.revision;
  f.at(cutoff + 1);
  assert.equal((await f.own(client)).revision, revision, 'rejected purge is idempotent one millisecond after cutoff');
});
