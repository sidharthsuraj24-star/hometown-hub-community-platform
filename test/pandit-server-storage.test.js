'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPanditServerStorage, KEY_ENV } = require('../lib/pandit-server-storage');
const { createPanditStorageHarness, BUCKET } = require('./helpers/pandit-storage-harness');

const SYNTHETIC_PDF = Buffer.from('%PDF-1.4\nSYNTHETIC STORAGE CONNECTOR TEST ONLY\n%%EOF');
const APP_ID = '20000000-0000-4000-8000-000000000001';
const FILE_NOW = '2035-01-02T00:00:00.000Z';
const ENV = {
  SUPABASE_URL: 'https://synthetic-project.supabase.co',
  PANDIT_EVIDENCE_STORAGE_KEY: 'mock-service-key',
  SUPABASE_SERVICE_ROLE_KEY: 'must-not-be-used-as-a-fallback',
};

function serviceRoot(harness) { return harness.storage('service').storage; }

test('connector is inert unless explicitly enabled and refuses fallback to the general service key', () => {
  let constructed = 0;
  assert.equal(createPanditServerStorage({ createSupabaseClient: () => { constructed += 1; } }), null);
  assert.equal(constructed, 0);
  assert.throws(() => createPanditServerStorage({
    enabled: true,
    isProduction: true,
    env: { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'mock-service-key' },
    createSupabaseClient: () => { constructed += 1; },
  }), error => error.code === 'PANDIT_STORAGE_NOT_CONFIGURED');
  assert.equal(constructed, 0);
});

test('legacy server key uses a non-persistent server client and private bucket-only operations', async () => {
  const harness = createPanditStorageHarness();
  const clientArgs = [];
  const provider = createPanditServerStorage({
    enabled: true,
    isProduction: true,
    env: ENV,
    now: () => Date.parse(FILE_NOW),
    createSupabaseClient: (...args) => { clientArgs.push(args); return { storage: serviceRoot(harness) }; },
  });
  assert.deepEqual(Object.keys(provider).sort(), ['get', 'preflight', 'put', 'removeExpired']);
  assert.equal(clientArgs.length, 1);
  assert.equal(clientArgs[0][0], ENV.SUPABASE_URL);
  assert.equal(clientArgs[0][1], ENV[KEY_ENV]);
  assert.deepEqual(clientArgs[0][2].auth, { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
  assert.equal(clientArgs[0][2].global, undefined);

  const application = {
    id: APP_ID, user_id: 'synthetic-owner', is_simulation: 0,
    status: 'ACTION_REQUIRED', submitted_at: null,
  };
  const evidence = {
    id: randomUUID(), application_id: APP_ID, kind: 'GOVERNMENT_ID', content_type: 'application/pdf',
  };
  const path = await provider.put({
    application, evidence, actor: { id: 'synthetic-owner', disabled: false }, bytes: SYNTHETIC_PDF,
  });
  assert.equal(path, `${APP_ID}/${evidence.id}`);
  assert.ok(harness.objects.has(`${BUCKET}/${path}`));

  application.submitted_at = '2035-01-01T00:00:00.000Z';
  const downloadable = { ...evidence, storage_path: path, delete_after: '2036-01-01T00:00:00.000Z' };
  assert.deepEqual(await provider.get({
    application, evidence: downloadable, actor: { id: 'synthetic-checker', disabled: false }, role: 'CHECKER', now: FILE_NOW,
  }), SYNTHETIC_PDF);

  const expired = { ...downloadable, retention_basis: 'PENDING', delete_after: '2035-01-01T00:00:00.000Z' };
  assert.equal(await provider.removeExpired({ application, evidence: expired, now: FILE_NOW }), path);
  assert.equal(harness.objects.has(`${BUCKET}/${path}`), false);
  assert.equal(harness.calls.some(call => /\/(public|sign|list)(\/|\?)/.test(call.url)), false);
  assert.equal(harness.calls.some(call => call.method === 'POST' && call.url.includes('/storage/v1/bucket/')), false);
  assert.ok(harness.calls.some(call => call.url === `http://supabase.test/storage/v1/bucket/${BUCKET}`));
});

test('production connector rejects corrupt and oversized downloaded evidence', async () => {
  const harness = createPanditStorageHarness();
  const provider = createPanditServerStorage({
    enabled: true, isProduction: true, env: ENV, now: () => Date.parse(FILE_NOW),
    createSupabaseClient: () => ({ storage: serviceRoot(harness) }),
  });
  const application = {
    id: APP_ID, user_id: 'synthetic-owner', is_simulation: 0,
    status: 'PENDING_VERIFICATION', submitted_at: '2035-01-01T00:00:00.000Z',
  };
  for (const bytes of [Buffer.from('not a PDF'), Buffer.alloc(1048577, 0x41)]) {
    const id = randomUUID();
    const evidence = {
      id, application_id: APP_ID, kind: 'GOVERNMENT_ID', content_type: 'application/pdf',
      storage_path: `${APP_ID}/${id}`, delete_after: '2036-01-01T00:00:00.000Z',
    };
    harness.seedObject(evidence.storage_path, bytes, evidence.content_type);
    await assert.rejects(() => provider.get({
      application, evidence, actor: { id: 'synthetic-checker', disabled: false }, role: 'CHECKER', now: FILE_NOW,
    }), /download/);
    harness.objects.delete(`${BUCKET}/${evidence.storage_path}`);
  }
});

test('new sb_secret key reaches only the apikey header constructor path', async () => {
  const harness = createPanditStorageHarness();
  let captured;
  class FakeStorageClient {
    constructor(url, headers, fetch) {
      captured = { url, headers, fetch };
      return serviceRoot(harness);
    }
  }
  const provider = createPanditServerStorage({
    enabled: true,
    isProduction: true,
    env: { SUPABASE_URL: ENV.SUPABASE_URL, PANDIT_EVIDENCE_STORAGE_KEY: 'sb_secret_synthetic_test_key' },
    StorageClientImpl: FakeStorageClient,
    storageFetch: async () => { throw new Error('No network expected in this test.'); },
  });
  await provider.preflight();
  assert.equal(captured.url, `${ENV.SUPABASE_URL}/storage/v1`);
  assert.deepEqual(captured.headers, { apikey: 'sb_secret_synthetic_test_key' });
  assert.equal(captured.fetch instanceof Function, true);
});

test('bucket drift fails before any synthetic object operation', async () => {
  const harness = createPanditStorageHarness();
  harness.configure({ bucket: { public: true } });
  const provider = createPanditServerStorage({
    enabled: true, isProduction: true, env: ENV,
    createSupabaseClient: () => ({ storage: serviceRoot(harness) }),
  });
  await assert.rejects(() => provider.put({
    application: { id: APP_ID, user_id: 'synthetic-owner', is_simulation: 0, status: 'ACTION_REQUIRED' },
    evidence: { id: randomUUID(), application_id: APP_ID, kind: 'GOVERNMENT_ID', content_type: 'application/pdf' },
    actor: { id: 'synthetic-owner', disabled: false }, bytes: SYNTHETIC_PDF,
  }), /bucket verification failed/);
  assert.equal(harness.calls.some(call => call.url.includes('/storage/v1/object/')), false);
  assert.equal(harness.calls.every(call => call.url.includes(`/storage/v1/bucket/${BUCKET}`)), true);
});
