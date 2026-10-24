# Hometown Hub

A responsive web platform for people who want to stay connected to their hometown or local community. Hometown Hub provides community feeds, member-led events, moderation, and platform administration without preloaded fictional activity.

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

There is **no demo activity or sample user data** in a fresh database. Pandit onboarding application code remains local and unreleased: every production Pandit endpoint returns `503`, and real evidence uploads remain disabled. Separately, migration `004_pandit_onboarding.sql` has been applied to Hometown Hub production. The five Pandit tables were verified empty, with RLS enabled and default-deny client access. The private `hometown-pandit-evidence` bucket exists with a 1,048,576-byte limit and exactly `application/pdf`, `image/png`, and `image/jpeg` allowed. This production schema/storage setup is not an end-to-end live app integration and does not establish that evidence uploads work. This module does not claim legal certification or compliance.

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
- The approved local policy is **3 calendar years** for approved evidence, **90 elapsed UTC days** for pending evidence after the last applicant activity, **90 elapsed UTC days** from rejection for rejected `GOVERNMENT_ID`, `BACKGROUND_CHECK`, and `EDUCATION` evidence, and **30 elapsed UTC days** for appeals. New retention fields default to 90 days, while settings remain nullable/configurable; null or invalid policy fails closed for uploads/submission/reviews rather than guessing. Applicant state-changing saves, evidence uploads, submissions, appeals, and explicit applicant signals count as activity and reset pending deadlines; GETs, reviewer actions, and retention sweeps do not. Feb 29 clamps to Feb 28 when adding calendar years. Approved evidence deadlines remove evidence, not the profile; the profile remains with action-required/reset verification and metadata audit. Rejected evidence deadlines originate at rejection, are immutable through appeal, and persist until that evidence version is replaced. Appeals are accepted strictly before the deadline; the separate `appeal_status` metadata is derived as `OPEN`, `CLOSED`, `OPENED`, or `NOT_APPLICABLE` without changing the lifecycle status names.
- Retention is a local request-time sweep under a transaction, not an unattended job; offline operation cannot promise scheduled or guaranteed deletion. Expiry simulation is permitted only with explicit `allowSimulations` and `is_simulation: 1`; it is never a production behavior. Simulations use normal-format test fixtures only with `is_simulation: true`, conspicuous synthetic identities/documents, no realistic identifiers or people, an explicit test-mode option, and are always denied in production. Migration `004_pandit_onboarding.sql` has been applied to Hometown Hub production; no production seed/import was added or supported. The five Pandit tables were verified empty, RLS-enabled, and default-deny. The separate private `hometown-pandit-evidence` bucket has a 1,048,576-byte limit and exactly `application/pdf`, `image/png`, and `image/jpeg` allowed. Remaining owner decisions are terminology/tradition taxonomy and authorized app release policy; this local policy is not a legal compliance claim.
- Pandit local tests include runtime/migration field-agreement coverage and simulation/mock storage flows with policy-bound deletion, retry-safe metadata cleanup, and reviewer authorization checks. The migration runner intentionally skips 004 to prevent reapplication; 004 was also validated in disposable local PostgreSQL **16.15**. The Pandit app code remains local and unreleased: production endpoints return `503`, and real evidence uploads remain disabled. These tests do not establish end-to-end live app integration or that evidence uploads work.

See [docs/PRD.md](docs/PRD.md) and [docs/TECHNICAL.md](docs/TECHNICAL.md).
