# Hometown Hub — Product Requirements Document

**Status:** Phase 1 prototype implemented; production is owner-approved for access by direct link, while Vercel SSO protects preview deployments only. Public-by-link access is not a promoted public launch. The release branch gates Pandit APIs on the dedicated server-side Storage connector. Earlier read-only checks reported migrations 001–006, empty Pandit application/evidence/upload-journal tables, a private 1 MiB PDF/PNG/JPEG bucket with default-deny client access, and two distinct active reviewer roles; the first scheduled cleanup call was reported as HTTP 200 with zero deletions. This local-only code audit at `fe3c829` did not recheck those hosted details or change production configuration/data. No production user, application, or file was created for release checks, and no end-to-end applicant flow was exercised. No legal or compliance certification is claimed.
**Product:** Hometown Hub
**Product type:** Responsive web application for hometown and local communities.

## 1. Problem and opportunity

People move away from their hometowns for work or education and can lose touch with local relationships, traditions, and initiatives. Existing broad social platforms and fragmented group chats do not provide a structured, community-owned place for local discussions, announcements, and gatherings.

Hometown Hub gives people a focused digital home for community updates and participation. The product should support connection without manufacturing community activity or presenting fictional records as real.

## 2. Product objectives

### Primary objectives

1. Help people with a shared hometown or location connect digitally.
2. Provide a central feed for community posts and discussions.
3. Let members organize events and participate in them.
4. Strengthen participation while giving communities straightforward moderation tools.

### Secondary objectives

- Support member-led cultural preservation, help, and collaboration.
- Provide a platform structure that could support community-led news and alerts later; no official or emergency alert integrations are included now.

## 3. Users and roles

| Role | Capabilities |
|---|---|
| Visitor | View the sign-in/registration screen. Approved community listings are available after sign-in in this Phase 1 implementation. |
| Member | Maintain a profile; discover communities; request membership; contribute posts and comments; like/share posts; create or RSVP to events; submit reports, track their status, send follow-ups, and ask to reopen a closed case. |
| Community moderator | Member capabilities plus approve/reject join requests, edit guidelines, pin posts, remove posts/comments, and edit or cancel community events. Community creators are moderators of their submitted community. |
| Platform administrator | Review new communities, enable/disable member accounts, assign/remove community moderators, triage reports, exchange reporter-visible updates while keeping internal notes private, and manage category/tag vocabularies. |

## 4. Phase 1 scope

### Included and implemented

- Web-based responsive interface, designed mobile-first.
- Account registration, sign-in, and profile with name, hometown/region, and short bio.
- Community creation requests, platform approval, directory, and join-request workflow.
- Community feed with text posts, optional images, categories, announcements, comments, likes, share links, and moderator pinning/removal.
- Events created by community members, including event details and creator-defined optional capacity; creators and moderators can edit or cancel events, and RSVP members are notified about changes/cancellations.
- Concurrent RSVP enforcement: a capacity-limited event is designed not to accept more active RSVPs than its stated capacity in the supported single-process deployment.
- In-app notifications for membership actions, community review, new posts/events and event changes, comments, likes, guideline changes, and report filing/status/follow-up.
- Community rules/guidelines editable by moderators, with in-app notices to active members when rules change; moderation actions and an administrator dashboard.
- Abuse reports for users, posts, comments, and communities, with reporter case tracking, message exchange, status history, appeal/reopen, and admin-only private notes.
- Platform-managed post categories and community tags.
- Platform-admin report review with target context, open/in-review/resolved/dismissed states, reporter-visible responses, private admin notes, status history, and in-app case alerts/updates.
- Database-derived DAU, rolling active-member, post engagement, upcoming-event RSVP, member/community growth metrics, and a 30-day activity chart.
- PRD, technical documentation, automated API tests, and a local run configuration.
- Non-root Docker/Compose deployment files and GitHub Actions CI for a persistent single-instance host.
- Pandit onboarding is an approved connector-gated production release: routes require the dedicated server-side key and explicit feature flag. Production is owner-approved for direct-link access; Vercel SSO protects preview deployments only. Earlier read-only checks reported migrations 001–006, empty application/evidence/upload-journal tables, the private evidence bucket, and default-deny Storage access, plus a first scheduled cleanup call with zero deletions. This local-only audit did not recheck those hosted details or change production configuration/data. No production user, application, or file was created for release checks; no end-to-end applicant flow is claimed.

### Excluded

- Native mobile applications, paid advertising, or marketplace/classifieds.
- Advanced/AI moderation.
- Emergency alert or government system integration.
- External mail, SMS, web-push, or identity providers.
- Promoted public launch or marketing rollout (production is owner-approved for access by direct link; preview deployments remain SSO-protected), fictional seed users, communities, local news, events, service providers, alerts, or performance/impact metrics.
- Pandit certification or compliance claims, public evidence, contact details, booking, payments, production seed/import, and any Pandit production endpoint before authorized release.

## 5. Functional requirements and acceptance checks

| ID | Requirement | Acceptance evidence |
|---|---|---|
| U1 | Register and sign in | API integration tests create an account and use its session. Passwords are scrypt-hashed. |
| U2 | Create/edit profile | Profile API stores a name, hometown/region, and bio; email is not included in post author data. |
| C1 | Create a community | Request is stored as `pending` and the creator is made its moderator. It is not publicly listed before approval. |
| C2 | Approve/reject creation | Platform-admin review changes the community state and notifies its creator. |
| C3 | Join a community | Join request is `pending` until a moderator approves or rejects it. Feed access is restricted to active members. |
| P1 | Post text, image, announcement | Active members can share posts. Optional images are verified PNG/JPEG/WebP files up to 1.5 MB. |
| P2 | Engage with posts | Members can like, comment, and copy/share an in-app deep link. Moderators can pin posts. |
| P3 | Moderate posts/comments | Authors can remove their own content; community moderators can remove content in their community. |
| E1 | Create/manage events | Active community members can create events; creators and moderators can edit or cancel them. Edits that would reduce capacity below active RSVPs are rejected; attendees are notified of event changes or cancellation. |
| E2 | RSVP safely | RSVP uses an SQLite immediate transaction to check capacity and insert/update attendance atomically. A simultaneous-capacity integration test checks one-seat contention. |
| N1 | Receive in-app notifications | Relevant community activity creates notification records; users can mark them read. No external push delivery is claimed. |
| M1 | Manage membership and guidelines | Moderators can review membership requests and change community guidelines; active members receive an in-app notice when guidelines change. |
| A1 | Platform operations | Admin panel shows database-derived counts and provides community, account, moderator, report, category, and tag controls. |
| A2 | Measure community activity | Admin analytics derive DAU, rolling active members, engagement, event RSVP intent, and growth from actual records; no synthetic activity is used. |
| A3 | Resolve reports and disputes | Reporters can view their own cases, exchange visible follow-up messages, and request reopening after closure. Admins can mark a case open/in review/resolved/dismissed, send a visible response, and retain a separate private note; status changes are recorded. |
| PND1 | Apply as a Pandit/cleric | An authenticated member may save or submit a local application with required private government ID, background-check evidence, education evidence, and `ritual_skills`; incomplete/withdrawn drafts are `ACTION_REQUIRED` with `submitted_at` null. Evidence is never public or in the member directory. |
| PND2 | Verify and decide | Exact statuses are `PENDING_VERIFICATION`, `ACTION_REQUIRED`, `APPROVED`, and `REJECTED`. `CHECKER` inspects/verifies evidence and recommends approval or `ACTION_REQUIRED`; `COMPLIANCE` makes the final approve/reject decision; `SUPER_ADMIN` manages settings, roles, and audit only, with no automatic evidence access or final decision. |
| PND3 | Protect evidence and visibility | Evidence is authenticated, private local-DB data, never public/member-directory data. Minimal metadata excludes filenames, IDs, and bank details; audit logs contain no documents/content. Self-review and role escalation are blocked; approved directory entries expire on their due date. |
| PND4 | Enforce policy and lifecycle | The approved local policy is 3 calendar years for approved evidence, 90 elapsed UTC days for pending evidence after last applicant activity, 90 elapsed UTC days from rejection for rejected government-ID, background-check, and education evidence, and 30 elapsed UTC days for appeals. New retention fields default to 90 days but remain nullable/configurable; null or invalid policy fails closed rather than guessing. Legacy approved-retention days remain supported, mutually exclusive with years. Applicant state-changing save/upload/submit/appeal/signal operations reset pending activity; GETs, reviewer actions, and sweeps do not. Rejected deadlines originate at rejection and persist immutably through appeal until replacement. Upload/submit/review fail closed when policy is missing or ambiguous. Reverification is fixed at 2 calendar years. Approved evidence expiry removes evidence but keeps the profile and audit metadata; rejected ID expiry keeps the profile/status. Bank-details-change or official-ID-change triggers immediate `ACTION_REQUIRED` reverification; no bank details are collected. Appeals are accepted strictly before the deadline and expose derived `OPEN`, `CLOSED`, `OPENED`, or `NOT_APPLICABLE` status. |

## 6. Safety, privacy, and content principles

- Do not seed fake members, news, events, businesses, services, alerts, or community impact statistics.
- Keep new community requests non-public until approval.
- Store authentication passwords only as scrypt hashes and keep uploaded files and SQLite data out of Git.
- Record activity at UTC-day granularity for analytics and delete activity rows older than 90 days at startup; do not send product analytics to a third party.
- Use same-site HTTP-only session cookies, same-origin checks on browser writes, login/registration throttling, restrictive security headers, input-size limits, and parameterized SQL statements.
- Tell users what profile details are visible and encourage careful sharing.
- Human moderators/admins handle content reports; reporter-facing status and messaging support the process but do not promise automated detection or dispute adjudication. Internal admin notes are not shown to reporters.
- Pandit evidence and review are a private local workflow, not identity, background, religious-credential certification, legal compliance, or certification. Required government-ID, background-check, and education evidence is never public/member-directory content. Do not put filenames, IDs, bank details, or evidence/document content in audit logs. No bank details, contact details, booking, payments, or external verification are collected.

## 7. Product decisions and remaining decisions

### Interpreted requirement

“Supports concurrent bookings” is treated as a requirement for safe concurrent event RSVPs, not paid booking or appointment infrastructure. Capacity is optional and defined by the event creator.

### Pandit onboarding scope (approved; connector-gated production release)

Earlier read-only production checks reported migrations `004_pandit_onboarding.sql` and `005_pandit_storage_uploads.sql` applied, policy values matching the owner-approved periods, distinct active CHECKER/COMPLIANCE reviewers, configured dedicated server-side credentials, a successful non-destructive Storage preflight, a private 1 MiB PDF/PNG/JPEG bucket, and empty application/evidence/upload-journal tables. This local code audit did not recheck the current hosted ledger, policy, roles, credentials, bucket, or row counts. The release branch opens routes only when the dedicated connector initializes. Production is owner-approved for access by direct link; Vercel SSO protects preview deployments only. No production seed/import or end-to-end applicant operation was performed.

An authenticated member may save or submit an application with required private government-ID, background-check, and education evidence plus a `ritual_skills` list. The exact lifecycle statuses are `PENDING_VERIFICATION`, `ACTION_REQUIRED`, `APPROVED`, and `REJECTED`; incomplete or withdrawn drafts use `ACTION_REQUIRED` and `submitted_at` remains null. Evidence is authenticated private data in the local database, never public or member-directory data. Store minimal metadata only: never filenames, IDs, bank details, or evidence/document content in audit logs.

`CHECKER` can inspect/verify evidence and recommend approval or `ACTION_REQUIRED`. `COMPLIANCE` makes the final approve/reject decision. `SUPER_ADMIN` can manage settings, roles, and audit only; it has no automatic evidence access and cannot make final decisions. Bootstrap provisioning is server-side. Self-review and role escalation are blocked.

The live owner-approved policy is 3 calendar years for approved evidence, 90 elapsed UTC days for pending evidence after the last applicant activity, 90 elapsed UTC days from rejection for rejected government-ID, background-check, and education evidence, and 30 elapsed UTC days to appeal. Missing or ambiguous policy still blocks uploads, submission, and review rather than guessing. Successful applicant state-changing saves, evidence uploads, submissions, appeals, and explicit signals reset pending activity; GETs, reviewer actions, and retention sweeps do not. Rejected deadlines originate at rejection and remain immutable through appeal until replacement. Feb 29 anniversaries clamp to Feb 28. Reverification is fixed at 2 calendar years; the directory independently hides overdue profiles. Immediate bank-details-change or official-ID-change reverification collects no bank details. Expiry deletes due evidence, not the application or metadata-only audit; approved applications require action after evidence expiry. Only explicitly enabled synthetic simulations tagged `is_simulation: true` undergo the local transactional request-time expiry sweep. The first scheduled production cleanup call returned HTTP 200 and deleted zero evidence/reservations. No retroactive deadline backfill is performed.

Simulations use normal-format test fixtures only, require `is_simulation: true` and an explicit test-mode option, and use conspicuous synthetic identities/documents—not realistic identifiers or real people. They are always denied in production.

Local lifecycle verification uses isolated synthetic fixtures and simulated UTC clocks: approval, rejection, appeal and expiry boundaries, evidence replacement, concurrent idempotence, policy snapshots, private access, and fail-closed simulation/production separation are covered. The current `PANDIT_SYNTHETIC_ONLY=1 npm run check` passed 176 tests and skipped three owner-PDF-dependent preview cases before fixture loading. Earlier read-only checks reported the hosted migration ledger, bucket defaults, private access boundary, active reviewer roles, policy values, Edge Function, and scheduled-job metadata; they were not repeated in this local audit. The first scheduled worker call was previously reported as successful with no deletions. No live applicant upload/review, backup erasure, malware scanning, or formal security/compliance assessment was performed. The fresh temporary preview retains its upload/save/submit-only gateway; staff lifecycle testing does not weaken that gate.

A protected one-shot application endpoint remains local for `/api/internal/pandit-retention`; no Vercel Cron is configured. Invocation would require a valid `CRON_SECRET` (at least 16 characters) and `PANDIT_RETENTION_WORKER_ENABLED=true`. Earlier production information reported the Supabase cleanup Edge Function and daily `pg_cron` job active, with a first scheduled run returning HTTP 200 and zero deletions; current schedule state was not rechecked here. No manual production cleanup was invoked. The approved production-by-link/preview-only-SSO access policy was left unchanged. Production Pandit routes are gated on the dedicated Storage connector.

### Remaining decisions

- Any production changes beyond the approved storage-backed release require separate authorization.
- Terminology and tradition taxonomy.
- Backup deletion and any future non-simulation expiry service; the pending and rejected background/education periods are owner-approved at 90 elapsed UTC days, while nullable/configurable settings remain supported and fail closed when null or invalid.

The retention and appeal periods above are owner-approved. The Pandit API release is connector-gated and its dedicated production key is sensitive and server-only. Production is owner-approved for access by direct link; Vercel SSO protects preview deployments only. Read-only checks previously reported migrations 001–006, empty production Pandit tables, the private bucket, distinct active reviewer roles, configured policy, and a first scheduled cleanup call returning HTTP 200 with zero deletions; this local audit did not recheck hosted state or change production settings/data. No production users, applications, or files were created for release checks, and no end-to-end applicant flow is claimed.

## 8. Success measurement

The admin dashboard calculates DAU and rolling active members from authenticated member activity, engagement from recorded posts/interactions, upcoming-event RSVP intent from active member-event opportunities, and 30-day user/community growth from creation dates. Definitions and limits are documented in `TECHNICAL.md`; the dashboard never seeds or estimates activity. Growth percentages are not shown when the prior period is zero. Event RSVPs are not verified attendance. The 90-day daily activity records are used for these aggregate views and are not sent to an external analytics provider.

The supplied brief sets a page-load target under three seconds. That target, production traffic capacity, concurrent-user scalability, and availability have **not** been measured in a production-like environment and are not claimed by the Phase 1 build. The owner-approved Vercel/Supabase production deployment is accessible by direct link, while preview deployments are SSO-protected; this does not constitute a promoted public launch. The current hosted deployment commit was not independently checked in this local-only audit. The container configuration remains a separate persistent single-instance option; neither path is a multi-instance claim.

### Non-functional verification (local evidence only)

- **Performance:** Run `npm run nfr:smoke` for the current local HTTP app-shell check; no production performance claim is made.
- **Concurrent event RSVPs:** The integration suite sends 8 simultaneous RSVP requests for 3 available places; exactly 3 are accepted and 5 receive HTTP 409. This verifies capacity enforcement in the supported single-process SQLite deployment, not across multiple app instances.
- **Security:** Automated checks cover scrypt password storage, omission of password fields from API output, strict Origin/Fetch-Metadata checks for state-changing requests, write/auth/report throttling, logout invalidation, generic signup responses, strict admin Boolean handling, decoded/re-encoded post images, and production cookie/security headers. The approved release branch includes these hardening changes; confirm the deployed commit before relying on them in the hosted runtime. Local test sessions/rate limits are in memory, while production sessions/rate limits use Postgres. The app still lacks email verification and MFA, and these checks are not a formal security audit.
- **Mobile usability:** A prior signed-in UI spot-check at 390×844 and 320×720 found no horizontal overflow. This is a layout check, not a full usability or accessibility study.
- **Multiple cities and villages:** Profiles and communities accept separate bounded free-text hometown/location labels; automated tests retain city, village, and region values independently. There is no standardized geographic hierarchy, geocoding, or distance-based search. The SQLite application remains single-process and is not horizontally scalable as configured.

## 9. Future candidates (not implemented)

- Native mobile applications and multi-language interface.
- Optional local marketplace/classifieds.
- Verified local-government updates and separately governed emergency alert integrations.
- Email/push delivery, account verification/recovery, and advanced moderation support.
