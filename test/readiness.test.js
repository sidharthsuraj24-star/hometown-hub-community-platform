'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { createApp, passwordHash } = require('../server');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t) {
  const root = temporary(t);
  const server = createApp({ dataDir: root, nodeEnv: 'test', env: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server.closeDatabase();
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
function snapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('isolated SQLite online backup plus quiesced uploads restores every row and preserves the unset policy gate', async t => {
  const root = temporary(t);
  const source = path.join(root, 'source');
  const archive = path.join(root, 'archive');
  const restored = path.join(root, 'restored');
  const server = createApp({ dataDir: source, nodeEnv: 'test', env: {} });
  let open = true;
  t.after(() => { if (open) server.closeDatabase(); });
  const db = server.database;
  const stamp = new Date().toISOString();
  const hash = passwordHash('synthetic-readiness-password-123');
  // Synthetic fixtures only: no evidence API is enabled and no policy periods are set.
  db.prepare('INSERT INTO users(id,email,name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)')
    .run('synthetic-user', 'readiness@example.test', 'Synthetic readiness member', hash.salt, hash.hash, stamp);
  db.prepare('INSERT INTO communities(id,name,location,description,category,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('synthetic-community', 'Synthetic community', 'Test locality', 'Synthetic backup rehearsal only', 'General', 'approved', 'synthetic-user', stamp);
  db.prepare('INSERT INTO memberships(community_id,user_id,status,created_at) VALUES(?,?,?,?)')
    .run('synthetic-community', 'synthetic-user', 'active', stamp);
  const imageName = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png';
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(source, 'uploads', imageName), image, { mode: 0o600 });
  db.prepare('INSERT INTO posts(id,community_id,user_id,body,category,image_path,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('synthetic-post', 'synthetic-community', 'synthetic-user', 'Synthetic post', 'General', `/uploads/${imageName}`, stamp);
  db.prepare('INSERT INTO pandit_applications(id,user_id,is_simulation,created_at,updated_at) VALUES(?,?,1,?,?)')
    .run('synthetic-application', 'synthetic-user', stamp, stamp);
  db.prepare('INSERT INTO pandit_evidence(id,application_id,kind,content_type,content_base64,created_at) VALUES(?,?,?,?,?,?)')
    .run('synthetic-evidence', 'synthetic-application', 'EDUCATION', 'application/pdf', Buffer.from('%PDF-1.4\nSYNTHETIC BACKUP FIXTURE ONLY\n%%EOF').toString('base64'), stamp);
  const expected = snapshot(db);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  fs.mkdirSync(archive, { mode: 0o700 });
  // Online backup captures WAL contents; writers stay quiesced during upload copying.
  await backup(db, path.join(archive, 'hometown-hub.sqlite'));
  fs.chmodSync(path.join(archive, 'hometown-hub.sqlite'), 0o600);
  fs.cpSync(path.join(source, 'uploads'), path.join(archive, 'uploads'), { recursive: true });
  server.closeDatabase(); open = false;
  fs.rmSync(source, { recursive: true, force: true });
  fs.cpSync(archive, restored, { recursive: true });
  const app = createApp({ dataDir: restored, nodeEnv: 'test', env: {} });
  t.after(() => app.closeDatabase());
  assert.deepEqual(snapshot(app.database), expected);
  assert.equal(app.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(app.database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(sha256(fs.readFileSync(path.join(restored, 'uploads', imageName))), sha256(image));
  const policy = app.database.prepare('SELECT * FROM pandit_policy').get();
  assert.deepEqual({ approved_retention_years: policy.approved_retention_years, approved_retention_days: policy.approved_retention_days, pending_evidence_retention_days: policy.pending_evidence_retention_days, rejected_evidence_retention_days: policy.rejected_evidence_retention_days, rejected_background_check_retention_days: policy.rejected_background_check_retention_days, rejected_education_retention_days: policy.rejected_education_retention_days, appeal_days: policy.appeal_days, recheck_years: policy.recheck_years }, { approved_retention_years: 3, approved_retention_days: null, pending_evidence_retention_days: 90, rejected_evidence_retention_days: 90, rejected_background_check_retention_days: 90, rejected_education_retention_days: 90, appeal_days: 30, recheck_years: 1 });
  assert.equal(fs.statSync(path.join(restored, 'hometown-hub.sqlite')).mode & 0o777, 0o600);
  const { createFetchHandler } = require('../lib/fetch-handler');
  const invoke = createFetchHandler(() => app);
  // Preserve backup defaults, then explicitly unset this restored fixture for
  // the fail-closed evidence-gate assertion below.
  app.database.prepare('UPDATE pandit_policy SET approved_retention_years=NULL, approved_retention_days=NULL WHERE id=1').run();
  const login = await invoke(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'readiness@example.test', password: 'synthetic-readiness-password-123' }) }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const feed = await invoke(new Request('http://localhost/api/feed', { headers: { Cookie: cookie } }));
  assert.equal(feed.status, 200); assert.equal((await feed.json()).posts[0].id, 'synthetic-post');
  const upload = await invoke(new Request(`http://localhost/uploads/${imageName}`, { headers: { Cookie: cookie } }));
  assert.equal(upload.status, 200); assert.equal(sha256(Buffer.from(await upload.arrayBuffer())), sha256(image));
  const denied = await invoke(new Request('http://localhost/api/pandit-application/evidence', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ revision: 1, kind: 'EDUCATION', content_type: 'application/pdf', content_base64: Buffer.from('synthetic').toString('base64') }) }));
  assert.equal(denied.status, 503);
  const corrupted = path.join(root, 'corrupted.sqlite');
  fs.copyFileSync(path.join(archive, 'hometown-hub.sqlite'), corrupted);
  fs.truncateSync(corrupted, 64);
  assert.throws(() => { const broken = new DatabaseSync(corrupted, { readOnly: true }); try { broken.prepare('PRAGMA integrity_check').all(); } finally { broken.close(); } });
});

test('security smoke denies private paths and malformed/unauthorized requests with no-store errors', async t => {
  const { base } = await fixture(t);
  for (const endpoint of ['/.env', '/server.js', '/package.json', '/data/hometown-hub.sqlite', '/uploads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png']) {
    const response = await fetch(base + endpoint);
    assert.equal(response.status, 404, endpoint); await response.arrayBuffer();
  }
  for (const [body, status] of [['{', 400], ['null', 400], ['[]', 400], ['"text"', 400], ['{}', 401]]) {
    const response = await fetch(base + '/api/profile', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store'); await response.arrayBuffer();
  }
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  for (const [header, value] of [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['cross-origin-resource-policy', 'same-origin']]) assert.equal(response.headers.get(header), value);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  await response.arrayBuffer();
});

test('injected database failure is redacted and the next request recovers', async t => {
  const { server, base } = await fixture(t);
  const original = server.database.prepare;
  const originalLog = console.error;
  const logs = [];
  const marker = 'SYNTHETIC_PRIVATE_EVIDENCE_NOT_FOR_LOGS';
  try {
    server.database.prepare = () => { throw Object.assign(new Error(marker), { code: marker + '\nunsafe' }); };
    console.error = (...args) => logs.push(args.map(String).join(' '));
    const response = await fetch(base + '/api/meta');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Something went wrong. Please try again.' });
  } finally { server.database.prepare = original; console.error = originalLog; }
  assert.deepEqual(logs, ['hometown_hub_request_failure Error:NO_CODE']);
  const recovered = await fetch(base + '/api/meta');
  assert.equal(recovered.status, 200); await recovered.arrayBuffer();
});

test('Fetch boundary failures return generic no-store responses without sensitive logs', async () => {
  const { createFetchHandler } = require('../lib/fetch-handler');
  const original = console.error;
  const logs = [];
  const marker = 'SYNTHETIC_PRIVATE_BOUNDARY_MESSAGE';
  try {
    console.error = (...args) => logs.push(args.map(String).join(' '));
    for (const method of ['GET', 'HEAD']) {
      for (const getApp of [
        () => { throw new Error(marker); },
        () => ({ handle: async () => { throw Object.assign(new Error(marker), { name: 'Unsafe\nName', code: 'Unsafe\nCode' }); } })
      ]) {
        const response = await createFetchHandler(getApp)(new Request('http://localhost/api/meta', { method }));
        assert.equal(response.status, 500);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        if (method === 'HEAD') assert.equal(await response.text(), '');
        else assert.deepEqual(await response.json(), { error: 'Something went wrong. Please try again.' });
      }
    }
  } finally { console.error = original; }
  assert.deepEqual(logs, Array(4).fill('hometown_hub_fetch_failure Error:NO_CODE'));
});

test('outer Node failure boundary logs sanitized failures when response writing initially fails', async t => {
  const root = temporary(t);
  const app = createApp({ dataDir: root, nodeEnv: 'test', env: {} });
  t.after(() => app.closeDatabase());
  const original = console.error;
  const logs = [];
  let writes = 0;
  let status;
  let output;
  const req = { get url() { throw new Error('SYNTHETIC_PRIVATE_REQUEST'); } };
  const res = {
    headersSent: false,
    writeHead(code) { if (++writes === 1) throw new Error('SYNTHETIC_PRIVATE_RESPONSE'); status = code; },
    end(body) { output = body; }
  };
  try {
    console.error = (...args) => logs.push(args.map(String).join(' '));
    app.listeners('request')[0](req, res);
    await new Promise(resolve => setImmediate(resolve));
  } finally { console.error = original; }
  assert.equal(status, 500);
  assert.deepEqual(JSON.parse(output), { error: 'Something went wrong. Please try again.' });
  assert.deepEqual(logs, Array(2).fill('hometown_hub_request_failure Error:NO_CODE'));
});

test('Fetch request parsing enforces body size and JSON media type', async t => {
  const root = temporary(t);
  const app = createApp({ dataDir: root, nodeEnv: 'test', env: {} });
  t.after(() => app.closeDatabase());
  const { createFetchHandler } = require('../lib/fetch-handler');
  const invoke = createFetchHandler(() => app);
  for (const [contentType, body, expected] of [
    ['text/plain', '{}', 415],
    ['application/json', JSON.stringify({ value: 'x'.repeat(3 * 1024 * 1024) }), 413]
  ]) {
    const response = await invoke(new Request('http://localhost/api/profile', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': contentType }, body }));
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.json()).error);
  }
  assert.equal(app.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
});
