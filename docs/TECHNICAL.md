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
- `compose.yaml` sets production mode and persists both the SQLite database and uploads in the named `hometown-hub-data` volume.
- `.dockerignore` excludes credentials, local data, and source-control files. GitHub Actions runs `npm run check` on Node 24 for pushes and pull requests to `main`.

Start with `docker compose up --build -d` after creating and securely editing `.env`. Place the app behind HTTPS before using it outside a trusted private network. Back up the entire persistent volume consistently and test restoring the database and uploads together. A formal production security review, abuse operations, centralized logs/monitoring, and tested recovery plan remain deployment-owner responsibilities.

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

## KPI definitions and interpretation

- **DAU / 7-day / 30-day active members:** distinct non-admin accounts with authenticated activity on one or more UTC days in the period.
- **Engaged members (30d):** distinct active members with a post, comment, like, share, or going RSVP during the period; the engagement rate is engaged members divided by 30-day active members.
- **Post engagement rate (30d):** posts created during the period with at least one like, comment, or share divided by all posts created during that period.
- **Upcoming event RSVP rate:** going RSVPs for open future events created during the last 30 days divided by active member-event opportunities in those communities. This measures RSVP intent, **not verified attendance**.
- **Member/community growth:** current-period records created in the last 30 days compared with records created in the preceding 30 days. Community counts include approved communities only. The percentage is omitted when the preceding count is zero.
- **Daily activity chart:** one row per member/UTC day for the most recent 30 days.

No records, events, active members, or impact values are seeded. Zero activity and insufficient historical baseline are represented as such rather than estimated.

## Non-functional verification and limits

Run `npm run nfr:smoke` for a disposable local HTTP app-shell check. It starts an isolated SQLite database in a temporary directory, runs 10 concurrent anonymous clients, and has each retrieve `/`, `/styles.css`, `/app.js`, `/favicon.svg`, `/api/meta`, and `/api/me`. It reports p50/p95 latency from request start until all response bodies are consumed, and exits unsuccessfully when p95 is at or above 3 seconds. It removes its temporary database and does not modify the app's configured `DATA_DIR`.

This is a lightweight HTTP regression check, **not** a browser-render/load test or evidence of production-network performance. Two fresh local runs measured 181.7 ms and 216.0 ms p95. A separate local preview observation measured 1.18 seconds p95 to app-ready under 10 concurrent anonymous desktop sessions; neither measurement is a production guarantee. A prior local signed-in test completed 130/130 requests across 13 simultaneous sessions with 48.5 ms p95, but that result is likewise limited to its test environment.

The RSVP integration test exercises eight simultaneous members competing for three event places and asserts that exactly three succeed. Multi-locality tests use disposable city, village, and region strings to verify that profile and community labels remain distinct. Security regressions check password hashing/privacy, same-origin rejection, logout, rate limiting, and production transport/session headers. A prior responsive-layout spot-check found no horizontal overflow at 390×844 and 320×720; no formal usability, accessibility, or security audit has been completed.

Multiple city/village communities are representable as free-text locations. Structured city/district hierarchies, geocoding, proximity search, shared multi-instance sessions/rate limiting, a managed database, production capacity, backups, and formal security review are not implemented or verified.

## Event-capacity correctness

The RSVP handler runs `BEGIN IMMEDIATE`, checks an existing RSVP and counts active `going` RSVPs, and writes the RSVP within the same transaction. If capacity is full, the entire transaction rolls back with HTTP `409`. The integration suite tests eight simultaneous members competing for three places. A multi-instance deployment needs a shared transactional database and operational testing before it can claim the same behavior.

## Security controls and boundaries

- Passwords use Node `scryptSync` with per-password random salts; comparisons use `timingSafeEqual`. Sign-in responses are generic, and an unknown account still receives a dummy scrypt comparison.
- Sessions are random, server-side in-memory tokens in `HttpOnly; SameSite=Lax` cookies. They expire after seven days and are invalidated on logout or admin disablement; process restart clears sessions.
- Login, registration, and report submissions are throttled per remote address. The limiter is in-memory and is not shared across app instances.
- Writes reject cross-origin browser requests; JSON-only writes and SameSite cookies provide CSRF friction. This build has no email verification, account recovery, MFA, persistent session store, or formal security audit.
- SQL values are parameterized. User-provided strings are length-bounded and HTML-escaped in the UI.
- Security headers include a restrictive content policy, HSTS in production, frame/type protection, referrer policy, and permissions policy. Request and header timeouts and request-body limits are configured.
- The app should not be exposed to public traffic without reviewing TLS/proxy behavior, shared rate-limiting/session requirements, backups, abuse operations, logs, privacy notices, and multi-instance storage.

## Verification

Run `npm run check` for JavaScript syntax checks and API integration tests, including registration, community approval/member roles, image access controls, guideline authorization and notifications, event edit/cancel permissions, 8-way RSVP capacity enforcement and attendee notifications, data-derived KPI calculations, reporter case tracking/appeals, public case messages versus private admin notes, report status history, report-schema migration, multi-locality values, and security safeguards. Tests use temporary SQLite databases and do not create repository seed data. Run `npm run nfr:smoke` separately for the app-shell HTTP timing check described above.

## Vercel/Supabase migration status

- `server.js` and `api/index.mjs` expose the same Fetch-standard adapter from `lib/fetch-handler.js`, bridging Web requests/responses to the existing Node HTTP handler without calling `listen()` on import. Vercel local dev and a local production build both recognized the handler; the build packaged `api/index.mjs` for Node 24 in Mumbai (`bom1`, 10-second maximum) and configured static-response security headers.
- `supabase/migrations/001_initial_schema.sql` creates the durable PostgreSQL schema and only the existing non-personal taxonomy vocabulary. `002_private_storage.sql` creates the **private** `hometown-post-images` bucket and deliberately creates no public or client storage policies.
- `scripts/apply-supabase-migrations.sh` remains the reproducible operator-run setup path and requires an explicitly supplied `SUPABASE_DB_URL`. The new Hometown Hub Supabase project was created on Free in Mumbai at verified `$0/month`; migrations `001`–`003` were applied to that project, enabling default-deny RLS on every public app table. Only the existing non-personal taxonomy vocabulary is present; user, community, post, event, report, session, and activity data remain empty. No preview records were copied.
- Production routes now use `lib/production-adapter.js` and do not create or fall back to SQLite or local uploads. The adapter uses verified TLS, server-only PostgreSQL and Supabase Storage credentials, hashed persistent sessions, serialized shared rate limits, and the private photo bucket. Image downloads are still authorized against community membership before bytes are returned. The service-role key is never sent to browser code.
- A supplied administrator email/password will be bootstrapped once on the first non-health API request; an existing non-admin/disabled account will not be promoted, and an existing administrator password will not be overwritten. All non-health API routes fail closed without the production database and administrator configuration. No Hometown Hub administrator details have been submitted, so no admin account or public deployment exists.
- Vercel has only an empty project shell under the existing Hobby account: no Git source, production environment variables, or hosted deployment exists. The local CLI build created only ignored `.vercel/` settings/build artifacts; it did not deploy. Keep the GitHub repository private and its default branch unchanged. Vercel Hobby requires personal, non-commercial use; owner eligibility confirmation is still required. Supabase Free quotas/pausing apply; neither service should be upgraded or attached to billing for this setup.
- Local verification: `npm run check` passes all 22 tests; `npm run nfr:smoke` passed at p50 111.4 ms / p95 159.7 ms for 10 concurrent sessions × 6 requests. Vercel's local production build succeeded and packaged the Mumbai Node 24 function; loopback checks returned HTTP 200 for health, 503 for login with backend configuration absent, and the expected security headers. Production adapter tests use mocks only; a live connection and stable URL remain unverified and are blocked pending real admin details, Vercel Hobby eligibility confirmation, and secure production environment setup. Do not interpret these local results as live-service verification.
