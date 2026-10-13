# Hometown Hub — Technical Notes

## Architecture

- **Runtime:** Node.js 22.13+; tested in Node 24.19.
- **HTTP/API:** Node built-in `http` server and JSON REST-style endpoints; no Express or third-party runtime package is required.
- **Database:** built-in `node:sqlite`/SQLite with prepared statements, foreign keys, indexes, WAL mode, and a busy timeout.
- **Frontend:** vanilla JavaScript, semantic HTML, and responsive CSS served from `public/`.
- **Uploads:** locally stored verified PNG/JPEG/WebP files under `DATA_DIR/uploads/` with randomized filenames and a 1.5 MB limit.
- **Local persistence:** `DATA_DIR/hometown-hub.sqlite` (default `data/hometown-hub.sqlite`).

The app is intentionally a single-process private-project prototype. It is not connected to a hosted database or deployment service.

## Run and configure

```sh
cp .env.example .env
# edit PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD
npm start
```

- `PORT` — HTTP port (default `3000`).
- `HOST` — listen interface (default `127.0.0.1`).
- `DATA_DIR` — database and uploads directory (default `./data`).
- `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` — on first startup, create a platform admin if both values are valid and that email does not already exist. Password minimum: 12 characters.
- `NODE_ENV=production` — adds the `Secure` cookie attribute; HTTPS is required for that mode.

Configure the bootstrap email before registering it as a normal user. The bootstrap secret is not persisted in code; the resulting password is scrypt-hashed. If the account exists already, startup deliberately does not promote it or change its password.

## Data model

| Entity | Purpose |
|---|---|
| `users` | Account identity, scrypt salt/hash, profile fields, platform role, disabled state. |
| `communities` | Location, description, category, selected managed tags, guidelines, creation-review status. |
| `memberships` | Per-community role and pending/active/rejected state. Composite primary key prevents duplicate membership requests. |
| `posts` | Community feed content, kind, category, optional local image path, and pin state. |
| `comments`, `likes`, `shares` | Post discussion and engagement; unique keys prevent duplicate likes/shares by a user. |
| `events`, `rsvps` | Creator-managed event details, optional capacity, and each user's attendance state. |
| `notifications` | In-app activity notification and read state. |
| `reports` | Member-submitted content/user reports and platform resolution state. |
| `content_categories`, `content_tags` | Platform-managed vocabulary; default entries are taxonomy only, not sample community records. |

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
- `GET/POST /api/events`; `POST /api/events/:id/rsvp`; `DELETE /api/events/:id`
- `GET /api/notifications`; `POST /api/notifications/read/:id` or `/read`
- `POST /api/reports`
- Admin: `GET /api/admin/dashboard`; review communities; change active member roles; enable/disable users; resolve reports; create/delete categories and tags.

## Event-capacity correctness

The RSVP handler runs `BEGIN IMMEDIATE`, checks an existing RSVP and counts active `going` RSVPs, and writes the RSVP within the same transaction. If capacity is full, the entire transaction rolls back with HTTP `409`. This protects simultaneous requests handled by this SQLite database in the single-process configuration, which is covered by an integration test. A multi-instance deployment needs a shared transactional database and operational testing before it can claim the same behavior.

## Security controls and boundaries

- Passwords use Node `scryptSync` with per-password random salts; comparisons use `timingSafeEqual`.
- Sessions are random, server-side in-memory tokens in `HttpOnly; SameSite=Lax` cookies. They expire after seven days and are invalidated on logout or admin disablement; process restart clears sessions.
- Login and registration are throttled per remote address. This in-memory limiter is not shared across instances.
- Writes reject cross-origin browser requests; JSON-only writes and SameSite cookies provide CSRF friction. This prototype has no user-managed email verification, account recovery, MFA, persistent session store, or formal security audit.
- SQL values are parameterized. User-provided strings are length-bounded and HTML-escaped in the UI.
- Security headers include a restrictive content policy, `X-Frame-Options`, and `X-Content-Type-Options`.
- The prototype should not be exposed to public traffic without reviewing HTTPS/proxy behavior, rate-limits, spam controls, backups, abuse operations, logs, and multi-instance storage.

## Verification

Run `npm test` for API integration coverage, including the simultaneous capacity-one RSVP race. `npm run check` also runs Node syntax checks. Tests use temporary SQLite databases and do not create repository seed data.
