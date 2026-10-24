'use strict';

// Local HTTP benchmark only. Never loads .env or connects a production adapter.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createApp, passwordHash } = require('../server');
const COMMUNITIES = 100;
const POSTS = 1000;
const REQUESTS_PER_WORKER = 10;
const percentile = (values, p) => values[Math.ceil(values.length * p) - 1];

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-readiness-load-'));
  const server = createApp({ dataDir, env: {}, nodeEnv: 'test' });
  const lag = monitorEventLoopDelay({ resolution: 10 });
  try {
    const db = server.database;
    const stamp = new Date().toISOString();
    const hash = passwordHash('synthetic-load-password-123');
    db.exec('BEGIN');
    db.prepare('INSERT INTO users(id,email,name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run('synthetic-load-user', 'load@example.test', 'Synthetic load member', hash.salt, hash.hash, stamp);
    const community = db.prepare('INSERT INTO communities(id,name,location,description,category,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)');
    const member = db.prepare('INSERT INTO memberships(community_id,user_id,status,created_at) VALUES(?,?,?,?)');
    const post = db.prepare('INSERT INTO posts(id,community_id,user_id,body,category,created_at) VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < COMMUNITIES; i++) {
      community.run(`load-community-${i}`, `Synthetic community ${i}`, 'Test locality', 'Synthetic benchmark data only', 'General', 'approved', 'synthetic-load-user', stamp);
      member.run(`load-community-${i}`, 'synthetic-load-user', 'active', stamp);
    }
    for (let i = 0; i < POSTS; i++) post.run(`load-post-${i}`, `load-community-${i % COMMUNITIES}`, 'synthetic-load-user', `Synthetic post ${i}: ${'test content '.repeat(20)}`, 'General', stamp);
    db.exec('COMMIT');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'load@example.test', password: 'synthetic-load-password-123' }) });
    assert.equal(login.status, 200); await login.arrayBuffer();
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const results = [];
    const endpoints = ['/api/feed', '/api/communities'];
    for (const endpoint of endpoints) {
      // Warm the handler and validate payloads before the measured batches.
      const warm = await fetch(base + endpoint, { headers: { Cookie: cookie } });
      assert.equal(warm.status, 200);
      const payload = await warm.json();
      assert.equal((payload.posts || payload.communities).length, 100);
      for (const concurrency of [1, 10, 25]) {
        const latencies = []; let bytes = 0;
        lag.reset(); lag.enable();
        const started = performance.now();
        await Promise.all(Array.from({ length: concurrency }, async () => {
          for (let i = 0; i < REQUESTS_PER_WORKER; i++) {
            const begin = performance.now();
            const response = await fetch(base + endpoint, { headers: { Cookie: cookie } });
            const body = Buffer.from(await response.arrayBuffer());
            assert.equal(response.status, 200);
            assert.equal((JSON.parse(body).posts || JSON.parse(body).communities).length, 100);
            bytes += body.length; latencies.push(performance.now() - begin);
          }
        }));
        const elapsedMs = performance.now() - started;
        lag.disable(); latencies.sort((a, b) => a - b);
        results.push({ endpoint, concurrency, requests: latencies.length, errors: 0, p50Ms: +percentile(latencies, .50).toFixed(1), p95Ms: +percentile(latencies, .95).toFixed(1), maxMs: +latencies.at(-1).toFixed(1), requestsPerSecond: +(latencies.length * 1000 / elapsedMs).toFixed(1), totalBytes: bytes, eventLoopP95Ms: +(lag.percentile(95) / 1e6).toFixed(1) });
        console.error(`completed ${endpoint} concurrency=${concurrency}`);
      }
    }
    console.log(JSON.stringify({ scope: 'Loopback HTTP, single Node process + SQLite, one synthetic authenticated session shared by workers; no browser paint, remote services, production capacity or authentication load claim', synthetic: { users: 1, communities: COMMUNITIES, memberships: COMMUNITIES, posts: POSTS }, requestsPerWorker: REQUESTS_PER_WORKER, results, rssMiB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1), policySnapshot: db.prepare('SELECT approved_retention_years,approved_retention_days,rejected_evidence_retention_days,appeal_days,recheck_years FROM pandit_policy WHERE id=1').get(), temporaryData: true }, null, 2));
  } finally {
    lag.disable(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    server.closeDatabase(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
