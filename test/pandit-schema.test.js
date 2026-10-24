'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { SQLITE_SCHEMA, STATUSES, KINDS } = require('../lib/pandit-onboarding');

const migration = fs.readFileSync(require.resolve('../supabase/migrations/004_pandit_onboarding.sql'), 'utf8');
const runtime = fs.readFileSync(require.resolve('../lib/pandit-onboarding.js'), 'utf8');
const TABLES = ['pandit_applications', 'pandit_evidence', 'pandit_roles', 'pandit_policy', 'pandit_reviews'];
const REQUIRED = {
  pandit_applications: ['id', 'user_id', 'display_name', 'location', 'description', 'traditions', 'languages', 'ritual_skills', 'experience_years', 'status', 'revision', 'review_feedback', 'is_simulation', 'created_at', 'updated_at', 'submitted_at', 'approved_at', 'rejected_at', 'last_activity_at', 'appeal_until', 'reverify_at', 'approved_record_until', 'rejected_evidence_until', 'evidence_expired_at'],
  pandit_evidence: ['id', 'application_id', 'kind', 'content_type', 'storage_path', 'content_base64', 'verified', 'verified_by', 'created_at', 'delete_after', 'retention_basis'],
  pandit_roles: ['user_id', 'role'],
  pandit_policy: ['id', 'approved_retention_days', 'approved_retention_years', 'pending_evidence_retention_days', 'rejected_evidence_retention_days', 'rejected_background_check_retention_days', 'rejected_education_retention_days', 'appeal_days', 'recheck_years'],
  pandit_reviews: ['id', 'application_id', 'actor_id', 'event', 'from_status', 'to_status', 'feedback', 'created_at']
};

function splitDefinitions(body) {
  const parts = []; let start = 0; let depth = 0; let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) { if (c === quote && body[i - 1] !== '\\') quote = null; continue; }
    if (c === "'") { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(body.slice(start).trim());
  return parts.filter(Boolean);
}
function parsedPgColumns(table) {
  const sql = migration.replace(/^\s*--.*$/gm, '');
  const match = sql.match(new RegExp(`create\\s+table\\s+${table}\\s*\\(([^;]*?)\\n\\);`, 'is'));
  assert.ok(match, `migration must define ${table}`);
  return splitDefinitions(match[1]).filter(x => !/^constraint\b/i.test(x)).filter(x => !/^unique\s*\(/i.test(x)).filter(x => !/^check\s*\(/i.test(x)).map(x => x.match(/^([a-z_][a-z0-9_]*)\s+/i)?.[1]).filter(Boolean);
}
function sqliteColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
}

test('Pandit PostgreSQL migration and SQLite runtime schema stay in exact field agreement', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, disabled INTEGER DEFAULT 0);');
  db.exec(SQLITE_SCHEMA);
  for (const table of TABLES) {
    const pg = parsedPgColumns(table);
    const sqlite = sqliteColumns(db, table);
    assert.deepEqual(new Set(sqlite), new Set(pg), `${table}: SQLite runtime columns must match parsed PostgreSQL columns`);
    for (const field of REQUIRED[table]) {
      assert.ok(pg.includes(field), `${table}.${field} must be present in PostgreSQL migration`);
      assert.ok(sqlite.includes(field), `${table}.${field} must be present in SQLite runtime schema`);
    }
  }
  db.close();
});

test('Every queried or written retention/expiry field is represented in runtime and migration', () => {
  const fields = [
    'approved_retention_years', 'approved_retention_days', 'pending_evidence_retention_days',
    'rejected_evidence_retention_days', 'rejected_background_check_retention_days',
    'rejected_education_retention_days', 'appeal_days', 'recheck_years', 'evidence_expired_at',
    'approved_record_until', 'rejected_evidence_until', 'delete_after', 'retention_basis', 'storage_path', 'content_base64'
  ];
  for (const field of fields) {
    assert.match(runtime, new RegExp(`\\b${field}\\b`), `runtime must query or write ${field}`);
    assert.ok(TABLES.some(table => parsedPgColumns(table).includes(field)), `migration must define ${field}`);
  }
  assert.match(runtime, /SELECT approved_retention_years/);
  assert.match(runtime, /evidence_expired_at/);
  assert.match(migration, /evidence_expired_at/);
});

test('SQLite and PostgreSQL runtime flags use compatible numeric storage and retain production safety checks', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, disabled INTEGER DEFAULT 0);');
  db.exec(SQLITE_SCHEMA);
  const app = Object.fromEntries(db.prepare('PRAGMA table_info(pandit_applications)').all().map(c => [c.name, c]));
  const evidence = Object.fromEntries(db.prepare('PRAGMA table_info(pandit_evidence)').all().map(c => [c.name, c]));
  assert.equal(app.is_simulation.type.toUpperCase(), 'INTEGER');
  assert.equal(evidence.verified.type.toUpperCase(), 'INTEGER');
  assert.match(runtime, /is_simulation=1|is_simulation = 1/);
  assert.match(runtime, /verified\s*\?\s*1/);
  assert.match(migration, /is_simulation integer not null default 0 check \(is_simulation = 0\)/i);
  assert.match(migration, /verified integer not null default 0 check \(verified in \(0,1\)\)/i);
  assert.match(runtime, /u\.disabled=false/, 'false is portable between PostgreSQL boolean and SQLite numeric disabled flags');
  assert.doesNotMatch(runtime, /u\.disabled=0/);
  assert.match(runtime, /CASE WHEN \?=1 THEN/, 'CASE predicate works with shared numeric bindings');
  db.close();
});

test('Pandit constants and migration security constraints are explicit', () => {
  assert.deepEqual(STATUSES, ['PENDING_VERIFICATION', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED']);
  assert.deepEqual(KINDS, ['GOVERNMENT_ID', 'BACKGROUND_CHECK', 'EDUCATION']);
  assert.match(migration, /is_simulation integer not null default 0 check \(is_simulation = 0\)/i);
  assert.match(migration, /constraint pandit_evidence_exactly_one_source check \(\(storage_path is null\) <> \(content_base64 is null\)\)/i);
  assert.match(migration, /retention_basis text check[\s\S]*APPROVED[\s\S]*PENDING[\s\S]*REJECTED_BACKGROUND_CHECK[\s\S]*REJECTED_EDUCATION[\s\S]*REJECTED_GOVERNMENT_ID/i);
  const executableSql = migration.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(executableSql, /as\s+permissive/i, 'never grant client evidence access');
  const policies = executableSql.match(/create\s+policy[^;]+;/gi) || [];
  assert.equal(policies.length, 0, 'migration must not alter provider-owned storage policies');
  assert.doesNotMatch(executableSql, /storage\.(objects|buckets)/i, 'migration must not touch provider-owned storage tables');
  for (const table of TABLES) {
    assert.match(migration, new RegExp(`alter table ${table.replace('.', '\\.')} enable row level security`, 'i'), `${table} must be deny-by-default protected`);
  }
  assert.match(migration, /revoke all on table pandit_applications, pandit_evidence, pandit_roles, pandit_policy, pandit_reviews from anon, authenticated/i);
  assert.doesNotMatch(executableSql, /revoke[^;]+storage\.(objects|buckets)/i, 'do not change unrelated bucket privileges');
  assert.match(migration, /check \(approved_retention_days is null or approved_retention_years is null\)/i, 'unset policy is allowed but ambiguous units are not');
  assert.doesNotMatch(executableSql, /insert\s+into\s+(pandit_policy|pandit_roles|pandit_applications|pandit_evidence)\b/i, 'no policy decisions or users/documents are seeded');
});

test('existing local evidence CHECK constraints upgrade without losing records or backfilling deadlines', () => {
  const { initializePanditSchema } = require('../lib/pandit-onboarding');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, disabled INTEGER DEFAULT 0);');
  const oldSchema = SQLITE_SCHEMA.replace("'APPROVED','PENDING','REJECTED_GOVERNMENT_ID','REJECTED_BACKGROUND_CHECK','REJECTED_EDUCATION'", "'APPROVED','REJECTED_GOVERNMENT_ID'");
  db.exec(oldSchema);
  db.exec("INSERT INTO users(id) VALUES('synthetic-owner'); INSERT INTO pandit_applications(id,user_id,created_at,updated_at) VALUES('synthetic-case','synthetic-owner','2032-01-01T00:00:00.000Z','2032-01-01T00:00:00.000Z'); INSERT INTO pandit_evidence(id,application_id,kind,content_type,content_base64,created_at) VALUES('synthetic-old-evidence','synthetic-case','GOVERNMENT_ID','application/pdf','U1lOVEhFVElD','2032-01-01T00:00:00.000Z'); UPDATE pandit_policy SET pending_evidence_retention_days=NULL;");
  const before = db.prepare('SELECT * FROM pandit_evidence').get();
  initializePanditSchema(db);
  assert.deepEqual(db.prepare('SELECT * FROM pandit_evidence').get(), before);
  assert.equal(db.prepare('SELECT pending_evidence_retention_days FROM pandit_policy').get().pending_evidence_retention_days, null);
  db.exec("INSERT INTO pandit_evidence(id,application_id,kind,content_type,content_base64,created_at,retention_basis) VALUES('synthetic-new-evidence','synthetic-case','BACKGROUND_CHECK','application/pdf','U1lOVEhFVElD','2032-01-02T00:00:00.000Z','PENDING');");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, 2);
  initializePanditSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pandit_evidence').get().n, 2, 'upgrade is repeatable');
  db.close();
});

test('failed legacy evidence-table rebuild rolls back the rename and retains synthetic source rows', () => {
  const { initializePanditSchema } = require('../lib/pandit-onboarding');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, disabled INTEGER DEFAULT 0);');
    const oldSchema = SQLITE_SCHEMA.replace("'APPROVED','PENDING','REJECTED_GOVERNMENT_ID','REJECTED_BACKGROUND_CHECK','REJECTED_EDUCATION'", "'APPROVED','REJECTED_GOVERNMENT_ID'").replace(' CHECK((storage_path IS NULL) <> (content_base64 IS NULL)),', '');
    db.exec(oldSchema);
    db.exec("INSERT INTO users(id) VALUES('synthetic-owner'); INSERT INTO pandit_applications(id,user_id,created_at,updated_at) VALUES('synthetic-case','synthetic-owner','2032-01-01','2032-01-01'); INSERT INTO pandit_evidence(id,application_id,kind,content_type,content_base64,storage_path,created_at) VALUES('synthetic-invalid-legacy','synthetic-case','GOVERNMENT_ID','application/pdf','U1lOVEhFVElD','synthetic/path','2032-01-01');");
    const before = db.prepare('SELECT * FROM pandit_evidence').get();
    assert.throws(() => initializePanditSchema(db), /CHECK constraint failed/);
    assert.deepEqual(db.prepare('SELECT * FROM pandit_evidence').get(), before);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='pandit_evidence_old'").get(), undefined);
  } finally { db.close(); }
});
