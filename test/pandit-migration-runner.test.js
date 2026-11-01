'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.resolve(__dirname, '../scripts/apply-supabase-migrations.sh');

function makeMockEnvironment(t, history, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-migration-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  // This fake only returns synthetic ledger versions and records calls. No database client, credentials or network.
  fs.writeFileSync(path.join(dir, 'psql'), `#!/bin/bash
set -e
if [[ "$*" == *"SELECT version FROM supabase_migrations.schema_migrations"* ]]; then
  printf '%s\\n' 'READ_HISTORY' >> "$MOCK_PSQL_LOG"
  if [[ "\${MOCK_HISTORY_FAIL:-}" == "1" ]]; then exit 42; fi
  if [[ -n "\${MOCK_MIGRATION_HISTORY:-}" ]]; then printf '%s\\n' "$MOCK_MIGRATION_HISTORY"; fi
  exit 0
fi
printf 'APPLY %s\\n' "$*" >> "$MOCK_PSQL_LOG"
`, { mode: 0o700 });
  const env = {
    PATH: `${dir}:/usr/bin:/bin`,
    HOME: dir,
    SUPABASE_DB_URL: 'postgresql://synthetic.invalid/disallowed',
    MOCK_PSQL_LOG: log,
    MOCK_MIGRATION_HISTORY: history,
    ...extraEnv,
  };
  return { env, log };
}

test('migration runner skips recorded versions and keeps 004–006 excluded', t => {
  assert.equal(fs.statSync(runner).mode & 0o111, 0o111, 'migration runner must remain executable');
  const { env, log } = makeMockEnvironment(t, '001\n002\n003\n004\n005\n006');
  for (let run = 0; run < 2; run += 1) {
    const result = spawnSync(runner, [], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipping already-applied migration 001_initial_schema\.sql/);
    assert.match(result.stdout, /Skipping already-applied migration 002_private_storage\.sql/);
    assert.match(result.stdout, /Skipping already-applied migration 003_enable_default_deny_rls\.sql/);
    assert.match(result.stdout, /Skipping already-applied Hometown Hub migration 004_pandit_onboarding\.sql/);
    assert.match(result.stdout, /Skipping already-applied Hometown Hub migration 005_pandit_storage_uploads\.sql/);
    assert.match(result.stdout, /Skipping already-applied Hometown Hub migration 006_pandit_retention_cron_extensions\.sql/);
  }
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['READ_HISTORY', 'READ_HISTORY']);
});

test('migration runner applies only a version missing from the recorded history', t => {
  const { env, log } = makeMockEnvironment(t, '001\n003\n004\n005\n006');
  const result = spawnSync(runner, [], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'READ_HISTORY');
  assert.ok(calls[1].endsWith('/002_private_storage.sql'), calls[1]);
});

test('migration runner fails closed if history cannot be read or is empty', t => {
  for (const extraEnv of [{ MOCK_HISTORY_FAIL: '1' }, {}]) {
    const history = extraEnv.MOCK_HISTORY_FAIL ? '001\n002\n003' : '';
    const { env, log } = makeMockEnvironment(t, history, extraEnv);
    const result = spawnSync(runner, [], { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['READ_HISTORY']);
  }
});
