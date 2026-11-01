'use strict';

const { StorageClient } = require('@supabase/storage-js');

const PROJECT_URL = 'https://xsqnqmrnxtfymzkuzjoq.supabase.co';
const BUCKET = 'hometown-pandit-evidence';
const APP_ID = '11111111-1111-4111-8111-111111111111';
const EVIDENCE_ID = '22222222-2222-4222-8222-222222222222';
const FILE_SIZE_LIMIT = 1_048_576;
const MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const PDF = Buffer.from('%PDF-1.4\nSYNTHETIC RETENTION TEST ONLY\n%%EOF');
const OBJECT_PATH = `${APP_ID}/${EVIDENCE_ID}`;

function verifyBucket(bucket) {
  const types = bucket?.allowed_mime_types;
  if (bucket?.id !== BUCKET || bucket?.name !== BUCKET || bucket?.public !== false ||
      ![FILE_SIZE_LIMIT, String(FILE_SIZE_LIMIT)].includes(bucket?.file_size_limit) ||
      !Array.isArray(types) || types.length !== MIME_TYPES.length || new Set(types).size !== types.length ||
      !MIME_TYPES.every(type => types.includes(type))) {
    throw new Error('Test evidence bucket settings mismatch; refusing to change it.');
  }
}

async function main() {
  const key = process.env.PANDIT_TEST_SUPABASE_KEY;
  if (typeof key !== 'string' || !key.startsWith('sb_secret_')) throw new Error('A test-project secret key is required.');
  const storage = new StorageClient(`${PROJECT_URL}/storage/v1`, { apikey: key });
  let bucket = await storage.getBucket(BUCKET);
  if (!bucket?.error && bucket?.data) verifyBucket(bucket.data);
  else if (Number(bucket?.error?.statusCode ?? bucket?.error?.status) === 404) {
    const created = await storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: FILE_SIZE_LIMIT,
      allowedMimeTypes: MIME_TYPES,
    });
    if (created?.error) throw new Error('Disposable test bucket creation failed.');
    bucket = await storage.getBucket(BUCKET);
    if (bucket?.error || !bucket?.data) throw new Error('Disposable test bucket verification failed.');
    verifyBucket(bucket.data);
  } else {
    throw new Error('Disposable test bucket lookup failed.');
  }

  const existing = await storage.from(BUCKET).download(OBJECT_PATH);
  if (!existing?.error) throw new Error('Synthetic test object already exists; refusing to overwrite it.');
  if (Number(existing.error?.statusCode ?? existing.error?.status) !== 404) throw new Error('Synthetic test object lookup failed.');

  const uploaded = await storage.from(BUCKET).upload(OBJECT_PATH, PDF, {
    contentType: 'application/pdf',
    upsert: false,
  });
  if (uploaded?.error || uploaded?.data?.path !== OBJECT_PATH) throw new Error('Synthetic test object upload failed.');
  console.log(JSON.stringify({ ok: true, project: 'hometown-pandit-storage-test', bucketVerified: true, syntheticObjectUploaded: true }));
}

main().catch(() => {
  console.error('Synthetic test storage setup failed; credential values were not logged.');
  process.exitCode = 1;
});
