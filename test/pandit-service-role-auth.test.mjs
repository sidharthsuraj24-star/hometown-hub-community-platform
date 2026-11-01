import test from 'node:test'
import assert from 'node:assert/strict'
import { isAuthorizedServiceRoleRequest } from '../supabase/functions/pandit-retention-cleanup/service-role-auth.mjs'
import { parseJsonRequestPayload, isPreflightPayload, isWorkerPayload } from '../supabase/functions/pandit-retention-cleanup/request-shape.mjs'

const KEY = 'synthetic-service-role-key-for-unit-tests'

function request(headers = {}) {
  return new Request('https://example.test/functions/v1/pandit-retention-cleanup', { headers })
}

test('accepts only matching Authorization and apikey headers for the runtime key', () => {
  assert.equal(isAuthorizedServiceRoleRequest(request({
    authorization: `Bearer ${KEY}`,
    apikey: KEY,
  }), KEY), true)
})

test('rejects missing, mismatched, or empty service-role credentials', () => {
  assert.equal(isAuthorizedServiceRoleRequest(request(), KEY), false)
  assert.equal(isAuthorizedServiceRoleRequest(request({ authorization: `Bearer ${KEY}` }), KEY), false)
  assert.equal(isAuthorizedServiceRoleRequest(request({ apikey: KEY }), KEY), false)
  assert.equal(isAuthorizedServiceRoleRequest(request({
    authorization: `Bearer ${KEY}`,
    apikey: 'different-key',
  }), KEY), false)
  assert.equal(isAuthorizedServiceRoleRequest(request({
    authorization: 'Bearer another-token',
    apikey: KEY,
  }), KEY), false)
  assert.equal(isAuthorizedServiceRoleRequest(request({
    authorization: `Bearer ${KEY}`,
    apikey: KEY,
  }), ''), false)
})

test('accepts only the exact preflight object and empty worker object', () => {
  assert.equal(isPreflightPayload({ mode: 'preflight' }), true)
  assert.equal(isPreflightPayload({ mode: 'preflight', extra: true }), false)
  assert.equal(isPreflightPayload([]), false)
  assert.equal(isPreflightPayload(null), false)
  assert.equal(isWorkerPayload({}), true)
  assert.equal(isWorkerPayload({ mode: 'preflight' }), false)
  assert.equal(isWorkerPayload({ extra: true }), false)
})

test('rejects empty or malformed JSON request bodies before worker execution', () => {
  for (const raw of ['', '   ', '{']) assert.equal(parseJsonRequestPayload(raw).ok, false)
  const parsed = parseJsonRequestPayload('{}')
  assert.deepEqual(parsed, { ok: true, value: {} })
  for (const raw of ['null', 'false', '0', '"x"', '[]']) {
    const result = parseJsonRequestPayload(raw)
    assert.equal(result.ok, true)
    assert.equal(isPreflightPayload(result.value), false)
    assert.equal(isWorkerPayload(result.value), false)
  }
})
