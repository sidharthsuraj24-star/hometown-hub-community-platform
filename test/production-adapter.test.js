'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { X509Certificate } = require('node:crypto');
const { BUCKET, toPg, hashSessionToken, requiredProductionEnv, databaseSslOptions, createProductionAdapter } = require('../lib/production-adapter');
const { createPanditStorageHarness } = require('./helpers/pandit-storage-harness');
const { LOCK_KEY } = require('../lib/pandit-retention-worker');

function mockPool() {
  const calls = [];
  const rows = [];
  return {
    calls, rows,
    async query(text, values) { calls.push({ text, values }); return { rows: rows.shift() || [], rowCount: 1 }; },
    async connect() {
      const tx = [];
      return {
        tx,
        async query(text, values) { tx.push({ text, values }); if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] }; return { rows: rows.shift() || [], rowCount: 1 }; },
        release() { this.released = true; }
      };
    },
    async end() {}
  };
}

test('production SQL mapper preserves quoted literals and numbers placeholders', () => {
  assert.equal(toPg("SELECT '?' AS literal, \"?\" AS identifier, ? AS value"), "SELECT '?' AS literal, \"?\" AS identifier, $1 AS value");
});

test('production Postgres TLS verifies with the Supabase Root 2021 CA', () => {
  const ssl = databaseSslOptions();
  const ca = new X509Certificate(ssl.ca);
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ca.subject, ca.issuer);
  assert.match(ca.subject, /CN=Supabase Root 2021 CA/);
});

test('production adapter hashes session tokens and uses injected pool/storage', async () => {
  const pool = mockPool();
  pool.rows.push([], [{ user_id: 'user-1' }], [{ id: 'user-1', email: 'member@example.test', disabled: false }]);
  const storageCalls = [];
  const storage = {
    async upload(path, body, options) { storageCalls.push(['upload', path, body, options]); return { data: {}, error: null }; },
    async download(path) { storageCalls.push(['download', path]); return { data: new Blob(['image']), error: null }; },
    async remove(paths) { storageCalls.push(['remove', paths]); return { data: {}, error: null }; }
  };
  const adapter = createProductionAdapter({ env: { SUPABASE_DB_URL: 'postgres://server-only', SUPABASE_URL: 'https://private.example', SUPABASE_SERVICE_ROLE_KEY: 'server-only' }, pool, storage });
  const session = await adapter.createSession('user-1', 'raw-token');
  assert.equal(pool.calls[0].values[0], hashSessionToken('raw-token'));
  assert.notEqual(pool.calls[0].values[0], 'raw-token');
  assert.ok(session.expiresAt instanceof Date);
  const user = await adapter.sessionUser('raw-token');
  assert.equal(user.id, 'user-1');
  await adapter.upload('uuid.png', Buffer.from('png'), 'image/png');
  assert.deepEqual(await adapter.download('uuid.png'), Buffer.from('image'));
  await adapter.remove('uuid.png');
  assert.deepEqual(storageCalls.map(call => call[0]), ['upload', 'download', 'remove']);
  await adapter.close();
});

test('production Storage adapter sends an sb_secret key in apikey only', async () => {
  const pool = mockPool();
  const key = 'sb_secret_synthetic_test_value';
  const requests = [];
  const storageFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    requests.push({ url: String(input), method: init.method || 'GET', apikey: headers.get('apikey'), authorization: headers.get('authorization') });
    return new Response(JSON.stringify({ Key: `${BUCKET}/synthetic-file.pdf`, id: 'synthetic-file.pdf' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const adapter = createProductionAdapter({
    env: { SUPABASE_DB_URL: 'postgres://server-only', SUPABASE_URL: 'https://private.example/', SUPABASE_SERVICE_ROLE_KEY: key },
    pool,
    storageFetch
  });
  assert.equal(await adapter.upload('synthetic-file.pdf', Buffer.from('%PDF-1.4\n'), 'application/pdf'), 'synthetic-file.pdf');
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, `/storage/v1/object/${BUCKET}/synthetic-file.pdf`);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].apikey, key);
  assert.equal(requests[0].authorization, null);
  await adapter.close();
});

test('production Storage adapter preserves bearer auth for legacy service_role JWT keys', async () => {
  const pool = mockPool();
  const key = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.synthetic-signature';
  const requests = [];
  const storageFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    requests.push({ apikey: headers.get('apikey'), authorization: headers.get('authorization') });
    return new Response(JSON.stringify({ Key: `${BUCKET}/synthetic-file.pdf`, id: 'synthetic-file.pdf' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const adapter = createProductionAdapter({
    env: { SUPABASE_DB_URL: 'postgres://server-only', SUPABASE_URL: 'https://private.example', SUPABASE_SERVICE_ROLE_KEY: key },
    pool,
    storageFetch
  });
  assert.equal(await adapter.upload('synthetic-file.pdf', Buffer.from('%PDF-1.4\n'), 'application/pdf'), 'synthetic-file.pdf');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].apikey, key);
  assert.equal(requests[0].authorization, `Bearer ${key}`);
  await adapter.close();
});

test('Pandit Storage adapter requires its own explicit flag and dedicated server key, and exposes a transaction lock', async () => {
  const pool = mockPool(), harness = createPanditStorageHarness();
  const baseEnv = { SUPABASE_DB_URL: 'postgres://server-only', SUPABASE_URL: 'https://synthetic-project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'general-key' };
  const disabled = createProductionAdapter({ env: baseEnv, pool, storage: {} });
  assert.equal(disabled.panditEvidenceStorage, null);
  await disabled.close();

  let clientArgs;
  const adapter = createProductionAdapter({
    env: { ...baseEnv, PANDIT_EVIDENCE_STORAGE_ENABLED: 'true', PANDIT_EVIDENCE_STORAGE_KEY: 'mock-service-key' },
    pool,
    storage: {},
    panditCreateSupabaseClient: (...args) => { clientArgs = args; return { storage: harness.storage('service').storage }; },
  });
  assert.ok(adapter.panditEvidenceStorage);
  assert.equal(clientArgs[0], baseEnv.SUPABASE_URL);
  assert.equal(clientArgs[1], 'mock-service-key');
  await adapter.panditEvidenceStorage.preflight();
  assert.equal(harness.calls.filter(call => call.url.includes('/storage/v1/bucket/')).length, 1);
  assert.equal(harness.calls.some(call => call.url.includes('/storage/v1/object/')), false);

  let sql, lockKey;
  assert.equal(await adapter.acquirePanditRetentionLock({ one: async (query, key) => { sql = query; lockKey = key; return { locked: true }; } }), true);
  assert.match(sql, /pg_try_advisory_xact_lock/);
  assert.equal(lockKey, LOCK_KEY);
  await adapter.close();
});

test('transaction rolls back and releases the connection on locking-flow failure', async () => {
  const pool = mockPool();
  const client = await pool.connect();
  pool.connect = async () => client;
  const adapter = createProductionAdapter({ env: { SUPABASE_DB_URL: 'postgres://server-only', SUPABASE_URL: 'https://private.example', SUPABASE_SERVICE_ROLE_KEY: 'server-only' }, pool, storage: {} });
  await assert.rejects(() => adapter.transaction(async tx => {
    await tx.one('SELECT id FROM events WHERE id=? FOR UPDATE', 'event-1');
    throw new Error('capacity');
  }), /capacity/);
  assert.deepEqual(client.tx.map(call => call.text), ['BEGIN', 'SELECT id FROM events WHERE id=$1 FOR UPDATE', 'ROLLBACK']);
  assert.equal(client.released, true);
});

test('admin bootstrap creates only the supplied administrator and uses a transaction lock', async () => {
  const pool = mockPool();
  const client = await pool.connect();
  pool.connect = async () => client;
  const adapter = createProductionAdapter({ env: { SUPABASE_DB_URL: 'postgres://server-only', SUPABASE_URL: 'https://private.example', SUPABASE_SERVICE_ROLE_KEY: 'server-only' }, pool, storage: {} });
  const created = await adapter.ensureAdmin({ id: 'admin-1', email: 'owner@example.test', passwordSalt: 'salt', passwordHash: 'hash', createdAt: new Date('2026-01-01T00:00:00.000Z') });
  assert.equal(created, true);
  assert.deepEqual(client.tx.map(call => call.text), [
    'BEGIN',
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    'SELECT id,role,disabled FROM users WHERE email=$1 FOR UPDATE',
    'INSERT INTO users(id,email,name,password_salt,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    'COMMIT'
  ]);
  assert.equal(client.tx[3].values[1], 'owner@example.test');
  assert.equal(client.tx[3].values[4], 'hash');
});

test('admin bootstrap refuses to promote an existing member account', async () => {
  const pool = mockPool();
  pool.rows.push([], [{ id: 'member-1', role: 'user', disabled: false }]);
  const client = await pool.connect();
  pool.connect = async () => client;
  const adapter = createProductionAdapter({ env: { SUPABASE_DB_URL: 'postgres://server-only', SUPABASE_URL: 'https://private.example', SUPABASE_SERVICE_ROLE_KEY: 'server-only' }, pool, storage: {} });
  await assert.rejects(() => adapter.ensureAdmin({ id: 'admin-1', email: 'owner@example.test', passwordSalt: 'salt', passwordHash: 'hash', createdAt: new Date() }), error => error.code === 'ADMIN_BOOTSTRAP_CONFLICT');
  assert.deepEqual(client.tx.map(call => call.text), [
    'BEGIN',
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    'SELECT id,role,disabled FROM users WHERE email=$1 FOR UPDATE',
    'ROLLBACK'
  ]);
});

test('production rate limiting serializes each bucket and enforces its threshold', async () => {
  const pool = mockPool();
  const client = await pool.connect();
  pool.connect = async () => client;
  pool.rows.push([], [], [{ n: 0 }]);
  const adapter = createProductionAdapter({ env: { SUPABASE_DB_URL: 'postgres://server-only', SUPABASE_URL: 'https://private.example', SUPABASE_SERVICE_ROLE_KEY: 'server-only' }, pool, storage: {} });
  assert.equal(await adapter.rateLimit('login:127.0.0.1', 1_000_000, 12), true);
  assert.ok(client.tx.some(call => call.text.startsWith('SELECT pg_advisory_xact_lock')));
  assert.ok(client.tx.some(call => call.text.startsWith('INSERT INTO rate_limit_attempts')));
  const insertsBeforeLimit = client.tx.filter(call => call.text.startsWith('INSERT INTO rate_limit_attempts')).length;
  pool.rows.push([], [], [{ n: 12 }]);
  assert.equal(await adapter.rateLimit('login:127.0.0.1', 1_000_001, 12), false);
  assert.equal(client.tx.filter(call => call.text.startsWith('INSERT INTO rate_limit_attempts')).length, insertsBeforeLimit);
  assert.equal(client.released, true);
});

test('missing production backend configuration is closed by default', () => {
  assert.deepEqual(requiredProductionEnv({}), ['SUPABASE_DB_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  assert.throws(() => createProductionAdapter({ env: {} }), /not configured/);
});
