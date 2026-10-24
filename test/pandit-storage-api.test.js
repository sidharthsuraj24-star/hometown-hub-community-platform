'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPanditStorageHarness, BUCKET, MAX_FILE_SIZE } = require('./helpers/pandit-storage-harness');
const { createPanditPrivateStorage } = require('../lib/pandit-private-storage');
const { ensurePanditPrivateBucket } = require('../lib/pandit-storage-bucket');

const applicationId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const reviewerId = '44444444-4444-4444-8444-444444444444';
const NOW = '2035-01-01T00:00:00.000Z';
const PDF = Buffer.from('%PDF-1.4\nSYNTHETIC ONLY\n%%EOF\n');
const app = (extra = {}) => ({ id: applicationId, user_id: ownerId, is_simulation: 1, submitted_at: NOW, status: 'PENDING_VERIFICATION', ...extra });
const evidence = (extra = {}) => ({ id: evidenceId, application_id: applicationId, kind: 'GOVERNMENT_ID', content_type: 'application/pdf', storage_path: `${applicationId}/${evidenceId}`, delete_after: '2035-02-01T00:00:00.000Z', retention_basis: 'APPROVED', ...extra });
const actor = (extra = {}) => ({ id: reviewerId, disabled: false, ...extra });

 test('service SDK sees the exact private bucket settings and can use object endpoints', async () => {
  const harness = createPanditStorageHarness();
  const service = harness.storage('service');
  const metadata = await service.storage.getBucket(BUCKET);
  assert.equal(metadata.error, null);
  assert.deepEqual(metadata.data, { id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_FILE_SIZE, allowed_mime_types: ['application/pdf', 'image/png', 'image/jpeg'] });
  const path = `${applicationId}/${evidenceId}`;
  const uploaded = await service.storage.from(BUCKET).upload(path, PDF, { contentType: 'application/pdf', upsert: false });
  assert.equal(uploaded.error, null);
  const downloaded = await service.storage.from(BUCKET).download(path);
  assert.equal(downloaded.error, null);
  assert.deepEqual(Buffer.from(await downloaded.data.arrayBuffer()), PDF);
  const listed = await service.storage.from(BUCKET).list(applicationId);
  assert.equal(listed.error, null);
  assert.equal(listed.data[0].name, path);
  const removed = await service.storage.from(BUCKET).remove([path]);
  assert.equal(removed.error, null);
  assert.equal(removed.data[0].name, path);
  assert.equal(harness.objects.size, 0);
  assert.equal((await service.storage.from(BUCKET).download(path)).error.status, 404);
  assert.deepEqual((await service.storage.from(BUCKET).remove([path])).data, []);
});

test('anon and authenticated clients cannot upload, download, list, or delete private evidence', async () => {
  const harness = createPanditStorageHarness().seedObject(`${applicationId}/${evidenceId}`, PDF);
  for (const role of ['anon', 'authenticated']) {
    const client = harness.storage(role);
    const bucket = client.storage.from(BUCKET);
    for (const operation of [
      () => bucket.upload('new/path', PDF, { contentType: 'application/pdf' }),
      () => bucket.download(`${applicationId}/${evidenceId}`),
      () => bucket.list(),
      () => bucket.remove([`${applicationId}/${evidenceId}`])
    ]) {
      const result = await operation();
      assert.ok(result.error, `${role} operation should be denied`);
      assert.equal(String(result.error.status || result.error.statusCode), '403');
    }
  }
  assert.equal(harness.objects.size, 1);
});

test('private bucket blocks public URL, but authorized signing is possible and must not be used by the app', async () => {
  const harness = createPanditStorageHarness().seedObject(`${applicationId}/${evidenceId}`, PDF);
  const service = harness.storage('service');
  const publicUrl = service.storage.from(BUCKET).getPublicUrl(`${applicationId}/${evidenceId}`);
  assert.match(publicUrl.data.publicUrl, /\/object\/public\//);
  const publicResponse = await harness.fetch(publicUrl.data.publicUrl);
  assert.equal(publicResponse.status, 404);
  const before = harness.calls.length;
  const signed = await service.storage.from(BUCKET).createSignedUrl(`${applicationId}/${evidenceId}`, 60);
  assert.equal(signed.error, null);
  assert.equal(harness.calls.length, before + 1);
  assert.equal(harness.calls.at(-1).url.includes('/object/sign/'), true);
  assert.deepEqual(Buffer.from(await (await harness.fetch(signed.data.signedUrl)).arrayBuffer()), PDF);
  for (const role of ['anon', 'authenticated']) assert.equal((await harness.storage(role).storage.from(BUCKET).createSignedUrl(`${applicationId}/${evidenceId}`, 60)).error.status, 403);
});

test('private helper uses the injected service storage and preserves policy guards', async () => {
  const harness = createPanditStorageHarness();
  const helper = createPanditPrivateStorage({ storage: harness.storage('service').storage, allowSimulations: true, now: NOW });
  const params = { application: app({ submitted_at: null, status: 'ACTION_REQUIRED' }), evidence: evidence(), actor: actor({ id: ownerId }), role: 'CHECKER' };
  assert.equal(await helper.put({ ...params, bytes: PDF }), `${applicationId}/${evidenceId}`);
  assert.deepEqual(await helper.get({ ...params, application: app(), actor: actor(), now: NOW }), PDF);
  for (const denied of [
    { actor: actor({ disabled: true }), role: 'CHECKER' },
    { actor: actor({ id: ownerId }), role: 'CHECKER' },
    { actor: actor(), role: 'SUPER_ADMIN' },
    { application: app({ submitted_at: null, status: 'ACTION_REQUIRED' }), actor: actor(), role: 'CHECKER' },
    { evidence: evidence({ delete_after: NOW }), actor: actor(), role: 'CHECKER' }
  ]) await assert.rejects(() => helper.get({ ...params, ...denied }));
  assert.equal([...harness.objects.keys()].length, 1);
  await helper.removeExpired({ application: app(), evidence: evidence({ delete_after: NOW }), now: NOW });
  assert.equal(harness.objects.size, 0);
  await helper.removeExpired({ application: app(), evidence: evidence({ delete_after: NOW }), now: NOW });
  assert.ok(harness.calls.every(call => !/\/object\/(public|sign)\//.test(call.url)));
});

test('helper surfaces storage failures and does not mistake outages for missing objects', async () => {
  const calls = [];
  const storage = { from: () => ({
    upload: async () => ({ error: { status: 503 } }),
    download: async () => ({ error: { status: 503 } }),
    remove: async paths => { calls.push(paths); return { error: { status: 500, message: 'not found during outage' } }; }
  }) };
  const helper = createPanditPrivateStorage({ storage, allowSimulations: true, now: NOW });
  await assert.rejects(() => helper.put({ application: app({ submitted_at: null, status: 'ACTION_REQUIRED' }), evidence: evidence(), actor: actor({ id: ownerId }), bytes: PDF }), /upload failed/);
  await assert.rejects(() => helper.get({ application: app(), evidence: evidence(), actor: actor(), role: 'CHECKER' }), /download failed/);
  await assert.rejects(() => helper.removeExpired({ application: app(), evidence: evidence({ delete_after: NOW }), now: NOW }), /remove failed/);
  assert.equal(calls.length, 1);
});

test('local bucket initializer creates and verifies settings idempotently through the actual SDK wire contract', async () => {
  const harness = createPanditStorageHarness();
  harness.buckets.delete(BUCKET);
  const storage = harness.storage('service').storage;
  assert.equal((await ensurePanditPrivateBucket({ storage, allowLocal: true })).created, true);
  assert.equal((await ensurePanditPrivateBucket({ storage, allowLocal: true })).created, false);
  const creates = harness.calls.filter(call => call.method === 'POST');
  assert.equal(creates.length, 1);
  assert.deepEqual(JSON.parse(creates[0].body), { id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_FILE_SIZE, allowed_mime_types: ['application/pdf', 'image/png', 'image/jpeg'] });
  harness.configure({ bucket: { public: true } });
  await assert.rejects(() => ensurePanditPrivateBucket({ storage, allowLocal: true }), /mismatch/);
});

test('a broad policy fixture defeats private-only isolation; bucket settings verification is not policy verification', async () => {
  const harness = createPanditStorageHarness({ policies: { object: true, list: true } }).seedObject(`${applicationId}/${evidenceId}`, PDF);
  assert.equal((await ensurePanditPrivateBucket({ storage: harness.storage('service').storage, allowLocal: true })).created, false);
  const client = harness.storage('authenticated').storage.from(BUCKET);
  assert.equal((await client.download(`${applicationId}/${evidenceId}`)).error, null);
  assert.equal((await client.list()).data.length, 1);
});
