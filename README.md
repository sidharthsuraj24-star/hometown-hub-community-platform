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

There is **no demo activity or sample user data** in a fresh database. The “Pandit onboarding” and “Sample Pandit Data” references are an unresolved product question because their intended workflow conflicts with the otherwise community-only, no-marketplace scope. No Pandit module or records are added until that scope is clarified.

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

To run syntax checks and automated tests:

```sh
npm run check
```

Health check: `GET /api/health`.

## Self-host with Docker Compose

The Compose setup stores the SQLite database and uploaded images in the persistent `hometown-hub-data` volume. It starts the app as a non-root user and includes a health check.

```sh
cp .env.example .env
# Edit .env: set a real admin email and a unique 12+ character password.
docker compose up --build -d
curl http://localhost:3000/api/health
```

`PORT` in `.env` selects the host-side port. Compose binds the app inside the container on port 3000 and provides `NODE_ENV=production`, which sets secure cookies and production security headers. Put the service behind HTTPS before using it outside a trusted network. Preserve and back up the named data volume, including both SQLite data and uploads; test restore procedures before relying on it.

## Local data and operation

By default, SQLite data and uploaded images live under `data/`, which is ignored by Git. Override `DATA_DIR` to use another persistent directory. The app uses SQLite WAL mode, prepared statements, and transaction-safe RSVP capacity checks. Authentication sessions and rate limits are held in memory and are reset when the process restarts. Run one app instance against its local persistent data directory; this release does not support shared multi-instance state.

Analytics are derived from real database records, not sample values. A non-admin member’s authenticated requests record a daily activity row at UTC-day granularity; rows older than 90 days are pruned when the app starts. The dashboard’s event metric is an RSVP-intent rate—not verified attendance—and growth percentages are withheld when the prior period is zero. No third-party analytics service is used.

## Scope and deployment limits

- This is a private-project Phase 1 build. No production project or public deployment is configured.
- The app includes in-app notifications; external email, SMS, and web-push delivery are not configured. There are no account recovery or email-verification flows.
- Human moderators/admins handle content reports. No advanced or AI moderation, emergency/government feed, advertising, marketplace, or native mobile client is included.
- Post images are limited to 1.5 MB and stored locally. Use durable storage and backups for any real deployment.
- The included Docker path is for a persistent single-instance host; it does not provide a managed database, distributed rate limiting, central session storage, automated backup service, or a formal security audit.
- **Open product question:** should “Pandit onboarding” and “Sample Pandit Data” mean Hindu-priest service listings, or are those references unrelated template text? No Pandit module or records are included pending product-owner clarification.

See [docs/PRD.md](docs/PRD.md) and [docs/TECHNICAL.md](docs/TECHNICAL.md).
