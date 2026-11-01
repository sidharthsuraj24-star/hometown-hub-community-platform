const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function parseJsonRequestPayload(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

function isPreflightPayload(value) {
  return isRecord(value) && Object.keys(value).length === 1 && value.mode === 'preflight'
}

function isWorkerPayload(value) {
  return isRecord(value) && Object.keys(value).length === 0
}

export { parseJsonRequestPayload, isPreflightPayload, isWorkerPayload }
