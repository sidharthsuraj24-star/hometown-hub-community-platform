# Hometown Hub

A responsive, private-project prototype for people who want to stay connected to their hometown or local community. It is an original product concept and does not reuse another platform’s branding or copy.

## Implemented

- Account registration and sign-in, editable hometown profile, and sign-out.
- Community directory and creation requests; new communities remain private until a platform administrator approves them.
- Join requests with moderator approval or rejection.
- Member-only community feeds with text, PNG/JPEG/WebP images, announcements, likes, comments, shareable deep links, and pinned posts.
- Community-created events with optional creator-defined capacity and transactional, capacity-safe RSVPs.
- In-app notifications for posts, comments, likes, community reviews, membership requests/decisions, and events.
- Community moderator tools for membership review, guidelines, pinned announcements, post/comment moderation, and event management.
- Platform admin dashboard with record counts, community review, account enable/disable, moderator assignment, reports, categories, and managed community tags.
- Responsive layout and project/technical documentation.

There is **no demo activity or sample user data** in a fresh database. The default categories and tags are only reusable vocabulary lists. The “Pandit onboarding” and “Sample Pandit Data” references are intentionally not implemented; they are recorded as an unresolved scope question in the PRD.

## Requirements

- Node.js **22.13 or newer** with the built-in `node:sqlite` module (tested with Node 24.19).
- No third-party npm packages are required.

## Run locally

1. Review `.env.example`, then copy it to `.env` and replace the administrator email/password with values you control. Use a unique password of at least 12 characters. Keep `.env` private.
2. Run:

   ```sh
   npm start
   ```

3. Open `http://127.0.0.1:3000`.

The configured platform administrator is created on first startup when both `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` are present and the email is not already registered. Configure these **before registering that email**. The password is scrypt-hashed; it is not stored in plaintext. Admin credentials are not included in this repository.

To run the automated checks:

```sh
npm test
# or
npm run check
```

Health check: `GET /api/health`.

## Local data and operation

By default, SQLite data and uploaded images live under `data/`, which is ignored by Git. Override `DATA_DIR` to use a different persistent directory. Back up both the SQLite database (including SQLite WAL/checkpoint state) and the `uploads/` directory together. Sessions are held in memory and expire after seven days; restarting the process signs users out.

The server listens on loopback by default. `PORT` changes the port. This repository has **not been deployed** and has no configured cloud database, public URL, third-party identity provider, email/SMS service, or external notification integration.

## Scope and known limitations

- This is a single-process prototype for a private student project. SQLite transactions protect capacity-limited RSVPs within this deployment; running multiple independent app instances against separate local disks would not provide shared state.
- Account recovery, email verification, profile photos, public community discovery without an account, and external push notifications are not implemented.
- Moderation is human-operated; there is no advanced or AI moderation, automatic abuse triage, emergency/government feed, advertising, marketplace, or native mobile client.
- Post images are limited to 1.5 MB per image and stored locally.
- Platform-admin bootstrap is environment-driven. Do not expose this prototype to public traffic without a separate production security, abuse, backup, and operations review.
- **Open product question:** should “Pandit onboarding” and “Sample Pandit Data” refer to Hindu-priest service listings, or are those references unrelated template content? No Pandit module or records are included pending clarification.

See [docs/PRD.md](docs/PRD.md) and [docs/TECHNICAL.md](docs/TECHNICAL.md).
