'use strict';

const crypto = require('node:crypto');
const { addDays, addYears } = require('./pandit-onboarding');

const APPROVED_RETENTION = Object.freeze({
  approved_retention_years: 3,
  approved_retention_days: null,
  pending_evidence_retention_days: 90,
  rejected_evidence_retention_days: 90,
  rejected_background_check_retention_days: 90,
  rejected_education_retention_days: 90,
  appeal_days: 30,
  recheck_years: 2,
});
const KINDS = Object.freeze({
  GOVERNMENT_ID: 'REJECTED_GOVERNMENT_ID',
  BACKGROUND_CHECK: 'REJECTED_BACKGROUND_CHECK',
  EDUCATION: 'REJECTED_EDUCATION',
});
const MAX_BATCH = 10;
const LOCK_KEY = 'hometown-hub-pandit-retention-v1';

const dateValue = value => {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : NaN;
};
const sameInstant = (left, right) => {
  const a = dateValue(left), b = dateValue(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
};
const exactPolicy = policy => Boolean(policy) && Object.entries(APPROVED_RETENTION).every(([key, expected]) =>
  expected === null ? policy[key] == null : Number(policy[key]) === expected);
const validKind = kind => Object.hasOwn(KINDS, kind);

function expectedPendingDeadline(application) {
  const activity = application?.last_activity_at || application?.updated_at || application?.created_at;
  if (!Number.isFinite(dateValue(activity))) return null;
  try { return addDays(activity, APPROVED_RETENTION.pending_evidence_retention_days); } catch { return null; }
}

function createPanditRetentionWorker({
  transaction,
  privateEvidenceStorage = null,
  isProduction = false,
  enabled = false,
  allowSimulations = false,
  acquireLock = null,
  now = () => new Date(),
  afterPurge = async () => {},
} = {}) {
  if (typeof transaction !== 'function') throw new Error('A transaction-capable database adapter is required.');
  if (typeof afterPurge !== 'function') throw new Error('A valid post-purge callback is required.');

  async function runOnce() {
    if (enabled !== true || !isProduction && allowSimulations !== true) {
      return { skipped: true, reason: 'worker-disabled' };
    }
    if (isProduction && (typeof acquireLock !== 'function' || !privateEvidenceStorage || typeof privateEvidenceStorage.removeExpired !== 'function')) {
      return { skipped: true, reason: 'production-worker-prerequisite-missing' };
    }
    const clock = typeof now === 'function' ? now() : now;
    const stamp = clock instanceof Date ? clock.toISOString() : new Date(clock).toISOString();
    if (!Number.isFinite(dateValue(stamp))) throw new Error('Retention worker clock is invalid.');
    let changed = false;
    const result = await transaction(async tx => {
      if (!tx || typeof tx.one !== 'function' || typeof tx.many !== 'function' || typeof tx.run !== 'function') {
        throw new Error('Retention worker transaction adapter is incomplete.');
      }
      if (isProduction && await acquireLock(tx, LOCK_KEY) !== true) {
        return { skipped: true, reason: 'worker-lock-busy', deletedEvidence: 0, deletedReservations: 0, skippedUnsafe: 0 };
      }
      const policy = await tx.one(`SELECT approved_retention_years,approved_retention_days,
        pending_evidence_retention_days,rejected_evidence_retention_days,
        rejected_background_check_retention_days,rejected_education_retention_days,appeal_days,recheck_years
        FROM pandit_policy WHERE id=1`);
      if (!exactPolicy(policy)) {
        return { skipped: true, reason: 'approved-policy-not-ready', deletedEvidence: 0, deletedReservations: 0, skippedUnsafe: 0 };
      }

      const simulationFlag = isProduction ? 0 : 1;
      let deletedEvidence = 0, deletedReservations = 0, skippedUnsafe = 0;
      const reservations = await tx.many(`SELECT j.* FROM pandit_storage_uploads j
        JOIN pandit_applications a ON a.id=j.application_id
        WHERE a.is_simulation=? AND j.retention_basis='PENDING' AND j.delete_after<=?
        ORDER BY j.delete_after,j.id LIMIT ?`, simulationFlag, stamp, MAX_BATCH);
      for (const reservation of reservations) {
        const application = await tx.one('SELECT * FROM pandit_applications WHERE id=?', reservation.application_id);
        if (!application || !sameInstant(reservation.delete_after, expectedPendingDeadline(application)) ||
            !validKind(reservation.kind) || !reservation.storage_path ||
            reservation.storage_path !== `${application.id}/${reservation.id}`) {
          skippedUnsafe += 1;
          continue;
        }
        if (await tx.one('SELECT id FROM pandit_evidence WHERE id=? AND application_id=?', reservation.id, application.id)) {
          throw new Error('Expired upload reservation conflicts with committed evidence; cleanup stopped.');
        }
        if (!privateEvidenceStorage || typeof privateEvidenceStorage.removeExpired !== 'function') {
          throw new Error('Private evidence storage is unavailable; cleanup metadata was retained.');
        }
        await privateEvidenceStorage.removeExpired({
          application,
          evidence: { ...reservation, application_id: application.id },
          now: stamp,
        });
        const deleted = await tx.run(`DELETE FROM pandit_storage_uploads
          WHERE id=? AND application_id=? AND storage_path=? AND retention_basis='PENDING' AND delete_after<=?`,
        reservation.id, application.id, reservation.storage_path, stamp);
        if (Number(deleted?.rowCount ?? deleted?.changes ?? 0) !== 1) {
          throw new Error('Upload reservation changed during cleanup; transaction rolled back.');
        }
        deletedReservations += 1;
        changed = true;
      }

      const applications = await tx.many(`SELECT a.* FROM pandit_applications a
        WHERE a.is_simulation=? AND (a.approved_record_until<=? OR a.rejected_evidence_until<=? OR EXISTS
          (SELECT 1 FROM pandit_evidence e WHERE e.application_id=a.id AND e.delete_after<=?))
        ORDER BY a.updated_at,a.id LIMIT ?`, simulationFlag, stamp, stamp, stamp, MAX_BATCH);
      for (const application of applications) {
        const approval = application.approved_record_until
          ? await tx.one(`SELECT created_at FROM pandit_reviews
              WHERE application_id=? AND event='REVIEW' AND to_status='APPROVED'
              ORDER BY created_at DESC,id DESC LIMIT 1`, application.id)
          : null;
        let expectedApproved = null;
        if (approval?.created_at) {
          try { expectedApproved = addYears(approval.created_at, APPROVED_RETENTION.approved_retention_years); } catch { expectedApproved = null; }
        }
        const approvedDeadlineValid = Boolean(expectedApproved && sameInstant(application.approved_record_until, expectedApproved));
        const approvedDue = approvedDeadlineValid && dateValue(application.approved_record_until) <= dateValue(stamp);
        let expectedRejected = null;
        if (application.rejected_at && Number.isFinite(dateValue(application.rejected_at))) {
          try { expectedRejected = addDays(application.rejected_at, APPROVED_RETENTION.rejected_evidence_retention_days); } catch { expectedRejected = null; }
        }
        const rejectedDeadlineValid = Boolean(expectedRejected && sameInstant(application.rejected_evidence_until, expectedRejected));
        const rejectedDue = rejectedDeadlineValid && dateValue(application.rejected_evidence_until) <= dateValue(stamp);
        const candidates = await tx.many(`SELECT * FROM pandit_evidence
          WHERE application_id=? AND delete_after IS NOT NULL AND delete_after<=?
          ORDER BY delete_after,id LIMIT ?`, application.id, stamp, MAX_BATCH);
        const removed = [];
        for (const evidence of candidates) {
          if (!validKind(evidence.kind)) { skippedUnsafe += 1; continue; }
          let expected = null;
          if (evidence.retention_basis === 'APPROVED' && approvedDeadlineValid) expected = expectedApproved;
          else if (evidence.retention_basis === 'PENDING') expected = expectedPendingDeadline(application);
          else if (evidence.retention_basis === KINDS[evidence.kind] && expectedRejected) expected = expectedRejected;
          if (!expected || !sameInstant(evidence.delete_after, expected)) { skippedUnsafe += 1; continue; }
          if (isProduction && (typeof evidence.storage_path !== 'string' ||
              evidence.storage_path !== `${application.id}/${evidence.id}` || evidence.content_base64 !== null)) {
            skippedUnsafe += 1;
            continue;
          }
          if (evidence.storage_path) {
            if (!privateEvidenceStorage || typeof privateEvidenceStorage.removeExpired !== 'function') {
              throw new Error('Private evidence storage is unavailable; cleanup metadata was retained.');
            }
            await privateEvidenceStorage.removeExpired({ application, evidence, now: stamp });
          }
          const deleted = await tx.run(`DELETE FROM pandit_evidence
            WHERE id=? AND application_id=? AND delete_after=? AND retention_basis=?`,
          evidence.id, application.id, evidence.delete_after, evidence.retention_basis);
          if (Number(deleted?.rowCount ?? deleted?.changes ?? 0) !== 1) {
            throw new Error('Evidence changed during cleanup; transaction rolled back.');
          }
          removed.push(evidence);
          deletedEvidence += 1;
          changed = true;
        }

        const pendingPurged = removed.some(e => e.retention_basis === 'PENDING');
        const nextStatus = approvedDue || pendingPurged ? 'ACTION_REQUIRED' : application.status;
        if (removed.length || approvedDue || rejectedDue) {
          const approvedRemaining = await tx.one(`SELECT MAX(delete_after) AS until FROM pandit_evidence
            WHERE application_id=? AND retention_basis='APPROVED'`, application.id);
          const rejectedRemaining = await tx.one(`SELECT MAX(delete_after) AS until FROM pandit_evidence
            WHERE application_id=? AND retention_basis LIKE 'REJECTED_%'`, application.id);
          const approvedUntil = approvedDue ? approvedRemaining?.until || null : application.approved_record_until;
          const rejectedUntil = rejectedDue ? rejectedRemaining?.until || null : application.rejected_evidence_until;
          await tx.run(`UPDATE pandit_applications SET status=?,revision=revision+1,updated_at=?,
            approved_record_until=?,rejected_evidence_until=?,evidence_expired_at=?,
            review_feedback=CASE WHEN ?=1 THEN '' ELSE review_feedback END WHERE id=? AND is_simulation=?`,
          nextStatus, stamp, approvedUntil, rejectedUntil, removed.length ? stamp : application.evidence_expired_at,
          removed.length || approvedDue || rejectedDue ? 1 : 0, application.id, simulationFlag);
          if (nextStatus !== application.status || approvedDue) {
            await tx.run('UPDATE pandit_evidence SET verified=0,verified_by=NULL WHERE application_id=?', application.id);
          }
          if (approvedDue) await audit(tx, application, 'APPROVED_RETENTION_EXPIRED', nextStatus, stamp);
          if (rejectedDue) await audit(tx, application, 'REJECTED_EVIDENCE_PURGED', nextStatus, stamp);
          if (removed.length && !approvedDue && !rejectedDue) {
            await audit(tx, application, pendingPurged ? 'PENDING_EVIDENCE_PURGED' : 'EVIDENCE_RETENTION_EXPIRED', nextStatus, stamp);
          }
        }
      }
      return { skipped: false, deletedEvidence, deletedReservations, skippedUnsafe,
        batchLimitReached: reservations.length === MAX_BATCH || applications.length === MAX_BATCH };
    });
    if (changed) await afterPurge();
    return result;
  }

  return Object.freeze({ runOnce });
}

async function audit(tx, application, event, toStatus, stamp) {
  await tx.run(`INSERT INTO pandit_reviews(id,application_id,actor_id,event,from_status,to_status,feedback,created_at)
    VALUES(?,?,NULL,?,?,?, '',?)`, crypto.randomUUID(), application.id, event, application.status || '', toStatus || application.status || '', stamp);
}

module.exports = { APPROVED_RETENTION, MAX_BATCH, LOCK_KEY, exactPolicy, createPanditRetentionWorker };
