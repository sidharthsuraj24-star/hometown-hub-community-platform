'use strict';

const { createClient } = require('@supabase/supabase-js');
const BUCKET = 'hometown-pandit-evidence';
const MAX_FILE_SIZE = 1048576;
const ALLOWED_MIME_TYPES = Object.freeze(['application/pdf', 'image/png', 'image/jpeg']);
const ROLES = Object.freeze(['service', 'anon', 'authenticated']);
const BASE_URL = 'http://supabase.test';
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));

/** In-memory wire-contract fixture, NOT a Supabase Storage server or RLS engine. */
function createPanditStorageHarness(options = {}) {
  const calls = [], buckets = new Map(), objects = new Map(), signedTokens = new Map();
  const policies = { object: false, list: false, ...(options.policies || {}) };
  const config = { bucket: {
    id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_FILE_SIZE,
    allowed_mime_types: [...ALLOWED_MIME_TYPES], ...(options.bucket || {}),
  } };
  buckets.set(BUCKET, config.bucket);
  const keys = Object.freeze({ service: 'mock-service-key', anon: 'mock-anon-key', authenticated: 'mock-authenticated-key' });
  const roleForToken = token => Object.keys(keys).find(role => token === keys[role] || token === `mock-${role}-token`) || null;
  const roleForRequest = request => {
    const auth = request.headers.get('authorization');
    // A user bearer token must never inherit the service apikey's RLS bypass.
    return auth ? roleForToken(auth.replace(/^Bearer\s+/i, '')) : roleForToken(request.headers.get('apikey'));
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fail = (status, message, code = 'storage_error') => json({ statusCode: status, error: code, message }, status);
  const objectKey = (bucket, path) => `${bucket}/${path}`;
  const canObject = role => role === 'service' || role !== null && policies.object === true;
  const canList = role => role === 'service' || role !== null && policies.list === true;
  const bodyBuffer = async request => Buffer.from(await request.arrayBuffer());
  const readJson = async request => JSON.parse(await request.text() || '{}');
  const serve = item => item ? new Response(item.data, { headers: { 'content-type': item.contentType } }) : fail(404, 'Object not found.', 'not_found');

  async function fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== BASE_URL) throw new Error('Harness refuses any other origin; no network fallback exists.');
    const role = roleForRequest(request);
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await bodyBuffer(request.clone());
    calls.push({ method: request.method, url: request.url, role, headers: Object.fromEntries(request.headers), body });
    const match = url.pathname.match(/^\/storage\/v1\/(object|bucket)(?:\/([^/]+))?(?:\/(.*))?$/);
    if (!match) return fail(404, 'Storage endpoint not found.');
    const [type, second, path] = [match[1], decodeURIComponent(match[2] || ''), decodeURIComponent(match[3] || '')];
    if (type === 'bucket') {
      if (role !== 'service') return fail(403, 'Bucket administration denied.', 'access_denied');
      if (request.method === 'GET') return buckets.has(second) ? json(clone(buckets.get(second))) : fail(404, 'Bucket not found.', 'not_found');
      if (request.method === 'POST') {
        const data = await readJson(request);
        const name = data.id;
        if (buckets.has(name)) return fail(409, 'Bucket already exists.', 'Duplicate');
        buckets.set(name, { id: name, name, public: false, ...data });
        return json({ name });
      }
      return fail(405, 'Unsupported bucket operation.');
    }
    if (second === 'public') {
      const slash = path.indexOf('/'), bucket = path.slice(0, slash), key = path.slice(slash + 1);
      return buckets.get(bucket)?.public === true ? serve(objects.get(objectKey(bucket, key))) : fail(404, 'Private bucket.', 'not_found');
    }
    if (second === 'sign') {
      const slash = path.indexOf('/'), bucket = path.slice(0, slash), key = path.slice(slash + 1);
      const object = objects.get(objectKey(bucket, key));
      if (request.method === 'POST') {
        if (!canObject(role)) return fail(403, 'Signing denied.', 'access_denied');
        if (!object) return fail(404, 'Object not found.', 'not_found');
        const token = `synthetic-signed-token-${signedTokens.size}`;
        signedTokens.set(token, objectKey(bucket, key));
        return json({ signedURL: `/object/sign/${bucket}/${key}?token=${token}` });
      }
      // Tokens are synthetic; expiry/cryptography are intentionally not modeled.
      return signedTokens.get(url.searchParams.get('token')) === objectKey(bucket, key) ? serve(object) : fail(403, 'Invalid signed token.');
    }
    if (second === 'list' && request.method === 'POST') {
      if (!buckets.has(path)) return fail(404, 'Bucket not found.', 'not_found');
      if (!canList(role)) return fail(403, 'Listing denied by fixture policy.', 'access_denied');
      const data = await readJson(request), prefix = data.prefix || '';
      return json([...objects.values()].filter(item => item.bucket === path && item.path.startsWith(prefix)).map(item => ({ name: item.path, id: item.path, metadata: { size: item.data.length } })));
    }
    const bucket = buckets.get(second);
    if (!bucket) return fail(404, 'Bucket not found.', 'not_found');
    if (!canObject(role)) return fail(403, 'Object access denied by fixture policy.', 'access_denied');
    if (request.method === 'DELETE' && !path) {
      const data = await readJson(request), removed = [];
      for (const prefix of data.prefixes || []) {
        const key = objectKey(second, prefix);
        if (objects.delete(key)) removed.push({ name: prefix, bucket_id: second });
      }
      return json(removed); // Empty array is the idempotent already-missing result.
    }
    const key = objectKey(second, path);
    if (request.method === 'POST' || request.method === 'PUT') {
      const data = await bodyBuffer(request), contentType = request.headers.get('content-type') || 'application/octet-stream';
      if (data.length > Number(bucket.file_size_limit)) return fail(413, 'File exceeds bucket size limit.');
      if (!bucket.allowed_mime_types?.includes(contentType)) return fail(415, 'File type not allowed.');
      if (objects.has(key) && request.headers.get('x-upsert') !== 'true') return fail(409, 'Object already exists.');
      objects.set(key, { bucket: second, path, data, contentType });
      return json({ Key: `${second}/${path}`, id: path });
    }
    if (request.method === 'GET') return serve(objects.get(key));
    return fail(405, 'Unsupported object operation.');
  }
  const storage = (role = 'service') => {
    if (!ROLES.includes(role)) throw new Error(`Unknown mock role: ${role}`);
    return createClient(BASE_URL, keys[role], { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } });
  };
  const configure = changes => {
    if (changes?.bucket) { Object.assign(config.bucket, changes.bucket); buckets.set(BUCKET, config.bucket); }
    if (changes?.policies) Object.assign(policies, changes.policies);
    if (changes?.buckets) for (const [name, value] of Object.entries(changes.buckets)) buckets.set(name, { id: name, name, ...value });
    return harness;
  };
  const seedObject = (path, data, contentType = 'application/pdf', bucket = BUCKET) => {
    objects.set(objectKey(bucket, path), { bucket, path, data: Buffer.from(data), contentType });
    return harness;
  };
  const clear = () => { calls.length = 0; objects.clear(); signedTokens.clear(); return harness; };
  const harness = { storage, fetch, calls, buckets, objects, policies, keys, configure, seedObject, clear, constants: { BUCKET, MAX_FILE_SIZE, ALLOWED_MIME_TYPES } };
  return harness;
}
module.exports = { BUCKET, MAX_FILE_SIZE, ALLOWED_MIME_TYPES, createPanditStorageHarness };
