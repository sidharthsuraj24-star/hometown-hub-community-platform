'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BUCKET } = require('../lib/pandit-private-storage');
const { FILE_SIZE_LIMIT, ALLOWED_MIME_TYPES, verifyPanditBucket, ensurePanditPrivateBucket } = require('../lib/pandit-storage-bucket');
const settings = extra => ({ id: BUCKET, name: BUCKET, public: false, file_size_limit: FILE_SIZE_LIMIT, allowed_mime_types: [...ALLOWED_MIME_TYPES], ...extra });
function mock(initial = null) {
  let bucket = initial;
  const calls = [];
  return { calls, storage: {
    async getBucket(id) { calls.push(['getBucket', id]); return bucket ? { data: bucket, error: null } : { data: null, error: { status: 404 } }; },
    async createBucket(id, options) {
      calls.push(['createBucket', id, options]);
      bucket = settings({ public: options.public, file_size_limit: options.fileSizeLimit, allowed_mime_types: options.allowedMimeTypes });
      return { data: { name: id }, error: null };
    },
  } };
}
test('bucket API provisioning is explicitly local and performs no calls when closed', async () => {
  for (const options of [{}, { allowLocal: true, isProduction: true }]) {
    const f = mock();
    await assert.rejects(() => ensurePanditPrivateBucket({ storage: f.storage, ...options }), /local-only/);
    assert.deepEqual(f.calls, []);
  }
});
test('idempotent API creation is private and bounded; subsequent calls only verify', async () => {
  const f = mock();
  const first = await ensurePanditPrivateBucket({ storage: f.storage, allowLocal: true });
  assert.equal(first.created, true);
  assert.deepEqual(f.calls[1], ['createBucket', BUCKET, { public: false, allowedMimeTypes: [...ALLOWED_MIME_TYPES], fileSizeLimit: FILE_SIZE_LIMIT }]);
  assert.equal((await ensurePanditPrivateBucket({ storage: f.storage, allowLocal: true })).created, false);
  assert.deepEqual(f.calls.map(call => call[0]), ['getBucket', 'createBucket', 'getBucket', 'getBucket']);
});
test('public and mismatched bucket settings fail closed without mutating existing settings', async () => {
  for (const extra of [
    { public: true }, { public: null }, { name: 'other' }, { id: 'other' },
    { file_size_limit: null }, { file_size_limit: FILE_SIZE_LIMIT + 1 },
    { allowed_mime_types: null }, { allowed_mime_types: ['image/*'] },
    { allowed_mime_types: [...ALLOWED_MIME_TYPES, 'text/plain'] },
    { allowed_mime_types: ['application/pdf', 'image/png', 'image/png'] },
  ]) {
    const f = mock(settings(extra));
    await assert.rejects(() => ensurePanditPrivateBucket({ storage: f.storage, allowLocal: true }), /mismatch/);
    assert.equal(f.calls.length, 1);
  }
  assert.doesNotThrow(() => verifyPanditBucket(settings({ file_size_limit: String(FILE_SIZE_LIMIT), allowed_mime_types: [...ALLOWED_MIME_TYPES].reverse() })));
});
test('lookup permission failures and outages never trigger bucket creation', async () => {
  for (const error of [{ status: 403 }, { status: 500, message: 'not found' }, { code: 'AccessDenied' }]) {
    let creates = 0;
    await assert.rejects(() => ensurePanditPrivateBucket({ allowLocal: true, storage: {
      getBucket: async () => ({ data: null, error }), createBucket: async () => { creates++; },
    } }), /lookup failed/);
    assert.equal(creates, 0);
  }
});
test('creation races re-read and verify; conflicts never reconcile a public bucket', async () => {
  for (const publicValue of [false, true]) {
    let reads = 0;
    const run = () => ensurePanditPrivateBucket({ allowLocal: true, storage: {
      getBucket: async () => ++reads === 1 ? { error: { code: 'NoSuchBucket' } } : { data: settings({ public: publicValue }), error: null },
      createBucket: async () => ({ error: { status: 409 } }),
    } });
    if (publicValue) await assert.rejects(run, /mismatch/);
    else assert.equal((await run()).created, false);
    assert.equal(reads, 2);
  }
});
test('verification after creation rejects drift and malformed results', async () => {
  for (const result of [undefined, { data: null, error: null }, { error: { status: 503 } }, { data: settings({ public: true }), error: null }]) {
    let reads = 0;
    await assert.rejects(() => ensurePanditPrivateBucket({ allowLocal: true, storage: {
      getBucket: async () => ++reads === 1 ? { error: { status: 404 } } : result,
      createBucket: async () => ({ data: { name: BUCKET }, error: null }),
    } }));
  }
});
test('unrecognized creation failures are not treated as success or retried', async () => {
  for (const error of [{ status: 403 }, { status: 500 }, { status: 400, message: 'already exists' }]) {
    let reads = 0;
    await assert.rejects(() => ensurePanditPrivateBucket({ allowLocal: true, storage: {
      getBucket: async () => { reads++; return { error: { status: 404 } }; },
      createBucket: async () => ({ error }),
    } }), /creation failed/);
    assert.equal(reads, 1);
  }
});
