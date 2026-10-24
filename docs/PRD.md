# Hometown Hub — Product Requirements Document

**Status:** Phase 1 prototype implemented; existing Vercel/Supabase production architecture is live behind Vercel Authentication; this private repository is not a public launch. Pandit database/storage groundwork (migration 004 and a separate private evidence bucket) is present in Hometown Hub production, but Pandit application code remains local and unreleased: all production Pandit endpoints return `503` and real evidence uploads remain disabled. This setup is not an end-to-end live app integration and does not establish that evidence uploads work.
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
- Pandit onboarding refinement remains a local/unreleased app feature: the application/evidence workflow and policy are specified below, but all Pandit production endpoints return `503` and real evidence uploads remain disabled. Migration `004_pandit_onboarding.sql` has been applied to Hometown Hub production; its five tables were verified empty with RLS-enabled, default-deny client access. The separate private `hometown-pandit-evidence` bucket was verified with a 1,048,576-byte limit and exactly `application/pdf`, `image/png`, and `image/jpeg` allowed. This schema/storage setup is not a live app integration.

### Excluded

- Native mobile applications, paid advertising, or marketplace/classifieds.
- Advanced/AI moderation.
- Emergency alert or government system integration.
- External mail, SMS, web-push, or identity providers.
- Public launch, fictional seed users, communities, local news, events, service providers, alerts, or performance/impact metrics.
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
| PND4 | Enforce policy and lifecycle | The approved local policy is 3 calendar years for approved evidence, 90 elapsed UTC days for pending evidence after last applicant activity, 90 elapsed UTC days from rejection for rejected government-ID, background-check, and education evidence, and 30 elapsed UTC days for appeals. New retention fields default to 90 days but remain nullable/configurable; null or invalid policy fails closed rather than guessing. Legacy approved-retention days remain supported, mutually exclusive with years. Applicant state-changing save/upload/submit/appeal/signal operations reset pending activity; GETs, reviewer actions, and sweeps do not. Rejected deadlines originate at rejection and persist immutably through appeal until replacement. Upload/submit/review fail closed when policy is missing or ambiguous. `recheck_years` is 1 or 2. Approved evidence expiry removes evidence but keeps the profile and audit metadata; rejected ID expiry keeps the profile/status. Bank-details-change or official-ID-change triggers immediate `ACTION_REQUIRED` reverification; no bank details are collected. Appeals are accepted strictly before the deadline and expose derived `OPEN`, `CLOSED`, `OPENED`, or `NOT_APPLICABLE` status. |

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

### Pandit onboarding scope (approved; local/unreleased application code)

The production database/storage groundwork is applied: migration `004_pandit_onboarding.sql` is live in Hometown Hub production, its five Pandit tables were verified empty with RLS enabled and default-deny client access, and the separate private `hometown-pandit-evidence` bucket has a 1,048,576-byte limit with exactly `application/pdf`, `image/png`, and `image/jpeg` allowed. The Pandit application code remains local and unreleased: all production endpoints return `503`, real evidence uploads remain disabled, and no end-to-end live app integration or working upload path is claimed. No production seed or import is supported.

An authenticated member may save or submit an application with required private government-ID, background-check, and education evidence plus a `ritual_skills` list. The exact lifecycle statuses are `PENDING_VERIFICATION`, `ACTION_REQUIRED`, `APPROVED`, and `REJECTED`; incomplete or withdrawn drafts use `ACTION_REQUIRED` and `submitted_at` remains null. Evidence is authenticated private data in the local database, never public or member-directory data. Store minimal metadata only: never filenames, IDs, bank details, or evidence/document content in audit logs.

`CHECKER` can inspect/verify evidence and recommend approval or `ACTION_REQUIRED`. `COMPLIANCE` makes the final approve/reject decision. `SUPER_ADMIN` can manage settings, roles, and audit only; it has no automatic evidence access and cannot make final decisions. Bootstrap provisioning is server-side. Self-review and role escalation are blocked.

The owner-approved local defaults are 3 calendar years for approved evidence, 90 elapsed UTC days for pending evidence after the last applicant activity, 90 elapsed UTC days from rejection for rejected government-ID, background-check, and education evidence, and 30 elapsed UTC days to appeal. New retention settings default to 90 days but remain nullable/configurable; missing or ambiguous policy still blocks uploads, submission, and review rather than guessing. Successful applicant state-changing saves, evidence uploads, submissions, appeals, and explicit signals reset pending activity; GETs, reviewer actions, and retention sweeps do not. Rejected deadlines originate at rejection and remain immutable through appeal until replacement. Feb 29 anniversaries clamp to Feb 28. `recheck_years` remains configurable as 1 or 2; the directory independently hides overdue profiles. Immediate bank-details-change or official-ID-change reverification collects no bank details. Expiry deletes due evidence, not the application or metadata-only audit; approved applications require action after evidence expiry. Only explicitly enabled synthetic simulations tagged `is_simulation: true` undergo the local transactional request-time expiry sweep. There is no background scheduler, offline deletion guarantee, or retroactive deadline backfill.

Simulations use normal-format test fixtures only, require `is_simulation: true` and an explicit test-mode option, and use conspicuous synthetic identities/documents—not realistic identifiers or real people. They are always denied in production.

Local lifecycle verification uses isolated synthetic fixtures and simulated UTC clocks: approval, rejection, appeal and expiry boundaries, evidence replacement, concurrent idempotence, policy snapshots, private access, and fail-closed simulation/production separation are covered. Updated test results are intentionally not asserted here; three existing owner-PDF-dependent preview tests remain explicitly skipped without reading that file. Hosted scheduling, non-simulation automated deletion, production migrations/integration, backup erasure, malware scanning, and formal security/compliance remain unverified and are not implied by local tests. The fresh temporary preview retains its upload/save/submit-only gateway; staff lifecycle testing does not weaken that gate.

### Remaining decisions

- Authorized release criteria for lifting the local-only `503` guard and any future production deployment.
- Terminology and tradition taxonomy.
- Backup deletion and any future non-simulation expiry service; the pending and rejected background/education periods are owner-approved at 90 elapsed UTC days, while nullable/configurable settings remain supported and fail closed when null or invalid.

The retention and appeal periods above are approved; the production release guard remains unchanged until separately authorized. Real evidence remains disabled, and migration 004 is only validated in disposable local PostgreSQL 16.15—not Supabase or production.

## 8. Success measurement

The admin dashboard calculates DAU and rolling active members from authenticated member activity, engagement from recorded posts/interactions, upcoming-event RSVP intent from active member-event opportunities, and 30-day user/community growth from creation dates. Definitions and limits are documented in `TECHNICAL.md`; the dashboard never seeds or estimates activity. Growth percentages are not shown when the prior period is zero. Event RSVPs are not verified attendance. The 90-day daily activity records are used for these aggregate views and are not sent to an external analytics provider.

The supplied brief sets a page-load target under three seconds. That target, production traffic capacity, concurrent-user scalability, and availability have **not** been measured in a production-like environment and are not claimed by the Phase 1 build. The existing Vercel/Supabase architecture is production-configured and access-controlled, but this local Pandit change is not deployed. The container configuration remains a separate persistent single-instance option; neither path is a public launch or multi-instance claim.

### Non-functional verification (local evidence only)

- **Performance:** Run `npm run nfr:smoke` for the current local HTTP app-shell check; no production performance claim is made.
- **Concurrent event RSVPs:** The integration suite sends 8 simultaneous RSVP requests for 3 available places; exactly 3 are accepted and 5 receive HTTP 409. This verifies capacity enforcement in the supported single-process SQLite deployment, not across multiple app instances.
- **Security:** Automated checks cover non-plaintext scrypt password storage, omission of password fields from API output, same-origin write rejection, logout invalidation, registration throttling, and production cookie/security headers. These checks do not constitute a formal security audit; sessions and rate limits remain process-local.
- **Mobile usability:** A prior signed-in UI spot-check at 390×844 and 320×720 found no horizontal overflow. This is a layout check, not a full usability or accessibility study.
- **Multiple cities and villages:** Profiles and communities accept separate bounded free-text hometown/location labels; automated tests retain city, village, and region values independently. There is no standardized geographic hierarchy, geocoding, or distance-based search. The SQLite application remains single-process and is not horizontally scalable as configured.

## 9. Future candidates (not implemented)

- Native mobile applications and multi-language interface.
- Optional local marketplace/classifieds.
- Verified local-government updates and separately governed emergency alert integrations.
- Email/push delivery, account verification/recovery, and advanced moderation support.
