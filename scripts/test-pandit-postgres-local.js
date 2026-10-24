#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const BIN = '/usr/lib/postgresql/16/bin';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pandit-pg-'));
const data = path.join(root, 'data');
const socket = path.join(root, 'socket');
const log = path.join(root, 'postgres.log');
const migration = path.resolve(__dirname, '../supabase/migrations/004_pandit_onboarding.sql');
let started = false;
function command(file, args, input, options = {}) {
  const result = spawnSync(file, args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}
function psql(sql, user = 'postgres', extra = []) {
  return command(path.join(BIN, 'psql'), ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', user, '-d', 'postgres', ...extra], sql);
}
function must(sql, user = 'postgres', extra = []) {
  const result = psql(sql, user, extra);
  assert.equal(result.status, 0, `psql failed for ${user}: ${result.stderr}\n${sql}`);
  return result.stdout.trim();
}
function query(sql, user = 'postgres') { return must(sql, user, ['-At']); }
function jsonQuery(sql, user = 'postgres') { return JSON.parse(query(sql, user)); }
function snapshot() {
  return jsonQuery(`SELECT json_build_object(
    'bucket', (SELECT json_agg(row_to_json(x) ORDER BY id) FROM (SELECT id,name,public,file_size_limit,allowed_mime_types FROM storage.buckets) x),
    'objects', (SELECT json_agg(row_to_json(x) ORDER BY id) FROM (SELECT id,bucket_id,name,payload FROM storage.objects) x),
    'provider_tables', (SELECT json_agg(row_to_json(x) ORDER BY relname) FROM (SELECT relname,pg_get_userbyid(relowner) AS owner,relrowsecurity,relforcerowsecurity,relacl FROM pg_class WHERE oid IN ('storage.objects'::regclass,'storage.buckets'::regclass)) x),
    'owner', (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='storage.objects'::regclass),
    'rls', (SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass),
    'force_rls', (SELECT relforcerowsecurity FROM pg_class WHERE oid='storage.objects'::regclass),
    'policies', (SELECT json_agg(row_to_json(x) ORDER BY policyname) FROM (SELECT policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='storage' AND tablename='objects') x)
  )`);
}
function cleanup() {
  if (started) command(path.join(BIN, 'pg_ctl'), ['-D', data, '-o', `-k ${socket}`, '-m', 'immediate', 'stop']);
  fs.rmSync(root, { recursive: true, force: true });
}
process.on('exit', cleanup);
try {
  fs.mkdirSync(socket);
  let r = command(path.join(BIN, 'initdb'), ['-D', data, '--username=postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  assert.equal(r.status, 0, r.stderr);
  r = command(path.join(BIN, 'pg_ctl'), ['-D', data, '-o', `-k ${socket} -c listen_addresses=''`, '-l', log, '-w', 'start']);
  assert.equal(r.status, 0, r.stderr);
  started = true;
  must(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE provider_owner LOGIN;
    CREATE ROLE app_owner LOGIN;
    CREATE ROLE anon LOGIN;
    CREATE ROLE authenticated LOGIN;
    CREATE SCHEMA storage AUTHORIZATION provider_owner;
    CREATE TABLE public.users (id uuid PRIMARY KEY, email text);
    ALTER TABLE public.users OWNER TO app_owner;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL, file_size_limit integer, allowed_mime_types text[]);
    CREATE TABLE storage.objects (id uuid PRIMARY KEY, bucket_id text NOT NULL, name text NOT NULL, payload text);
    ALTER TABLE storage.buckets OWNER TO provider_owner;
    ALTER TABLE storage.objects OWNER TO provider_owner;
    GRANT CREATE ON SCHEMA public TO app_owner;
    REVOKE ALL ON SCHEMA storage FROM PUBLIC;
    REVOKE ALL ON storage.buckets, storage.objects FROM PUBLIC, app_owner;
    GRANT USAGE ON SCHEMA storage TO anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;
    INSERT INTO storage.buckets VALUES ('existing-private', 'existing-private', false, 123, ARRAY['application/pdf']);
    INSERT INTO storage.objects VALUES ('00000000-0000-0000-0000-000000000001', 'existing-private', 'synthetic.txt', 'synthetic fixture');
    INSERT INTO storage.buckets VALUES ('target-private', 'target-private', false, 456, ARRAY['application/pdf']);
    INSERT INTO storage.objects VALUES ('00000000-0000-0000-0000-000000000002', 'target-private', 'target.txt', 'synthetic target fixture');
    -- Fixture-only RLS setup: production storage policy DDL is intentionally not exercised here.
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  `);
  const before = snapshot();
  const migrationSql = fs.readFileSync(migration, 'utf8');
  r = psql('BEGIN;\n' + migrationSql + '\nCOMMIT;\n', 'app_owner');
  assert.equal(r.status, 0, `migration must execute as app schema owner: ${r.stderr}`);
  const after = snapshot();
  assert.deepEqual(after, before, 'provider storage ownership, RLS, policies, and data must be unchanged');
  assert.equal(query("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'pandit_%'"), '5');
  assert.equal(query("SELECT count(*) FROM pandit_applications") , '0');
  assert.equal(query("SELECT count(*) FROM pandit_evidence"), '0');
  assert.equal(query("SELECT count(*) FROM pandit_roles"), '0');
  assert.equal(query("SELECT count(*) FROM pandit_policy"), '0');
  assert.equal(query("SELECT count(*) FROM pandit_reviews"), '0');
  assert.equal(query("SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'pandit_%'"), '0');
  assert.equal(query("SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'pandit_%' AND relrowsecurity"), '5');
  assert.equal(query("SELECT has_table_privilege('app_owner','storage.objects','SELECT') OR has_table_privilege('app_owner','storage.buckets','SELECT')"), 'f');
  // Synthetic valid rows exercise the intended shape; each invalid case is isolated and rolled back.
  const validRows = `
    BEGIN;
    INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000011','valid@example.test');
    INSERT INTO pandit_applications (id,user_id,display_name) VALUES ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000011','Valid');
    INSERT INTO pandit_evidence (application_id,kind,content_type,storage_path) VALUES ('00000000-0000-0000-0000-000000000011','GOVERNMENT_ID','application/pdf','private/valid.pdf');
    INSERT INTO pandit_roles VALUES ('00000000-0000-0000-0000-000000000011','CHECKER');
    INSERT INTO pandit_policy (id,approved_retention_days) VALUES (1,30);
    INSERT INTO pandit_reviews (application_id,actor_id,event) VALUES ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000011','submitted');
    ROLLBACK;`;
  must(validRows);
  const invalidRows = [
    ['invalid status', "INSERT INTO pandit_applications (id,user_id,status) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000011','BROKEN')"],
    ['invalid evidence kind', "INSERT INTO pandit_evidence (application_id,kind,content_type,storage_path) VALUES ('00000000-0000-0000-0000-000000000011','PASSPORT','application/pdf','private/x.pdf')"],
    ['both evidence sources', "INSERT INTO pandit_evidence (application_id,kind,content_type,storage_path,content_base64) VALUES ('00000000-0000-0000-0000-000000000011','EDUCATION','application/pdf','private/x.pdf','eA==')"],
    ['neither evidence source', "INSERT INTO pandit_evidence (application_id,kind,content_type) VALUES ('00000000-0000-0000-0000-000000000011','EDUCATION','application/pdf')"],
    ['retention-kind mismatch', "INSERT INTO pandit_evidence (application_id,kind,content_type,storage_path,retention_basis) VALUES ('00000000-0000-0000-0000-000000000011','EDUCATION','application/pdf','private/x.pdf','REJECTED_GOVERNMENT_ID')"],
    ['approved units both set', "INSERT INTO pandit_policy (id,approved_retention_days,approved_retention_years) VALUES (1,30,1)"],
  ];
  for (const [label, statement] of invalidRows) {
    r = psql(`BEGIN;\n${statement};\nCOMMIT;`, 'postgres', ['-v', 'VERBOSITY=verbose']);
    assert.notEqual(r.status, 0, `${label} must violate a SQL constraint`);
    assert.match(r.stderr, /23514/, `${label} must fail a CHECK, not an unrelated FK or syntax constraint`);
  }
  // Client roles are explicitly denied table access; with disposable SELECT grants, RLS still defaults to zero rows.
  for (const role of ['anon', 'authenticated']) {
    r = psql('SELECT count(*) FROM pandit_applications;', role);
    assert.notEqual(r.status, 0, `${role} must be denied app-table access after migration revokes`);
  }
  must('GRANT SELECT ON pandit_applications, pandit_evidence, pandit_roles, pandit_policy, pandit_reviews TO anon, authenticated;');
  for (const role of ['anon', 'authenticated']) {
    const probe = validRows.replace('ROLLBACK;', `SET LOCAL ROLE ${role}; SELECT count(*) FROM pandit_applications; SELECT count(*) FROM pandit_evidence; ROLLBACK;`);
    assert.equal(must(probe, 'postgres', ['-qAt']), '0\n0', `${role} cannot see existing synthetic app/evidence rows under default-deny RLS`);
  }
  must('REVOKE SELECT ON pandit_applications, pandit_evidence, pandit_roles, pandit_policy, pandit_reviews FROM anon, authenticated;');
  // Re-grant disposable fixture table privileges so default-deny RLS, rather than ACLs, is tested.
  must('GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;', 'provider_owner');
  for (const role of ['anon', 'authenticated']) {
    assert.equal(query("SELECT count(*) FROM storage.objects", role), '0', `${role} sees no rows under RLS default deny`);
    for (const action of ['INSERT INTO storage.objects VALUES (gen_random_uuid(), \'existing-private\', \'denied\', \'x\')', "UPDATE storage.objects SET payload='denied'", 'DELETE FROM storage.objects']) {
      r = psql(`${action};`, role);
      if (action.startsWith('INSERT')) {
        assert.notEqual(r.status, 0, `${role} ${action} must be denied without a policy`);
        assert.match(r.stderr, /row-level security|permission denied/i);
      } else {
        assert.equal(r.status, 0, `${role} ${action} should be filtered by default-deny RLS`);
        assert.match(r.stdout, /UPDATE 0|DELETE 0/);
      }
    }
  }
  // A rerun is intentionally rejected, but its transaction must leave the first install unchanged.
  const rerunBefore = snapshot();
  r = psql('BEGIN;\n' + migrationSql + '\nCOMMIT;\n', 'app_owner');
  assert.notEqual(r.status, 0, 'fresh-only migration rerun must fail');
  assert.deepEqual(snapshot(), rerunBefore, 'failed rerun must roll back transactionally');
  console.log('PASS: 18 assertion categories: immutable app-owner migration/storage snapshot, app constraints, client revokes, default-deny storage RLS fixture, anon/auth object SELECT/INSERT/UPDATE/DELETE behavior, and transactional migration rerun rollback verified. Broad/restrictive production policy behavior is intentionally untested; no storage policy DDL is executed.');
} finally {
  cleanup();
}
