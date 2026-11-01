'use strict';

const crypto = require('node:crypto');
const { Pool, types: pgTypes } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { StorageClient } = require('@supabase/storage-js');
const SUPABASE_CA_CERT = require('./supabase-root-ca');
const { createPanditServerStorage } = require('./pandit-server-storage');
const { LOCK_KEY: PANDIT_RETENTION_LOCK_KEY } = require('./pandit-retention-worker');

const BUCKET = 'hometown-post-images';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;

function databaseSslOptions() {
  return { ca: SUPABASE_CA_CERT, rejectUnauthorized: true };
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// The application keeps SQLite's ? placeholders. This mapper deliberately skips
// quoted strings so SQL literals containing ? are not rewritten.
function toPg(sql) {
  let index = 0;
  let quote = null;
  let output = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      output += ch;
      if (ch === quote && sql[i + 1] === quote) { output += sql[++i]; continue; }
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch; output += ch;
    } else if (ch === '?') {
      output += `$${++index}`;
    } else output += ch;
  }
  return output;
}

function requiredProductionEnv(env = process.env) {
  const missing = ['SUPABASE_DB_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter(name => !env[name] || !String(env[name]).trim());
  return missing;
}

function createProductionAdapter(options = {}) {
  const env = options.env || process.env;
  const missing = requiredProductionEnv(env);
  if (missing.length) {
    const error = new Error(`Production backend is not configured: missing ${missing.join(', ')}`);
    error.code = 'PRODUCTION_BACKEND_NOT_CONFIGURED';
    error.missing = missing;
    throw error;
  }
  const valueTypes = {
    getTypeParser(oid, format) {
      if (oid === 20 || oid === 1700) return value => {
        const number = Number(value);
        return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : value;
      };
      if (oid === 1184) return value => new Date(value).toISOString();
      return pgTypes.getTypeParser(oid, format);
    }
  };
  const pool = options.pool || new Pool({
    connectionString: env.SUPABASE_DB_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    query_timeout: 10000,
    types: valueTypes,
    ssl: databaseSslOptions()
  });
  const storageKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const storageUrl = `${String(env.SUPABASE_URL).replace(/\/+$/, '')}/storage/v1`;
  // New sb_secret keys must be sent in apikey only; preserve the legacy JWT path.
  const storage = options.storage || (storageKey.startsWith('sb_secret_')
    ? new StorageClient(storageUrl, { apikey: storageKey }, options.storageFetch).from(BUCKET)
    : createClient(env.SUPABASE_URL, storageKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      ...(options.storageFetch ? { global: { fetch: options.storageFetch } } : {})
    }).storage.from(BUCKET));
  const panditEvidenceStorage = env.PANDIT_EVIDENCE_STORAGE_ENABLED === 'true'
    ? createPanditServerStorage({
      env, enabled: true, isProduction: true,
      storageFetch: options.panditStorageFetch,
      createSupabaseClient: options.panditCreateSupabaseClient || createClient,
      StorageClientImpl: options.panditStorageClientImpl || StorageClient,
    })
    : null;
  const query = (sql, ...params) => pool.query(toPg(sql), params);
  const one = async (sql, ...params) => (await query(sql, ...params)).rows[0] || null;
  const many = async (sql, ...params) => (await query(sql, ...params)).rows;
  const run = async (sql, ...params) => query(sql, ...params);
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        query: (sql, ...params) => client.query(toPg(sql), params),
        one: async (sql, ...params) => (await client.query(toPg(sql), params)).rows[0] || null,
        many: async (sql, ...params) => (await client.query(toPg(sql), params)).rows,
        run: (sql, ...params) => client.query(toPg(sql), params)
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }
  async function acquirePanditRetentionLock(tx) {
    const lock = await tx.one('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked', PANDIT_RETENTION_LOCK_KEY);
    return lock?.locked === true;
  }
  async function createSession(userId, token = crypto.randomBytes(32).toString('base64url')) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await run('INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', hashSessionToken(token), userId, expiresAt);
    return { token, expiresAt };
  }
  async function revokeSession(token) {
    if (token) await run('DELETE FROM app_sessions WHERE token_hash=?', hashSessionToken(token));
  }
  async function sessionUser(token) {
    if (!token) return null;
    const session = await one('SELECT user_id FROM app_sessions WHERE token_hash=? AND expires_at > now()', hashSessionToken(token));
    if (!session) return null;
    const user = await one('SELECT id,email,name,hometown,bio,role,disabled,created_at FROM users WHERE id=?', session.user_id);
    if (!user || user.disabled) { await revokeSession(token); return null; }
    return user;
  }
  async function ensureAdmin({ id, email, passwordSalt, passwordHash, createdAt }) {
    return transaction(async tx => {
      await tx.run('SELECT pg_advisory_xact_lock(hashtext(?))', `hometown-hub-admin:${email}`);
      const existing = await tx.one('SELECT id,role,disabled FROM users WHERE email=? FOR UPDATE', email);
      if (existing) {
        if (existing.role !== 'admin' || existing.disabled) {
          const error = new Error('The configured administrator email belongs to a non-admin or disabled account.');
          error.code = 'ADMIN_BOOTSTRAP_CONFLICT';
          throw error;
        }
        return false;
      }
      await tx.run('INSERT INTO users(id,email,name,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)', id, email, 'Platform administrator', passwordSalt, passwordHash, 'admin', createdAt);
      return true;
    });
  }
  async function rateLimit(bucket, nowMs = Date.now(), limit = 12) {
    const cutoff = new Date(nowMs - RATE_WINDOW_MS);
    return transaction(async tx => {
      await tx.run('SELECT pg_advisory_xact_lock(hashtext(?))', `hometown-hub-rate:${bucket}`);
      await tx.run('DELETE FROM rate_limit_attempts WHERE attempted_at < ?', cutoff);
      const result = await tx.one('SELECT COUNT(*)::int AS n FROM rate_limit_attempts WHERE bucket=? AND attempted_at >= ?', bucket, cutoff);
      if (Number(result?.n || 0) >= limit) return false;
      await tx.run('INSERT INTO rate_limit_attempts(bucket,attempted_at) VALUES(?,?)', bucket, new Date(nowMs));
      return true;
    });
  }
  async function upload(path, body, contentType) {
    const result = await storage.upload(path, body, { contentType, upsert: false, cacheControl: '31536000' });
    if (result.error) throw result.error;
    return path;
  }
  async function download(path) {
    const result = await storage.download(path);
    if (result.error) { if (/not found/i.test(result.error.message || '')) return null; throw result.error; }
    return Buffer.from(await result.data.arrayBuffer());
  }
  async function remove(path) {
    const result = await storage.remove([path]);
    if (result.error) throw result.error;
  }
  return {
    pool, storage, query, one, many, run, transaction, createSession, revokeSession, ensureAdmin,
    sessionUser, rateLimit, upload, download, remove, panditEvidenceStorage, acquirePanditRetentionLock,
    close: () => pool.end()
  };
}

module.exports = { BUCKET, SESSION_TTL_MS, hashSessionToken, toPg, requiredProductionEnv, databaseSslOptions, createProductionAdapter };
