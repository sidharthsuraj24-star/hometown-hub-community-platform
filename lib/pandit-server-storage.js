'use strict';

const { createClient } = require('@supabase/supabase-js');
const { StorageClient } = require('@supabase/storage-js');
const { createPanditPrivateStorage, PANDIT_PRIVATE_BUCKET } = require('./pandit-private-storage');
const { verifyPanditBucket } = require('./pandit-storage-bucket');

const KEY_ENV = 'PANDIT_EVIDENCE_STORAGE_KEY';

function safeHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Pandit evidence Storage URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Pandit evidence Storage URL must be a clean HTTPS origin.');
  }
  return url.origin;
}

/**
 * Construct the server-only client for the dedicated evidence bucket.
 * This factory is inert unless enabled is explicitly true. It never creates,
 * updates, or makes public a bucket, and it never falls back to the broader
 * Hometown Hub image-bucket credential.
 */
function createPanditServerStorage({
  env = process.env,
  enabled = false,
  isProduction = true,
  now = () => Date.now(),
  storageFetch,
  createSupabaseClient = createClient,
  StorageClientImpl = StorageClient,
} = {}) {
  if (enabled !== true) return null;
  if (isProduction !== true) throw new Error('The production Pandit Storage connector is server-only.');
  const url = safeHttpsUrl(env.SUPABASE_URL || '');
  const key = typeof env[KEY_ENV] === 'string' ? env[KEY_ENV].trim() : '';
  if (!key) {
    const error = new Error('Pandit evidence Storage is not configured.');
    error.code = 'PANDIT_STORAGE_NOT_CONFIGURED';
    throw error;
  }

  let storageApi;
  if (key.startsWith('sb_secret_')) {
    storageApi = new StorageClientImpl(`${url}/storage/v1`, { apikey: key }, storageFetch);
  } else {
    const client = createSupabaseClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      ...(storageFetch ? { global: { fetch: storageFetch } } : {}),
    });
    storageApi = client?.storage;
  }
  if (!storageApi || typeof storageApi.getBucket !== 'function') {
    throw new Error('Pandit evidence Storage client could not be initialized.');
  }

  const operations = createPanditPrivateStorage({
    storage: storageApi,
    isProduction: true,
    allowProductionEvidence: true,
    now,
  });
  async function preflight() {
    try {
      const result = await storageApi.getBucket(PANDIT_PRIVATE_BUCKET);
      if (!result || result.error || !result.data) throw new Error('lookup');
      verifyPanditBucket(result.data);
      return true;
    } catch {
      throw new Error('Private Pandit evidence bucket verification failed; no bucket changes were attempted.');
    }
  }
  const guarded = method => async params => {
    await preflight();
    return operations[method](params);
  };

  return Object.freeze({
    preflight,
    put: guarded('put'),
    get: guarded('get'),
    removeExpired: guarded('removeExpired'),
  });
}

module.exports = { KEY_ENV, createPanditServerStorage };
