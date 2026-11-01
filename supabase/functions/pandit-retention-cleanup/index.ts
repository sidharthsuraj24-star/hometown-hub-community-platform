import postgres from 'npm:postgres@3.4.7'
import { withSupabase } from 'npm:@supabase/server@1'
import { createPanditRetentionWorker } from './retention-worker.mjs'
import { parseJsonRequestPayload, isPreflightPayload, isWorkerPayload } from './request-shape.mjs'

const BUCKET = 'hometown-pandit-evidence'
const FILE_SIZE_LIMIT = 1_048_576
const MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function verifyBucket(bucket) {
  const types = bucket?.allowed_mime_types
  if (bucket?.id !== BUCKET || bucket?.name !== BUCKET || bucket?.public !== false ||
      ![FILE_SIZE_LIMIT, String(FILE_SIZE_LIMIT)].includes(bucket?.file_size_limit) ||
      !Array.isArray(types) || types.length !== MIME_TYPES.length || new Set(types).size !== types.length ||
      !MIME_TYPES.every(type => types.includes(type))) {
    throw new Error('private bucket config mismatch')
  }
  return bucket
}

function toPostgres(sql) {
  let index = 0
  let quote = null
  let output = ''
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]
    if (quote) {
      output += ch
      if (ch === quote && sql[i + 1] === quote) { output += sql[++i]; continue }
      if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      output += ch
    } else if (ch === '?') output += `$${++index}`
    else output += ch
  }
  return output
}

function dueTimestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : NaN
}

function storagePath(application, evidence) {
  if (typeof application?.id !== 'string' || !UUID.test(application.id) ||
      typeof evidence?.id !== 'string' || !UUID.test(evidence.id) ||
      typeof evidence?.application_id !== 'string' || evidence.application_id.toLowerCase() !== application.id.toLowerCase()) {
    throw new Error('invalid evidence binding')
  }
  const expected = `${application.id.toLowerCase()}/${evidence.id.toLowerCase()}`
  if (evidence.storage_path !== expected) throw new Error('noncanonical evidence path')
  return expected
}

function isMissingObject(error) {
  const status = error?.statusCode ?? error?.status ?? error?.code
  return status === 404 || status === '404' || status === 'NOT_FOUND' || status === 'not_found'
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export default {
  fetch: withSupabase({ auth: 'secret:pandit_cleanup_worker' }, async (request, ctx) => {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)

    const admin = ctx.supabaseAdmin
    if (!admin) return json({ ok: false, error: 'cleanup_unavailable' }, 503)

    let raw
    try { raw = await request.text() } catch { return json({ ok: false, error: 'invalid_request' }, 400) }
    const parsed = parseJsonRequestPayload(raw)
    if (!parsed.ok) return json({ ok: false, error: 'invalid_request' }, 400)
    const payload = parsed.value

    if (isPreflightPayload(payload)) {
      try {
        const { data, error } = await admin.storage.getBucket(BUCKET)
        if (error || !data) return json({ ok: false, error: 'bucket_unavailable' }, 503)
        verifyBucket(data)
        return json({ ok: true, bucketVerified: true })
      } catch {
        return json({ ok: false, error: 'bucket_unavailable' }, 503)
      }
    }
    if (!isWorkerPayload(payload)) return json({ ok: false, error: 'invalid_request' }, 400)

    const databaseUrl = Deno.env.get('SUPABASE_DB_URL') || ''
    if (!databaseUrl) return json({ ok: false, error: 'cleanup_unavailable' }, 503)

    const privateEvidenceStorage = Object.freeze({
      async removeExpired({ application, evidence, now }) {
        if (Number(application?.is_simulation) !== 0) throw new Error('simulation scope rejected')
        if (!['GOVERNMENT_ID', 'BACKGROUND_CHECK', 'EDUCATION'].includes(evidence?.kind)) throw new Error('unsupported evidence kind')
        if (!['APPROVED', 'PENDING', 'REJECTED_GOVERNMENT_ID', 'REJECTED_BACKGROUND_CHECK', 'REJECTED_EDUCATION'].includes(evidence?.retention_basis)) {
          throw new Error('unsupported retention basis')
        }
        if (evidence.retention_basis === 'REJECTED_GOVERNMENT_ID' && evidence.kind !== 'GOVERNMENT_ID' ||
            evidence.retention_basis === 'REJECTED_BACKGROUND_CHECK' && evidence.kind !== 'BACKGROUND_CHECK' ||
            evidence.retention_basis === 'REJECTED_EDUCATION' && evidence.kind !== 'EDUCATION') {
          throw new Error('retention basis mismatch')
        }
        const path = storagePath(application, evidence)
        const expiry = dueTimestamp(evidence?.delete_after)
        const current = dueTimestamp(now)
        if (!Number.isFinite(expiry) || !Number.isFinite(current) || expiry > current) throw new Error('evidence is not due')

        const { data, error } = await admin.storage.getBucket(BUCKET)
        if (error || !data) throw new Error('private bucket preflight failed')
        verifyBucket(data)
        const result = await admin.storage.from(BUCKET).remove([path])
        if (result?.error && !isMissingObject(result.error)) throw new Error('private object removal failed')
        if (!result?.error && !Array.isArray(result?.data)) throw new Error('private object removal response invalid')
        return path
      },
    })

    const db = postgres(databaseUrl, {
      max: 1,
      connect_timeout: 5,
      idle_timeout: 10,
      prepare: false,
    })
    const transaction = async callback => db.begin(async tx => {
      const query = async (statement, ...values) => tx.unsafe(toPostgres(statement), values)
      const adapter = {
        one: async (statement, ...values) => (await query(statement, ...values))[0] || null,
        many: async (statement, ...values) => await query(statement, ...values),
        run: async (statement, ...values) => {
          const result = await query(statement, ...values)
          return { rowCount: result.count }
        },
      }
      return callback(adapter)
    })
    const acquireLock = async (tx, key) => {
      const row = await tx.one('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked', key)
      return row?.locked === true
    }

    try {
      const worker = createPanditRetentionWorker({
        transaction,
        privateEvidenceStorage,
        isProduction: true,
        enabled: true,
        allowSimulations: false,
        acquireLock,
      })
      const result = await worker.runOnce()
      return json({ ok: true, result })
    } catch {
      return json({ ok: false, error: 'cleanup_failed' }, 503)
    } finally {
      try { await db.end({ timeout: 5 }) } catch { /* no credentials or error details are logged */ }
    }
  }),
}
