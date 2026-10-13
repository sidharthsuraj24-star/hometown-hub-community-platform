'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 3 * 1024 * 1024;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'hometown_session';
const DEFAULT_CATEGORIES = ['General', 'Announcements', 'Culture', 'Events', 'Local Help'];
const DEFAULT_TAGS = ['Alumni', 'Culture', 'Local Help', 'Local History', 'Food & Traditions'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const emailValue = value => text(value, 254).toLowerCase();
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const safeInt = value => Number.isInteger(Number(value)) ? Number(value) : null;

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function passwordMatches(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64);
  const target = Buffer.from(expected, 'hex');
  return target.length === actual.length && crypto.timingSafeEqual(actual, target);
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2)).filter(pair => pair.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
}
function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data');
  const uploadDir = options.uploadDir || path.join(dataDir, 'uploads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  const dbPath = options.dbPath || path.join(dataDir, 'hometown-hub.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, hometown TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS communities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL,
      category TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', rules TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships (
      community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
      PRIMARY KEY (community_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, category TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'post', image_path TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS likes (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shares (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL,
      location TEXT NOT NULL, starts_at TEXT NOT NULL, capacity INTEGER, status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rsvps (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (event_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, message TEXT NOT NULL, link TEXT NOT NULL DEFAULT '',
      read_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id), target_type TEXT NOT NULL,
      target_id TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL, resolved_by TEXT REFERENCES users(id), resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS content_categories (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS content_tags (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_communities_status ON communities(status);
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_posts_community_created ON posts(community_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_community_start ON events(community_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
  `);

  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const many = (sql, ...args) => db.prepare(sql).all(...args);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  };
  if (!one('SELECT name FROM content_categories LIMIT 1')) {
    for (const category of DEFAULT_CATEGORIES) run('INSERT OR IGNORE INTO content_categories(name, created_at) VALUES(?, ?)', category, now());
  }
  if (!one('SELECT name FROM content_tags LIMIT 1')) {
    for (const tag of DEFAULT_TAGS) run('INSERT OR IGNORE INTO content_tags(name, created_at) VALUES(?, ?)', tag, now());
  }

  const adminEmail = emailValue(options.adminEmail ?? process.env.PLATFORM_ADMIN_EMAIL ?? '');
  const adminPassword = options.adminPassword ?? process.env.PLATFORM_ADMIN_PASSWORD ?? '';
  if (adminEmail && adminPassword && validEmail(adminEmail) && adminPassword.length >= 12 && !one('SELECT id FROM users WHERE email = ?', adminEmail)) {
    const hash = passwordHash(adminPassword);
    run('INSERT INTO users(id,email,name,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)', uuid(), adminEmail, 'Platform administrator', hash.salt, hash.hash, 'admin', now());
  }

  const sessions = new Map();
  const loginAttempts = new Map();
  const isProduction = (options.nodeEnv || process.env.NODE_ENV) === 'production';
  const headers = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  };
  function send(res, status, data, extra = {}) {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(data));
  }
  function cookie(token, clear = false) {
    const bits = [`${COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
    bits.push(`Max-Age=${clear ? 0 : Math.floor(SESSION_TTL / 1000)}`);
    if (isProduction) bits.push('Secure');
    return bits.join('; ');
  }
  function sessionUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = token && sessions.get(token);
    if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); return null; }
    const user = one('SELECT id,email,name,hometown,bio,role,disabled,created_at FROM users WHERE id = ?', session.userId);
    if (!user || user.disabled) { sessions.delete(token); return null; }
    return user;
  }
  function requireUser(req) {
    const user = sessionUser(req);
    if (!user) fail(401, 'Please sign in to continue.');
    return user;
  }
  function requireAdmin(req) {
    const user = requireUser(req);
    if (user.role !== 'admin') fail(403, 'Platform administrator access is required.');
    return user;
  }
  function requireCommunity(id, user, allowPendingOwner = false) {
    const community = one('SELECT * FROM communities WHERE id = ?', id);
    if (!community) fail(404, 'Community not found.');
    if (community.status !== 'approved' && !(allowPendingOwner && (community.created_by === user.id || user.role === 'admin'))) fail(404, 'Community not found.');
    const membership = one('SELECT role,status FROM memberships WHERE community_id = ? AND user_id = ?', id, user.id);
    if (user.role !== 'admin' && (!membership || membership.status !== 'active')) fail(403, 'Join this community to continue.');
    return { community, membership };
  }
  function isModerator(communityId, user) {
    if (user.role === 'admin') return true;
    return Boolean(one("SELECT 1 FROM memberships WHERE community_id = ? AND user_id = ? AND status = 'active' AND role = 'moderator'", communityId, user.id));
  }
  function requireModerator(communityId, user) {
    if (!isModerator(communityId, user)) fail(403, 'Community moderator access is required.');
  }
  function notify(userId, type, message, link = '') {
    if (userId) run('INSERT INTO notifications(id,user_id,type,message,link,created_at) VALUES(?,?,?,?,?,?)', uuid(), userId, type, text(message, 240), text(link, 500), now());
  }
  function notifyMembers(communityId, excludeUserId, type, message, link = '') {
    const members = many("SELECT user_id FROM memberships WHERE community_id = ? AND status = 'active' AND user_id <> ?", communityId, excludeUserId || '');
    const created = now();
    const stmt = db.prepare('INSERT INTO notifications(id,user_id,type,message,link,created_at) VALUES(?,?,?,?,?,?)');
    for (const member of members) stmt.run(uuid(), member.user_id, type, text(message, 240), text(link, 500), created);
  }
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) fail(413, 'Request is too large.');
      chunks.push(chunk);
    }
    if (!size) return {};
    if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) fail(415, 'Send JSON content.');
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail(400, 'Invalid JSON request.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'A JSON object is required.');
    return value;
  }
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    try { if (new URL(origin).host !== req.headers.host) fail(403, 'Request origin was not accepted.'); }
    catch (error) { if (error instanceof HttpError) throw error; fail(403, 'Request origin was not accepted.'); }
  }
  function rateLimit(req, key) {
    const ip = req.socket.remoteAddress || 'unknown';
    const id = `${key}:${ip}`;
    const time = Date.now();
    const old = loginAttempts.get(id) || [];
    const recent = old.filter(ts => time - ts < 15 * 60 * 1000);
    if (recent.length >= 12) fail(429, 'Too many attempts. Please wait 15 minutes and try again.');
    recent.push(time); loginAttempts.set(id, recent);
  }
  function publicUser(userId) {
    return one('SELECT id,name,hometown,bio,created_at FROM users WHERE id = ?', userId);
  }
  function communitySummary(community) {
    const counts = one("SELECT COUNT(*) AS members FROM memberships WHERE community_id = ? AND status = 'active'", community.id);
    return { ...community, tags: safeJson(community.tags) || [], member_count: counts.members };
  }
  function postRecord(post, currentUser) {
    const counts = one('SELECT (SELECT COUNT(*) FROM likes WHERE post_id=?) AS likes, (SELECT COUNT(*) FROM comments WHERE post_id=?) AS comments, (SELECT COUNT(*) FROM shares WHERE post_id=?) AS shares', post.id, post.id, post.id);
    const comments = many('SELECT c.id,c.body,c.created_at,u.id AS user_id,u.name AS user_name FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.created_at ASC LIMIT 100', post.id);
    return { ...post, author_name: post.user_name, community_name: post.community_name, can_moderate: post.my_role === 'moderator' || currentUser.role === 'admin', liked_by_me: Boolean(one('SELECT 1 FROM likes WHERE post_id=? AND user_id=?', post.id, currentUser.id)), like_count: counts.likes, comment_count: counts.comments, share_count: counts.shares, comments };
  }

  async function api(req, res, url) {
    const method = req.method;
    const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
    if (!parts.length || parts[0] !== 'api') return false;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) checkOrigin(req);
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : {};

    if (method === 'GET' && parts[1] === 'health') { send(res, 200, { ok: true, service: 'hometown-hub' }); return true; }
    if (method === 'GET' && parts[1] === 'me') { send(res, 200, { user: sessionUser(req) || null }); return true; }
    if (method === 'POST' && parts[1] === 'auth' && parts[2] === 'register') {
      rateLimit(req, 'register');
      const email = emailValue(body.email), password = typeof body.password === 'string' ? body.password : '';
      const name = text(body.name, 80);
      if (!validEmail(email)) fail(400, 'Enter a valid email address.');
      if (password.length < 10 || password.length > 128) fail(400, 'Password must be 10–128 characters.');
      if (name.length < 2) fail(400, 'Enter your name.');
      if (one('SELECT id FROM users WHERE email = ?', email)) fail(409, 'An account with this email already exists.');
      const id = uuid(), pass = passwordHash(password);
      run('INSERT INTO users(id,email,name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', id, email, name, pass.salt, pass.hash, now());
      const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, { userId: id, expires: Date.now() + SESSION_TTL });
      send(res, 201, { user: publicUser(id) && { ...publicUser(id), email, role: 'user' } }, { 'Set-Cookie': cookie(token) }); return true;
    }
    if (method === 'POST' && parts[1] === 'auth' && parts[2] === 'login') {
      rateLimit(req, 'login');
      const email = emailValue(body.email), password = typeof body.password === 'string' ? body.password : '';
      const account = one('SELECT * FROM users WHERE email = ?', email);
      if (!account || account.disabled || !passwordMatches(password, account.password_salt, account.password_hash)) fail(401, 'Email or password is incorrect.');
      const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, { userId: account.id, expires: Date.now() + SESSION_TTL });
      send(res, 200, { user: { id: account.id, email: account.email, name: account.name, hometown: account.hometown, bio: account.bio, role: account.role, created_at: account.created_at } }, { 'Set-Cookie': cookie(token) }); return true;
    }
    if (method === 'POST' && parts[1] === 'auth' && parts[2] === 'logout') {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME]; if (token) sessions.delete(token);
      send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', true) }); return true;
    }
    if (method === 'GET' && parts[1] === 'meta') { send(res, 200, { categories: many('SELECT name FROM content_categories ORDER BY name').map(row => row.name), tags: many('SELECT name FROM content_tags ORDER BY name').map(row => row.name) }); return true; }
    if (method === 'POST' && parts[1] === 'profile') {
      const user = requireUser(req); const name = text(body.name, 80), hometown = text(body.hometown, 120), bio = text(body.bio, 400);
      if (name.length < 2) fail(400, 'Enter a name of at least 2 characters.');
      run('UPDATE users SET name=?, hometown=?, bio=? WHERE id=?', name, hometown, bio, user.id);
      send(res, 200, { user: { ...publicUser(user.id), email: user.email, role: user.role } }); return true;
    }

    if (method === 'GET' && parts[1] === 'communities' && parts.length === 2) {
      const user = sessionUser(req);
      const rows = user
        ? many("SELECT c.*,m.role AS my_role,m.status AS my_status FROM communities c LEFT JOIN memberships m ON m.community_id=c.id AND m.user_id=? WHERE c.status='approved' OR c.created_by=? ORDER BY CASE c.status WHEN 'approved' THEN 0 ELSE 1 END,c.name", user.id, user.id)
        : many("SELECT * FROM communities WHERE status='approved' ORDER BY name");
      send(res, 200, { communities: rows.map(communitySummary) }); return true;
    }
    if (method === 'POST' && parts[1] === 'communities' && parts.length === 2) {
      const user = requireUser(req); const name = text(body.name, 100), location = text(body.location, 120), description = text(body.description, 1200);
      const category = text(body.category, 80), tags = Array.isArray(body.tags) ? body.tags.map(tag => text(tag, 30)).filter(Boolean).slice(0, 8) : [];
      if (name.length < 3 || location.length < 2 || description.length < 20) fail(400, 'Enter a community name, location, and a description of at least 20 characters.');
      if (!one('SELECT name FROM content_categories WHERE name=?', category)) fail(400, 'Choose a valid community category.');
      if (tags.some(tag => !one('SELECT name FROM content_tags WHERE name=?', tag))) fail(400, 'Choose tags from the platform-managed tag list.');
      const id = uuid(), created = now();
      transaction(() => {
        run('INSERT INTO communities(id,name,location,description,category,tags,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, name, location, description, category, JSON.stringify(tags), 'pending', user.id, created);
        run('INSERT INTO memberships(community_id,user_id,role,status,created_at) VALUES(?,?,?,?,?)', id, user.id, 'moderator', 'active', created);
      });
      send(res, 201, { community: communitySummary(one('SELECT * FROM communities WHERE id=?', id)) }); return true;
    }
    if (method === 'GET' && parts[1] === 'communities' && parts[2] && parts.length === 3) {
      const user = sessionUser(req); const row = one('SELECT * FROM communities WHERE id=?', parts[2]);
      if (!row || (row.status !== 'approved' && (!user || (row.created_by !== user.id && user.role !== 'admin')))) fail(404, 'Community not found.');
      const membership = user ? one('SELECT role,status FROM memberships WHERE community_id=? AND user_id=?', row.id, user.id) : null;
      send(res, 200, { community: { ...communitySummary(row), my_membership: membership || null } }); return true;
    }
    if (method === 'POST' && parts[1] === 'communities' && parts[2] && parts[3] === 'join') {
      const user = requireUser(req), id = parts[2]; const community = one("SELECT id,status,created_by FROM communities WHERE id=? AND status='approved'", id);
      if (!community) fail(404, 'Community not found.');
      const old = one('SELECT status FROM memberships WHERE community_id=? AND user_id=?', id, user.id);
      if (old && old.status === 'active') fail(409, 'You are already a member.');
      if (old && old.status === 'pending') fail(409, 'Your membership request is awaiting review.');
      run('INSERT INTO memberships(community_id,user_id,role,status,created_at) VALUES(?,?,?,?,?) ON CONFLICT(community_id,user_id) DO UPDATE SET role=\'member\',status=\'pending\',created_at=excluded.created_at', id, user.id, 'member', 'pending', now());
      const mods = many("SELECT user_id FROM memberships WHERE community_id=? AND role='moderator' AND status='active'", id);
      for (const mod of mods) notify(mod.user_id, 'membership_request', `${user.name} requested to join ${one('SELECT name FROM communities WHERE id=?', id).name}.`, `/?community=${id}`);
      send(res, 201, { status: 'pending' }); return true;
    }
    if (method === 'POST' && parts[1] === 'communities' && parts[2] && parts[3] === 'rules') {
      const user = requireUser(req), id = parts[2]; requireModerator(id, user);
      const rules = text(body.rules, 3000); run('UPDATE communities SET rules=? WHERE id=?', rules, id);
      send(res, 200, { rules }); return true;
    }
    if (method === 'GET' && parts[1] === 'communities' && parts[2] && parts[3] === 'requests') {
      const user = requireUser(req), id = parts[2]; requireModerator(id, user);
      send(res, 200, { requests: many("SELECT u.id,u.name,u.email,u.hometown,m.created_at AS requested_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.community_id=? AND m.status='pending' ORDER BY m.created_at", id) }); return true;
    }
    if (method === 'POST' && parts[1] === 'communities' && parts[2] && parts[3] === 'requests' && parts[4]) {
      const user = requireUser(req), communityId = parts[2], targetUser = parts[4]; requireModerator(communityId, user);
      const action = body.action;
      if (!['approve', 'reject'].includes(action)) fail(400, 'Choose approve or reject.');
      const pending = one("SELECT status FROM memberships WHERE community_id=? AND user_id=? AND status='pending'", communityId, targetUser);
      if (!pending) fail(404, 'Membership request not found.');
      if (action === 'approve') run("UPDATE memberships SET status='active' WHERE community_id=? AND user_id=?", communityId, targetUser);
      else run("UPDATE memberships SET status='rejected' WHERE community_id=? AND user_id=?", communityId, targetUser);
      const communityName = one('SELECT name FROM communities WHERE id=?', communityId).name;
      notify(targetUser, 'membership_decision', action === 'approve' ? `Your request to join ${communityName} was approved.` : `Your request to join ${communityName} was declined.`, `/?community=${communityId}`);
      send(res, 200, { ok: true }); return true;
    }

    if (method === 'GET' && parts[1] === 'feed') {
      const user = requireUser(req), communityId = url.searchParams.get('community');
      let posts;
      if (communityId) {
        requireCommunity(communityId, user);
        posts = many("SELECT p.*,u.name AS user_name,c.name AS community_name,m.role AS my_role FROM posts p JOIN users u ON u.id=p.user_id JOIN communities c ON c.id=p.community_id LEFT JOIN memberships m ON m.community_id=p.community_id AND m.user_id=? AND m.status='active' WHERE p.community_id=? ORDER BY p.pinned DESC,p.created_at DESC LIMIT 100", user.id, communityId);
      } else {
        posts = many("SELECT p.*,u.name AS user_name,c.name AS community_name FROM posts p JOIN users u ON u.id=p.user_id JOIN communities c ON c.id=p.community_id JOIN memberships m ON m.community_id=p.community_id AND m.user_id=? AND m.status='active' WHERE c.status='approved' ORDER BY p.pinned DESC,p.created_at DESC LIMIT 100", user.id);
      }
      send(res, 200, { posts: posts.map(post => postRecord(post, user)) }); return true;
    }
    if (method === 'POST' && parts[1] === 'posts' && parts.length === 2) {
      const user = requireUser(req); const communityId = text(body.community_id, 64), content = text(body.body, 4000);
      const kind = body.kind === 'announcement' ? 'announcement' : 'post';
      const category = text(body.category, 80);
      if (content.length < 1) fail(400, 'Write something before posting.');
      const { community } = requireCommunity(communityId, user);
      if (!one('SELECT name FROM content_categories WHERE name=?', category)) fail(400, 'Choose a valid category.');
      let imagePath = '';
      if (body.image) {
        if (typeof body.image !== 'string' || body.image.length > 2_100_000) fail(413, 'Image must be 1.5 MB or smaller.');
        const match = body.image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!match) fail(400, 'Upload a PNG, JPEG, or WebP image.');
        const buffer = Buffer.from(match[2], 'base64');
        if (buffer.length > 1_500_000) fail(413, 'Image must be 1.5 MB or smaller.');
        const signatures = { 'image/png': buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'image/jpeg': buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff, 'image/webp': buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' };
        if (!signatures[match[1]]) fail(400, 'The image file format could not be verified.');
        const ext = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
        const filename = `${uuid()}.${ext}`; fs.writeFileSync(path.join(uploadDir, filename), buffer, { flag: 'wx' }); imagePath = `/uploads/${filename}`;
      }
      const id = uuid();
      run('INSERT INTO posts(id,community_id,user_id,body,category,kind,image_path,created_at) VALUES(?,?,?,?,?,?,?,?)', id, communityId, user.id, content, category, kind, imagePath, now());
      notifyMembers(communityId, user.id, kind, `${user.name} shared ${kind === 'announcement' ? 'an announcement' : 'a post'} in ${community.name}.`, `/?community=${communityId}#post-${id}`);
      send(res, 201, { id }); return true;
    }
    if (method === 'POST' && parts[1] === 'posts' && parts[2] && parts[3] === 'comments') {
      const user = requireUser(req), post = one('SELECT * FROM posts WHERE id=?', parts[2]);
      if (!post) fail(404, 'Post not found.'); requireCommunity(post.community_id, user);
      const content = text(body.body, 1200); if (!content) fail(400, 'Write a comment first.');
      const id = uuid(); run('INSERT INTO comments(id,post_id,user_id,body,created_at) VALUES(?,?,?,?,?)', id, post.id, user.id, content, now());
      if (post.user_id !== user.id) notify(post.user_id, 'comment', `${user.name} commented on your post.`, `/?community=${post.community_id}#post-${post.id}`);
      send(res, 201, { id }); return true;
    }
    if (method === 'POST' && parts[1] === 'posts' && parts[2] && parts[3] === 'like') {
      const user = requireUser(req), post = one('SELECT * FROM posts WHERE id=?', parts[2]);
      if (!post) fail(404, 'Post not found.'); requireCommunity(post.community_id, user);
      const exists = one('SELECT 1 FROM likes WHERE post_id=? AND user_id=?', post.id, user.id);
      if (exists) run('DELETE FROM likes WHERE post_id=? AND user_id=?', post.id, user.id);
      else { run('INSERT INTO likes(post_id,user_id,created_at) VALUES(?,?,?)', post.id, user.id, now()); if (post.user_id !== user.id) notify(post.user_id, 'like', `${user.name} liked your post.`, `/?community=${post.community_id}#post-${post.id}`); }
      send(res, 200, { liked: !exists }); return true;
    }
    if (method === 'POST' && parts[1] === 'posts' && parts[2] && parts[3] === 'share') {
      const user = requireUser(req), post = one('SELECT * FROM posts WHERE id=?', parts[2]);
      if (!post) fail(404, 'Post not found.'); requireCommunity(post.community_id, user);
      run('INSERT OR IGNORE INTO shares(post_id,user_id,created_at) VALUES(?,?,?)', post.id, user.id, now());
      send(res, 200, { url: `/?community=${post.community_id}#post-${post.id}` }); return true;
    }
    if (method === 'POST' && parts[1] === 'posts' && parts[2] && parts[3] === 'pin') {
      const user = requireUser(req), post = one('SELECT * FROM posts WHERE id=?', parts[2]);
      if (!post) fail(404, 'Post not found.'); requireModerator(post.community_id, user);
      run('UPDATE posts SET pinned=? WHERE id=?', body.pinned ? 1 : 0, post.id); send(res, 200, { pinned: Boolean(body.pinned) }); return true;
    }
    if (method === 'DELETE' && parts[1] === 'posts' && parts[2]) {
      const user = requireUser(req), post = one('SELECT * FROM posts WHERE id=?', parts[2]);
      if (!post) fail(404, 'Post not found.'); if (post.user_id !== user.id) requireModerator(post.community_id, user);
      if (post.image_path) { const filename = path.basename(post.image_path); try { fs.unlinkSync(path.join(uploadDir, filename)); } catch {} }
      run('DELETE FROM posts WHERE id=?', post.id); send(res, 200, { ok: true }); return true;
    }
    if (method === 'DELETE' && parts[1] === 'comments' && parts[2]) {
      const user = requireUser(req), comment = one('SELECT c.*,p.community_id FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=?', parts[2]);
      if (!comment) fail(404, 'Comment not found.'); if (comment.user_id !== user.id) requireModerator(comment.community_id, user);
      run('DELETE FROM comments WHERE id=?', comment.id); send(res, 200, { ok: true }); return true;
    }

    if (method === 'GET' && parts[1] === 'events') {
      const user = requireUser(req), communityId = url.searchParams.get('community');
      let rows;
      if (communityId) { requireCommunity(communityId, user); rows = many("SELECT e.*,c.name AS community_name,u.name AS creator_name,m.role AS my_role,(SELECT COUNT(*) FROM rsvps r WHERE r.event_id=e.id AND r.status='going') AS attendee_count,(SELECT status FROM rsvps r WHERE r.event_id=e.id AND r.user_id=?) AS my_rsvp FROM events e JOIN communities c ON c.id=e.community_id JOIN users u ON u.id=e.created_by LEFT JOIN memberships m ON m.community_id=e.community_id AND m.user_id=? AND m.status='active' WHERE e.community_id=? ORDER BY e.starts_at ASC", user.id, user.id, communityId); }
      else { rows = many("SELECT e.*,c.name AS community_name,u.name AS creator_name,m.role AS my_role,(SELECT COUNT(*) FROM rsvps r WHERE r.event_id=e.id AND r.status='going') AS attendee_count,(SELECT status FROM rsvps r WHERE r.event_id=e.id AND r.user_id=?) AS my_rsvp FROM events e JOIN communities c ON c.id=e.community_id JOIN users u ON u.id=e.created_by JOIN memberships m ON m.community_id=e.community_id AND m.user_id=? AND m.status='active' WHERE c.status='approved' ORDER BY e.starts_at ASC LIMIT 100", user.id, user.id); }
      send(res, 200, { events: rows }); return true;
    }
    if (method === 'POST' && parts[1] === 'events' && parts.length === 2) {
      const user = requireUser(req), communityId = text(body.community_id, 64), title = text(body.title, 120), description = text(body.description, 1500), location = text(body.location, 160);
      const { community } = requireCommunity(communityId, user);
      const eventDate = new Date(body.starts_at);
      if (typeof body.starts_at !== 'string' || !Number.isFinite(eventDate.getTime())) fail(400, 'Enter a valid event date and time.');
      const startsAt = eventDate.toISOString();
      if (eventDate.getTime() <= Date.now()) fail(400, 'Choose a future event date and time.');
      if (title.length < 3 || description.length < 10 || location.length < 2) fail(400, 'Add an event title, description, and location.');
      let capacity = null;
      if (body.capacity !== '' && body.capacity != null) {
        capacity = safeInt(body.capacity);
        if (capacity === null || capacity < 1 || capacity > 100000) fail(400, 'Capacity must be a whole number between 1 and 100,000, or left blank.');
      }
      const id = uuid(); run('INSERT INTO events(id,community_id,created_by,title,description,location,starts_at,capacity,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, communityId, user.id, title, description, location, startsAt, capacity, now());
      notifyMembers(communityId, user.id, 'event', `${user.name} created an event in ${community.name}: ${title}.`, `/?event=${id}`);
      send(res, 201, { id }); return true;
    }
    if (method === 'POST' && parts[1] === 'events' && parts[2] && parts[3] === 'rsvp') {
      const user = requireUser(req), eventId = parts[2], action = body.action;
      const event = one("SELECT * FROM events WHERE id=? AND status='open'", eventId); if (!event) fail(404, 'Open event not found.');
      requireCommunity(event.community_id, user);
      if (!['going', 'cancel'].includes(action)) fail(400, 'Choose going or cancel.');
      transaction(() => {
        if (action === 'cancel') run('DELETE FROM rsvps WHERE event_id=? AND user_id=?', eventId, user.id);
        else {
          const existing = one("SELECT status FROM rsvps WHERE event_id=? AND user_id=?", eventId, user.id);
          if (!existing && event.capacity !== null) {
            const count = one("SELECT COUNT(*) AS n FROM rsvps WHERE event_id=? AND status='going'", eventId).n;
            if (count >= event.capacity) fail(409, 'This event has reached its capacity.');
          }
          run("INSERT INTO rsvps(event_id,user_id,status,created_at) VALUES(?,?, 'going', ?) ON CONFLICT(event_id,user_id) DO UPDATE SET status='going',created_at=excluded.created_at", eventId, user.id, now());
        }
      });
      send(res, 200, { status: action === 'going' ? 'going' : 'not_going' }); return true;
    }
    if (method === 'DELETE' && parts[1] === 'events' && parts[2]) {
      const user = requireUser(req), event = one('SELECT * FROM events WHERE id=?', parts[2]); if (!event) fail(404, 'Event not found.');
      if (event.created_by !== user.id) requireModerator(event.community_id, user);
      run("UPDATE events SET status='cancelled' WHERE id=?", event.id); send(res, 200, { ok: true }); return true;
    }

    if (method === 'GET' && parts[1] === 'notifications') {
      const user = requireUser(req);
      send(res, 200, { notifications: many('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', user.id), unread_count: one('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL', user.id).n }); return true;
    }
    if (method === 'POST' && parts[1] === 'notifications' && parts[2] === 'read') {
      const user = requireUser(req);
      if (parts[3]) run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?', now(), parts[3], user.id);
      else run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', now(), user.id);
      send(res, 200, { ok: true }); return true;
    }

    if (method === 'POST' && parts[1] === 'reports') {
      const user = requireUser(req), targetType = text(body.target_type, 20), targetId = text(body.target_id, 64), reason = text(body.reason, 1000);
      if (!['user', 'post', 'comment', 'community'].includes(targetType) || !targetId || reason.length < 10) fail(400, 'Choose content to report and describe the issue in at least 10 characters.');
      const exists = targetType === 'user' ? one('SELECT id FROM users WHERE id=?', targetId) : targetType === 'post' ? one('SELECT id FROM posts WHERE id=?', targetId) : targetType === 'comment' ? one('SELECT id FROM comments WHERE id=?', targetId) : one('SELECT id FROM communities WHERE id=?', targetId);
      if (!exists) fail(404, 'The reported item was not found.');
      const id = uuid(); run('INSERT INTO reports(id,reporter_id,target_type,target_id,reason,created_at) VALUES(?,?,?,?,?,?)', id, user.id, targetType, targetId, reason, now());
      send(res, 201, { id }); return true;
    }

    if (method === 'GET' && parts[1] === 'admin' && parts[2] === 'dashboard') {
      requireAdmin(req);
      const counts = {
        users: one('SELECT COUNT(*) AS n FROM users WHERE role <> \'admin\'').n,
        communities: one("SELECT COUNT(*) AS n FROM communities WHERE status='approved'").n,
        pending_communities: one("SELECT COUNT(*) AS n FROM communities WHERE status='pending'").n,
        posts: one('SELECT COUNT(*) AS n FROM posts').n,
        upcoming_events: one("SELECT COUNT(*) AS n FROM events WHERE status='open' AND starts_at > ?", now()).n,
        open_reports: one("SELECT COUNT(*) AS n FROM reports WHERE status='open'").n
      };
      const communities = many("SELECT c.*,u.name AS creator_name FROM communities c JOIN users u ON u.id=c.created_by WHERE c.status='pending' ORDER BY c.created_at",);
      const users = many('SELECT id,email,name,hometown,role,disabled,created_at FROM users ORDER BY created_at DESC LIMIT 100');
      const reports = many("SELECT r.*,u.name AS reporter_name FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 100");
      const moderators = many("SELECT m.community_id,m.user_id,m.created_at,u.name AS user_name,c.name AS community_name FROM memberships m JOIN users u ON u.id=m.user_id JOIN communities c ON c.id=m.community_id WHERE m.role='moderator' AND m.status='active'");
      const memberships = many("SELECT m.community_id,m.user_id,m.role,m.created_at,u.name AS user_name,c.name AS community_name FROM memberships m JOIN users u ON u.id=m.user_id JOIN communities c ON c.id=m.community_id WHERE m.status='active' AND c.status='approved' ORDER BY c.name,u.name");
      send(res, 200, { counts, communities: communities.map(communitySummary), users, reports, categories: many('SELECT name,created_at FROM content_categories ORDER BY name'), tags: many('SELECT name,created_at FROM content_tags ORDER BY name'), moderators, memberships }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'communities' && parts[3] && parts[4] === 'review') {
      const admin = requireAdmin(req), action = body.action, id = parts[3];
      if (!['approve', 'reject'].includes(action)) fail(400, 'Choose approve or reject.');
      const community = one("SELECT * FROM communities WHERE id=? AND status='pending'", id); if (!community) fail(404, 'Pending community not found.');
      run('UPDATE communities SET status=? WHERE id=?', action === 'approve' ? 'approved' : 'rejected', id);
      notify(community.created_by, 'community_review', action === 'approve' ? `${community.name} has been approved.` : `${community.name} was not approved.`, `/?community=${id}`);
      send(res, 200, { ok: true }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'communities' && parts[3] && parts[4] === 'members' && parts[5] && parts[6] === 'role') {
      requireAdmin(req); const communityId = parts[3], userId = parts[5], role = body.role;
      if (!['member', 'moderator'].includes(role)) fail(400, 'Choose member or moderator.');
      const member = one("SELECT status FROM memberships WHERE community_id=? AND user_id=?", communityId, userId);
      if (!member || member.status !== 'active') fail(404, 'Active community membership not found.');
      run('UPDATE memberships SET role=? WHERE community_id=? AND user_id=?', role, communityId, userId); send(res, 200, { ok: true }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'users' && parts[3] && parts[4] === 'status') {
      const admin = requireAdmin(req), target = one('SELECT id,role,disabled FROM users WHERE id=?', parts[3]);
      if (!target) fail(404, 'User not found.'); if (target.id === admin.id || target.role === 'admin') fail(400, 'Platform administrator accounts cannot be disabled here.');
      const disabled = body.disabled ? 1 : 0; run('UPDATE users SET disabled=? WHERE id=?', disabled, target.id);
      if (disabled) for (const [token, session] of sessions) if (session.userId === target.id) sessions.delete(token);
      send(res, 200, { disabled: Boolean(disabled) }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'reports' && parts[3] && parts[4] === 'resolve') {
      const admin = requireAdmin(req), report = one('SELECT * FROM reports WHERE id=?', parts[3]); if (!report) fail(404, 'Report not found.');
      const status = body.status === 'dismissed' ? 'dismissed' : 'resolved';
      run('UPDATE reports SET status=?,resolved_by=?,resolved_at=? WHERE id=?', status, admin.id, now(), report.id); send(res, 200, { status }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'categories') {
      requireAdmin(req); const name = text(body.name, 40);
      if (name.length < 2) fail(400, 'Category name must be at least 2 characters.');
      try { run('INSERT INTO content_categories(name,created_at) VALUES(?,?)', name, now()); }
      catch { fail(409, 'That category already exists.'); }
      send(res, 201, { name }); return true;
    }
    if (method === 'DELETE' && parts[1] === 'admin' && parts[2] === 'categories' && parts[3]) {
      requireAdmin(req); if (parts[3] === 'General') fail(400, 'The General category cannot be removed.');
      run('DELETE FROM content_categories WHERE name=?', parts[3]); send(res, 200, { ok: true }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'tags') {
      requireAdmin(req); const name = text(body.name, 30);
      if (name.length < 2) fail(400, 'Tag must be at least 2 characters.');
      try { run('INSERT INTO content_tags(name,created_at) VALUES(?,?)', name, now()); }
      catch { fail(409, 'That tag already exists.'); }
      send(res, 201, { name }); return true;
    }
    if (method === 'DELETE' && parts[1] === 'admin' && parts[2] === 'tags' && parts[3]) {
      requireAdmin(req); run('DELETE FROM content_tags WHERE name=?', parts[3]); send(res, 200, { ok: true }); return true;
    }
    send(res, 404, { error: 'API route not found.' }); return true;
  }

  const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
  function serveStatic(req, res, url) {
    let filename;
    if (url.pathname.startsWith('/uploads/')) {
      const basename = path.basename(url.pathname);
      if (!/^[a-f0-9-]+\.(?:png|jpg|webp)$/i.test(basename)) { res.writeHead(404, headers); res.end('Not found'); return; }
      filename = path.join(uploadDir, basename);
    } else {
      const map = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/app.js': 'app.js', '/favicon.svg': 'favicon.svg' };
      if (!map[url.pathname]) { res.writeHead(404, headers); res.end('Not found'); return; }
      filename = path.join(PUBLIC_DIR, map[url.pathname]);
    }
    try {
      const data = fs.readFileSync(filename);
      const cacheControl = url.pathname.startsWith('/uploads/') ? 'private, no-store' : url.pathname === '/' ? 'no-cache' : 'public, max-age=3600';
      res.writeHead(200, { ...headers, 'Content-Type': mimeTypes[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': cacheControl });
      res.end(data);
    } catch { res.writeHead(404, headers); res.end('Not found'); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) { await api(req, res, url); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers); res.end('Method not allowed'); return; }
      if (url.pathname.startsWith('/uploads/')) {
        const imagePost = one('SELECT community_id FROM posts WHERE image_path=?', url.pathname);
        const viewer = sessionUser(req);
        const allowed = imagePost && viewer && (viewer.role === 'admin' || Boolean(one("SELECT 1 FROM memberships m JOIN communities c ON c.id=m.community_id WHERE m.community_id=? AND m.user_id=? AND m.status='active' AND c.status='approved'", imagePost.community_id, viewer.id)));
        if (!allowed) { res.writeHead(404, headers); res.end('Not found'); return; }
      }
      serveStatic(req, res, url);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) console.error(error);
      send(res, status, { error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.' });
    }
  });
  server.database = db;
  server.closeDatabase = () => db.close();
  server.appOptions = { dataDir, uploadDir, dbPath };
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const server = createApp();
  server.listen(port, host, () => {
    console.log(`Hometown Hub is listening on http://${host}:${port}`);
    if (!process.env.PLATFORM_ADMIN_EMAIL || !process.env.PLATFORM_ADMIN_PASSWORD) console.warn('Platform admin bootstrap is disabled. Set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD (12+ chars) before first launch to initialize an admin account.');
  });
  const shutdown = () => server.close(() => { server.closeDatabase(); process.exit(0); });
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

module.exports = { createApp, passwordHash, passwordMatches };
