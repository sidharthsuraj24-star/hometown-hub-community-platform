'use strict';

/**
 * Server-only access to Pandit evidence in a private bucket. Access defaults
 * to explicit simulations; production records require a separate enable flag.
 * Callers must fetch fresh records in their own transaction. This module
 * performs final record binding and storage operations, but never writes metadata.
 */
const PANDIT_PRIVATE_BUCKET = 'hometown-pandit-evidence';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEWER_ROLES = new Set(['CHECKER', 'COMPLIANCE']);
const EVIDENCE_KINDS = new Set(['GOVERNMENT_ID', 'BACKGROUND_CHECK', 'EDUCATION']);
const MAX_EVIDENCE_BYTES = 1048576;
const EVIDENCE_CONTENT_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const validEvidenceBytes = (contentType, body) => {
  if (!EVIDENCE_CONTENT_TYPES.has(contentType) || !Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_EVIDENCE_BYTES) return false;
  if (contentType === 'application/pdf') return body.subarray(0, 5).toString() === '%PDF-';
  if (contentType === 'image/png') return body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return body[0] === 255 && body[1] === 216 && body[2] === 255;
};
const APPROVED_BASIS = 'APPROVED';
const RETENTION_BASES = new Set(['APPROVED','PENDING','REJECTED_GOVERNMENT_ID','REJECTED_BACKGROUND_CHECK','REJECTED_EDUCATION']);

const fail = message => { throw new Error(message); };
const uuid = (value, label) => {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a UUID.`);
  return value.toLowerCase();
};
const storageAllowed = (application, isProduction, allowSimulations, allowProductionEvidence) => isProduction
  ? allowProductionEvidence === true && Number(application?.is_simulation) === 0
  : allowSimulations && (application?.is_simulation === true || application?.is_simulation === 1);
const submitted = application => Boolean(application?.submitted_at);
const activeActor = actor => actor && typeof actor.id === 'string' && actor.id.length > 0 && (actor.disabled === false || actor.disabled === 0) && actor.active !== false && actor.is_active !== false;
const timestamp = value => {
  const result = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(result) ? result : NaN;
};
const canonicalPath = (application, evidence) => {
  const applicationId = uuid(application?.id, 'application.id');
  const evidenceId = uuid(evidence?.id, 'evidence.id');
  if (uuid(evidence?.application_id, 'evidence.application_id') !== applicationId) fail('Evidence is not bound to this application.');
  const expected = `${applicationId}/${evidenceId}`;
  if (evidence?.storage_path !== undefined && evidence.storage_path !== expected) fail('Evidence storage_path is not canonical for its records.');
  return expected;
};
const storageError = (operation, error) => {
  if (!error) return;
  const status = error.statusCode ?? error.status ?? error.code;
  // Only a structured missing-object response is idempotent. Error text may
  // mention "not found" even on outages or access failures; those must retain
  // metadata so the sweep can retry instead of claiming a successful deletion.
  if (operation === 'remove' && (status === 404 || status === '404' || status === 'NOT_FOUND' || status === 'not_found')) return;
  throw new Error(`Private evidence ${operation} failed.`);
};
const unwrap = (operation, result) => {
  if (!result || typeof result !== 'object') fail(`Private evidence ${operation} returned no result.`);
  storageError(operation, result?.error);
  if (!result.error && (result.error !== null || result.data == null || operation === 'remove' && !Array.isArray(result.data))) fail(`Private evidence ${operation} returned an invalid success result.`);
  return result;
};

function createPanditPrivateStorage({ storage, isProduction = false, allowSimulations = false, allowProductionEvidence = false, now = () => Date.now() } = {}) {
  if (!storage || typeof storage.from !== 'function') fail('A Supabase-compatible storage dependency is required.');
  const bucket = storage.from(PANDIT_PRIVATE_BUCKET);
  if (!bucket || typeof bucket.upload !== 'function' || typeof bucket.download !== 'function' || typeof bucket.remove !== 'function') fail('Storage dependency must provide bucket upload, download, and remove methods.');
  const guard = application => {
    if (!storageAllowed(application, isProduction, allowSimulations, allowProductionEvidence)) fail('Private Pandit evidence is unavailable outside an explicitly enabled server workflow.');
  };
  const clock = () => typeof now === 'function' ? now() : now;
  const put = async ({ application, evidence, actor, bytes } = {}) => {
    guard(application);
    const path = canonicalPath(application, evidence);
    if (!activeActor(actor) || actor.id !== application.user_id) fail('Only the active application owner may upload evidence.');
    if (application.status !== 'ACTION_REQUIRED' || submitted(application)) fail('Uploads require an unsubmitted action-required application.');
    if (!EVIDENCE_KINDS.has(evidence?.kind) || !['application/pdf', 'image/png', 'image/jpeg'].includes(evidence?.content_type)) fail('Evidence category or content type is unsupported.');
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) fail('Evidence bytes are required.');
    const body = Buffer.from(bytes);
    if (body.length === 0 || body.length > MAX_EVIDENCE_BYTES) fail('Evidence must be non-empty and at most 1 MiB.');
    if (!validEvidenceBytes(evidence.content_type, body)) fail('Evidence content does not match its declared file type.');
    const result = await bucket.upload(path, body, { contentType: evidence.content_type, upsert: false });
    unwrap('upload', result);
    if (result.data.path !== path) fail('Private evidence upload returned a mismatched path.');
    return path;
  };
  const get = async ({ application, evidence, actor, role, now: at } = {}) => {
    guard(application);
    const path = canonicalPath(application, evidence);
    if (!activeActor(actor) || !REVIEWER_ROLES.has(role) || actor.id === application.user_id) fail('Only an active non-owner checker or compliance reviewer may access evidence.');
    if (!submitted(application)) fail('Evidence is available only after application submission.');
    const expiry = timestamp(evidence?.delete_after);
    const current = timestamp(at === undefined ? clock() : at);
    if (!Number.isFinite(current) || evidence?.delete_after != null && !Number.isFinite(expiry)) fail('Evidence expiry cannot be evaluated safely.');
    if (Number.isFinite(expiry) && expiry <= current) fail('Evidence has expired.');
    const result = await bucket.download(path);
    unwrap('download', result);
    if (!result || !result.data) fail('Private evidence download returned no data.');
    if (Number.isFinite(result.data.size) && result.data.size > MAX_EVIDENCE_BYTES) fail('Private evidence download exceeds the 1 MiB limit.');
    const body = Buffer.isBuffer(result.data) ? result.data : typeof result.data.arrayBuffer === 'function' ?
      Buffer.from(await result.data.arrayBuffer()) : Buffer.from(result.data);
    if (!validEvidenceBytes(evidence?.content_type, body)) fail('Private evidence download does not match its declared type or size limit.');
    return body;
  };
  const removeExpired = async ({ application, evidence, now } = {}) => {
    guard(application);
    const path = canonicalPath(application, evidence);
    const basis = evidence?.retention_basis;
    if (!EVIDENCE_KINDS.has(evidence?.kind)) fail('Evidence kind is not supported.');
    if (!RETENTION_BASES.has(basis)) fail('Evidence is not bound to an approved retention policy.');
    if (basis === 'REJECTED_GOVERNMENT_ID' && evidence?.kind !== 'GOVERNMENT_ID' || basis === 'REJECTED_BACKGROUND_CHECK' && evidence?.kind !== 'BACKGROUND_CHECK' || basis === 'REJECTED_EDUCATION' && evidence?.kind !== 'EDUCATION') fail('Evidence retention basis does not match its category.');
    const dueAt = timestamp(evidence?.delete_after);
    if (!Number.isFinite(dueAt)) fail('Evidence must have a finite delete_after deadline.');
    const at = now === undefined ? timestamp(clock()) : timestamp(now);
    if (!Number.isFinite(at)) fail('Removal time must be a valid timestamp.');
    if (dueAt > at) fail('Evidence retention has not expired.');
    const result = await bucket.remove([path]);
    unwrap('remove', result);
    return path;
  };
  return Object.freeze({ put, get, removeExpired });
}

module.exports = { PANDIT_PRIVATE_BUCKET, BUCKET: PANDIT_PRIVATE_BUCKET, createPanditPrivateStorage };
