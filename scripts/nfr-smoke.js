'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createApp } = require('../server');

const CONCURRENT_SESSIONS = 10;
const TARGET_MS = 3000;

async function fetchAndConsume(url) {
  const response = await fetch(url);
  const body = await response.arrayBuffer();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return { bytes: body.byteLength, contentType: response.headers.get('content-type') || '' };
}

async function anonymousShellReady(base) {
  const started = performance.now();
  const home = await fetchAndConsume(`${base}/`);
  if (!home.contentType.includes('text/html')) throw new Error('Homepage did not return HTML.');

  const resources = await Promise.all([
    '/styles.css',
    '/app.js',
    '/favicon.svg',
    '/api/meta',
    '/api/me'
  ].map(resource => fetchAndConsume(`${base}${resource}`)));

  if (!resources[3].contentType.includes('application/json') || !resources[4].contentType.includes('application/json')) {
    throw new Error('Initial metadata/session requests did not return JSON.');
  }
  return { elapsedMs: performance.now() - started, bytes: home.bytes + resources.reduce((sum, item) => sum + item.bytes, 0) };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-hub-perf-'));
  const server = createApp({ dataDir, env: {}, nodeEnv: 'test' });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const sessions = await Promise.all(Array.from({ length: CONCURRENT_SESSIONS }, () => anonymousShellReady(base)));
    const sorted = sessions.map(session => session.elapsedMs).sort((a, b) => a - b);
    const p50 = sorted[Math.ceil(sorted.length * 0.50) - 1];
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    const result = {
      metric: 'anonymous app-shell HTTP readiness (not browser paint or production capacity)',
      concurrentSessions: CONCURRENT_SESSIONS,
      requestsPerSession: 6,
      p50Ms: Number(p50.toFixed(1)),
      p95Ms: Number(p95.toFixed(1)),
      targetMs: TARGET_MS,
      p95WithinTarget: p95 < TARGET_MS,
      temporaryData: true
    };
    console.log(JSON.stringify(result, null, 2));
    if (p95 >= TARGET_MS) process.exitCode = 1;
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    server.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
