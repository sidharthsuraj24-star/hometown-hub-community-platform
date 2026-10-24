# Hometown Hub — Technical Notes

## Architecture

- **Runtime:** Node.js 22.13+; tested with Node 24.19.
- **HTTP/API:** Node built-in `http` server and JSON REST-style endpoints; no third-party runtime package is required.
- **Database:** local development/tests use built-in `node:sqlite`; the production adapter uses a server-only `pg` pool (Supabase transaction pooler, SSL, max one connection), parameter mapping, bounded timeouts, and connection-bound transactions for community/RSVP critical sections.
- **Frontend:** vanilla JavaScript, semantic HTML, and responsive CSS served from `public/`.
- **Uploads:** local development/tests use verified PNG/JPEG/WebP files under `DATA_DIR/uploads/`; production uses the private `hometown-post-images` Supabase Storage bucket through the server-only service role, with no public URLs or browser credentials.
- **Local persistence:** `DATA_DIR/hometown-hub.sqlite` (default `data/hometown-hub.sqlite`).

The app keeps a local SQLite mode for development and tests. Vercel uses an awaitable Node handler and Mumbai (`bom1`) routing; public files remain static while `/api/*` and `/uploads/*` reach the function. Production persistence is designed for Supabase, with server-only credentials.

## Run and configure

```sh
cp .env.example .env
# Edit PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD
npm start
```

- `PORT` — HTTP port (default `3000`).
- `HOST` — listen interface (default `127.0.0.1` for local development; `0.0.0.0` when `NODE_ENV=production` and `HOST` is unset).
- `DATA_DIR` — database and uploads directory (default `./data`).
- `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` — on first startup, create a platform admin if both values are valid and the email does not already exist. Bootstrap password minimum: 12 characters.
- `NODE_ENV=production` — enables the `Secure` session-cookie attribute and HSTS. Production requires an HTTPS reverse proxy or TLS termination.

Configure the bootstrap email before registering it as a normal user. The bootstrap secret is not persisted in code; the resulting password is scrypt-hashed. If the account already exists, startup does not promote it or change its password.

## Self-hosted container deployment

- `Dockerfile` builds a small Node 24 image, runs as the unprivileged `node` user, exposes port 3000, and includes a health check.
- `compose.yaml` sets production mode, persists both the SQLite database and uploads in the named `hometown-hub-data` volume, and binds the host port to loopback by default; external traffic requires a separately configured TLS-terminating reverse proxy.
- `.dockerignore` excludes credentials, local data, and source-control files. GitHub Actions runs `npm run check` on Node 24 for pushes and pull requests to `main`.

Start with `docker compose up --build -d` after creating and securely editing `.env`. Keep the service on loopback and put a TLS-terminating reverse proxy in front of it before allowing external traffic. Back up the entire persistent volume consistently and test restoring the database and uploads together. A formal production security review, abuse operations, centralized logs/monitoring, and tested recovery plan remain deployment-owner responsibilities.

## Data model

| Entity | Purpose |
|---|---|
| `users` | Account identity, scrypt salt/hash, profile fields, platform role, disabled state. |
| `communities` | Location, description, category, selected managed tags, guidelines, creation-review status. |
| `memberships` | Per-community role and pending/active/rejected state. Composite primary key prevents duplicate membership requests. |
| `posts` | Community feed content, kind, category, optional local image path, and pin state. |
| `comments`, `likes`, `shares` | Post discussion and engagement; unique keys prevent duplicate likes/shares by a user. |
| `events`, `rsvps` | Creator/moderator-managed event details, optional capacity, and each user's attendance intent. Existing going RSVPs bound capacity reductions; event changes/cancellations notify going attendees. |
| `notifications` | In-app activity notification and read state. No external delivery provider is configured. |
| `reports` | Reporter, target, concern, open/in-review/resolved/dismissed status, reviewing administrator, timestamp, and private resolution note. |
| `report_messages` | Reporter/admin conversation visible to the reporter and platform administrators; internal notes stay in `reports.resolution_note`. |
| `report_status_history` | Append-only actor/time record for report status transitions, visible in the reporter case view and admin review. |
| `user_activity` | One UTC-day activity record per non-admin user. Rows older than 90 days are removed at startup. |
| `content_categories`, `content_tags` | Platform-managed vocabulary; default entries are taxonomy only, not sample community records. |
| `pandit_applications` (prepared migration 004) | Local-only application lifecycle with exact statuses, private evidence references/metadata, reviewer roles, policy state, expiry/reverification, retention, and appeal state. Migration 004 is prepared for local review only and is not applied, imported, seeded, or deployed. |

The `reports.resolution_note` field is added by a backward-compatible startup migration when opening an older database. Activity is recorded at daily granularity on authenticated requests, not with an external analytics service.

## API overview

All write routes accept JSON, use same-origin checks when an `Origin` header is present, and require the HTTP-only session cookie except for auth/bootstrap metadata routes.

- `GET /api/health`, `GET /api/meta`, `GET /api/me`
- `POST /api/auth/register`, `/api/auth/login`, `/api/auth/logout`
- `POST /api/profile`
- `GET/POST /api/communities`; `GET /api/communities/:id`
- `POST /api/communities/:id/join`, `/rules`, `/requests/:userId`
- `GET /api/communities/:id/requests`
- `GET /api/feed?community=:id`; `POST /api/posts`
- `POST /api/posts/:id/comments`, `/like`, `/share`, `/pin`; `DELETE /api/posts/:id`, `/api/comments/:id`
- `GET/POST /api/events`; `PATCH /api/events/:id` for creator/moderator edits; `POST /api/events/:id/rsvp`; `DELETE /api/events/:id` cancels and notifies going attendees
- `GET /api/notifications`; `POST /api/notifications/read/:id` or `/read`
- `POST /api/reports`; `GET /api/reports` lists only the signed-in reporter's cases; `POST /api/reports/:id/messages` adds reporter follow-up and reopens a resolved/dismissed case.
- Admin: `GET /api/admin/dashboard` (counts and analytics), community review, member role/access controls, report review, categories, and tags.
- `POST /api/admin/reports/:id/resolve` accepts `status: open|in_review|resolved|dismissed`, an optional private `resolution_note` (max 1,000 characters), and optional reporter-visible `response` text. `POST /api/admin/reports/:id/messages` sends a case reply without changing status. Reopening clears the current private note/resolution timestamp; status changes are retained in `report_status_history` and reporters receive in-app updates.

## Pandit onboarding implementation notes

- This is a local-only module. Every Pandit production endpoint must explicitly return HTTP `503` until an authorized release; no production seed/import is supported. The prepared `supabase/migrations/004_pandit_onboarding.sql` is local-only and must not be applied.
- The prepared PostgreSQL migration matches every local runtime table field, including calendar-year retention, evidence expiry, nullable/configurable retention policies, private storage references and retention basis. Numeric Pandit flags match the shared runtime SQL; existing PostgreSQL user boolean fields use portable `false` predicates. Migration 004 is validated only against disposable local PostgreSQL **16.15**; the runner explicitly skips it for Supabase/production and it is never applied there. Isolated PostgreSQL validation covers columns, flag types, statuses, roles, constraints and private access. This is local schema preparation, not an applied migration or a production-readiness claim.
- For retention validation, run `env -i PATH="$PATH" HOME=/tmp NODE_ENV=test PANDIT_SYNTHETIC_ONLY=1 npm run check`. This runs all test files without reading the owner's PDF and explicitly skips its three dependent preview tests. The remaining preview tests use only the generated synthetic placeholder; the existing exact-byte allowlist is unchanged.
- Applications require an authenticated member, private government-ID evidence, background-check evidence, education evidence, and a `ritual_skills` list. Exact statuses are `PENDING_VERIFICATION`, `ACTION_REQUIRED`, `APPROVED`, and `REJECTED`; incomplete or withdrawn drafts are `ACTION_REQUIRED` with `submitted_at` null.
- Evidence is authenticated private local-database data and is never public or returned by member-directory endpoints. Keep metadata minimal: no filenames, IDs, bank details, or document/content data in audit logs. The module collects no bank details.
- Evidence uploads remain inline in the private local database; no live Supabase client or object store is connected. An optional, dependency-injected `createPanditPrivateStorage` helper prepares private object operations against the dedicated `hometown-pandit-evidence` bucket. It accepts Supabase's Storage client, scopes it with `.from(...)`, and never reads credentials or creates a client. The local test route can download/delete existing object-backed synthetic evidence through this helper. Every object path is bound to application/evidence UUIDs. Downloads require fresh, active, non-self Checker/Compliance authorization and submission, deny expired evidence, and return no signed/public URLs. Supabase Blob responses are served as private attachments.
- Migration 004 touches only application-owned Pandit tables/indexes, enabling their RLS and revoking client privileges. It contains no Storage table writes, Storage ALTER, or Storage policy DDL. Bucket provisioning is separately prepared through the local-only API adapter `lib/pandit-storage-bucket.js`; see “Storage without managed-table ownership” below. No policy configuration, reviewers, people or evidence are seeded.
- `CHECKER` may inspect/verify evidence and recommend approval or `ACTION_REQUIRED`; `COMPLIANCE` makes final approve/reject decisions; `SUPER_ADMIN` manages settings, roles, and audit only, with no automatic evidence access or final-decision authority. Bootstrap provisioning is server-side. Self-review and role escalation are blocked.
- Approved directory entries expire on their due date, while the application profile is retained. Approval evidence has an `approved_record_until` deadline; at or after that deadline, approved evidence is removed, the profile remains, and verification is reset/action-required with a metadata audit event. Bank-details-change and official-ID-change events immediately set `ACTION_REQUIRED` and require reverification. `recheck_years` is limited to 1 or 2.
- The initialized/upgraded default policy is `approved_retention_years: 3`, `approved_retention_days: null`, `pending_evidence_retention_days: 90`, `rejected_evidence_retention_days: 90` for `GOVERNMENT_ID`, `BACKGROUND_CHECK`, and `EDUCATION`, `rejected_background_check_retention_days: 90`, `rejected_education_retention_days: 90`, and `appeal_days: 30`. The legacy approved-retention-days API remains supported, but years and days are mutually exclusive. Calendar-year addition is UTC and clamps Feb 29 to Feb 28; pending and all rejected-evidence intervals are elapsed UTC days from the applicable activity/rejection timestamp, and appeal intervals are elapsed UTC days. Appeals are accepted strictly before the deadline. Retention runs as a local request-time sweep inside a transaction, not an unattended job; when offline, scheduled/guaranteed deletion cannot be promised. Expiry behavior is simulated only when explicitly allowed and `is_simulation=1`; production expiry is never simulated. No existing application deadlines are backfilled.
- Application responses expose evidence metadata (`id`, `kind`, `verified`, `delete_after`) plus `approved_record_until`, `rejected_evidence_until`, `evidence_expired_at`, and derived `appeal_status` (`OPEN`, `CLOSED`, `OPENED`, `NOT_APPLICABLE`; an `APPEALED` event produces `OPENED`). Unchanged rejected evidence versions retain their deadline across appeal; every rejected deadline originates at rejection and is immutable until that version is replaced. Replacing a version clears its old deadline. Approved evidence is removed at or after its deadline, while the profile and audit metadata remain.
- The configured bootstrap platform administrator is provisioned locally as `SUPER_ADMIN`; the role-assignment endpoint can grant only `CHECKER`/`COMPLIANCE` or remove those roles, never change the caller or grant a Super Admin. A final approver must not be the person who checked the evidence, even after a role change.
- Super Admin policy settings are `approved_retention_years` (positive integer) or legacy `approved_retention_days` (positive integer), exactly one of which may be set, plus `pending_evidence_retention_days`, `rejected_evidence_retention_days`, `rejected_background_check_retention_days`, `rejected_education_retention_days`, `appeal_days`, and `recheck_years` (1 or 2). New retention fields default to 90 days, but null/configurable values remain possible and fail closed. Exact deadlines are snapshotted on approval/rejection; policy changes affect subsequent decisions, not existing deadlines. No legal compliance or certification claim is made.
- Pending evidence, rejected background checks and rejected education have separate nullable settings: `pending_evidence_retention_days`, `rejected_background_check_retention_days`, and `rejected_education_retention_days`. Each defaults to 90 days while remaining nullable/configurable; null or invalid values fail closed and no alternate period is guessed. The base policy PUT retains its existing full-payload contract; these three optional settings preserve prior values when omitted and accept explicit null. Configuring synthetic values does not authorize real collection or turn on a production release. Real-evidence uploads, submission and review are denied even locally; explicit disposable simulation mode and an immutable synthetic application designation are required.
- Approved and rejected-ID decisions snapshot a per-evidence `retention_basis` and deadline. Purges select only due approved evidence or due rejected evidence with a snapshotted category deadline; pending evidence uses the last applicant activity timestamp, where state-changing save/upload/submit/appeal/signal activity resets the deadline, while GETs, reviewer actions, and sweeps do not. Matching old local aggregate deadlines are supported without backfilling data. Blob removal precedes metadata deletion. A failed object removal rolls the metadata transaction back for retry; missing-object deletion is idempotent after an interrupted transaction. Object-backed evidence replacement is rejected until authorized expiry rather than orphaning or prematurely deleting a retained blob. Inline synthetic replacement retains its existing lifecycle behavior. Expiry removes evidence rows and private review feedback, retaining the profile, lifecycle timestamps and metadata-only audit events.
- The local SQLite database and its journal files have mode `0600`; secure-delete is enabled and retention purges truncate the WAL checkpoint. This is not a guarantee of forensic erasure from filesystem snapshots/backups. A production backup/deletion and file-malware-scanning design remains a release prerequisite; uploaded files are attachment-only with strict type/signature and size checks, not inline previews.
- Upgrading the earlier local Pandit schema retains profile fields and minimal historic review events, discards old unstructured notes/feedback, and returns legacy applications to `ACTION_REQUIRED` for fresh evidence and review. No legacy approval is grandfathered.
- Simulations require an explicit test-mode option and `is_simulation: true`, use conspicuous synthetic identities/documents in normal-format test fixtures, never realistic identifiers or real people, and are always denied in production.

### Storage without managed-table ownership

Migration 004 is a fresh-install, no-data **application schema** migration. Its only ALTER operations enable RLS on the five application-owned Pandit tables. It neither writes `storage.buckets` nor changes `storage.objects`, ownership, grants, or Storage policies. The migration runner still unconditionally skips 004. Migrations 001–003 and the existing post-image bucket are unchanged.

`ensurePanditPrivateBucket({ storage, allowLocal: true })` in `lib/pandit-storage-bucket.js` is an injected, local-only preparation adapter, not a CLI or a production provisioning path. It uses `getBucket` and, only after a structured missing-bucket result, `createBucket('hometown-pandit-evidence', { public: false, allowedMimeTypes: ['application/pdf','image/png','image/jpeg'], fileSizeLimit: 1048576 })`. It verifies settings after creation and on every repeated call. Existing public, unbounded, wrong-name or mismatched-MIME buckets are rejected rather than silently updated. A structured create conflict is re-read and verified; permission failures/outages do not trigger blind creation or retries. No credentials, live client, or route wiring were added.

[Official bucket API documentation](https://supabase.com/docs/reference/javascript/storage-createbucket) describes bucket INSERT policy permission for creation and no object-table permission; `getBucket` requires bucket SELECT. These API privileges are **not table ownership or policy-management privileges**. A trusted existing server service key can bypass RLS, but is project-wide, not a least-privilege bucket token. This change adds no credentials or grants. Where an already-authorized bucket-scoped identity exists, the API can use it; this task does not create such an identity or the policies needed to authorize it.

**A private bucket alone is insufficient.** [Supabase's access-control guide](https://supabase.com/docs/guides/storage/security/access-control) says client operations require matching RLS policies; a trusted service key bypasses them. For server-only evidence, client allow policies are unnecessary **only if** RLS is enabled and no applicable permissive policy admits this bucket. Disposable PostgreSQL tests prove that default deny hides SELECT rows, rejects INSERT, and filters UPDATE/DELETE to zero rows even with ordinary table privileges. They also prove that an unrelated broad permissive policy can expose the private bucket. The API adapter checks configuration, not this policy invariant; local success is not hosted isolation approval.

[PostgreSQL requires the table owner to create/change policies](https://www.postgresql.org/docs/16/sql-createpolicy.html). Ordinary DML grants or permission to call `createBucket` do not confer this authority. The Supabase bucket API does not create object policies. An existing authorized project operator may use the provider-supported Storage policy/Dashboard or privileged migration channel; the availability/authority of that channel in this project has **not** been verified. Do not assume that Dashboard access bypasses SQL ownership. No runtime/app ownership or broader grant should be requested. If the existing authorized channel rejects policy operations, stop for a provider-supported resolution rather than trying ALTER/ownership/grant workarounds.

If a later inventory finds broad client allow policies, the following is a **review-only example, not part of any migration or approved action**. On a table where RLS is already enabled, the local provider-owner fixture proves this restrictive policy blocks all client operations for the evidence bucket without weakening unrelated buckets or issuing an ALTER:

```sql
create policy pandit_evidence_deny_clients on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'hometown-pandit-evidence')
  with check (bucket_id <> 'hometown-pandit-evidence');
```

A future authorized inventory must inspect `pg_class.relrowsecurity`, `pg_policies` (including PUBLIC and inherited-role applicability), bucket settings and relevant grants, then test anon/authenticated access with synthetic objects. No inventory or policy operation was performed remotely. If provider RLS is off, do not enable it from this migration: stop. This task deliberately does not ship a policy-applying script.

The private helper now requires an active owning applicant and an unsubmitted `ACTION_REQUIRED` draft for `put`, validates kind/type/signature/1 MiB, uses canonical UUID paths and `upsert: false`, and checks the upload acknowledgement path. `get` remains active non-self CHECKER/COMPLIANCE only after submission and before expiry. `removeExpired` is an internal server sweep capability, not a client deletion endpoint; it requires a matching retention basis and due timestamp. It rejects malformed results and storage failures; structured missing-object results and successful empty deletion lists are idempotent. Empty deletion lists cannot independently prove a correctly privileged provider identity: the server-only credential/isolation invariant needs hosted validation. Successful blob removal plus failed SQL cleanup is retried safely; metadata and audit updates roll back until deletion succeeds.

[Private buckets can still use authorized signed URLs](https://supabase.com/docs/guides/storage/buckets/fundamentals); private does not prohibit signing. Application helper paths never generate public or signed URLs, expose storage paths in JSON, or use the public-upload route. Reviewer downloads remain authenticated `no-store` attachments. Upload routes still store synthetic inline SQLite bytes; the helper's object-upload API is tested directly, not newly connected to the route. A production object-upload integration, transaction/orphan handling and runtime DB privileges remain unimplemented/unverified release work.

Run the following in a scrubbed environment, with no Supabase variables or owner PDF access:

```sh
env -i PATH="$PATH" HOME=/tmp NODE_ENV=test PANDIT_SYNTHETIC_ONLY=1 npm run check
env -i PATH="$PATH" HOME=/tmp NODE_ENV=test node scripts/test-pandit-postgres-local.js
```

The second command creates and destroys its own PostgreSQL 16 cluster using a temporary Unix socket and `listen_addresses=''`; it accepts no remote database URL. The SDK tests inject an in-memory `fetch` into the installed client and have no network fallback. SQL policy evaluation is real local PostgreSQL; Storage HTTP status mappings, service-key bypass, signed tokens, MIME enforcement and object persistence are fixture behavior, not a running Supabase Storage service or S3 test. Signed-token cryptography/expiry, hosted role inheritance/policies, provider API permissions and backup/CDN erasure remain unverified. Retention is still request-triggered, not unattended.

**Exact next approval:** approve synthetic-only validation against a specifically named, disposable, non-production Supabase environment using an existing authorized operator and no paid resources. The scope must explicitly permit read-only bucket/RLS/policy inventory, application-only fresh migration 004 in that disposable environment, and bucket API create/verify plus synthetic upload/fetch/delete tests. If broad allow policies exist, obtain separate approval for the exact bucket-restrictive policy through an existing provider-supported authorized channel; no ownership change, broader grants or managed-table ALTER is proposed. If no such channel exists, validation remains blocked. This is **not** approval for any production retry, migration-runner skip removal, push, deploy, real-evidence collection or guard opening; those require a subsequent explicit release decision. The approved retention values remain unchanged: 3 calendar years approved; pending 90 days after last successful applicant activity; all three rejected evidence kinds 90 days after rejection; appeals 30 days.

### Local retention verification and remaining limits

Run the synthetic-only complete check command above for the current test totals; the three owner-PDF-dependent preview tests are deliberately skipped and the owner PDF is not read. API tests exercise independent approval, rejection, appeals immediately before/at/after 30 days, pending and rejected-evidence expiry before/at/after 90 days, three-calendar-year evidence expiry, leap/century boundaries, policy snapshots, activity resets/non-resets, evidence replacement, concurrent idempotent sweeps, private access, and metadata-only auditing. Separate tests exercise schema upgrades without deadline backfill, null-policy gates, disabled-simulation no-mutation behavior, production guards, schema/runtime agreement, object path authorization, revoked reviewer roles, Supabase Blob downloads, failed-deletion retries, review-feedback cleanup and preservation of evidence. Migration/schema validation uses disposable isolated PostgreSQL 16.15 support and never contacts Supabase or production.

These are simulated clocks and disposable local SQLite fixtures, not a real-time three-year run, hosted migration, production integration test, security certification, malware scan, or forensic-erasure guarantee. All persisted Pandit fixtures are explicitly synthetic. Local synthetic backup/restore is regression-tested; production backup expiry and recovery remain unverified. Pending evidence uses the approved 90-day activity-based period, and rejected background/education evidence uses the approved 90-day period from rejection; unchanged rejected versions keep their immutable deadlines through appeal until replacement, while previously approved evidence keeps its existing deadline even through an edit or rejection. Replacing an ID clears its obsolete aggregate rejection deadline immediately. The temporary review gateway still denies staff/admin operations; approval/rejection/appeal/expiry are verified by isolated API tests, not enabled as new preview access gates.

**Release blocker:** real-evidence deployment remains separately unauthorized. The approved defaults are 90 elapsed UTC days for pending evidence after last applicant activity and 90 elapsed UTC days from rejection for rejected background-check/education evidence; nullable/configurable policy still fails closed when unset or invalid. The production HTTP guard is unchanged, no production environment or credentials were accessed, and migration 004 has not been applied. Production scheduling, backup expiry/deletion verification, malware scanning and a separately authorized release remain prerequisites; this local task does not enable them.

## KPI definitions and interpretation

- **DAU / 7-day / 30-day active members:** distinct non-admin accounts with authenticated activity on one or more UTC days in the period.
- **Engaged members (30d):** distinct active members with a post, comment, like, share, or going RSVP during the period; the engagement rate is engaged members divided by 30-day active members.
- **Post engagement rate (30d):** posts created during the period with at least one like, comment, or share divided by all posts created during that period.
- **Upcoming event RSVP rate:** going RSVPs for open future events created during the last 30 days divided by active member-event opportunities in those communities. This measures RSVP intent, **not verified attendance**.
- **Member/community growth:** current-period records created in the last 30 days compared with records created in the preceding 30 days. Community counts include approved communities only. The percentage is omitted when the preceding count is zero.
- **Daily activity chart:** one row per member/UTC day for the most recent 30 days.

No records, events, active members, Pandit applications, or impact values are seeded or imported. Zero activity and insufficient historical baseline are represented as such rather than estimated. Community summary fields “Member Count” and “Created Date” are derived from database records, not import/sample values.

## Non-functional verification and limits

Run `npm run nfr:smoke` for a disposable local HTTP app-shell check. It starts an isolated SQLite database in a temporary directory, runs 10 concurrent anonymous clients, and has each retrieve `/`, `/styles.css`, `/app.js`, `/favicon.svg`, `/api/meta`, and `/api/me`. It reports p50/p95 latency from request start until all response bodies are consumed, and exits unsuccessfully when p95 is at or above 3 seconds. It removes its temporary database and does not modify the app's configured `DATA_DIR`.

This is a lightweight HTTP regression check, **not** a browser-render/load test or evidence of production-network performance. Two fresh local runs measured 181.7 ms and 216.0 ms p95. A separate local preview observation measured 1.18 seconds p95 to app-ready under 10 concurrent anonymous desktop sessions; neither measurement is a production guarantee. A prior local signed-in test completed 130/130 requests across 13 simultaneous sessions with 48.5 ms p95, but that result is likewise limited to its test environment.

The RSVP integration test exercises eight simultaneous members competing for three event places and asserts that exactly three succeed. Multi-locality tests use disposable city, village, and region strings to verify that profile and community labels remain distinct. Security regressions check password hashing/privacy, same-origin rejection, logout, rate limiting, and production transport/session headers. A prior responsive-layout spot-check found no horizontal overflow at 390×844 and 320×720; no formal usability, accessibility, or security audit has been completed.

Multiple city/village communities are representable as free-text locations. Structured city/district hierarchies, geocoding, proximity search, geographic normalization, production capacity, tested backups, and formal security review are not verified. Production uses managed Supabase PostgreSQL with persistent sessions and shared rate limits; local SQLite remains single-process.

## Event-capacity correctness

The RSVP handler runs `BEGIN IMMEDIATE`, checks an existing RSVP and counts active `going` RSVPs, and writes the RSVP within the same transaction. If capacity is full, the entire transaction rolls back with HTTP `409`. The integration suite tests eight simultaneous members competing for three places. A multi-instance deployment needs a shared transactional database and operational testing before it can claim the same behavior.

## Security controls and boundaries

- Passwords use Node `scryptSync` with per-password random salts; comparisons use `timingSafeEqual`. Sign-in responses are generic, and an unknown account still receives a dummy scrypt comparison.
- Local development sessions and rate limits are in memory. Production sessions are random tokens stored server-side as SHA-256 hashes and delivered only in `HttpOnly; SameSite=Lax; Secure` cookies; they expire after seven days and are invalidated on logout or account disablement. Production login, registration, and report rate limits are shared through Postgres and serialized per bucket; the Vercel adapter uses the platform's `x-vercel-forwarded-for` client-IP header and ignores generic client-supplied forwarding headers.
- Writes reject cross-origin browser requests; JSON-only writes and SameSite cookies provide CSRF friction. This build has no email verification, account recovery, or MFA; it has not received a formal security audit.
- SQL values are parameterized. User-provided strings are length-bounded and HTML-escaped in the UI.
- Security headers include a restrictive content policy, HSTS in production, frame/type protection, referrer policy, permissions policy, and same-origin opener/resource policies. The CSP disallows inline styles; app layout styling uses the static stylesheet, and Vercel static responses carry the matching header set. Request and header timeouts and request-body limits are configured.
- Moderator membership-request responses omit email addresses; reporter case views redact reported-account profile details, and reports cannot be used to retrieve posts/comments from communities the reporter cannot access. Production exception logs retain only a sanitized error class/code, not raw error text or stack traces.
- Authenticated content creation still has no per-user write or cumulative upload quota; service quotas, abuse response, TLS/proxy trust, backups and restore testing, privacy notices, and any future multi-instance requirements remain deployment-owner considerations.

## Verification

Run `npm run check` for the current JavaScript syntax checks and API integration tests. Tests use temporary SQLite databases and do not create repository seed/import data. Run `npm run nfr:smoke` separately for the current local app-shell HTTP timing check. These commands are the current validation baseline; this document does not assert that they pass.

## Vercel/Supabase migration status

- `server.js` and `api/index.mjs` expose the same Fetch-standard adapter from `lib/fetch-handler.js`, bridging Web requests/responses to the existing Node HTTP handler without calling `listen()` on import. Vercel local dev and a local production build both recognized the handler; the build packaged `api/index.mjs` for Node 24 in Mumbai (`bom1`, 10-second maximum) and configured static-response security headers.
- `supabase/migrations/001_initial_schema.sql` creates the durable PostgreSQL schema and only the existing non-personal taxonomy vocabulary. `002_private_storage.sql` creates the **private** `hometown-post-images` bucket and deliberately creates no public or client storage policies.
- `scripts/apply-supabase-migrations.sh` remains the reproducible operator-run setup path and requires an explicitly supplied `SUPABASE_DB_URL`. The Hometown Hub Supabase project is in Mumbai; migrations `001`–`003` were applied there, enabling default-deny RLS on every public app table. Migration `004_pandit_onboarding.sql` was also applied to Hometown Hub production. Its five Pandit tables were verified empty, with RLS enabled and client access default-deny. The separate private `hometown-pandit-evidence` bucket was verified with a 1,048,576-byte limit and exactly `application/pdf`, `image/png`, and `image/jpeg` allowed. Only the existing non-personal taxonomy vocabulary is present in the original app tables; user, community, post, event, report, session, and activity data remain empty. No preview records or Pandit rows were seeded.
- Production routes now use `lib/production-adapter.js` and do not create or fall back to SQLite or local uploads. The adapter uses verified TLS, server-only PostgreSQL and Supabase Storage credentials, hashed persistent sessions, serialized shared rate limits, and the private photo bucket. Image downloads are still authorized against community membership before bytes are returned. The service-role key is never sent to browser code.
- A supplied administrator email/password is bootstrapped once on the first non-health API request; an existing non-admin/disabled account will not be promoted, and an existing administrator password will not be overwritten. All non-health API routes fail closed without the production database and administrator configuration. Credentials remain environment-only and must never be committed.
- The live Vercel deployment is protected by Vercel Authentication; this repository remains private and the app is not a public launch. Pandit application code remains local and unreleased: production endpoints return `503`, and real evidence uploads remain disabled. Migration 004 is already applied to Hometown Hub production, so the general migration runner intentionally skips it to prevent reapplication. The verified database/bucket setup is groundwork only and is not an end-to-end live app integration; no claim is made that evidence uploads work. No production seed/import is supported. Vercel Hobby requires personal, non-commercial use; Supabase Free quotas/pausing apply; neither service should be upgraded or attached to billing for this setup.
- Run `npm run check` and `npm test` for local validation, with `npm run nfr:smoke` separately. These checks cover local code, simulations, and mocks; they do not establish end-to-end live Pandit app integration or working production evidence uploads. Migration 004 has been applied to Hometown Hub production, but this local test suite is not a hosted app integration test.

### Pandit evidence Storage API integration — disposable tests only

`lib/pandit-storage-api.js` is a local test/simulation adapter that exercises applicant-upload, reviewer-download, and retention-deletion behavior against an injected mock transport. It is not wired to the live Hometown Hub project or deployed production routes, and it does not demonstrate that real evidence uploads work. It accepts only the synthetic `mock-service-key` and fixed `http://supabase.test` origin, never environment credentials or ambient network fetch. `panditStorageApi` is a server construction option, not request input. Every test operation requires explicit simulation permission, a successful `assertMockIsolation` fixture assertion, and a fresh exact bucket configuration check: private `hometown-pandit-evidence`, 1 MiB, and only PDF/PNG/JPEG. Errors are sanitized and fail closed. No public/signed URL API is used, and API responses/audit records omit object paths, storage credentials, and inline evidence data.

Missing storage configuration no longer falls back to inline uploads. Historical synthetic fixtures/preview can explicitly opt into `panditInlineSimulationEvidence: true` in test mode only; this opt-in is ignored whenever the Storage API option is present. Non-simulation records and all production Pandit endpoints remain closed. A direct injected `panditPrivateStorage` remains a trusted test seam, not a deployable credential/configuration path.

The local SQLite `pandit_storage_uploads` journal commits a canonical object binding before attempting an upload. Successful metadata commits remove that reservation atomically. An upload or later database failure retains the reservation, with no evidence bytes, so the simulation retention sweep can retry deleting an ambiguous/unreferenced object at its pending-evidence deadline. Object deletion precedes metadata/journal deletion; outages preserve retry records, and structured missing-object results are idempotent. This is not a distributed transaction. A process interruption can leave a reservation for an object never uploaded; deleting that missing object later is intentional. The journal is local-only and is **not** added to migration 004.

This integration is **not production-ready**. A private bucket's API settings cannot establish that existing Storage RLS policies deny anonymous/authenticated reads. `assertMockIsolation` is only an injected assertion about the disposable fixture, not a production attestation. Before any separately authorized release, the provider/table owner must establish and verify the absence of applicable permissive policies (or independently manage a narrowly scoped exclusion if existing policies require it). No application-owned policy workaround, expanded grant, or provider-table alteration is supplied. The production guard remains closed and the migration runner still skips 004. The local PostgreSQL runner executes no storage policy DDL; its synthetic provider tables alone need ownership/RLS setup to exercise default-deny behavior.
