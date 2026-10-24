'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.resolve(__dirname, '../scripts/apply-supabase-migrations.sh');

test('migration runner excludes unapproved draft 004 on every invocation (mock psql only)', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-migration-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  // This fake only records arguments. No database client, credentials or network.
  fs.writeFileSync(path.join(dir, 'psql'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$MOCK_PSQL_LOG"\n', { mode: 0o700 });
  const env = { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, SUPABASE_DB_URL: 'postgresql://synthetic.invalid/disallowed', MOCK_PSQL_LOG: log };
  for (let run = 0; run < 2; run += 1) {
    const result = spawnSync('/bin/bash', [runner], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipping already-applied Hometown Hub migration 004_pandit_onboarding\.sql/);
    assert.match(result.stdout, /migration 004 remains skipped because it is already applied to Hometown Hub production/);
  }
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 6);
  for (let run = 0; run < 2; run += 1) {
    for (const [index, file] of ['001_initial_schema.sql', '002_private_storage.sql', '003_enable_default_deny_rls.sql'].entries()) {
      assert.ok(calls[run * 3 + index].endsWith(file));
    }
  }
  assert.ok(calls.every(call => !call.includes('004_pandit_onboarding.sql')));
});
