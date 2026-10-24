'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BUCKET, createPanditPrivateStorage } = require('../lib/pandit-private-storage');

const applicationId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const reviewerId = '44444444-4444-4444-8444-444444444444';
const NOW = '2035-01-01T00:00:00.000Z';
const app = (extra = {}) => ({ id: applicationId, user_id: ownerId, is_simulation: 1, submitted_at: NOW, status: 'PENDING_VERIFICATION', ...extra });
const evidence = (extra = {}) => ({ id: evidenceId, application_id: applicationId, kind: 'GOVERNMENT_ID', content_type: 'application/pdf', storage_path: `${applicationId}/${evidenceId}`, delete_after: '2035-02-01T00:00:00.000Z', retention_basis: 'APPROVED', ...extra });
const actor = (extra = {}) => ({ id: reviewerId, disabled: false, ...extra });
function mockStorage() {
  const calls = [];
  const bucket = {
    async upload(...args) { calls.push(['upload', ...args]); return { data: { path: args[0] }, error: null }; },
    async download(...args) { calls.push(['download', ...args]); return { data: Buffer.from('private'), error: null }; },
    async remove(...args) { calls.push(['remove', ...args]); return { data: [], error: null }; },
  };
  return { calls, storage: { from(name) { calls.push(['from', name]); return bucket; } } };
}

 test('uses only the injected private bucket and canonical application/evidence path', async () => {
  const mock = mockStorage();
  const privateStorage = createPanditPrivateStorage({ storage: mock.storage, allowSimulations: true, now: NOW });
  assert.equal(BUCKET, 'hometown-pandit-evidence');
  assert.equal(await privateStorage.put({ application: app({ submitted_at: null, status: 'ACTION_REQUIRED' }), evidence: evidence(), actor: actor({ id: ownerId }), bytes: Buffer.from('%PDF-1.4\nSYNTHETIC ONLY\n%%EOF') }), `${applicationId}/${evidenceId}`);
  assert.deepEqual(mock.calls[1][0], 'upload');
  assert.equal(mock.calls[1][1], `${applicationId}/${evidenceId}`);
  await assert.rejects(() => privateStorage.put({ application: app(), evidence: evidence({ storage_path: `${applicationId}/other` }), bytes: Buffer.from('synthetic') }), /canonical/);
  assert.equal(mock.calls.length, 2);
});

test('fails closed before any storage action in production, without simulation permission, or for normal records', async () => {
  for (const options of [{ isProduction: true, allowSimulations: true }, { isProduction: false, allowSimulations: false }]) {
    const mock = mockStorage();
    const helper = createPanditPrivateStorage({ storage: mock.storage, ...options });
    await assert.rejects(() => helper.put({ application: app(), evidence: evidence(), bytes: Buffer.from('x') }));
    assert.deepEqual(mock.calls, [['from', BUCKET]]);
  }
  const mock = mockStorage();
  const helper = createPanditPrivateStorage({ storage: mock.storage, allowSimulations: true });
  await assert.rejects(() => helper.put({ application: app({ is_simulation: 0 }), evidence: evidence(), bytes: Buffer.from('x') }));
  assert.deepEqual(mock.calls, [['from', BUCKET]]);
});

test('get requires an active non-owner checker/compliance reviewer and submitted, unexpired evidence', async () => {
  const mock = mockStorage();
  const helper = createPanditPrivateStorage({ storage: mock.storage, allowSimulations: true, now: NOW });
  const params = { application: app(), evidence: evidence(), actor: actor(), role: 'CHECKER' };
  assert.deepEqual(await helper.get(params), Buffer.from('private'));
  for (const denied of [
    { role: 'SUPER_ADMIN' }, { role: 'CHECKER', actor: actor({ id: ownerId }) },
    { role: 'COMPLIANCE', actor: actor({ disabled: true }) },
    { role: 'CHECKER', actor: actor({ disabled: 1 }) },
    { role: 'CHECKER', actor: actor({ disabled: undefined }) },
    { role: 'CHECKER', application: app({ submitted_at: null, status: 'ACTION_REQUIRED' }) },
    { role: 'CHECKER', evidence: evidence({ delete_after: NOW }) },
    { role: 'CHECKER', evidence: evidence({ delete_after: 'invalid-expiry' }) },
    { role: 'CHECKER', now: 'invalid-clock' },
  ]) await assert.rejects(() => helper.get({ ...params, ...denied }));
  const downloads = mock.calls.filter(call => call[0] === 'download');
  assert.equal(downloads.length, 1);
});

test('removeExpired enforces policy and due-time boundary; failed removal is observable while missing is idempotent', async () => {
  const mock = mockStorage();
  const helper = createPanditPrivateStorage({ storage: mock.storage, allowSimulations: true, now: NOW });
  assert.equal(await helper.removeExpired({ application: app(), evidence: evidence({ delete_after: NOW }), now: NOW }), `${applicationId}/${evidenceId}`);
  await assert.rejects(() => helper.removeExpired({ application: app(), evidence: evidence({ delete_after: '2035-01-01T00:00:00.001Z' }), now: NOW }), /not expired/);
  for (const invalid of [
    { retention_basis: 'UNKNOWN' }, { retention_basis: 'REJECTED_GOVERNMENT_ID', kind: 'EDUCATION' },
    { kind: 'UNKNOWN' }, { delete_after: null }, { storage_path: 'arbitrary/prefix' },
  ]) await assert.rejects(() => helper.removeExpired({ application: app(), evidence: evidence(invalid), now: NOW }));
  // Use a direct bucket mock for the failed-removal assertion to avoid recursive from().
  const failedCalls = [];
  const failed = createPanditPrivateStorage({ storage: { from: name => ({ upload: async () => ({}), download: async () => ({}), remove: async paths => { failedCalls.push(paths); return { error: { status: 500 } }; } }) }, allowSimulations: true });
  await assert.rejects(() => failed.removeExpired({ application: app(), evidence: evidence({ delete_after: NOW }), now: NOW }), /remove failed/);
  assert.equal(failedCalls.length, 1);
  const missing = createPanditPrivateStorage({ storage: { from: () => ({ upload: async () => ({}), download: async () => ({}), remove: async () => ({ error: { status: 404 } }) }) }, allowSimulations: true });
  await assert.doesNotReject(() => missing.removeExpired({ application: app(), evidence: evidence({ delete_after: NOW }), now: NOW }));
});

test('removeExpired never treats an explicit server or authorization failure as a missing object', async () => {
  for (const error of [
    { status: 500, message: 'Storage dependency not found' },
    { statusCode: '503', message: 'Storage service does not exist' },
    { status: 403, message: 'Object not found or access denied' },
    { code: 'AccessDenied', message: 'Object not found' },
  ]) {
    const helper = createPanditPrivateStorage({ allowSimulations: true, storage: { from: () => ({
      upload: async () => ({}), download: async () => ({}), remove: async () => ({ error }),
    }) } });
    await assert.rejects(() => helper.removeExpired({ application: app(), evidence: evidence({ delete_after: NOW }), now: NOW }), /remove failed/);
  }
});

test('new pending and rejected per-kind bases allow deletion only at or after the precise deadline', async () => {
  for (const [basis, kind] of [
    ['PENDING', 'GOVERNMENT_ID'], ['PENDING', 'BACKGROUND_CHECK'], ['PENDING', 'EDUCATION'],
    ['REJECTED_BACKGROUND_CHECK', 'BACKGROUND_CHECK'], ['REJECTED_EDUCATION', 'EDUCATION'],
  ]) {
    const mock = mockStorage();
    const helper = createPanditPrivateStorage({ storage: mock.storage, allowSimulations: true });
    const params = { application: app(), evidence: evidence({ kind, retention_basis: basis, delete_after: NOW }) };
    await assert.rejects(() => helper.removeExpired({ ...params, now: '2034-12-31T23:59:59.999Z' }), /not expired/);
    assert.equal(await helper.removeExpired({ ...params, now: NOW }), `${applicationId}/${evidenceId}`);
    assert.equal(await helper.removeExpired({ ...params, now: '2035-01-01T00:00:00.001Z' }), `${applicationId}/${evidenceId}`);
    assert.equal(mock.calls.filter(call => call[0] === 'remove').length, 2);
  }
  for (const [basis, kind] of [['REJECTED_BACKGROUND_CHECK', 'EDUCATION'], ['REJECTED_EDUCATION', 'GOVERNMENT_ID']]) {
    const mock = mockStorage();
    const helper = createPanditPrivateStorage({ storage: mock.storage, allowSimulations: true });
    await assert.rejects(() => helper.removeExpired({ application: app(), evidence: evidence({ kind, retention_basis: basis, delete_after: NOW }), now: NOW }));
    assert.equal(mock.calls.filter(call => call[0] === 'remove').length, 0);
  }
});

test('put requires an active owning applicant, unsubmitted draft and valid bounded evidence', async () => {
  const mock = mockStorage();
  const helper = createPanditPrivateStorage({ storage: mock.storage, allowSimulations: true });
  const params = { application: app({ status: 'ACTION_REQUIRED', submitted_at: null }), evidence: evidence(), actor: actor({ id: ownerId }), bytes: Buffer.from('%PDF-1.4\nSYNTHETIC ONLY\n%%EOF') };
  for (const denied of [
    { actor: undefined }, { actor: actor() }, { actor: actor({ id: ownerId, disabled: true }) },
    { actor: actor({ id: ownerId, disabled: undefined }) },
    { application: app() }, { application: app({ status: 'REJECTED', submitted_at: null }) },
    { application: app({ status: 'ACTION_REQUIRED', submitted_at: NOW }) },
    { evidence: evidence({ kind: 'OTHER' }) }, { evidence: evidence({ content_type: 'text/plain' }) },
    { bytes: Buffer.alloc(0) }, { bytes: Buffer.alloc(1048577) }, { bytes: Buffer.from('not a pdf') },
  ]) await assert.rejects(() => helper.put({ ...params, ...denied }));
  assert.equal(mock.calls.filter(call => call[0] === 'upload').length, 0);
  assert.equal(await helper.put(params), `${applicationId}/${evidenceId}`);
  assert.deepEqual(mock.calls.at(-1)[3], { contentType: 'application/pdf', upsert: false });
});

test('malformed storage successes cannot authorize deletion or a claimed upload', async () => {
  for (const result of [undefined, null, {}, { data: [] }, { data: null, error: null }, { data: {}, error: null }]) {
    const helper = createPanditPrivateStorage({ allowSimulations: true, storage: { from: () => ({
      upload: async () => result, download: async () => result, remove: async () => result,
    }) } });
    await assert.rejects(() => helper.removeExpired({ application: app(), evidence: evidence({ delete_after: NOW }), now: NOW }));
  }
});
