'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-hub-test-'));
  const server = createApp({ dataDir, adminEmail: 'admin@example.test', adminPassword: 'test-admin-password-123' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { base, admin: { cookie: '' } };
}

async function call(ctx, client, url, method = 'GET', body) {
  const headers = {};
  if (client.cookie) headers.Cookie = client.cookie;
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers.Origin = ctx.base; }
  const response = await fetch(`${ctx.base}${url}`, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) client.cookie = setCookie.split(';')[0];
  const data = await response.json().catch(() => ({}));
  return { response, data };
}
async function register(ctx, client, name, email) {
  const result = await call(ctx, client, '/api/auth/register', 'POST', { name, email, password: 'member-password-123' });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  client.email = email;
  return result.data.user;
}
async function loginAdmin(ctx, client) {
  const result = await call(ctx, client, '/api/auth/login', 'POST', { email: 'admin@example.test', password: 'test-admin-password-123' });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return result.data.user;
}
async function createApprovedCommunity(ctx, owner, admin) {
  const created = await call(ctx, owner, '/api/communities', 'POST', { name: 'Hometown Circle', location: 'Example Town', description: 'A space for people connected to Example Town.', category: 'Culture', tags: ['Culture'] });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const id = created.data.community.id;
  assert.equal(created.data.community.status, 'pending');
  const approved = await call(ctx, admin, `/api/admin/communities/${id}/review`, 'POST', { action: 'approve' });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.data));
  return id;
}
async function joinAndApprove(ctx, member, owner, communityId) {
  const joined = await call(ctx, member, `/api/communities/${communityId}/join`, 'POST', {});
  assert.equal(joined.response.status, 201, JSON.stringify(joined.data));
  const requests = await call(ctx, owner, `/api/communities/${communityId}/requests`);
  assert.equal(requests.response.status, 200, JSON.stringify(requests.data));
  const request = requests.data.requests.find(item => item.email === member.email);
  assert.ok(request, 'member request is visible to the community moderator');
  const decision = await call(ctx, owner, `/api/communities/${communityId}/requests/${request.id}`, 'POST', { action: 'approve' });
  assert.equal(decision.response.status, 200, JSON.stringify(decision.data));
}

test('account registration and platform admin bootstrap use an empty database', async t => {
  const ctx = await fixture(t); const admin = ctx.admin;
  const beforeAuth = await call(ctx, admin, '/api/admin/dashboard');
  assert.equal(beforeAuth.response.status, 401);
  await loginAdmin(ctx, admin);
  const dashboard = await call(ctx, admin, '/api/admin/dashboard');
  assert.equal(dashboard.response.status, 200);
  assert.deepEqual(dashboard.data.counts, { users: 0, communities: 0, pending_communities: 0, posts: 0, upcoming_events: 0, open_reports: 0 });
  assert.equal(dashboard.data.communities.length, 0);
  const member = { cookie: '' };
  const profile = await register(ctx, member, 'First Member', 'first@example.test');
  assert.equal(profile.name, 'First Member');
  assert.equal(profile.email, 'first@example.test');
  const me = await call(ctx, member, '/api/me');
  assert.equal(me.data.user.id, profile.id);
  const updated = await call(ctx, member, '/api/profile', 'POST', { name: 'First Member', hometown: 'Example Village', bio: 'Glad to stay connected with neighbors.' });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.user.hometown, 'Example Village');
  assert.equal(updated.data.user.bio, 'Glad to stay connected with neighbors.');
  const refreshed = await call(ctx, member, '/api/me');
  assert.equal(refreshed.data.user.hometown, 'Example Village');
});

test('community requests require platform review and member approval; moderators can pin posts', async t => {
  const ctx = await fixture(t), admin = ctx.admin, owner = { cookie: '' }, member = { cookie: '' }, outsider = { cookie: '' };
  await loginAdmin(ctx, admin);
  const ownerUser = await register(ctx, owner, 'Community Owner', 'owner@example.test');
  const memberUser = await register(ctx, member, 'Joining Member', 'member@example.test');
  await register(ctx, outsider, 'Non-member', 'outsider@example.test');
  const communityId = await createApprovedCommunity(ctx, owner, admin);
  await joinAndApprove(ctx, member, owner, communityId);
  const post = await call(ctx, member, '/api/posts', 'POST', { community_id: communityId, body: 'A useful local update for the group.', category: 'General', kind: 'announcement', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0Z0AAAAASUVORK5CYII=' });
  assert.equal(post.response.status, 201, JSON.stringify(post.data));
  const unauthorizedPin = await call(ctx, member, `/api/posts/${post.data.id}/pin`, 'POST', { pinned: true });
  assert.equal(unauthorizedPin.response.status, 403);
  const pinned = await call(ctx, owner, `/api/posts/${post.data.id}/pin`, 'POST', { pinned: true });
  assert.equal(pinned.response.status, 200);
  const feed = await call(ctx, member, `/api/feed?community=${communityId}`);
  assert.equal(feed.data.posts[0].pinned, 1);
  assert.equal(feed.data.posts[0].kind, 'announcement');
  assert.equal(feed.data.posts[0].can_moderate, false);
  const promoted = await call(ctx, admin, `/api/admin/communities/${communityId}/members/${memberUser.id}/role`, 'POST', { role: 'moderator' });
  assert.equal(promoted.response.status, 200, JSON.stringify(promoted.data));
  const moderatorUnpin = await call(ctx, member, `/api/posts/${post.data.id}/pin`, 'POST', { pinned: false });
  assert.equal(moderatorUnpin.response.status, 200, JSON.stringify(moderatorUnpin.data));
  const demoted = await call(ctx, admin, `/api/admin/communities/${communityId}/members/${memberUser.id}/role`, 'POST', { role: 'member' });
  assert.equal(demoted.response.status, 200, JSON.stringify(demoted.data));
  const deniedAfterDemotion = await call(ctx, member, `/api/posts/${post.data.id}/pin`, 'POST', { pinned: true });
  assert.equal(deniedAfterDemotion.response.status, 403);
  const memberImage = await call(ctx, member, feed.data.posts[0].image_path);
  assert.equal(memberImage.response.status, 200);
  assert.equal(memberImage.response.headers.get('cache-control'), 'private, no-store');
  const outsiderImage = await call(ctx, outsider, feed.data.posts[0].image_path);
  assert.equal(outsiderImage.response.status, 404);
  const anonymousImage = await call(ctx, { cookie: '' }, feed.data.posts[0].image_path);
  assert.equal(anonymousImage.response.status, 404);
  const adminFeed = await call(ctx, admin, `/api/feed?community=${communityId}`);
  assert.equal(adminFeed.data.posts[0].can_moderate, true);
  assert.ok(ownerUser.id);
});

test('event capacity stays intact when eight members RSVP simultaneously', async t => {
  const ctx = await fixture(t), admin = ctx.admin, owner = { cookie: '' };
  await loginAdmin(ctx, admin);
  await register(ctx, owner, 'Event Host', 'host@example.test');
  const guests = Array.from({ length: 8 }, () => ({ cookie: '' }));
  for (const [index, guest] of guests.entries()) {
    await register(ctx, guest, `Guest ${index + 1}`, `guest-${index + 1}@example.test`);
  }
  const communityId = await createApprovedCommunity(ctx, owner, admin);
  for (const guest of guests) await joinAndApprove(ctx, guest, owner, communityId);
  const eventResult = await call(ctx, owner, '/api/events', 'POST', { community_id: communityId, title: 'Town Hall Picnic', description: 'Bring a dish to share with the community.', location: 'Community garden', starts_at: new Date(Date.now() + 86400000).toISOString(), capacity: 3 });
  assert.equal(eventResult.response.status, 201, JSON.stringify(eventResult.data));
  const eventId = eventResult.data.id;
  const results = await Promise.all(guests.map(guest => call(ctx, guest, `/api/events/${eventId}/rsvp`, 'POST', { action: 'going' })));
  assert.equal(results.filter(result => result.response.status === 200).length, 3);
  assert.equal(results.filter(result => result.response.status === 409).length, 5);
  const events = await call(ctx, owner, `/api/events?community=${communityId}`);
  assert.equal(events.data.events[0].attendee_count, 3);
});

test('invalid event dates and unapproved-community posting are rejected safely', async t => {
  const ctx = await fixture(t), admin = ctx.admin, owner = { cookie: '' };
  await loginAdmin(ctx, admin);
  await register(ctx, owner, 'Community Owner', 'owner2@example.test');
  const pending = await call(ctx, owner, '/api/communities', 'POST', { name: 'Not Yet Public', location: 'Test Place', description: 'This is still under platform review.', category: 'General' });
  const beforeApproval = await call(ctx, owner, '/api/posts', 'POST', { community_id: pending.data.community.id, body: 'This should not post yet.', category: 'General' });
  assert.equal(beforeApproval.response.status, 404);
  const id = await createApprovedCommunity(ctx, owner, admin);
  const badEvent = await call(ctx, owner, '/api/events', 'POST', { community_id: id, title: 'Bad date', description: 'This event has an invalid date.', location: 'Town', starts_at: 'not-a-date', capacity: 'not-a-number' });
  assert.equal(badEvent.response.status, 400);
});

test('admin KPIs use observed activity and reports support contextual review and reopening', async t => {
  const ctx = await fixture(t), admin = ctx.admin, owner = { cookie: '' }, member = { cookie: '' };
  await loginAdmin(ctx, admin);
  await register(ctx, owner, 'Community Owner', 'analytics-owner@example.test');
  await register(ctx, member, 'Community Member', 'analytics-member@example.test');
  const communityId = await createApprovedCommunity(ctx, owner, admin);
  await joinAndApprove(ctx, member, owner, communityId);

  const createdPost = await call(ctx, owner, '/api/posts', 'POST', { community_id: communityId, body: 'A real member-created update for the group.', category: 'General' });
  assert.equal(createdPost.response.status, 201, JSON.stringify(createdPost.data));
  const liked = await call(ctx, member, `/api/posts/${createdPost.data.id}/like`, 'POST', {});
  assert.equal(liked.response.status, 200, JSON.stringify(liked.data));
  const reportResult = await call(ctx, member, '/api/reports', 'POST', { target_type: 'post', target_id: createdPost.data.id, reason: 'This update needs a moderator to review its wording.' });
  assert.equal(reportResult.response.status, 201, JSON.stringify(reportResult.data));

  const eventResult = await call(ctx, owner, '/api/events', 'POST', { community_id: communityId, title: 'Local gathering', description: 'Meet neighbors at the town garden.', location: 'Town garden', starts_at: new Date(Date.now() + 86400000).toISOString(), capacity: 10 });
  assert.equal(eventResult.response.status, 201, JSON.stringify(eventResult.data));
  const rsvp = await call(ctx, member, `/api/events/${eventResult.data.id}/rsvp`, 'POST', { action: 'going' });
  assert.equal(rsvp.response.status, 200, JSON.stringify(rsvp.data));

  const dashboard = await call(ctx, admin, '/api/admin/dashboard');
  assert.equal(dashboard.response.status, 200, JSON.stringify(dashboard.data));
  const report = dashboard.data.reports.find(item => item.id === reportResult.data.id);
  assert.ok(report);
  assert.match(report.target_summary, /real member-created update/);
  assert.match(report.target_context, /Hometown Circle/);
  assert.match(report.target_link, new RegExp(communityId));
  assert.equal(report.target_available, true);
  const analytics = dashboard.data.analytics;
  assert.equal(analytics.dau, 2, 'admin requests are excluded from member DAU');
  assert.equal(analytics.active_users_7d, 2);
  assert.equal(analytics.active_users_30d, 2);
  assert.equal(analytics.engaged_users_30d, 2);
  assert.equal(analytics.engagement_rate_30d, 100);
  assert.equal(analytics.post_engagement_rate_30d, 100);
  assert.equal(analytics.event_participation.going_rsvps, 1);
  assert.equal(analytics.event_participation.eligible_member_event_pairs, 2);
  assert.equal(analytics.event_participation.rate_percent, 50);
  assert.equal(analytics.user_growth.current, 2);
  assert.equal(analytics.user_growth.growth_percent, null, 'a zero previous-period baseline is not presented as a fabricated percentage');
  assert.equal(analytics.community_growth.current, 1);
  assert.equal(analytics.community_growth.growth_percent, null);
  assert.equal(analytics.daily_active_trend.length, 30);
  assert.equal(analytics.daily_active_trend.at(-1).active_users, 2);

  const resolved = await call(ctx, admin, `/api/admin/reports/${report.id}/resolve`, 'POST', { status: 'resolved', resolution_note: 'Reviewed; action taken with the community moderator.' });
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.data));
  const afterResolve = await call(ctx, admin, '/api/admin/dashboard');
  const closedReport = afterResolve.data.reports.find(item => item.id === report.id);
  assert.equal(closedReport.status, 'resolved');
  assert.equal(closedReport.resolution_note, 'Reviewed; action taken with the community moderator.');
  assert.ok(closedReport.resolved_at);
  const memberNotes = await call(ctx, member, '/api/notifications');
  assert.ok(memberNotes.data.notifications.some(note => note.type === 'report_update'));

  const reopened = await call(ctx, admin, `/api/admin/reports/${report.id}/resolve`, 'POST', { status: 'open' });
  assert.equal(reopened.response.status, 200, JSON.stringify(reopened.data));
  const afterReopen = await call(ctx, admin, '/api/admin/dashboard');
  const openReport = afterReopen.data.reports.find(item => item.id === report.id);
  assert.equal(openReport.status, 'open');
  assert.equal(openReport.resolution_note, '');
  assert.equal(openReport.resolved_at, null);

  const invalidStatus = await call(ctx, admin, `/api/admin/reports/${report.id}/resolve`, 'POST', { status: 'deleted' });
  assert.equal(invalidStatus.response.status, 400);
  const unauthorized = await call(ctx, member, '/api/admin/dashboard');
  assert.equal(unauthorized.response.status, 403);
});

test('community moderators manage guidelines and event hosts can edit or cancel events safely', async t => {
  const ctx = await fixture(t), admin = ctx.admin, owner = { cookie: '' }, member = { cookie: '' }, second = { cookie: '' }, outsider = { cookie: '' };
  await loginAdmin(ctx, admin);
  await register(ctx, owner, 'Community Owner', 'manage-owner@example.test');
  await register(ctx, member, 'Community Member', 'manage-member@example.test');
  await register(ctx, second, 'Second Community Member', 'manage-second@example.test');
  await register(ctx, outsider, 'Non-member', 'manage-outsider@example.test');
  const communityId = await createApprovedCommunity(ctx, owner, admin);
  await joinAndApprove(ctx, member, owner, communityId);
  await joinAndApprove(ctx, second, owner, communityId);

  const savedRules = await call(ctx, owner, `/api/communities/${communityId}/rules`, 'POST', { rules: 'Be welcoming. Protect personal details. Keep local discussions relevant.' });
  assert.equal(savedRules.response.status, 200);
  const detail = await call(ctx, member, `/api/communities/${communityId}`);
  assert.equal(detail.data.community.rules, 'Be welcoming. Protect personal details. Keep local discussions relevant.');
  const deniedRules = await call(ctx, member, `/api/communities/${communityId}/rules`, 'POST', { rules: 'Member cannot change these.' });
  assert.equal(deniedRules.response.status, 403);
  const memberNotes = await call(ctx, member, '/api/notifications');
  assert.ok(memberNotes.data.notifications.some(note => note.type === 'community_rules'));

  const created = await call(ctx, owner, '/api/events', 'POST', { community_id: communityId, title: 'Garden gathering', description: 'Meet and plan the community garden.', location: 'Town garden', starts_at: new Date(Date.now() + 86400000).toISOString(), capacity: 2 });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const eventId = created.data.id;
  const deniedEdit = await call(ctx, outsider, `/api/events/${eventId}`, 'PATCH', { title: 'Unauthorized change' });
  assert.equal(deniedEdit.response.status, 403);
  const rsvp = await call(ctx, member, `/api/events/${eventId}/rsvp`, 'POST', { action: 'going' });
  assert.equal(rsvp.response.status, 200);
  const secondRsvp = await call(ctx, second, `/api/events/${eventId}/rsvp`, 'POST', { action: 'going' });
  assert.equal(secondRsvp.response.status, 200);
  const tooSmall = await call(ctx, owner, `/api/events/${eventId}`, 'PATCH', { capacity: 0 });
  assert.equal(tooSmall.response.status, 400);
  const belowAttendance = await call(ctx, owner, `/api/events/${eventId}`, 'PATCH', { capacity: 1 });
  assert.equal(belowAttendance.response.status, 409);
  const validEdit = await call(ctx, owner, `/api/events/${eventId}`, 'PATCH', { title: 'Garden planning afternoon', description: 'Meet and organize the upcoming planting day.', location: 'Riverside community garden', starts_at: new Date(Date.now() + 172800000).toISOString(), capacity: 2 });
  assert.equal(validEdit.response.status, 200, JSON.stringify(validEdit.data));
  assert.equal(validEdit.data.event.title, 'Garden planning afternoon');
  const attendeeNotes = await call(ctx, member, '/api/notifications');
  assert.ok(attendeeNotes.data.notifications.some(note => note.type === 'event_update' && /details changed/i.test(note.message)));

  const cancelled = await call(ctx, owner, `/api/events/${eventId}`, 'DELETE', {});
  assert.equal(cancelled.response.status, 200);
  const cancelNotes = await call(ctx, member, '/api/notifications');
  assert.ok(cancelNotes.data.notifications.some(note => note.type === 'event_update' && /cancelled/i.test(note.message)));
  const cancelledRsvp = await call(ctx, member, `/api/events/${eventId}/rsvp`, 'POST', { action: 'going' });
  assert.equal(cancelledRsvp.response.status, 404);
});

test('reporters can track cases, exchange public updates, and appeal while private admin notes stay private', async t => {
  const ctx = await fixture(t), admin = ctx.admin, reporter = { cookie: '' }, other = { cookie: '' };
  await loginAdmin(ctx, admin);
  const reporterUser = await register(ctx, reporter, 'Reporting Member', 'reporter-case@example.test');
  await register(ctx, other, 'Other Member', 'other-case@example.test');
  const reported = await call(ctx, reporter, '/api/reports', 'POST', { target_type: 'user', target_id: reporterUser.id, reason: 'Please review this account for a possible impersonation concern.' });
  assert.equal(reported.response.status, 201, JSON.stringify(reported.data));
  const reportId = reported.data.id;
  const adminAlerts = await call(ctx, admin, '/api/notifications');
  assert.ok(adminAlerts.data.notifications.some(note => note.type === 'report_case'));

  const ownCases = await call(ctx, reporter, '/api/reports');
  assert.equal(ownCases.response.status, 200);
  assert.equal(ownCases.data.reports.length, 1);
  assert.equal(ownCases.data.reports[0].status, 'open');
  assert.equal(Object.hasOwn(ownCases.data.reports[0], 'resolution_note'), false);
  assert.equal(ownCases.data.reports[0].history.length, 1);
  assert.equal((await call(ctx, other, '/api/reports')).data.reports.length, 0);
  assert.equal((await call(ctx, other, `/api/reports/${reportId}/messages`, 'POST', { message: 'This should not access another member case.' })).response.status, 404);

  const unauthorizedAdminReply = await call(ctx, reporter, `/api/admin/reports/${reportId}/messages`, 'POST', { message: 'Unauthorized response.' });
  assert.equal(unauthorizedAdminReply.response.status, 403);
  const review = await call(ctx, admin, `/api/admin/reports/${reportId}/resolve`, 'POST', { status: 'in_review', response: 'We have started reviewing the information you sent.', resolution_note: 'This note must remain private.' });
  assert.equal(review.response.status, 200, JSON.stringify(review.data));
  const inReview = await call(ctx, reporter, '/api/reports');
  assert.equal(inReview.data.reports[0].status, 'in_review');
  assert.ok(inReview.data.reports[0].messages.some(message => message.author_role === 'admin' && /started reviewing/.test(message.body)));
  const privateAtReview = await call(ctx, admin, '/api/admin/dashboard');
  assert.equal(privateAtReview.data.reports.find(item => item.id === reportId).resolution_note, 'This note must remain private.');

  const followUp = await call(ctx, reporter, `/api/reports/${reportId}/messages`, 'POST', { message: 'I can provide more context about the account and the concern.' });
  assert.equal(followUp.response.status, 201, JSON.stringify(followUp.data));
  const followUpAlerts = await call(ctx, admin, '/api/notifications');
  assert.ok(followUpAlerts.data.notifications.some(note => note.type === 'report_update'));
  const resolved = await call(ctx, admin, `/api/admin/reports/${reportId}/resolve`, 'POST', { status: 'resolved', resolution_note: 'Reviewed the submitted context; no further action was taken.', response: 'Review is complete. Thank you for the additional context.' });
  assert.equal(resolved.response.status, 200);
  const closedCase = (await call(ctx, reporter, '/api/reports')).data.reports[0];
  assert.equal(closedCase.status, 'resolved');
  assert.equal(Object.hasOwn(closedCase, 'resolution_note'), false);
  assert.ok(closedCase.messages.some(message => /Review is complete/.test(message.body)));

  const appeal = await call(ctx, reporter, `/api/reports/${reportId}/messages`, 'POST', { message: 'I am requesting another review because relevant context was missed.' });
  assert.equal(appeal.response.status, 201);
  assert.equal(appeal.data.status, 'open');
  const reopened = (await call(ctx, reporter, '/api/reports')).data.reports[0];
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.resolved_at, null);
  assert.ok(reopened.history.some(item => item.from_status === 'resolved' && item.to_status === 'open'));
  const adminCase = (await call(ctx, admin, '/api/admin/dashboard')).data.reports.find(item => item.id === reportId);
  assert.equal(adminCase.resolution_note, '');
  assert.ok(adminCase.messages.some(message => /requesting another review/.test(message.body)));
});

test('existing report tables are migrated with the resolution-note field', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-hub-legacy-'));
  const dbPath = path.join(dataDir, 'hometown-hub.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE reports(id TEXT PRIMARY KEY,reporter_id TEXT NOT NULL REFERENCES users(id),target_type TEXT NOT NULL,target_id TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL,resolved_by TEXT REFERENCES users(id),resolved_at TEXT);");
  legacy.close();
  const server = createApp({ dataDir });
  t.after(() => { server.closeDatabase(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const columns = server.database.prepare('PRAGMA table_info(reports)').all().map(column => column.name);
  assert.ok(columns.includes('resolution_note'));
  const tables = server.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(tables.includes('report_messages'));
  assert.ok(tables.includes('report_status_history'));
});

test('production mode keeps transport-security headers and fails closed without Supabase', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-hub-production-'));
  const server = createApp({ dataDir, nodeEnv: 'production', env: {}, adminEmail: 'prod-admin@example.test', adminPassword: 'production-admin-password-123' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: 'prod-admin@example.test', password: 'production-admin-password-123' })
  });
  assert.equal(login.status, 503);
  assert.equal(login.headers.get('set-cookie'), null);
  assert.equal(server.database, null, 'production must never fall back to SQLite');
  assert.equal(fs.existsSync(path.join(dataDir, 'hometown-hub.sqlite')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'uploads')), false);
});
