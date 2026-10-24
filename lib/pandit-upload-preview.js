'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp, passwordHash } = require('../server');
const { createFetchHandler } = require('./fetch-handler');

const MAX_BODY = 3 * 1024 * 1024;
const SYNTHETIC_EMAIL = 'pandit-preview@example.test';
const SYNTHETIC_PASSWORD = 'pandit-preview-password-123';
const SYNTHETIC_NAME = 'SYNTHETIC TEST PROFILE — NOT A PERSON';
function makeDummyPdf() {
  const header = '%PDF-1.4\n% SYNTHETIC TEST ONLY — NOT A DOCUMENT\n';
  const text = 'BT /F1 18 Tf 40 730 Td (SYNTHETIC TEST ONLY - NOT A DOCUMENT) Tj 0 -35 Td (No person, ID, background check or qualification.) Tj ET\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ];
  let output = header; const offsets = [];
  for (const object of objects) { offsets.push(Buffer.byteLength(output)); output += object; }
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(output)}\n%%EOF\n`;
  return Buffer.from(output + xref);
}
const DUMMY_PDF = makeDummyPdf();
const DUMMY_BASE64 = DUMMY_PDF.toString('base64');
// Manually inspected synthetic placeholder supplied for this local demonstration.
// This is an exact-byte allowlist, NOT filename, PDF-format, or content recognition.
// Keep this exception inside the disposable gateway, never the production uploader.
const REVIEWED_DUMMY1_SHA256 = '0bb15882d995136445b62bcd31b618a6fcd3e623b3bac59497a4d07411839131';
function isAllowedSyntheticPdf(contentBase64) {
  if (contentBase64 === DUMMY_BASE64) return true;
  if (typeof contentBase64 !== 'string') return false;
  const bytes = Buffer.from(contentBase64, 'base64');
  return bytes.length === 26579 && bytes.toString('base64') === contentBase64 &&
    crypto.createHash('sha256').update(bytes).digest('hex') === REVIEWED_DUMMY1_SHA256;
}
const PROFILE = Object.freeze({
  is_simulation: true,
  display_name: SYNTHETIC_NAME,
  location: 'Synthetic Test Township',
  description: 'Synthetic test profile used only for disposable workflow demonstrations.',
  traditions: 'Synthetic tradition', languages: 'Test language', ritual_skills: 'Synthetic ritual', experience_years: 12
});
const PROFILE_KEYS = new Set(['revision', 'action', ...Object.keys(PROFILE)]);
const UI_PROFILE_KEYS = new Set([...PROFILE_KEYS].filter(key => key !== 'is_simulation'));
const EVIDENCE_KEYS = new Set(['revision', 'kind', 'content_type', 'content_base64']);

function seed(db) {
  const id = 'pandit-preview-synthetic-user';
  const appId = 'pandit-preview-synthetic-application';
  const hash = passwordHash(SYNTHETIC_PASSWORD, 'pandit-preview-synthetic-salt');
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO users(id,email,name,password_salt,password_hash,hometown,bio,role,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, SYNTHETIC_EMAIL, SYNTHETIC_NAME, hash.salt, hash.hash, 'Synthetic Test Township', 'DISPOSABLE SIMULATION — NOT A PERSON', 'user', stamp);
  // The isolated database inherits the owner's approved 3-year / 90-day / 30-day policy.
  db.prepare(`INSERT INTO pandit_applications
    (id,user_id,display_name,location,description,traditions,languages,ritual_skills,experience_years,status,revision,is_simulation,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'ACTION_REQUIRED',1,1,?,?)`)
    .run(appId, id, PROFILE.display_name, PROFILE.location, PROFILE.description, PROFILE.traditions, PROFILE.languages, PROFILE.ritual_skills, PROFILE.experience_years, stamp, stamp);
  return { id, appId };
}

function onlyKeys(body, keys) {
  return body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === keys.size && Object.keys(body).every(k => keys.has(k));
}
function jsonHeaders(headers) {
  const out = {};
  for (const [key, value] of headers) if (!['content-length', 'cache-control', 'pragma'].includes(key.toLowerCase())) out[key] = value;
  return out;
}
function cookiesFrom(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const value = response.headers.get('set-cookie');
  return value ? [value] : [];
}

// Presentation adapter served only by the disposable gateway. Shared UI and
// production verification/policy behavior are deliberately left untouched.
function previewClientScript(source) {
  return source
    .replace('function evidenceList(a, role){', 'function standardEvidenceList(a, role){')
    .replace('Upload one PDF or PNG/JPEG for each required type. Private files are limited to 1 MiB each.', 'This preview accepts only the unchanged built-in dummy PDF or the exact inspected owner-supplied dummy1.pdf. Use the same allowed file in all three categories. Private files are limited to 1 MiB each.')
    .replace('Choose a file to upload it immediately. Wait for the uploaded confirmation before choosing the next file.', 'Choose an unchanged allowed dummy PDF for each category, one at a time. The file selectors clear after upload; “No file chosen” does not mean the upload is missing. Check the persistent status list below. After all three say UPLOADED, press Submit for review. Uploading is not verification.')
    .replace("toast('Private evidence uploaded.');", "toast(input.dataset.evidenceKind.replaceAll('_',' ') + ' uploaded — awaiting review.');")
    + `\nfunction evidenceList(a, role) {
      if (!a?.is_simulation || role) return standardEvidenceList(a, role);
      return ['GOVERNMENT_ID','BACKGROUND_CHECK','EDUCATION'].map(kind => {
        const evidence = (a.evidence || []).find(item => item.kind === kind);
        const label = !evidence ? 'NOT UPLOADED' : evidence.verified ? 'UPLOADED — VERIFIED' : 'UPLOADED — AWAITING REVIEW';
        return '<li><span>' + kind.replaceAll('_', ' ') + ' — ' + label + '</span></li>';
      }).join('') + '<li>' + ((a.evidence || []).length === 3
        ? a.status === 'PENDING_VERIFICATION' ? 'Application submitted — pending review. Uploads are not approval.' : 'All three files uploaded. Next: Submit for review.'
        : 'Upload the missing categories before submitting for review.') + '</li>';
    }\n`;
}

function createDisposablePreview(options = {}) {
  if (options.nodeEnv === 'production' || process.env.NODE_ENV === 'production') throw new Error('Disposable Pandit preview refuses NODE_ENV=production.');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometown-pandit-preview-'));
  const app = createApp({ dataDir, nodeEnv: 'test', env: {}, allowPanditSimulations: true, panditInlineSimulationEvidence: true });
  const seeded = seed(app.database);
  const appFetch = createFetchHandler(() => app);
  let closed = false;
  let timer;

  async function invoke(request, body) {
    const headers = new Headers(request.headers);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return appFetch(new Request(request.url, { method: request.method, headers, body: body === undefined ? undefined : body }));
  }
  function banner(html) {
    const note = '<aside class="pandit-warning preview-banner" role="note"><strong>DISPOSABLE SIMULATION — dummy files only. No production connection. Owner-approved policy: approved evidence 3 calendar years; pending evidence 90 days after last applicant activity; all rejected evidence 90 days from rejection; appeal window 30 days.</strong> <a href="/preview/start">start session</a> <a href="/preview/reset">reset session</a> <a href="/preview-dummy.pdf" download>Download built-in dummy PDF</a><p>Only the built-in dummy PDF and the exact owner-supplied dummy1.pdf placeholder inspected for this preview are accepted. Use either unchanged file for all three categories. Renaming another file to dummy1.pdf does not allow it. Never upload real personal documents. Profile fields are fixed synthetic fixtures. This preview expires after two hours. Start/reset session signs in again; it does not clear application progress.</p></aside>';
    return html.replace(/(<body[^>]*>)/i, `$1${note}`);
  }
  async function cleanup() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    await new Promise(resolve => gateway.close(() => resolve())).catch(() => {});
    gateway.closeAllConnections?.();
    try { app.closeDatabase(); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  const gateway = http.createServer(async (req, res) => {
    try {
      if (closed) throw Object.assign(new Error('Preview is closed.'), { status: 410 });
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const common = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
      if (req.method === 'GET' && url.pathname === '/preview-dummy.pdf') {
        res.writeHead(200, { ...common, 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="synthetic-test-only.pdf"' }); res.end(DUMMY_PDF); return;
      }
      if (req.method === 'GET' && url.pathname === '/preview/start') {
        const login = await invoke(new Request(`http://${req.headers.host}/api/auth/login`, { method: 'POST', headers: { Origin: `http://${req.headers.host}`, 'Content-Type': 'application/json' } }), JSON.stringify({ email: SYNTHETIC_EMAIL, password: SYNTHETIC_PASSWORD }));
        if (!login.ok) throw Object.assign(new Error('Synthetic login failed.'), { status: 503 });
        res.writeHead(303, { ...common, Location: '/?page=pandits', 'Set-Cookie': cookiesFrom(login) }); res.end(); return;
      }
      if (req.method === 'GET' && url.pathname === '/preview/reset') {
        const logout = await invoke(new Request(`http://${req.headers.host}/api/auth/logout`, { method: 'POST', headers: { Origin: `http://${req.headers.host}`, Cookie: req.headers.cookie || '' } }), '{}');
        res.writeHead(303, { ...common, Location: '/preview/start', 'Set-Cookie': cookiesFrom(logout) }); res.end(); return;
      }
      let bodyBytes = Buffer.alloc(0);
      if (!['GET', 'HEAD'].includes(req.method)) {
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > MAX_BODY) throw Object.assign(new Error('Request body exceeds the 3 MiB preview limit.'), { status: 413 });
        const chunks = []; let total = 0;
        for await (const chunk of req) { total += chunk.length; if (total > MAX_BODY) throw Object.assign(new Error('Request body exceeds the 3 MiB preview limit.'), { status: 413 }); chunks.push(chunk); }
        bodyBytes = Buffer.concat(chunks);
      }
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
        const allowedLogin = url.pathname === '/api/auth/login';
        const allowed = url.pathname === '/api/auth/logout' || url.pathname === '/api/pandit-application' || url.pathname === '/api/pandit-application/evidence' || allowedLogin;
        if (!allowed) throw Object.assign(new Error('This disposable gateway denies that write route.'), { status: 403 });
        let body; try { body = bodyBytes.length ? JSON.parse(bodyBytes.toString('utf8')) : {}; } catch { throw Object.assign(new Error('Expected a JSON request body.'), { status: 400 }); }
        if (allowedLogin && (body.email !== SYNTHETIC_EMAIL || body.password !== SYNTHETIC_PASSWORD)) throw Object.assign(new Error('Only the known synthetic account may log in through this gateway.'), { status: 403 });
        if (url.pathname === '/api/pandit-application') {
          if ((!onlyKeys(body, PROFILE_KEYS) && !onlyKeys(body, UI_PROFILE_KEYS)) || (Object.hasOwn(body, 'is_simulation') && body.is_simulation !== true) || body.display_name !== PROFILE.display_name || body.location !== PROFILE.location || body.description !== PROFILE.description || body.traditions !== PROFILE.traditions || body.languages !== PROFILE.languages || body.ritual_skills !== PROFILE.ritual_skills || body.experience_years !== PROFILE.experience_years || !['save', 'submit'].includes(body.action)) throw Object.assign(new Error('Only the fixed synthetic profile fields are permitted. Do not enter personal information in this simulation.'), { status: 400 });
          // The normal UI omits the immutable designation on updates. The gateway
          // always supplies it, after checking every other field against fixtures.
          bodyBytes = Buffer.from(JSON.stringify({ ...body, is_simulation: true }));
          req.headers['content-length'] = String(bodyBytes.length);
        }
        if (url.pathname.endsWith('/evidence') && (!onlyKeys(body, EVIDENCE_KEYS) || body.content_type !== 'application/pdf' || !isAllowedSyntheticPdf(body.content_base64) || !['GOVERNMENT_ID', 'BACKGROUND_CHECK', 'EDUCATION'].includes(body.kind))) throw Object.assign(new Error('This attempt was rejected; previously uploaded evidence is unchanged. This simulation accepts only the built-in dummy PDF or the exact inspected owner-supplied dummy1.pdf. Other files, including modified copies, are blocked; do not upload real documents.'), { status: 400 });
      } else if (url.pathname.startsWith('/api/admin/')) throw Object.assign(new Error('Administrative reads and writes are disabled in this disposable preview.'), { status: 403 });
      const forwarded = new Request(`http://${req.headers.host}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBytes });
      const response = await appFetch(forwarded);
      let data = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || '';
      if (req.method === 'GET' && url.pathname === '/' && contentType.includes('text/html')) data = Buffer.from(banner(data.toString('utf8')));
      if (req.method === 'GET' && url.pathname === '/app.js' && response.ok) data = Buffer.from(previewClientScript(data.toString('utf8')));
      const out = { ...jsonHeaders(response.headers), ...common, 'Content-Length': String(data.length) };
      res.writeHead(response.status, out); res.end(data);
    } catch (error) {
      const status = Number(error.status) || 500;
      res.writeHead(status, { ...commonErrorHeaders(), 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message || 'Preview request failed.' }));
    }
  });
  function commonErrorHeaders() { return { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff' }; }
  const start = (port = 3218, host = '0.0.0.0') => new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(port, host, () => { timer = setTimeout(cleanup, options.ttlMs || 2 * 60 * 60 * 1000); timer.unref?.(); resolve(gateway.address()); }); });
  gateway.on('close', () => { if (!closed) { try { app.closeDatabase(); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); closed = true; } });
  return { server: gateway, app, dataDir, dummyPdf: DUMMY_PDF, dummyPdfBase64: DUMMY_BASE64, account: { email: SYNTHETIC_EMAIL, password: SYNTHETIC_PASSWORD }, seeded, start, cleanup };
}

module.exports = { createDisposablePreview, previewClientScript, DUMMY_PDF, DUMMY_BASE64, PROFILE, SYNTHETIC_EMAIL, SYNTHETIC_PASSWORD };
