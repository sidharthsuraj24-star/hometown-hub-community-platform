'use strict';

const { createClient } = require('@supabase/supabase-js');
const { createPanditPrivateStorage, PANDIT_PRIVATE_BUCKET } = require('./pandit-private-storage');
const { verifyPanditBucket, FILE_SIZE_LIMIT, ALLOWED_MIME_TYPES } = require('./pandit-storage-bucket');

const MOCK_ORIGIN = 'http://supabase.test';

/**
 * Disposable integration ONLY. No environment credentials, configurable origin,
 * ambient fetch, session auth, bucket provisioning, SQL, or policy changes.
 * assertMockIsolation is a fixture assertion, NOT proof of production RLS.
 * Production remains unconditionally disabled by the server and route guards.
 */
function createPanditStorageApi({ config, isProduction = true, allowSimulations = false, nodeEnv, now,
  errorFactory = message => Object.assign(new Error(message), { status: 503 }) } = {}) {
  const unavailable = () => errorFactory('Private evidence storage is unavailable; no evidence was released.');
  let client;
  const configured = () => !isProduction && nodeEnv === 'test' && allowSimulations === true &&
    config?.serviceRoleKey === 'mock-service-key' && typeof config?.fetch === 'function' &&
    typeof config?.assertMockIsolation === 'function';
  const preflight = async () => {
    if (!configured()) throw unavailable();
    try {
      if (await config.assertMockIsolation() !== true) throw unavailable();
      if (!client) client = createClient(MOCK_ORIGIN, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input.url);
          if (url.origin !== MOCK_ORIGIN) throw unavailable();
          return config.fetch(input, init);
        } },
      });
      const result = await client.storage.getBucket(PANDIT_PRIVATE_BUCKET);
      if (!result || result.error) throw unavailable();
      verifyPanditBucket(result.data);
    } catch { throw unavailable(); }
  };
  // Construct lazily: invalid credentials or absent guards never reach even the SDK.
  const operation = method => async params => {
    await preflight();
    const storage = createPanditPrivateStorage({ storage: client.storage, isProduction, allowSimulations, now });
    try {
      const result = await storage[method](params);
      if (method === 'get') {
        const type = params.evidence?.content_type;
        const valid = type === 'application/pdf' ? result.subarray(0, 5).toString() === '%PDF-' :
          type === 'image/png' ? result.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
          type === 'image/jpeg' && result[0] === 255 && result[1] === 216 && result[2] === 255;
        if (!ALLOWED_MIME_TYPES.includes(type) || !valid || !result.length || result.length > FILE_SIZE_LIMIT) throw unavailable();
      }
      return result;
    } catch { throw unavailable(); }
  };
  return Object.freeze({ preflight, put: operation('put'), get: operation('get'), removeExpired: operation('removeExpired') });
}

module.exports = { createPanditStorageApi };
