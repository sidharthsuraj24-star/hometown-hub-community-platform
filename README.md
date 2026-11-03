# Hometown Hub

A responsive web platform for people who want to stay connected to their hometown or local community. Hometown Hub provides community feeds, member-led events, moderation, and platform administration without preloaded fictional activity. Release branch: host/supabase-vercel.

## Implemented

- Account registration and sign-in, editable hometown profile, and sign-out.
- Community directory and creation requests; new communities remain private until a platform administrator approves them.
- Join requests with moderator approval or rejection.
- Member-only community feeds with text, PNG/JPEG/WebP images, announcements, likes, comments, shareable links, and pinned posts.
- Community-created events with optional creator-defined capacity and transaction-safe concurrent RSVPs.
- In-app notifications for posts, comments, likes, community reviews, membership requests/decisions, events, and report review.
- Community moderator tools for membership review, guidelines, pinned announcements, post/comment moderation, and event management.
- Platform admin dashboard for record counts, community review, account access, moderator assignment, content categories/tags, and report case management with target context, human review notes, resolution, dismissal, and reopening.
- Data-derived KPI dashboard for DAU, 7/30-day active members, member engagement, post engagement, upcoming-event RSVP rate, and user/community growth, including a 30-day activity chart.
- Responsive layout, private-by-default local runtime storage, API integration tests, technical documentation, GitHub Actions CI, and a non-root Docker/Compose deployment path.

There is **no demo activity or sample user data** in a fresh database. Production checks confirmed migrations `001`–`006`; the Pandit application, evidence, and upload-journal tables remain empty. The evidence bucket is private, capped at 1 MiB, allows PDF/PNG/JPEG, and has zero objects; `storage.objects` RLS is enabled with no client policies, so client grants remain default-deny. The first scheduled Supabase cleanup run returned HTTP 200 with `ok: true` and zero deletions. The approved Pandit release opens routes only when the dedicated server-side Storage connector initializes, and Vercel SSO remains enabled for all deployments. No production users, applications, or files were created for release checks; no end-to-end applicant upload/review was exercised. This is not a public launch or a legal-compliance claim.

## Requirements

- Node.js **22.13 or newer** with the built-in `node:sqlite` module (container image uses Node 24).
- No third-party npm packages are required.

## Run locally

1. Review `.env.example`, copy it to `.env`, and replace the administrator email/password with values you control. Use a unique password of at least 12 characters and keep `.env` private.
2. Start the app:

   ```sh
   npm start
   ```

3. Open `http://127.0.0.1:3000`.

The configured platform administrator is created on first startup when both `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` are present and the email is not already registered. The password is scrypt-hashed; it is not stored in plaintext. Admin credentials are not included in this repository.

To run syntax checks and automated tests, then the optional local performance smoke check:

```sh
npm run check
npm run nfr:smoke
```

The smoke check uses 10 concurrent anonymous clients and temporary local data. It measures HTTP app-shell readiness after initial assets and API responses arrive, not browser rendering or production capacity; see [docs/TECHNICAL.md](docs/TECHNICAL.md) for the exact scope and evidence.

Health check: `GET /api/health`.

## Self-host with Docker Compose

The Compose setup stores the SQLite database and uploaded images in the persistent `hometown-hub-data` volume. It starts the app as a non-root user, binds the published HTTP port to loopback by default, and includes a health check.

```sh
cp .env.example .env
# Edit .env: set a real admin email and a unique 12+ character password.
docker compose up --build -d
curl http://localhost:3000/api/health
```

`PORT` in `.env` selects the host-side port. Compose binds the app inside the container on port 3000 and publishes it only on `127.0.0.1`; place a TLS-terminating reverse proxy on the same host before allowing external traffic. Do not expose the app's HTTP port directly to the Internet. Compose provides `NODE_ENV=production`, which sets secure cookies and production security headers. Preserve and back up the named data volume, including both SQLite data and uploads; test restore procedures before relying on it.

## Local data and operation

By default, SQLite data and uploaded images live under `data/`, which is ignored by Git. Override `DATA_DIR` to use another persistent directory. The app uses SQLite WAL mode, prepared statements, and transaction-safe RSVP capacity checks. Authentication sessions and rate limits are held in memory and are reset when the process restarts. Run one app instance against its local persistent data directory; this release does not support shared multi-instance state.

Analytics are derived from real database records, not sample values. A non-admin member’s authenticated requests record a daily activity row at UTC-day granularity; rows older than 90 days are pruned when the app starts. The dashboard’s event metric is an RSVP-intent rate—not verified attendance—and growth percentages are withheld when the prior period is zero. No third-party analytics service is used.

Profile hometowns and community locations are bounded free-text labels, allowing city, village, or region names without preloaded geography data. Structured geographic hierarchies, geocoding, and distance-based discovery are not included.

## Scope and deployment limits

- This is a private-project Phase 1 build. The live Vercel deployment is protected by Vercel Authentication and is not a public launch.
- The app includes in-app notifications; external email, SMS, and web-push delivery are not configured. There are no account recovery or email-verification flows.
- Human moderators/admins handle content reports. No advanced or AI moderation, emergency/government feed, advertising, marketplace, or native mobile client is included.
- Post images are limited to 1.5 MB; local development stores them under `DATA_DIR`, while production uses the private Supabase Storage bucket through the server only. Back up the database and media for any real deployment.
- The included Docker path is for a persistent single-instance host; it does not provide a managed database, distributed rate limiting, central session storage, automated backup service, or a formal security audit.
- Pandit applications use the exact statuses `PENDING_VERIFICATION`, `ACTION_REQUIRED`, `APPROVED`, and `REJECTED`. An incomplete or withdrawn draft is `ACTION_REQUIRED` with `submitted_at` null. Required evidence includes a private government ID, background check, education evidence, and a `ritual_skills` list; authenticated evidence is stored in the non-public local database and never exposed in the member directory. Evidence metadata is minimal: no filenames, IDs, bank details, or document/content data in audit logs.
- `CHECKER` roles may inspect/verify evidence and recommend approval or set `ACTION_REQUIRED`; `COMPLIANCE` makes the final approve/reject decision; `SUPER_ADMIN` manages settings, roles, and audit access only and has no automatic evidence access or final-decision authority. Bootstrap provisioning is server-side. Self-review and role escalation are blocked.
- The owner-approved policy is **3 calendar years** for approved evidence, **90 elapsed UTC days** for pending evidence after the last applicant activity, **90 elapsed UTC days** from rejection for rejected `GOVERNMENT_ID`, `BACKGROUND_CHECK`, and `EDUCATION` evidence, and **30 elapsed UTC days** for appeals. New retention fields default to 90 days, while settings remain nullable/configurable; null or invalid policy fails closed for uploads/submission/reviews rather than guessing. Applicant state-changing saves, evidence uploads, submissions, appeals, and explicit applicant signals count as activity and reset pending deadlines; GETs, reviewer actions, and retention sweeps do not. Reverification is fixed at 2 calendar years. Feb 29 clamps to Feb 28 when adding calendar years. Approved evidence deadlines remove evidence, not the profile; the profile remains with action-required/reset verification and metadata audit. Rejected evidence deadlines originate at rejection, are immutable through appeal, and persist until that evidence version is replaced. Appeals are accepted strictly before the deadline; the separate `appeal_status` metadata is derived as `OPEN`, `CLOSED`, `OPENED`, or `NOT_APPLICABLE` without changing the lifecycle status names.
- The local application worker has a guarded one-shot endpoint; no Vercel Cron is configured. Production separately uses an active Supabase cleanup Edge Function and daily `pg_cron` job at 21:00 UTC (02:30 IST); the first scheduled run returned HTTP 200 with zero deletions. No manual production cleanup was invoked, and Vercel SSO was not weakened. The local endpoint requires `CRON_SECRET` and `PANDIT_RETENTION_WORKER_ENABLED=true`; scheduled cleanup is handled by Supabase. Synthetic expiry remains explicitly test-only and is denied in production. No production seed/import is supported. Remaining product decision: terminology/tradition taxonomy; this policy is not a legal-compliance claim.
- Pandit local tests cover runtime/migration agreement, disposable PostgreSQL validation, mock Storage flows, policy-bound deletion, retries, and reviewer authorization. The migration runner consults history and excludes applied migrations 004–006. The latest synthetic-only check passes 171 tests and skips three owner-PDF-dependent cases before fixture loading. The production connector's read-only preflight passed; no production user, application, or file was created, and no end-to-end applicant upload/review was run. The connector-gated release remains behind Vercel SSO; local tests do not establish production-like end-to-end behavior or cleanup of non-empty evidence.

See [docs/PRD.md](docs/PRD.md) and [docs/TECHNICAL.md](docs/TECHNICAL.md).
