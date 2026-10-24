'use strict';

const { PANDIT_PRIVATE_BUCKET } = require('./pandit-private-storage');
const FILE_SIZE_LIMIT = 1048576;
const ALLOWED_MIME_TYPES = Object.freeze(['application/pdf', 'image/png', 'image/jpeg']);
const errorStatus = error => String(error?.statusCode ?? error?.status ?? '');
const missingBucket = error => error && (errorStatus(error) === '404' || error.code === 'NoSuchBucket');
const duplicateBucket = error => error && (errorStatus(error) === '409' || ['Duplicate', 'BucketAlreadyExists'].includes(error.code));

function verifyPanditBucket(bucket) {
  const types = bucket?.allowed_mime_types;
  if (bucket?.id !== PANDIT_PRIVATE_BUCKET || bucket?.name !== PANDIT_PRIVATE_BUCKET || bucket?.public !== false ||
      ![FILE_SIZE_LIMIT, String(FILE_SIZE_LIMIT)].includes(bucket?.file_size_limit) ||
      !Array.isArray(types) || types.length !== ALLOWED_MIME_TYPES.length ||
      new Set(types).size !== types.length || !ALLOWED_MIME_TYPES.every(type => types.includes(type))) {
    throw new Error('Private evidence bucket settings mismatch; refusing to update or use this bucket.');
  }
  return bucket;
}

/**
 * Local preparation only. Inject a disposable Storage API adapter/mock; this module
 * never creates a client, reads credentials, runs SQL, or connects itself to routes.
 * Verifies settings, NOT the RLS policy inventory. Private != isolated from broad
 * existing policies. A separate isolation review is required before any release.
 */
async function ensurePanditPrivateBucket({ storage, allowLocal = false, isProduction = false } = {}) {
  if (!allowLocal || isProduction || process.env.NODE_ENV === 'production') {
    throw new Error('Private bucket provisioning is local-only and requires explicit local permission.');
  }
  if (!storage || typeof storage.getBucket !== 'function' || typeof storage.createBucket !== 'function') {
    throw new Error('An injected Supabase-compatible bucket admin API is required.');
  }
  const existing = await storage.getBucket(PANDIT_PRIVATE_BUCKET);
  if (!existing || !existing.error) {
    verifyPanditBucket(existing?.data);
    return { created: false, bucket: existing.data };
  }
  if (!missingBucket(existing.error)) throw new Error('Private evidence bucket lookup failed; no creation attempted.');
  const created = await storage.createBucket(PANDIT_PRIVATE_BUCKET, {
    public: false,
    allowedMimeTypes: [...ALLOWED_MIME_TYPES],
    fileSizeLimit: FILE_SIZE_LIMIT,
  });
  // A competing initializer may win. Never treat an arbitrary error as a conflict.
  if (!created || created.error && !duplicateBucket(created.error)) throw new Error('Private evidence bucket creation failed.');
  const verified = await storage.getBucket(PANDIT_PRIVATE_BUCKET);
  if (!verified || verified.error) throw new Error('Private evidence bucket verification failed.');
  verifyPanditBucket(verified.data);
  return { created: !created.error, bucket: verified.data };
}

module.exports = { FILE_SIZE_LIMIT, ALLOWED_MIME_TYPES, verifyPanditBucket, ensurePanditPrivateBucket };
