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
});

test('community requests require platform review and member approval; moderators can pin posts', async t => {
  const ctx = await fixture(t), admin = ctx.admin, owner = { cookie: '' }, member = { cookie: '' }, outsider = { cookie: '' };
  await loginAdmin(ctx, admin);
  const ownerUser = await register(ctx, owner, 'Community Owner', 'owner@example.test');
  await register(ctx, member, 'Joining Member', 'member@example.test');
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

test('event capacity stays intact when two members RSVP simultaneously', async t => {
  const ctx = await fixture(t), admin = ctx.admin, owner = { cookie: '' }, first = { cookie: '' }, second = { cookie: '' };
  await loginAdmin(ctx, admin);
  await register(ctx, owner, 'Event Host', 'host@example.test');
  first.email = (await register(ctx, first, 'Guest One', 'guest-one@example.test')).email;
  second.email = (await register(ctx, second, 'Guest Two', 'guest-two@example.test')).email;
  const communityId = await createApprovedCommunity(ctx, owner, admin);
  await joinAndApprove(ctx, first, owner, communityId);
  await joinAndApprove(ctx, second, owner, communityId);
  const eventResult = await call(ctx, owner, '/api/events', 'POST', { community_id: communityId, title: 'Town Hall Picnic', description: 'Bring a dish to share with the community.', location: 'Community garden', starts_at: new Date(Date.now() + 86400000).toISOString(), capacity: 1 });
  assert.equal(eventResult.response.status, 201, JSON.stringify(eventResult.data));
  const eventId = eventResult.data.id;
  const results = await Promise.all([
    call(ctx, first, `/api/events/${eventId}/rsvp`, 'POST', { action: 'going' }),
    call(ctx, second, `/api/events/${eventId}/rsvp`, 'POST', { action: 'going' })
  ]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  const events = await call(ctx, owner, `/api/events?community=${communityId}`);
  assert.equal(events.data.events[0].attendee_count, 1);
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
