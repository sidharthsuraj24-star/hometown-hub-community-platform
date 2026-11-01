'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { createFetchHandler } = require('./lib/fetch-handler');
const { initializePanditSchema, createPanditRoutes } = require('./lib/pandit-onboarding');
const { createPanditRetentionWorker } = require('./lib/pandit-retention-worker');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 3 * 1024 * 1024;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'hometown_session';
const DEFAULT_CATEGORIES = ['General', 'Announcements', 'Culture', 'Events', 'Local Help'];
const DEFAULT_TAGS = ['Alumni', 'Culture', 'Local Help', 'Local History', 'Food & Traditions'];
const REGISTRATION_NOTICE = 'If an account can be created with these details, sign in with this email and password. If you already have an account, use the password you previously set.';

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
function strictBoolean(value, label) {
  if (typeof value !== 'boolean') fail(400, `${label} must be true or false.`);
  return value;
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function passwordMatches(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64);
  const target = Buffer.from(expected, 'hex');
  return target.length === actual.length && crypto.timingSafeEqual(actual, target);
}
const DUMMY_LOGIN_HASH = passwordHash('hometown-hub-login-timing-placeholder');
function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const pair = part.trim().split(/=(.*)/s).slice(0, 2);
    if (pair.length !== 2) continue;
    try { cookies[pair[0]] = decodeURIComponent(pair[1]); } catch { cookies[pair[0]] = ''; }
  }
  return cookies;
}
function safeJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function createApp(options = {}) {
  const env = options.env || process.env;
  const isProduction = (options.nodeEnv || env.NODE_ENV) === 'production';
  const { createProductionAdapter, requiredProductionEnv } = require('./lib/production-adapter');
  const productionMissing = isProduction ? requiredProductionEnv(env) : [];
  const adminEmail = emailValue(options.adminEmail ?? env.PLATFORM_ADMIN_EMAIL ?? '');
  const adminPassword = options.adminPassword ?? env.PLATFORM_ADMIN_PASSWORD ?? '';
  const adminConfigValid = Boolean(adminEmail && adminPassword && validEmail(adminEmail) && adminPassword.length >= 12);
  let db = null;
  let adapter = null;
  let backendError = null;
  let dataDir;
  let uploadDir;
  let dbPath;
  if (isProduction) {
    dataDir = options.dataDir || env.DATA_DIR || null; uploadDir = null; dbPath = null;
    if (productionMissing.length) backendError = Object.assign(new Error(`Production backend is not configured: missing ${productionMissing.join(', ')}`), { code: 'PRODUCTION_BACKEND_NOT_CONFIGURED' });
    else {
      try { adapter = createProductionAdapter({ env }); }
      catch (error) { backendError = error; }
    }
  } else {
    dataDir = options.dataDir || env.DATA_DIR || path.join(ROOT, 'data');
    uploadDir = options.uploadDir || path.join(dataDir, 'uploads');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(uploadDir, { recursive: true });
    dbPath = options.dbPath || path.join(dataDir, 'hometown-hub.sqlite');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, hometown TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS communities (id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', rules TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, PRIMARY KEY (community_id,user_id));
      CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'post', image_path TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS likes (post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(post_id,user_id));
      CREATE TABLE IF NOT EXISTS shares (post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(post_id,user_id));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE, created_by TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL, location TEXT NOT NULL, starts_at TEXT NOT NULL, capacity INTEGER, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rsvps (event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(event_id,user_id));
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, message TEXT NOT NULL, link TEXT NOT NULL DEFAULT '', read_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id), target_type TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, resolved_by TEXT REFERENCES users(id), resolved_at TEXT, resolution_note TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS report_messages (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_status_history (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, actor_id TEXT NOT NULL REFERENCES users(id), from_status TEXT NOT NULL, to_status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_activity (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, activity_day TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY(user_id,activity_day));
      CREATE TABLE IF NOT EXISTS content_categories(name TEXT PRIMARY KEY, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS content_tags(name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_communities_status ON communities(status); CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id,status); CREATE INDEX IF NOT EXISTS idx_posts_community_created ON posts(community_id,created_at DESC); CREATE INDEX IF NOT EXISTS idx_events_community_start ON events(community_id,starts_at); CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at DESC); CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status,created_at DESC); CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments(post_id,created_at); CREATE INDEX IF NOT EXISTS idx_rsvps_event_status ON rsvps(event_id,status); CREATE INDEX IF NOT EXISTS idx_activity_day ON user_activity(activity_day,user_id);
    `);
    initializePanditSchema(db);
    // Evidence is kept inside this non-public local database, never public uploads.
    fs.chmodSync(dbPath, 0o600);
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(dbPath + suffix)) fs.chmodSync(dbPath + suffix, 0o600);
    const reportColumns = db.prepare('PRAGMA table_info(reports)').all(); if (!reportColumns.some(column => column.name === 'resolution_note')) db.exec("ALTER TABLE reports ADD COLUMN resolution_note TEXT NOT NULL DEFAULT ''");
    db.prepare('DELETE FROM user_activity WHERE activity_day < ?').run(new Date(Date.now()-89*24*60*60*1000).toISOString().slice(0,10));
  }
  const run = async (sql, ...args) => adapter ? adapter.run(sql, ...args) : db.prepare(sql).run(...args);
  const one = async (sql, ...args) => adapter ? adapter.one(sql, ...args) : db.prepare(sql).get(...args);
  const many = async (sql, ...args) => adapter ? adapter.many(sql, ...args) : db.prepare(sql).all(...args);
  const transaction = async fn => { if (adapter) return adapter.transaction(fn); db.exec('BEGIN IMMEDIATE'); try { const result = await fn({run,one,many}); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } };
  if (db) { if (!db.prepare('SELECT name FROM content_categories LIMIT 1').get()) for (const category of DEFAULT_CATEGORIES) db.prepare('INSERT OR IGNORE INTO content_categories(name,created_at) VALUES(?,?)').run(category, now()); if (!db.prepare('SELECT name FROM content_tags LIMIT 1').get()) for (const tag of DEFAULT_TAGS) db.prepare('INSERT OR IGNORE INTO content_tags(name,created_at) VALUES(?,?)').run(tag, now()); if (adminConfigValid && !db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail)) { const hash=passwordHash(adminPassword); db.prepare('INSERT INTO users(id,email,name,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)').run(uuid(),adminEmail,'Platform administrator',hash.salt,hash.hash,'admin',now()); } }
  if (db && adminConfigValid) initializePanditSchema(db, adminEmail);
  let adminBootstrapPromise = null;
  const backendReady = async () => {
    if (backendError) fail(503, 'The production backend is not configured.');
    if (isProduction && !adminConfigValid) fail(503, 'Account registration is temporarily unavailable until platform administration is configured.');
    if (isProduction) {
      if (!adminBootstrapPromise) {
        const hash = passwordHash(adminPassword);
        adminBootstrapPromise = adapter.ensureAdmin({ id: uuid(), email: adminEmail, passwordSalt: hash.salt, passwordHash: hash.hash, createdAt: now() }).catch(error => {
          adminBootstrapPromise = null;
          throw error;
        });
      }
      try { await adminBootstrapPromise; }
      catch (error) {
        const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : 'Error';
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'NO_CODE';
        console.error('hometown_hub_admin_bootstrap_failure', `${name}:${code}`);
        fail(503, error.code === 'ADMIN_BOOTSTRAP_CONFLICT' ? 'The configured platform administrator cannot be initialized safely.' : 'The production backend is not available.');
      }
    }
  };
  const sessions = isProduction ? null : new Map();
  const rateLimitAttempts = isProduction ? null : new Map();
  let lastRateSweep = 0;
  const headers = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'X-DNS-Prefetch-Control': 'off', 'X-Permitted-Cross-Domain-Policies': 'none',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...(isProduction ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {})
  };
  function send(res, status, data, extra = {}) {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(data));
  }
  function logUnexpected(error) {
    // Never log exception messages/SQL: they can contain private evidence or applicant text.
    const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : 'Error';
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(error.code) ? error.code : 'NO_CODE';
    console.error('hometown_hub_request_failure', `${name}:${code}`);
  }
  function cookie(token, clear = false) {
    const bits = [`${COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
    bits.push(`Max-Age=${clear ? 0 : Math.floor(SESSION_TTL / 1000)}`);
    if (isProduction) bits.push('Secure');
    return bits.join('; ');
  }
  async function recordActivity(user) {
    if (!user || user.role === 'admin') return;
    const seenAt = now();
    await run('INSERT INTO user_activity(user_id,activity_day,last_seen_at) VALUES(?,?,?) ON CONFLICT(user_id,activity_day) DO UPDATE SET last_seen_at=excluded.last_seen_at', user.id, seenAt.slice(0, 10), seenAt);
  }
  async function sessionUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (isProduction) { const user = await adapter.sessionUser(token); if (user) await recordActivity(user); return user; }
    const session = token && sessions.get(token);
    if (!session || session.expires < Date.now()) { if (token) { if (isProduction) await adapter.revokeSession(token); else sessions.delete(token); } return null; }
    const user = await one('SELECT id,email,name,hometown,bio,role,disabled,created_at FROM users WHERE id = ?', session.userId);
    if (!user || user.disabled) { sessions.delete(token); return null; }
    await recordActivity(user);
    return user;
  }
  async function requireUser(req) {
    const user = await sessionUser(req);
    if (!user) fail(401, 'Please sign in to continue.');
    return user;
  }
  async function requireAdmin(req) {
    const user = await requireUser(req);
    if (user.role !== 'admin') fail(403, 'Platform administrator access is required.');
    return user;
  }
  async function requireCommunity(id, user, allowPendingOwner = false) {
    const community = await one('SELECT * FROM communities WHERE id = ?', id);
    if (!community) fail(404, 'Community not found.');
    if (community.status !== 'approved' && !(allowPendingOwner && (community.created_by === user.id || user.role === 'admin'))) fail(404, 'Community not found.');
    const membership = await one('SELECT role,status FROM memberships WHERE community_id = ? AND user_id = ?', id, user.id);
    if (user.role !== 'admin' && (!membership || membership.status !== 'active')) fail(403, 'Join this community to continue.');
    return { community, membership };
  }
  async function isModerator(communityId, user) {
    if (user.role === 'admin') return true;
    return Boolean(await one("SELECT 1 FROM memberships WHERE community_id = ? AND user_id = ? AND status = 'active' AND role = 'moderator'", communityId, user.id));
  }
  async function requireModerator(communityId, user) {
    if (!await isModerator(communityId, user)) fail(403, 'Community moderator access is required.');
  }
  async function notify(userId, type, message, link = '') {
    if (userId) await run('INSERT INTO notifications(id,user_id,type,message,link,created_at) VALUES(?,?,?,?,?,?)', uuid(), userId, type, text(message, 240), text(link, 500), now());
  }
  async function notifyMembers(communityId, excludeUserId, type, message, link = '') {
    const members = await many("SELECT user_id FROM memberships WHERE community_id = ? AND status = 'active' AND user_id <> ?", communityId, excludeUserId || '');
    const created = now();
    for (const member of members) await run('INSERT INTO notifications(id,user_id,type,message,link,created_at) VALUES(?,?,?,?,?,?)', uuid(), member.user_id, type, text(message, 240), text(link, 500), created);
  }
  async function notifyEventAttendees(eventId, excludeUserId, message) {
    const attendees = await many("SELECT user_id FROM rsvps WHERE event_id=? AND status='going' AND user_id<>?", eventId, excludeUserId || '');
    for (const attendee of attendees) await notify(attendee.user_id, 'event_update', message, `/?event=${eventId}`);
  }
  async function notifyAdmins(type, message) {
    for (const admin of await many(`SELECT id FROM users WHERE role='admin' AND disabled=${isProduction ? 'false' : '0'}`)) await notify(admin.id, type, message, '');
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
    if (typeof origin !== 'string' || !origin) fail(403, 'Request origin was not accepted.');
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) fail(403, 'Request origin was not accepted.');
    try {
      const parsed = new URL(origin);
      const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      const protocol = forwardedProtocol || (req.socket?.encrypted ? 'https' : 'http');
      if (!['http', 'https'].includes(protocol) || !req.headers.host || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) fail(403, 'Request origin was not accepted.');
      const expected = new URL(`${protocol}://${req.headers.host}`);
      if (parsed.origin !== expected.origin) fail(403, 'Request origin was not accepted.');
    }
    catch (error) { if (error instanceof HttpError) throw error; fail(403, 'Request origin was not accepted.'); }
  }
  async function rateLimit(req, key, limit = 12) {
    const ip = req.socket.remoteAddress || 'unknown'; const bucket = `${key}:${ip}`;
    if (isProduction) { if (!(await adapter.rateLimit(bucket, Date.now(), limit))) fail(429, 'Too many attempts. Please wait 15 minutes and try again.'); return; }
    const time = Date.now(); if (time-lastRateSweep>60000) { lastRateSweep=time; for (const [k,v] of rateLimitAttempts) { const fresh=v.filter(ts=>time-ts<15*60*1000); if (fresh.length) rateLimitAttempts.set(k,fresh); else rateLimitAttempts.delete(k); } }
    const recent=(rateLimitAttempts.get(bucket)||[]).filter(ts=>time-ts<15*60*1000); if (recent.length>=limit) fail(429,'Too many attempts. Please wait 15 minutes and try again.'); recent.push(time); rateLimitAttempts.set(bucket,recent);
  }

  async function publicUser(userId) {
    return await one('SELECT id,name,hometown,bio,created_at FROM users WHERE id = ?', userId);
  }
  async function communitySummary(community) {
    const counts = await one("SELECT COUNT(*) AS members FROM memberships WHERE community_id = ? AND status = 'active'", community.id);
    return { ...community, tags: safeJson(community.tags) || [], member_count: counts.members };
  }
  async function postRecord(post, currentUser) {
    const counts = await one('SELECT (SELECT COUNT(*) FROM likes WHERE post_id=?) AS likes, (SELECT COUNT(*) FROM comments WHERE post_id=?) AS comments, (SELECT COUNT(*) FROM shares WHERE post_id=?) AS shares', post.id, post.id, post.id);
    const comments = await many('SELECT c.id,c.body,c.created_at,u.id AS user_id,u.name AS user_name FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.created_at ASC LIMIT 100', post.id);
    return { ...post, author_name: post.user_name, community_name: post.community_name, can_moderate: post.my_role === 'moderator' || currentUser.role === 'admin', liked_by_me: Boolean(await one('SELECT 1 FROM likes WHERE post_id=? AND user_id=?', post.id, currentUser.id)), like_count: counts.likes, comment_count: counts.comments, share_count: counts.shares, comments };
  }

  async function analyticsSnapshot() {
    const today = new Date();
    const dayOffset = days => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days)).toISOString().slice(0, 10);
    const todayKey = dayOffset(0), sevenDayStart = dayOffset(-6), periodStart = dayOffset(-29), previousStart = dayOffset(-59);
    const periodTimestamp = `${periodStart}T00:00:00.000Z`, previousTimestamp = `${previousStart}T00:00:00.000Z`;
    const tomorrowTimestamp = `${dayOffset(1)}T00:00:00.000Z`, currentTime = now();
    const activeToday = (await one('SELECT COUNT(*) AS n FROM user_activity WHERE activity_day=?', todayKey)).n;
    const activeSevenDays = (await one('SELECT COUNT(DISTINCT user_id) AS n FROM user_activity WHERE activity_day>=? AND activity_day<=?', sevenDayStart, todayKey)).n;
    const activeThirtyDays = (await one('SELECT COUNT(DISTINCT user_id) AS n FROM user_activity WHERE activity_day>=? AND activity_day<=?', periodStart, todayKey)).n;
    const engagedThirtyDays = (await one(`SELECT COUNT(DISTINCT user_id) AS n FROM (
      SELECT user_id FROM posts WHERE created_at>=? AND created_at<?
      UNION SELECT user_id FROM comments WHERE created_at>=? AND created_at<?
      UNION SELECT user_id FROM likes WHERE created_at>=? AND created_at<?
      UNION SELECT user_id FROM shares WHERE created_at>=? AND created_at<?
      UNION SELECT user_id FROM rsvps WHERE status='going' AND created_at>=? AND created_at<?
    )`, periodTimestamp, tomorrowTimestamp, periodTimestamp, tomorrowTimestamp, periodTimestamp, tomorrowTimestamp, periodTimestamp, tomorrowTimestamp, periodTimestamp, tomorrowTimestamp)).n;
    const posts = await one(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM likes l WHERE l.post_id=p.id AND l.created_at>=?)
        OR EXISTS (SELECT 1 FROM comments c WHERE c.post_id=p.id AND c.created_at>=?)
        OR EXISTS (SELECT 1 FROM shares s WHERE s.post_id=p.id AND s.created_at>=?) THEN 1 ELSE 0 END) AS engaged
      FROM posts p WHERE p.created_at>=? AND p.created_at<?`, periodTimestamp, periodTimestamp, periodTimestamp, periodTimestamp, tomorrowTimestamp);
    const eventRsvp = await one(`SELECT COALESCE(SUM((SELECT COUNT(*) FROM rsvps r WHERE r.event_id=e.id AND r.status='going')),0) AS going,
      COALESCE(SUM((SELECT COUNT(*) FROM memberships m WHERE m.community_id=e.community_id AND m.status='active')),0) AS opportunities
      FROM events e JOIN communities c ON c.id=e.community_id
      WHERE e.status='open' AND c.status='approved' AND e.created_at>=? AND e.created_at<? AND e.starts_at>=?`, periodTimestamp, tomorrowTimestamp, currentTime);
    const countsInPeriod = async (table, extraWhere = '') => ({
      current: (await one(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at>=? AND created_at<? ${extraWhere}`, periodTimestamp, tomorrowTimestamp)).n,
      previous: (await one(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at>=? AND created_at<? ${extraWhere}`, previousTimestamp, periodTimestamp)).n
    });
    const membersGrowth = await countsInPeriod('users', "AND role<>'admin'");
    const communityGrowth = {
      current: (await one("SELECT COUNT(*) AS n FROM communities WHERE status='approved' AND created_at>=? AND created_at<?", periodTimestamp, tomorrowTimestamp)).n,
      previous: (await one("SELECT COUNT(*) AS n FROM communities WHERE status='approved' AND created_at>=? AND created_at<?", previousTimestamp, periodTimestamp)).n
    };
    const growthRate = values => values.previous ? Math.round(((values.current - values.previous) / values.previous) * 1000) / 10 : null;
    const dailyActive = await many('SELECT activity_day,COUNT(*) AS active_users FROM user_activity WHERE activity_day>=? AND activity_day<=? GROUP BY activity_day ORDER BY activity_day', periodStart, todayKey);
    const dailyMap = new Map(dailyActive.map(row => [row.activity_day, row.active_users]));
    const dailyActiveTrend = Array.from({ length: 30 }, (_, index) => {
      const day = dayOffset(index - 29);
      return { day, active_users: dailyMap.get(day) || 0 };
    });
    return {
      period_days: 30,
      computed_at: currentTime,
      dau: activeToday,
      active_users_7d: activeSevenDays,
      active_users_30d: activeThirtyDays,
      engaged_users_30d: engagedThirtyDays,
      engagement_rate_30d: activeThirtyDays ? Math.round((engagedThirtyDays / activeThirtyDays) * 1000) / 10 : null,
      post_engagement_rate_30d: posts.total ? Math.round((posts.engaged / posts.total) * 1000) / 10 : null,
      user_growth: { ...membersGrowth, growth_percent: growthRate(membersGrowth) },
      community_growth: { ...communityGrowth, growth_percent: growthRate(communityGrowth) },
      event_participation: {
        going_rsvps: eventRsvp.going,
        eligible_member_event_pairs: eventRsvp.opportunities,
        rate_percent: eventRsvp.opportunities ? Math.round((eventRsvp.going / eventRsvp.opportunities) * 1000) / 10 : null
      },
      daily_active_trend: dailyActiveTrend
    };
  }

  async function reportTargetInfo(report, { reporterView = false } = {}) {
    let target = null;
    let summary = 'Target is no longer available.';
    let context = '';
    let link = '';
    if (report.target_type === 'post') {
      target = await one('SELECT p.id,p.body,u.name AS author_name,c.id AS community_id,c.name AS community_name FROM posts p JOIN users u ON u.id=p.user_id JOIN communities c ON c.id=p.community_id WHERE p.id=?', report.target_id);
      if (target) {
        summary = target.body;
        context = `Post by ${target.author_name} in ${target.community_name}`;
        link = `/?community=${encodeURIComponent(target.community_id)}#post-${encodeURIComponent(target.id)}`;
      }
    } else if (report.target_type === 'comment') {
      target = await one('SELECT cm.id,cm.body,u.name AS author_name,p.id AS post_id,p.body AS post_body,c.id AS community_id,c.name AS community_name FROM comments cm JOIN users u ON u.id=cm.user_id JOIN posts p ON p.id=cm.post_id JOIN communities c ON c.id=p.community_id WHERE cm.id=?', report.target_id);
      if (target) {
        summary = target.body;
        context = `Comment by ${target.author_name} on “${target.post_body}” in ${target.community_name}`;
        link = `/?community=${encodeURIComponent(target.community_id)}#post-${encodeURIComponent(target.post_id)}`;
      }
    } else if (report.target_type === 'community') {
      target = await one('SELECT id,name,location,description FROM communities WHERE id=?', report.target_id);
      if (target) {
        summary = target.name;
        context = `${target.location} · ${target.description}`;
        link = `/?community=${encodeURIComponent(target.id)}`;
      }
    } else if (report.target_type === 'user') {
      target = await one('SELECT id,name,hometown FROM users WHERE id=?', report.target_id);
      if (target) {
        summary = reporterView ? 'Account report' : target.name;
        context = reporterView ? 'Reported account details are available only to platform administrators.' : target.hometown ? `Reported account · Hometown: ${target.hometown}` : 'Reported account';
      }
    }
    return { target_summary: text(summary, 1000), target_context: text(context, 1200), target_link: link, target_available: Boolean(target) };
  }
  async function reportTargetIsVisible(targetType, targetId, user) {
    if (targetType === 'user') return Boolean(await one('SELECT id FROM users WHERE id=?', targetId));
    if (targetType === 'community') {
      const community = await one('SELECT status,created_by FROM communities WHERE id=?', targetId);
      return Boolean(community && (user.role === 'admin' || community.status === 'approved' || community.created_by === user.id));
    }
    const post = targetType === 'post'
      ? await one('SELECT p.community_id,c.status FROM posts p JOIN communities c ON c.id=p.community_id WHERE p.id=?', targetId)
      : targetType === 'comment'
        ? await one('SELECT p.community_id,c.status FROM comments cm JOIN posts p ON p.id=cm.post_id JOIN communities c ON c.id=p.community_id WHERE cm.id=?', targetId)
        : null;
    if (!post || post.status !== 'approved') return false;
    if (user.role === 'admin') return true;
    return Boolean(await one("SELECT 1 FROM memberships WHERE community_id=? AND user_id=? AND status='active'", post.community_id, user.id));
  }
  async function reportMessages(reportId, { reporterView = false } = {}) {
    const columns = reporterView ? 'm.body,m.created_at,u.role AS author_role' : 'm.id,m.body,m.created_at,u.id AS author_id,u.name AS author_name,u.role AS author_role';
    return await many(`SELECT ${columns} FROM report_messages m JOIN users u ON u.id=m.author_id WHERE m.report_id=? ORDER BY m.created_at ASC`, reportId);
  }
  async function reportStatusHistory(reportId, { reporterView = false } = {}) {
    const columns = reporterView ? 'h.from_status,h.to_status,h.created_at' : 'h.from_status,h.to_status,h.created_at,u.name AS actor_name,u.role AS actor_role';
    return await many(`SELECT ${columns} FROM report_status_history h JOIN users u ON u.id=h.actor_id WHERE h.report_id=? ORDER BY h.created_at ASC`, reportId);
  }
  async function recordReportStatus(reportId, actorId, fromStatus, toStatus) {
    if (fromStatus === toStatus) return;
    await run('INSERT INTO report_status_history(id,report_id,actor_id,from_status,to_status,created_at) VALUES(?,?,?,?,?,?)', uuid(), reportId, actorId, fromStatus, toStatus, now());
  }

  const panditTestMode = !isProduction && (options.nodeEnv || env.NODE_ENV) === 'test';
  const allowPanditSimulations = panditTestMode && options.allowPanditSimulations === true;
  const retentionWorkerEnabled = isProduction ? env.PANDIT_RETENTION_WORKER_ENABLED === 'true' : options.enablePanditRetentionWorker === true;
  const retentionCronSecret = isProduction ? (typeof env.CRON_SECRET === 'string' ? env.CRON_SECRET : '') :
    panditTestMode && typeof options.retentionCronSecret === 'string' ? options.retentionCronSecret : '';
  const validRetentionCronSecret = secret => typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 16 &&
    Buffer.byteLength(secret, 'utf8') <= 512 && !/\s/.test(secret);
  const authorizedRetentionCron = req => {
    if (!validRetentionCronSecret(retentionCronSecret) || typeof req.headers.authorization !== 'string') return false;
    const expected = Buffer.from(`Bearer ${retentionCronSecret}`, 'utf8');
    const actual = Buffer.from(req.headers.authorization, 'utf8');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
  const panditStorage = panditTestMode && Object.hasOwn(options, 'panditStorageApi') ?
    require('./lib/pandit-storage-api').createPanditStorageApi({ config: options.panditStorageApi, isProduction, allowSimulations: allowPanditSimulations, nodeEnv: 'test', now: options.panditNow || now, errorFactory: message => new HttpError(503, message) }) :
    panditTestMode ? options.panditPrivateStorage : adapter?.panditEvidenceStorage || null;
  const retentionWorker = createPanditRetentionWorker({
    transaction,
    privateEvidenceStorage: panditStorage,
    isProduction,
    enabled: retentionWorkerEnabled,
    allowSimulations: panditTestMode && allowPanditSimulations,
    acquireLock: adapter?.acquirePanditRetentionLock,
    now: options.panditNow || now,
    afterPurge: () => { if (db) db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); },
  });
  const panditRoutes = createPanditRoutes({ one, many, transaction, requireUser, send, fail, uuid, now: options.panditNow || now, isProduction, afterPurge: () => { if (db) db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }, allowSimulations: allowPanditSimulations, privateEvidenceStorage: panditStorage,
    allowProductionEvidence: isProduction && Boolean(adapter?.panditEvidenceStorage),
    // Inline fixtures are explicit/test-only, never a fallback for an unavailable API.
    allowInlineSimulationEvidence: panditTestMode && options.panditInlineSimulationEvidence === true && !Object.hasOwn(options, 'panditStorageApi') });

  async function api(req, res, url) {
    const method = req.method;
    let parts;
    try { parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part)); }
    catch { fail(400, 'The request path is malformed.'); }
    if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'internal' && parts[2] === 'pandit-retention') {
      if (method !== 'GET') { send(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' }); return true; }
      if (!validRetentionCronSecret(retentionCronSecret)) fail(503, 'Scheduled retention is not configured.');
      if (!authorizedRetentionCron(req)) fail(401, 'Unauthorized.');
      if (!retentionWorkerEnabled || !isProduction && !panditTestMode) fail(503, 'Scheduled retention is disabled.');
      if (isProduction && (backendError || !adapter)) fail(503, 'The production backend is not available.');
      const result = await retentionWorker.runOnce();
      send(res, 200, { ok: true, result });
      return true;
    }
    if (isProduction && !panditStorage && (['pandits','pandit-application'].includes(parts[1]) || parts[1] === 'admin' && parts[2] === 'pandits')) fail(503, 'Pandit evidence Storage is not enabled for production.');
    if (!(method === 'GET' && parts[1] === 'health')) await backendReady();
    if (!parts.length || parts[0] !== 'api') return false;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      checkOrigin(req);
      await rateLimit(req, `write:${method}:${parts[1] || 'root'}`, 60);
    }
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : {};

    if (await panditRoutes(req, res, parts, body)) return true;

    if (method === 'GET' && parts[1] === 'health') { send(res, 200, { ok: true, service: 'hometown-hub' }); return true; }
    if (method === 'GET' && parts[1] === 'me') { send(res, 200, { user: await sessionUser(req) || null }); return true; }
    if (method === 'POST' && parts[1] === 'auth' && parts[2] === 'register') {
      if (isProduction && (!adminEmail || !adminPassword || !validEmail(adminEmail) || adminPassword.length < 12)) {
        fail(503, 'Account registration is temporarily unavailable until platform administration is configured.');
      }
      await rateLimit(req, 'register');
      const email = emailValue(body.email), password = typeof body.password === 'string' ? body.password : '';
      const name = text(body.name, 80);
      if (!validEmail(email)) fail(400, 'Enter a valid email address.');
      if (password.length < 10 || password.length > 128) fail(400, 'Password must be 10–128 characters.');
      if (name.length < 2) fail(400, 'Enter your name.');
      const id = uuid(), pass = passwordHash(password);
      await run('INSERT INTO users(id,email,name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO NOTHING', id, email, name, pass.salt, pass.hash, now());
      send(res, 202, { message: REGISTRATION_NOTICE }); return true;
    }
    if (method === 'POST' && parts[1] === 'auth' && parts[2] === 'login') {
      await rateLimit(req, 'login');
      const email = emailValue(body.email), password = typeof body.password === 'string' ? body.password : '';
      const account = await one('SELECT * FROM users WHERE email = ?', email);
      const passwordOk = passwordMatches(password.slice(0, 128), account?.password_salt || DUMMY_LOGIN_HASH.salt, account?.password_hash || DUMMY_LOGIN_HASH.hash);
      if (!account || account.disabled || password.length > 128 || !passwordOk) fail(401, 'Email or password is incorrect.');
      const token = crypto.randomBytes(32).toString('base64url'); if (isProduction) await adapter.createSession(account.id, token); else sessions.set(token, { userId: account.id, expires: Date.now() + SESSION_TTL });
      send(res, 200, { user: { id: account.id, email: account.email, name: account.name, hometown: account.hometown, bio: account.bio, role: account.role, created_at: account.created_at } }, { 'Set-Cookie': cookie(token) }); return true;
    }
    if (method === 'POST' && parts[1] === 'auth' && parts[2] === 'logout') {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME]; if (token) { if (isProduction) await adapter.revokeSession(token); else sessions.delete(token); }
      send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', true) }); return true;
    }
    if (method === 'GET' && parts[1] === 'meta') { send(res, 200, { categories: (await many('SELECT name FROM content_categories ORDER BY name')).map(row => row.name), tags: (await many('SELECT name FROM content_tags ORDER BY name')).map(row => row.name) }); return true; }
    if (method === 'POST' && parts[1] === 'profile') {
      const user = await requireUser(req); const name = text(body.name, 80), hometown = text(body.hometown, 120), bio = text(body.bio, 400);
      if (name.length < 2) fail(400, 'Enter a name of at least 2 characters.');
      await run('UPDATE users SET name=?, hometown=?, bio=? WHERE id=?', name, hometown, bio, user.id);
      const profileUser = await publicUser(user.id); send(res, 200, { user: { ...profileUser, email: user.email, role: user.role } }); return true;
    }

    if (method === 'GET' && parts[1] === 'communities' && parts.length === 2) {
      const user = await sessionUser(req);
      const rows = user
        ? await many("SELECT c.*,m.role AS my_role,m.status AS my_status FROM communities c LEFT JOIN memberships m ON m.community_id=c.id AND m.user_id=? WHERE c.status='approved' OR c.created_by=? ORDER BY CASE c.status WHEN 'approved' THEN 0 ELSE 1 END,c.name", user.id, user.id)
        : await many("SELECT * FROM communities WHERE status='approved' ORDER BY name");
      send(res, 200, { communities: await Promise.all(rows.map(communitySummary)) }); return true;
    }
    if (method === 'POST' && parts[1] === 'communities' && parts.length === 2) {
      const user = await requireUser(req); const name = text(body.name, 100), location = text(body.location, 120), description = text(body.description, 1200);
      const category = text(body.category, 80), tags = Array.isArray(body.tags) ? body.tags.map(tag => text(tag, 30)).filter(Boolean).slice(0, 8) : [];
      if (name.length < 3 || location.length < 2 || description.length < 20) fail(400, 'Enter a community name, location, and a description of at least 20 characters.');
      if (!await one('SELECT name FROM content_categories WHERE name=?', category)) fail(400, 'Choose a valid community category.');
      for (const tag of tags) if (!(await one('SELECT name FROM content_tags WHERE name=?', tag))) fail(400, 'Choose tags from the platform-managed tag list.');
      const id = uuid(), created = now();
      await transaction(async tx => {
        await tx.run('INSERT INTO communities(id,name,location,description,category,tags,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, name, location, description, category, JSON.stringify(tags), 'pending', user.id, created);
        await tx.run('INSERT INTO memberships(community_id,user_id,role,status,created_at) VALUES(?,?,?,?,?)', id, user.id, 'moderator', 'active', created);
      });
      send(res, 201, { community: await communitySummary(await one('SELECT * FROM communities WHERE id=?', id)) }); return true;
    }
    if (method === 'GET' && parts[1] === 'communities' && parts[2] && parts.length === 3) {
      const user = await sessionUser(req); const row = await one('SELECT * FROM communities WHERE id=?', parts[2]);
      if (!row || (row.status !== 'approved' && (!user || (row.created_by !== user.id && user.role !== 'admin')))) fail(404, 'Community not found.');
      const membership = user ? await one('SELECT role,status FROM memberships WHERE community_id=? AND user_id=?', row.id, user.id) : null;
      send(res, 200, { community: { ...(await communitySummary(row)), my_membership: membership || null } }); return true;
    }
    if (method === 'POST' && parts[1] === 'communities' && parts[2] && parts[3] === 'join') {
      const user = await requireUser(req), id = parts[2]; const community = await one("SELECT id,status,created_by FROM communities WHERE id=? AND status='approved'", id);
      if (!community) fail(404, 'Community not found.');
      const old = await one('SELECT status FROM memberships WHERE community_id=? AND user_id=?', id, user.id);
      if (old && old.status === 'active') fail(409, 'You are already a member.');
      if (old && old.status === 'pending') fail(409, 'Your membership request is awaiting review.');
      await run('INSERT INTO memberships(community_id,user_id,role,status,created_at) VALUES(?,?,?,?,?) ON CONFLICT(community_id,user_id) DO UPDATE SET role=\'member\',status=\'pending\',created_at=excluded.created_at', id, user.id, 'member', 'pending', now());
      const mods = await many("SELECT user_id FROM memberships WHERE community_id=? AND role='moderator' AND status='active'", id);
      for (const mod of mods) await notify(mod.user_id, 'membership_request', `${user.name} requested to join ${(await one('SELECT name FROM communities WHERE id=?', id)).name}.`, `/?community=${id}`);
      send(res, 201, { status: 'pending' }); return true;
    }
    if (method === 'POST' && parts[1] === 'communities' && parts[2] && parts[3] === 'rules') {
      const user = await requireUser(req), id = parts[2]; await requireModerator(id, user);
      const rules = text(body.rules, 3000), previous = await one('SELECT rules,name FROM communities WHERE id=?', id);
      await run('UPDATE communities SET rules=? WHERE id=?', rules, id);
      if (previous && previous.rules !== rules) await notifyMembers(id, user.id, 'community_rules', `Community guidelines were updated for ${previous.name}.`, `/?community=${id}`);
      send(res, 200, { rules }); return true;
    }
    if (method === 'GET' && parts[1] === 'communities' && parts[2] && parts[3] === 'requests') {
      const user = await requireUser(req), id = parts[2]; await requireModerator(id, user);
      send(res, 200, { requests: await many("SELECT u.id,u.name,u.hometown,m.created_at AS requested_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.community_id=? AND m.status='pending' ORDER BY m.created_at", id) }); return true;
    }
    if (method === 'POST' && parts[1] === 'communities' && parts[2] && parts[3] === 'requests' && parts[4]) {
      const user = await requireUser(req), communityId = parts[2], targetUser = parts[4]; await requireModerator(communityId, user);
      const action = body.action;
      if (!['approve', 'reject'].includes(action)) fail(400, 'Choose approve or reject.');
      const pending = await one("SELECT status FROM memberships WHERE community_id=? AND user_id=? AND status='pending'", communityId, targetUser);
      if (!pending) fail(404, 'Membership request not found.');
      if (action === 'approve') await run("UPDATE memberships SET status='active' WHERE community_id=? AND user_id=?", communityId, targetUser);
      else await run("UPDATE memberships SET status='rejected' WHERE community_id=? AND user_id=?", communityId, targetUser);
      const communityName = (await one('SELECT name FROM communities WHERE id=?', communityId)).name;
      await notify(targetUser, 'membership_decision', action === 'approve' ? `Your request to join ${communityName} was approved.` : `Your request to join ${communityName} was declined.`, `/?community=${communityId}`);
      send(res, 200, { ok: true }); return true;
    }

    if (method === 'GET' && parts[1] === 'feed') {
      const user = await requireUser(req), communityId = url.searchParams.get('community');
      let posts;
      if (communityId) {
        await requireCommunity(communityId, user);
        posts = await many("SELECT p.*,u.name AS user_name,c.name AS community_name,m.role AS my_role FROM posts p JOIN users u ON u.id=p.user_id JOIN communities c ON c.id=p.community_id LEFT JOIN memberships m ON m.community_id=p.community_id AND m.user_id=? AND m.status='active' WHERE p.community_id=? ORDER BY p.pinned DESC,p.created_at DESC LIMIT 100", user.id, communityId);
      } else {
        posts = await many("SELECT p.*,u.name AS user_name,c.name AS community_name FROM posts p JOIN users u ON u.id=p.user_id JOIN communities c ON c.id=p.community_id JOIN memberships m ON m.community_id=p.community_id AND m.user_id=? AND m.status='active' WHERE c.status='approved' ORDER BY p.pinned DESC,p.created_at DESC LIMIT 100", user.id);
      }
      send(res, 200, { posts: await Promise.all(posts.map(async post => postRecord(post, user))) }); return true;
    }
    if (method === 'POST' && parts[1] === 'posts' && parts.length === 2) {
      const user = await requireUser(req); const communityId = text(body.community_id, 64), content = text(body.body, 4000);
      const kind = body.kind === 'announcement' ? 'announcement' : 'post';
      const category = text(body.category, 80);
      if (content.length < 1) fail(400, 'Write something before posting.');
      const { community } = await requireCommunity(communityId, user);
      if (!await one('SELECT name FROM content_categories WHERE name=?', category)) fail(400, 'Choose a valid category.');
      let imagePath = '';
      if (body.image) {
        if (typeof body.image !== 'string' || body.image.length > 2_100_000) fail(413, 'Image must be 1.5 MB or smaller.');
        const match = body.image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!match) fail(400, 'Upload a PNG, JPEG, or WebP image.');
        const buffer = Buffer.from(match[2], 'base64');
        if (buffer.length > 1_500_000) fail(413, 'Image must be 1.5 MB or smaller.');
        if (buffer.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) fail(400, 'The image file format could not be verified.');
        const expectedFormat = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[match[1]];
        let normalized;
        try {
          const metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000, sequentialRead: true }).metadata();
          if (metadata.format !== expectedFormat) fail(400, 'The image file format could not be verified.');
          let pipeline = sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000, sequentialRead: true })
            .rotate()
            .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true });
          if (expectedFormat === 'jpeg') pipeline = pipeline.jpeg({ quality: 82, progressive: true });
          else if (expectedFormat === 'webp') pipeline = pipeline.webp({ quality: 82, effort: 4 });
          else pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
          normalized = await pipeline.toBuffer();
        } catch (error) {
          if (error instanceof HttpError) throw error;
          fail(400, 'The image could not be decoded safely.');
        }
        if (normalized.length > 1_500_000) fail(413, 'Image must be 1.5 MB or smaller after processing.');
        const ext = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
        const filename = `${uuid()}.${ext}`; imagePath = `/uploads/${filename}`;
        if (isProduction) await adapter.upload(filename, normalized, match[1]);
        else fs.writeFileSync(path.join(uploadDir, filename), normalized, { flag: 'wx' });
      }
      const id = uuid();
      try { await run('INSERT INTO posts(id,community_id,user_id,body,category,kind,image_path,created_at) VALUES(?,?,?,?,?,?,?,?)', id, communityId, user.id, content, category, kind, imagePath, now()); }
      catch (error) { if (isProduction && imagePath) { try { await adapter.remove(path.basename(imagePath)); } catch {} } else if (!isProduction && imagePath) { try { fs.unlinkSync(path.join(uploadDir, path.basename(imagePath))); } catch {} } throw error; }
      await notifyMembers(communityId, user.id, kind, `${user.name} shared ${kind === 'announcement' ? 'an announcement' : 'a post'} in ${community.name}.`, `/?community=${communityId}#post-${id}`);
      send(res, 201, { id }); return true;
    }
    if (method === 'POST' && parts[1] === 'posts' && parts[2] && parts[3] === 'comments') {
      const user = await requireUser(req), post = await one('SELECT * FROM posts WHERE id=?', parts[2]);
      if (!post) fail(404, 'Post not found.'); await requireCommunity(post.community_id, user);
      const content = text(body.body, 1200); if (!content) fail(400, 'Write a comment first.');
      const id = uuid(); await run('INSERT INTO comments(id,post_id,user_id,body,created_at) VALUES(?,?,?,?,?)', id, post.id, user.id, content, now());
      if (post.user_id !== user.id) await notify(post.user_id, 'comment', `${user.name} commented on your post.`, `/?community=${post.community_id}#post-${post.id}`);
      send(res, 201, { id }); return true;
    }
    if (method === 'POST' && parts[1] === 'posts' && parts[2] && parts[3] === 'like') {
      const user = await requireUser(req), post = await one('SELECT * FROM posts WHERE id=?', parts[2]);
      if (!post) fail(404, 'Post not found.'); await requireCommunity(post.community_id, user);
      const exists = await one('SELECT 1 FROM likes WHERE post_id=? AND user_id=?', post.id, user.id);
      if (exists) await run('DELETE FROM likes WHERE post_id=? AND user_id=?', post.id, user.id);
      else { await run('INSERT INTO likes(post_id,user_id,created_at) VALUES(?,?,?)', post.id, user.id, now()); if (post.user_id !== user.id) await notify(post.user_id, 'like', `${user.name} liked your post.`, `/?community=${post.community_id}#post-${post.id}`); }
      send(res, 200, { liked: !exists }); return true;
    }
    if (method === 'POST' && parts[1] === 'posts' && parts[2] && parts[3] === 'share') {
      const user = await requireUser(req), post = await one('SELECT * FROM posts WHERE id=?', parts[2]);
      if (!post) fail(404, 'Post not found.'); await requireCommunity(post.community_id, user);
      await run('INSERT INTO shares(post_id,user_id,created_at) VALUES(?,?,?) ON CONFLICT(post_id,user_id) DO NOTHING', post.id, user.id, now());
      send(res, 200, { url: `/?community=${post.community_id}#post-${post.id}` }); return true;
    }
    if (method === 'POST' && parts[1] === 'posts' && parts[2] && parts[3] === 'pin') {
      const user = await requireUser(req), post = await one('SELECT * FROM posts WHERE id=?', parts[2]);
      if (!post) fail(404, 'Post not found.'); await requireModerator(post.community_id, user);
      const pinned = Boolean(body.pinned);
      await run('UPDATE posts SET pinned=? WHERE id=?', isProduction ? pinned : (pinned ? 1 : 0), post.id); send(res, 200, { pinned }); return true;
    }
    if (method === 'DELETE' && parts[1] === 'posts' && parts[2]) {
      const user = await requireUser(req), post = await one('SELECT * FROM posts WHERE id=?', parts[2]);
      if (!post) fail(404, 'Post not found.'); if (post.user_id !== user.id) await requireModerator(post.community_id, user);
      await run('DELETE FROM posts WHERE id=?', post.id);
      if (post.image_path) { const filename = path.basename(post.image_path); try { if (isProduction) await adapter.remove(filename); else fs.unlinkSync(path.join(uploadDir, filename)); } catch {} }
      send(res, 200, { ok: true }); return true;
    }
    if (method === 'DELETE' && parts[1] === 'comments' && parts[2]) {
      const user = await requireUser(req), comment = await one('SELECT c.*,p.community_id FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=?', parts[2]);
      if (!comment) fail(404, 'Comment not found.'); if (comment.user_id !== user.id) await requireModerator(comment.community_id, user);
      await run('DELETE FROM comments WHERE id=?', comment.id); send(res, 200, { ok: true }); return true;
    }

    if (method === 'GET' && parts[1] === 'events') {
      const user = await requireUser(req), communityId = url.searchParams.get('community');
      let rows;
      if (communityId) { await requireCommunity(communityId, user); rows = await many("SELECT e.*,c.name AS community_name,u.name AS creator_name,m.role AS my_role,(SELECT COUNT(*) FROM rsvps r WHERE r.event_id=e.id AND r.status='going') AS attendee_count,(SELECT status FROM rsvps r WHERE r.event_id=e.id AND r.user_id=?) AS my_rsvp FROM events e JOIN communities c ON c.id=e.community_id JOIN users u ON u.id=e.created_by LEFT JOIN memberships m ON m.community_id=e.community_id AND m.user_id=? AND m.status='active' WHERE e.community_id=? ORDER BY e.starts_at ASC", user.id, user.id, communityId); }
      else { rows = await many("SELECT e.*,c.name AS community_name,u.name AS creator_name,m.role AS my_role,(SELECT COUNT(*) FROM rsvps r WHERE r.event_id=e.id AND r.status='going') AS attendee_count,(SELECT status FROM rsvps r WHERE r.event_id=e.id AND r.user_id=?) AS my_rsvp FROM events e JOIN communities c ON c.id=e.community_id JOIN users u ON u.id=e.created_by JOIN memberships m ON m.community_id=e.community_id AND m.user_id=? AND m.status='active' WHERE c.status='approved' ORDER BY e.starts_at ASC LIMIT 100", user.id, user.id); }
      send(res, 200, { events: rows }); return true;
    }
    if (method === 'POST' && parts[1] === 'events' && parts.length === 2) {
      const user = await requireUser(req), communityId = text(body.community_id, 64), title = text(body.title, 120), description = text(body.description, 1500), location = text(body.location, 160);
      const { community } = await requireCommunity(communityId, user);
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
      const id = uuid(); await run('INSERT INTO events(id,community_id,created_by,title,description,location,starts_at,capacity,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, communityId, user.id, title, description, location, startsAt, capacity, now());
      await notifyMembers(communityId, user.id, 'event', `${user.name} created an event in ${community.name}: ${title}.`, `/?event=${id}`);
      send(res, 201, { id }); return true;
    }
    if (method === 'PATCH' && parts[1] === 'events' && parts[2]) {
      const user = await requireUser(req), event = await one('SELECT * FROM events WHERE id=?', parts[2]);
      if (!event) fail(404, 'Event not found.');
      if (event.created_by !== user.id) await requireModerator(event.community_id, user);
      if (event.status !== 'open') fail(409, 'Only open events can be edited.');
      const updated = await transaction(async tx => {
        const current = await tx.one(`SELECT * FROM events WHERE id=?${isProduction ? ' FOR UPDATE' : ''}`, event.id);
        if (!current || current.status !== 'open') fail(409, 'Only open events can be edited.');
        const title = body.title === undefined ? current.title : text(body.title, 120);
        const description = body.description === undefined ? current.description : text(body.description, 1500);
        const location = body.location === undefined ? current.location : text(body.location, 160);
        const currentStartsAt = current.starts_at instanceof Date ? current.starts_at.toISOString() : current.starts_at;
        const startsAtInput = body.starts_at === undefined ? currentStartsAt : body.starts_at;
        const eventDate = new Date(startsAtInput);
        if (typeof startsAtInput !== 'string' || !Number.isFinite(eventDate.getTime())) fail(400, 'Enter a valid event date and time.');
        const startsAt = eventDate.toISOString();
        if (eventDate.getTime() <= Date.now()) fail(400, 'Choose a future event date and time.');
        if (title.length < 3 || description.length < 10 || location.length < 2) fail(400, 'Add an event title, description, and location.');
        let capacity = current.capacity;
        if (body.capacity !== undefined) {
          if (body.capacity === '' || body.capacity == null) capacity = null;
          else {
            capacity = safeInt(body.capacity);
            if (capacity === null || capacity < 1 || capacity > 100000) fail(400, 'Capacity must be a whole number between 1 and 100,000, or left blank.');
          }
        }
        const going = Number((await tx.one("SELECT COUNT(*) AS n FROM rsvps WHERE event_id=? AND status='going'", event.id)).n);
        if (capacity !== null && capacity < going) fail(409, `Capacity cannot be lower than the ${going} existing going RSVP${going === 1 ? '' : 's'}.`);
        const changed = title !== current.title || description !== current.description || location !== current.location || startsAt !== currentStartsAt || capacity !== current.capacity;
        await tx.run('UPDATE events SET title=?,description=?,location=?,starts_at=?,capacity=? WHERE id=?', title, description, location, startsAt, capacity, event.id);
        return { changed, event: { ...current, title, description, location, starts_at: startsAt, capacity } };
      });
      if (updated.changed) await notifyEventAttendees(event.id, user.id, `Event details changed: ${updated.event.title}.`);
      send(res, 200, { ok: true, event: updated.event }); return true;
    }
    if (method === 'POST' && parts[1] === 'events' && parts[2] && parts[3] === 'rsvp') {
      const user = await requireUser(req), eventId = parts[2], action = body.action;
      const event = await one("SELECT * FROM events WHERE id=? AND status='open'", eventId); if (!event) fail(404, 'Open event not found.');
      await requireCommunity(event.community_id, user);
      if (!['going', 'cancel'].includes(action)) fail(400, 'Choose going or cancel.');
      await transaction(async tx => {
        const lockedEvent = await tx.one(`SELECT id,capacity,status FROM events WHERE id=?${isProduction ? ' FOR UPDATE' : ''}`, eventId);
        if (!lockedEvent || lockedEvent.status !== 'open') fail(404, 'Open event not found.');
        if (action === 'cancel') await tx.run('DELETE FROM rsvps WHERE event_id=? AND user_id=?', eventId, user.id);
        else {
          const existing = await tx.one("SELECT status FROM rsvps WHERE event_id=? AND user_id=?", eventId, user.id);
          if (!existing && lockedEvent.capacity !== null) {
            const count = (await tx.one("SELECT COUNT(*) AS n FROM rsvps WHERE event_id=? AND status='going'", eventId)).n;
            if (Number(count) >= Number(lockedEvent.capacity)) fail(409, 'This event has reached its capacity.');
          }
          await tx.run("INSERT INTO rsvps(event_id,user_id,status,created_at) VALUES(?,?, 'going', ?) ON CONFLICT(event_id,user_id) DO UPDATE SET status='going',created_at=excluded.created_at", eventId, user.id, now());
        }
      });
      send(res, 200, { status: action === 'going' ? 'going' : 'not_going' }); return true;
    }
    if (method === 'DELETE' && parts[1] === 'events' && parts[2]) {
      const user = await requireUser(req), event = await one('SELECT * FROM events WHERE id=?', parts[2]); if (!event) fail(404, 'Event not found.');
      if (event.created_by !== user.id) await requireModerator(event.community_id, user);
      if (event.status === 'cancelled') fail(409, 'This event is already cancelled.');
      await run("UPDATE events SET status='cancelled' WHERE id=?", event.id);
      await notifyEventAttendees(event.id, user.id, `Event cancelled: ${event.title}.`);
      send(res, 200, { ok: true }); return true;
    }

    if (method === 'GET' && parts[1] === 'notifications') {
      const user = await requireUser(req);
      send(res, 200, { notifications: await many('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', user.id), unread_count: (await one('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL', user.id)).n }); return true;
    }
    if (method === 'POST' && parts[1] === 'notifications' && parts[2] === 'read') {
      const user = await requireUser(req);
      if (parts[3]) await run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?', now(), parts[3], user.id);
      else await run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', now(), user.id);
      send(res, 200, { ok: true }); return true;
    }

    if (method === 'GET' && parts[1] === 'reports' && parts.length === 2) {
      const user = await requireUser(req);
      const reports = await Promise.all((await many('SELECT * FROM reports WHERE reporter_id=? ORDER BY created_at DESC LIMIT 100', user.id)).map(async report => {
        const { resolution_note, resolved_by, ...reporterReport } = report;
        return { ...reporterReport, ...(await reportTargetInfo(report, { reporterView: true })), messages: await reportMessages(report.id, { reporterView: true }), history: await reportStatusHistory(report.id, { reporterView: true }) };
      }));
      send(res, 200, { reports }); return true;
    }
    if (method === 'POST' && parts[1] === 'reports' && parts.length === 2) {
      await rateLimit(req, 'report');
      const user = await requireUser(req), targetType = text(body.target_type, 20), targetId = text(body.target_id, 64), reason = text(body.reason, 1000);
      if (!['user', 'post', 'comment', 'community'].includes(targetType) || !targetId || reason.length < 10) fail(400, 'Choose content to report and describe the issue in at least 10 characters.');
      if (!await reportTargetIsVisible(targetType, targetId, user)) fail(404, 'The reported item was not found.');
      const id = uuid(); await run('INSERT INTO reports(id,reporter_id,target_type,target_id,reason,created_at) VALUES(?,?,?,?,?,?)', id, user.id, targetType, targetId, reason, now());
      await recordReportStatus(id, user.id, '', 'open');
      await notifyAdmins('report_case', 'A member submitted a report that is ready for review.');
      send(res, 201, { id }); return true;
    }
    if (method === 'POST' && parts[1] === 'reports' && parts[2] && parts[3] === 'messages') {
      await rateLimit(req, 'report_message');
      const user = await requireUser(req), report = await one('SELECT * FROM reports WHERE id=? AND reporter_id=?', parts[2], user.id);
      if (!report) fail(404, 'Report not found.');
      const message = text(body.message, 1500);
      if (message.length < 10) fail(400, 'Add at least 10 characters of useful information.');
      if (report.status === 'resolved' || report.status === 'dismissed') {
        await run("UPDATE reports SET status='open',resolved_by=NULL,resolved_at=NULL,resolution_note='' WHERE id=?", report.id);
        await recordReportStatus(report.id, user.id, report.status, 'open');
      }
      await run('INSERT INTO report_messages(id,report_id,author_id,body,created_at) VALUES(?,?,?,?,?)', uuid(), report.id, user.id, message, now());
      await notifyAdmins('report_update', 'A reporter added information to a case.');
      send(res, 201, { status: report.status === 'resolved' || report.status === 'dismissed' ? 'open' : report.status }); return true;
    }

    if (method === 'GET' && parts[1] === 'admin' && parts[2] === 'dashboard') {
      await requireAdmin(req);
      const counts = {
        users: (await one('SELECT COUNT(*) AS n FROM users WHERE role <> \'admin\'')).n,
        communities: (await one("SELECT COUNT(*) AS n FROM communities WHERE status='approved'")).n,
        pending_communities: (await one("SELECT COUNT(*) AS n FROM communities WHERE status='pending'")).n,
        posts: (await one('SELECT COUNT(*) AS n FROM posts')).n,
        upcoming_events: (await one("SELECT COUNT(*) AS n FROM events WHERE status='open' AND starts_at > ?", now())).n,
        open_reports: (await one("SELECT COUNT(*) AS n FROM reports WHERE status IN ('open','in_review')")).n
      };
      const communities = await many("SELECT c.*,u.name AS creator_name FROM communities c JOIN users u ON u.id=c.created_by WHERE c.status='pending' ORDER BY c.created_at",);
      const users = await many('SELECT id,email,name,hometown,role,disabled,created_at FROM users ORDER BY created_at DESC LIMIT 100');
      const reports = await Promise.all((await many("SELECT r.*,u.name AS reporter_name FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END,r.created_at DESC LIMIT 100")).map(async report => ({ ...report, ...(await reportTargetInfo(report)), messages: await reportMessages(report.id), history: await reportStatusHistory(report.id) })));
      const moderators = await many("SELECT m.community_id,m.user_id,m.created_at,u.name AS user_name,c.name AS community_name FROM memberships m JOIN users u ON u.id=m.user_id JOIN communities c ON c.id=m.community_id WHERE m.role='moderator' AND m.status='active'");
      const memberships = await many("SELECT m.community_id,m.user_id,m.role,m.created_at,u.name AS user_name,c.name AS community_name FROM memberships m JOIN users u ON u.id=m.user_id JOIN communities c ON c.id=m.community_id WHERE m.status='active' AND c.status='approved' ORDER BY c.name,u.name");
      send(res, 200, { counts, analytics: await analyticsSnapshot(), communities: await Promise.all(communities.map(communitySummary)), users, reports, categories: await many('SELECT name,created_at FROM content_categories ORDER BY name'), tags: await many('SELECT name,created_at FROM content_tags ORDER BY name'), moderators, memberships }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'communities' && parts[3] && parts[4] === 'review') {
      const admin = await requireAdmin(req), action = body.action, id = parts[3];
      if (!['approve', 'reject'].includes(action)) fail(400, 'Choose approve or reject.');
      const community = await one("SELECT * FROM communities WHERE id=? AND status='pending'", id); if (!community) fail(404, 'Pending community not found.');
      await run('UPDATE communities SET status=? WHERE id=?', action === 'approve' ? 'approved' : 'rejected', id);
      await notify(community.created_by, 'community_review', action === 'approve' ? `${community.name} has been approved.` : `${community.name} was not approved.`, `/?community=${id}`);
      send(res, 200, { ok: true }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'communities' && parts[3] && parts[4] === 'members' && parts[5] && parts[6] === 'role') {
      await requireAdmin(req); const communityId = parts[3], userId = parts[5], role = body.role;
      if (!['member', 'moderator'].includes(role)) fail(400, 'Choose member or moderator.');
      const member = await one("SELECT status FROM memberships WHERE community_id=? AND user_id=?", communityId, userId);
      if (!member || member.status !== 'active') fail(404, 'Active community membership not found.');
      await run('UPDATE memberships SET role=? WHERE community_id=? AND user_id=?', role, communityId, userId); send(res, 200, { ok: true }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'users' && parts[3] && parts[4] === 'status') {
      const admin = await requireAdmin(req), target = await one('SELECT id,role,disabled FROM users WHERE id=?', parts[3]);
      if (!target) fail(404, 'User not found.'); if (target.id === admin.id || target.role === 'admin') fail(400, 'Platform administrator accounts cannot be disabled here.');
      const disabled = strictBoolean(body.disabled, 'Disabled status'); await run('UPDATE users SET disabled=? WHERE id=?', isProduction ? disabled : (disabled ? 1 : 0), target.id);
      if (disabled && isProduction) await run('DELETE FROM app_sessions WHERE user_id=?', target.id); else if (disabled) for (const [token, session] of sessions) if (session.userId === target.id) sessions.delete(token);
      send(res, 200, { disabled }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'reports' && parts[3] && parts[4] === 'messages') {
      const admin = await requireAdmin(req), report = await one('SELECT * FROM reports WHERE id=?', parts[3]);
      if (!report) fail(404, 'Report not found.');
      const message = text(body.message, 1500);
      if (message.length < 2) fail(400, 'Write a response before sending.');
      await run('INSERT INTO report_messages(id,report_id,author_id,body,created_at) VALUES(?,?,?,?,?)', uuid(), report.id, admin.id, message, now());
      await notify(report.reporter_id, 'report_update', 'A platform administrator sent you an update about your report.', '');
      send(res, 201, { ok: true }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'reports' && parts[3] && parts[4] === 'resolve') {
      const admin = await requireAdmin(req), report = await one('SELECT * FROM reports WHERE id=?', parts[3]); if (!report) fail(404, 'Report not found.');
      const status = body.status;
      if (!['open', 'in_review', 'resolved', 'dismissed'].includes(status)) fail(400, 'Choose open, in review, resolved, or dismissed.');
      const resolutionNote = text(body.resolution_note, 1000);
      const response = text(body.response, 1500), isClosed = status === 'resolved' || status === 'dismissed';
      const resolvedAt = isClosed ? now() : null;
      await run('UPDATE reports SET status=?,resolved_by=?,resolved_at=?,resolution_note=? WHERE id=?', status, isClosed ? admin.id : null, resolvedAt, status === 'open' ? '' : resolutionNote, report.id);
      await recordReportStatus(report.id, admin.id, report.status, status);
      if (response) await run('INSERT INTO report_messages(id,report_id,author_id,body,created_at) VALUES(?,?,?,?,?)', uuid(), report.id, admin.id, response, now());
      if (status !== report.status || response) await notify(report.reporter_id, 'report_update', response ? 'A platform administrator updated your report.' : status === 'in_review' ? 'A platform administrator is reviewing your report.' : status === 'open' ? 'Your report was reopened for review.' : 'A platform administrator reviewed your report.', '');
      send(res, 200, { status, resolved_at: resolvedAt }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'categories') {
      await requireAdmin(req); const name = text(body.name, 40);
      if (name.length < 2) fail(400, 'Category name must be at least 2 characters.');
      try { await run('INSERT INTO content_categories(name,created_at) VALUES(?,?)', name, now()); }
      catch { fail(409, 'That category already exists.'); }
      send(res, 201, { name }); return true;
    }
    if (method === 'DELETE' && parts[1] === 'admin' && parts[2] === 'categories' && parts[3]) {
      await requireAdmin(req); if (parts[3] === 'General') fail(400, 'The General category cannot be removed.');
      await run('DELETE FROM content_categories WHERE name=?', parts[3]); send(res, 200, { ok: true }); return true;
    }
    if (method === 'POST' && parts[1] === 'admin' && parts[2] === 'tags') {
      await requireAdmin(req); const name = text(body.name, 30);
      if (name.length < 2) fail(400, 'Tag must be at least 2 characters.');
      try { await run('INSERT INTO content_tags(name,created_at) VALUES(?,?)', name, now()); }
      catch { fail(409, 'That tag already exists.'); }
      send(res, 201, { name }); return true;
    }
    if (method === 'DELETE' && parts[1] === 'admin' && parts[2] === 'tags' && parts[3]) {
      await requireAdmin(req); await run('DELETE FROM content_tags WHERE name=?', parts[3]); send(res, 200, { ok: true }); return true;
    }
    send(res, 404, { error: 'API route not found.' }); return true;
  }

  const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
  async function serveStatic(req, res, url) {
    let filename;
    if (url.pathname.startsWith('/uploads/')) {
      const basename = path.basename(url.pathname);
      if (!/^[a-f0-9-]+\.(?:png|jpg|webp)$/i.test(basename)) { res.writeHead(404, headers); res.end('Not found'); return; }
      if (isProduction) { const data = await adapter.download(basename); if (!data) { res.writeHead(404, headers); res.end('Not found'); return; } res.writeHead(200, { ...headers, 'Content-Type': mimeTypes[path.extname(basename)] || 'application/octet-stream', 'Cache-Control': 'private, no-store' }); res.end(data); return; }
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

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) { await api(req, res, url); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers); res.end('Method not allowed'); return; }
      if (url.pathname.startsWith('/uploads/')) {
        await backendReady();
        const imagePost = await one('SELECT community_id FROM posts WHERE image_path=?', url.pathname);
        const viewer = await sessionUser(req);
        const allowed = imagePost && viewer && (viewer.role === 'admin' || Boolean(await one("SELECT 1 FROM memberships m JOIN communities c ON c.id=m.community_id WHERE m.community_id=? AND m.user_id=? AND m.status='active' AND c.status='approved'", imagePost.community_id, viewer.id)));
        if (!allowed) { res.writeHead(404, headers); res.end('Not found'); return; }
      }
      await serveStatic(req, res, url);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) logUnexpected(error);
      send(res, status, { error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.' });
    }
  };
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!(error instanceof HttpError)) logUnexpected(error);
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      send(res, status, { error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.' });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.handle = handle;
  server.database = db || adapter;
  // Internal/test hook; production HTTP invocation uses the authenticated route above.
  server.runPanditRetentionWorker = () => retentionWorker.runOnce();
  server.closeDatabase = () => { if (db) db.close(); else if (adapter) return adapter.close(); };
  server.appOptions = { dataDir, uploadDir, dbPath };
  return server;
}
let vercelApp;
function getVercelApp() {
  if (!vercelApp) vercelApp = createApp({ dataDir: process.env.DATA_DIR || '/tmp/hometown-hub-data', nodeEnv: 'production' });
  return vercelApp;
}
const fetch = createFetchHandler(getVercelApp);

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer between 1 and 65535.');
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const server = createApp();
  server.listen(port, host, () => {
    console.log(`Hometown Hub is listening on http://${host}:${port}`);
    if (!process.env.PLATFORM_ADMIN_EMAIL || !process.env.PLATFORM_ADMIN_PASSWORD) console.warn('Platform admin bootstrap is disabled. Set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD (12+ chars) before first launch to initialize an admin account.');
  });
  const shutdown = () => server.close(() => { server.closeDatabase(); process.exit(0); });
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

module.exports = { createApp, passwordHash, passwordMatches, fetch, getVercelApp };
