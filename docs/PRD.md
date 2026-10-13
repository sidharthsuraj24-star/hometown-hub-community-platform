# Hometown Hub — Product Requirements Document

**Status:** Phase 1 prototype implemented; private repository only; not deployed.
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
- Concurrent RSVP enforcement: a capacity-limited event never accepts more active RSVPs than its stated capacity in the tested single-process deployment.
- In-app notifications for membership actions, community review, new posts/events and event changes, comments, likes, guideline changes, and report filing/status/follow-up.
- Community rules/guidelines editable by moderators, with in-app notices to active members when rules change; moderation actions and an administrator dashboard.
- Abuse reports for users, posts, comments, and communities, with reporter case tracking, message exchange, status history, appeal/reopen, and admin-only private notes.
- Platform-managed post categories and community tags.
- Platform-admin report review with target context, open/in-review/resolved/dismissed states, reporter-visible responses, private admin notes, status history, and in-app case alerts/updates.
- Database-derived DAU, rolling active-member, post engagement, upcoming-event RSVP, member/community growth metrics, and a 30-day activity chart.
- PRD, technical documentation, automated API tests, and a local run configuration.
- Non-root Docker/Compose deployment files and GitHub Actions CI for a persistent single-instance host.

### Excluded

- Native mobile applications, paid advertising, or marketplace/classifieds.
- Advanced/AI moderation.
- Emergency alert or government system integration.
- External mail, SMS, web-push, or identity providers.
- Production deployment, public release, live community data, or a cloud-managed database.
- Fictional seed users, communities, local news, events, service providers, alerts, or performance/impact metrics.

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

## 6. Safety, privacy, and content principles

- Do not seed fake members, news, events, businesses, services, alerts, or community impact statistics.
- Keep new community requests non-public until approval.
- Store authentication passwords only as scrypt hashes and keep uploaded files and SQLite data out of Git.
- Record activity at UTC-day granularity for analytics and delete activity rows older than 90 days at startup; do not send product analytics to a third party.
- Use same-site HTTP-only session cookies, same-origin checks on browser writes, login/registration throttling, restrictive security headers, input-size limits, and parameterized SQL statements.
- Tell users what profile details are visible and encourage careful sharing.
- Human moderators/admins handle content reports; reporter-facing status and messaging support the process but do not promise automated detection or dispute adjudication. Internal admin notes are not shown to reporters.

## 7. Product decisions and open question

### Interpreted requirement

“Supports concurrent bookings” is treated as a requirement for safe concurrent event RSVPs, not paid booking or appointment infrastructure. Capacity is optional and defined by the event creator.

### Unresolved scope question — Pandit module

The supplied brief lists “Pandit onboarding module” as a deliverable and “Sample Pandit Data,” but those phrases do not clearly align with the rest of the hometown social-community product. They may refer to Hindu-priest service listings, or may be copied from another project template. **Do not build the module or add sample Pandit records until the product owner confirms the intended meaning, target user, and workflow.**

## 8. Success measurement

The admin dashboard calculates DAU and rolling active members from authenticated member activity, engagement from recorded posts/interactions, upcoming-event RSVP intent from active member-event opportunities, and 30-day user/community growth from creation dates. Definitions and limits are documented in `TECHNICAL.md`; the dashboard never seeds or estimates activity. Growth percentages are not shown when the prior period is zero. Event RSVPs are not verified attendance. The 90-day daily activity records are used for these aggregate views and are not sent to an external analytics provider.

The supplied brief sets a page-load target under three seconds. That target, production traffic capacity, concurrent-user scalability, and availability have **not** been measured in a production-like environment and are not claimed by the Phase 1 build. The container configuration is deployment-ready for a persistent single-instance host but is not a production release, cloud-managed database, or multi-instance architecture.

### Non-functional verification (local evidence only)

- **Performance:** A local preview check previously measured 1.18 seconds p95 to app-ready under 10 concurrent anonymous desktop sessions. The repeatable `npm run nfr:smoke` check exercises the homepage, CSS, JavaScript, favicon, metadata, and session endpoints with 10 concurrent anonymous clients; two fresh local runs measured 181.7 ms and 216.0 ms p95. This script measures HTTP app-shell readiness after response bodies arrive, **not** browser rendering, a production network, or production capacity. Timings are machine- and load-dependent.
- **Concurrent event RSVPs:** The integration suite sends 8 simultaneous RSVP requests for 3 available places; exactly 3 are accepted and 5 receive HTTP 409. This verifies capacity enforcement in the supported single-process SQLite deployment, not across multiple app instances.
- **Security:** Automated checks cover non-plaintext scrypt password storage, omission of password fields from API output, same-origin write rejection, logout invalidation, registration throttling, and production cookie/security headers. These checks do not constitute a formal security audit; sessions and rate limits remain process-local.
- **Mobile usability:** A prior signed-in UI spot-check at 390×844 and 320×720 found no horizontal overflow. This is a layout check, not a full usability or accessibility study.
- **Multiple cities and villages:** Profiles and communities accept separate bounded free-text hometown/location labels; automated tests retain city, village, and region values independently. There is no standardized geographic hierarchy, geocoding, or distance-based search. The SQLite application remains single-process and is not horizontally scalable as configured.

## 9. Future candidates (not implemented)

- Native mobile applications and multi-language interface.
- Optional local marketplace/classifieds.
- Verified local-government updates and separately governed emergency alert integrations.
- Email/push delivery, account verification/recovery, and advanced moderation support.
