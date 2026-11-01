'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-hub-nfr-'));
  const server = createApp({ dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { base, server };
}

async function call(ctx, client, url, method = 'GET', body) {
  const headers = {};
  if (client.cookie) headers.Cookie = client.cookie;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers.Origin = ctx.base;
  }
  const response = await fetch(`${ctx.base}${url}`, {
    method,
    headers,
    ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {})
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) client.cookie = setCookie.split(';')[0];
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function register(ctx, client, name, email, password = 'member-password-123') {
  const signup = await call(ctx, client, '/api/auth/register', 'POST', { name, email, password });
  assert.equal(signup.response.status, 202, JSON.stringify(signup.data));
  assert.equal(signup.response.headers.get('set-cookie'), null);
  const result = await call(ctx, client, '/api/auth/login', 'POST', { email, password });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return result.data.user;
}

test('city, village, and region values are accepted and retained independently', async t => {
  const ctx = await fixture(t);
  const member = { cookie: '' };
  await register(ctx, member, 'Locality Test Member', 'locality@example.test');

  const profile = await call(ctx, member, '/api/profile', 'POST', {
    name: 'Locality Test Member',
    hometown: 'Village test locality, District test',
    bio: 'Disposable test profile for locality coverage.'
  });
  assert.equal(profile.response.status, 200, JSON.stringify(profile.data));
  assert.equal(profile.data.user.hometown, 'Village test locality, District test');

  const localities = [
    'City test locality, Region test',
    'Village test locality, District test',
    'Remote region test locality'
  ];
  for (const [index, location] of localities.entries()) {
    const created = await call(ctx, member, '/api/communities', 'POST', {
      name: `Locality community ${index + 1}`,
      location,
      description: 'Disposable test community proving location values remain distinct.',
      category: 'General'
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.community.location, location);
  }

  const directory = await call(ctx, member, '/api/communities');
  assert.equal(directory.response.status, 200);
  assert.deepEqual(
    directory.data.communities.map(community => community.location).sort(),
    localities.slice().sort()
  );
});

test('account privacy and session safeguards are enforced', async t => {
  const ctx = await fixture(t);
  const member = { cookie: '' };
  const password = 'member-password-123';
  const user = await register(ctx, member, 'Secure Test Member', 'secure@example.test', password);
  const stored = ctx.server.database.prepare('SELECT password_salt,password_hash FROM users WHERE id=?').get(user.id);

  assert.ok(stored.password_salt);
  assert.notEqual(stored.password_hash, password, 'the password is not stored as plaintext');
  assert.match(stored.password_hash, /^[a-f0-9]{128}$/i, 'stored password is a 64-byte scrypt hash');
  assert.equal(Object.hasOwn(user, 'password_hash'), false);
  assert.equal(Object.hasOwn(user, 'password_salt'), false);
  assert.match(member.cookie, /^hometown_session=.+/);
  const setCookie = (await call(ctx, { cookie: '' }, '/api/auth/login', 'POST', {
    email: 'secure@example.test', password
  })).response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const crossOrigin = await fetch(`${ctx.base}/api/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid', Cookie: member.cookie },
    body: JSON.stringify({ name: 'Changed Name', hometown: 'Changed Place', bio: '' })
  });
  assert.equal(crossOrigin.status, 403);
  const unchanged = ctx.server.database.prepare('SELECT name,hometown FROM users WHERE id=?').get(user.id);
  assert.equal(unchanged.name, 'Secure Test Member');
  assert.equal(unchanged.hometown, '');

  const logout = await call(ctx, member, '/api/auth/logout', 'POST', {});
  assert.equal(logout.response.status, 200);
  const me = await call(ctx, member, '/api/me');
  assert.equal(me.data.user, null, 'logout invalidates the server-side session');
  const denied = await call(ctx, member, '/api/profile', 'POST', { name: 'No Session', hometown: '', bio: '' });
  assert.equal(denied.response.status, 401);
});

test('registration attempts are throttled after twelve requests per client address', async t => {
  const ctx = await fixture(t);
  const statuses = [];
  for (let attempt = 0; attempt < 13; attempt += 1) {
    const response = await fetch(`${ctx.base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ctx.base },
      body: JSON.stringify({ name: 'Test Member', email: 'not-an-email', password: 'member-password-123' })
    });
    statuses.push(response.status);
    await response.arrayBuffer();
  }
  assert.deepEqual(statuses.slice(0, 12), Array(12).fill(400));
  assert.equal(statuses[12], 429);
});
