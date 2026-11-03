'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function ui() {
  const listeners = {};
  const context = vm.createContext({
    document: { querySelector: () => ({}), querySelectorAll: () => [], addEventListener: (name, fn) => { listeners[name] = fn; } },
    window: { addEventListener() {} }, URL, location: { origin: 'http://localhost', href: 'http://localhost/' },
    FormData: class {
      constructor(form) { this.data = new Map(Object.entries(form.values || {})); }
      set(k,v) { this.data.set(k,v); }
      entries() { return this.data.entries(); }
    }
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('(async function boot()')), context);
  vm.runInContext(`globalThis.ui = { state, bottomNav, panditApplicationForm, adminPanditsContent, formSubmit, actionClick, loadCommon };
    globalThis.sent=[]; globalThis.responses={}; globalThis.notices=[]; globalThis.loads=0;
    request=async (url,options)=>{const payload=options?.body?JSON.parse(options.body):{};sent.push({url,payload,method:options?.method});return responses[url]||{application:{status:payload.action}};};
    loadPage=async()=>{loads++;}; refreshNotifications=async()=>{}; toast=(message,error)=>notices.push({message,error});`, context);
  context.ui.state.user = { id: 'synthetic-viewer', name: 'SYNTHETIC TEST USER', role: 'user' };
  return { context, api: context.ui, listeners };
}
const policy = { approved_retention_years: 3, approved_retention_days: null, rejected_evidence_retention_days: 90, pending_evidence_retention_days: 90, rejected_background_check_retention_days: 90, rejected_education_retention_days: 90, appeal_days: 30, recheck_years: 2 };
const legacyPolicy = { approved_retention_years: null, approved_retention_days: 10, rejected_evidence_retention_days: 90, pending_evidence_retention_days: 90, rejected_background_check_retention_days: 90, rejected_education_retention_days: 90, appeal_days: 30, recheck_years: 2 }; // Disposable UI-test settings only.
const application = {
  id: 'synthetic-application', user_id: 'synthetic-applicant', is_simulation: true,
  display_name: 'SYNTHETIC TEST PROFILE — NOT A PERSON', location: 'Synthetic town',
  description: 'Synthetic test profile only.', languages: 'Synthetic', ritual_skills: 'Synthetic ritual',
  status: 'PENDING_VERIFICATION', revision: 7, submitted_at: '2030-01-01T00:00:00Z',
  evidence: [{ id: 'synthetic-evidence', kind: 'GOVERNMENT_ID', verified: 0, delete_after: '2030-04-01T00:00:00.000Z' }], approved_record_until: '2033-01-01T00:00:00.000Z', rejected_evidence_until: '2030-04-01T00:00:00.000Z', evidence_expired_at: '2030-04-02T00:00:00.000Z', appeal_status: 'OPENED'
};

test('Pandit save/submit intent preserves incomplete drafts without configured policy', async () => {
  const { context, api, listeners } = ui();
  const form = { dataset: { form: 'pandit-application' }, values: { revision: '0', display_name: '', experience_years: '' } };
  await listeners.submit({ target: { closest: () => form }, preventDefault() {}, submitter: { name: 'action', value: 'save' } });
  assert.equal(context.sent[0].payload.action, 'save');
  assert.equal(context.sent[0].payload.experience_years, 0);
  await api.formSubmit(form, { name: 'action', value: 'submit' });
  assert.equal(context.sent[1].payload.action, 'submit');
  const html = api.panditApplicationForm(null);
  assert.match(html, /value="save"[^>]*formnovalidate/);
  assert.doesNotMatch(html, /value="save"[^>]*disabled/);
  assert.match(html, /value="submit"[^>]*disabled/);
  assert.match(html, /data-evidence-kind="GOVERNMENT_ID"[^>]*disabled/);
  assert.match(html, />ACTION_REQUIRED<\/span>/);
});

test('Pandits and capability-based review remain reachable on mobile', async () => {
  const { api } = ui();
  assert.match(api.bottomNav(), /data-page="pandits"/);
  assert.doesNotMatch(api.bottomNav(), /data-page="pandit-review"/);
  api.state.panditCapabilities = { role: 'CHECKER' };
  assert.match(api.bottomNav(), /data-page="pandit-review"/);
  await api.actionClick({ dataset: { action: 'open-notification', link: '/?page=pandits' } });
  assert.equal(api.state.page, 'pandits');
});

test('Checker and Compliance have different private evidence and final-decision controls', () => {
  const { api } = ui();
  api.state.panditPolicy = policy;
  const checker = api.adminPanditsContent({ role: 'CHECKER', applications: [application] });
  assert.match(checker, /href="\/api\/admin\/pandits\/synthetic-application\/evidence\/synthetic-evidence" download=/);
  assert.match(checker, /data-action="pandit-verify"/);
  assert.match(checker, /option value="ACTION_REQUIRED"/);
  assert.doesNotMatch(checker, /option value="APPROVED"|content_base64|<iframe|<embed|private_note/);
  for (const suffix of ['status','feedback']) {
    assert.ok(checker.includes(`for="review-${suffix}-synthetic-application"`));
    assert.ok(checker.includes(`id="review-${suffix}-synthetic-application"`));
  }
  const compliance = api.adminPanditsContent({ role: 'COMPLIANCE', applications: [application] });
  assert.match(compliance, /Download private evidence/);
  assert.match(compliance, /option value="APPROVED"/);
  assert.match(compliance, /option value="REJECTED"/);
  assert.doesNotMatch(compliance, /data-action="pandit-verify"/);
  api.state.panditPolicy = null;
  const blocked = api.adminPanditsContent({ role: 'CHECKER', applications: [application] });
  assert.doesNotMatch(blocked, /data-action="pandit-verify"/);
  assert.match(blocked, /button class="button primary" disabled/);
});

test('review is closed outside pending state and self-review exposes no staff evidence controls', () => {
  const { api } = ui();
  api.state.panditPolicy = policy;
  const closed = api.adminPanditsContent({ role: 'CHECKER', applications: [{ ...application, status: 'APPROVED' }] });
  assert.doesNotMatch(closed, /data-form="pandit-review"|data-action="pandit-verify"/);
  const self = api.adminPanditsContent({ role: 'CHECKER', applications: [{ ...application, user_id: api.state.user.id }] });
  assert.match(self, /cannot review your own/);
  assert.doesNotMatch(self, /data-form="pandit-review"|data-action="pandit-verify"|Download private evidence/);
});

test('Super Admin sees policy, role assignment and escaped metadata audit, never evidence', () => {
  const { api } = ui();
  const html = api.adminPanditsContent({ role: 'SUPER_ADMIN', policy, applications: [application], reviews: [{ event: '<script>bad</script>', actor_id: 'synthetic-actor', created_at: '2030-01-01T00:00:00Z', content_base64: 'DO-NOT-RENDER', feedback: 'DO-NOT-RENDER' }] });
  assert.match(html, /data-form="pandit-policy"/);
  assert.match(html, /data-form="pandit-role"/);
  assert.match(html, /Metadata-only audit history/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|DO-NOT-RENDER|Download private evidence|data-form="pandit-review"|option value="SUPER_ADMIN"/);
});

test('applicant UI exposes bounded appeals and no-detail reverification triggers', () => {
  const { api } = ui();
  api.state.panditPolicy = policy;
  const open = api.panditApplicationForm({ ...application, status: 'REJECTED', appeal_until: '2999-01-01T00:00:00Z' });
  assert.match(open, /data-action="pandit-appeal"/);
  assert.match(open, /value="save"[^>]*disabled/);
  assert.match(open, /data-evidence-kind="GOVERNMENT_ID"[^>]*disabled/);
  assert.doesNotMatch(api.panditApplicationForm({ ...application, status: 'REJECTED', appeal_until: '2000-01-01T00:00:00Z' }), /data-action="pandit-appeal"/);
  const approved = api.panditApplicationForm({ ...application, status: 'APPROVED', reverify_at: '2031-01-01T00:00:00Z' });
  assert.match(approved, /Editing resets review/);
  assert.match(approved, /data-reason="BANK_DETAILS_CHANGED"/);
  assert.match(approved, /data-reason="OFFICIAL_ID_CHANGED"/);
  assert.doesNotMatch(approved, /name="bank|name="private_note|name="vetting_details|Download private evidence/);
});

test('ordinary-role staff submission refreshes queue without requiring the platform admin dashboard', async () => {
  const { context, api } = ui();
  api.state.admin = null;
  await api.formSubmit({ dataset: { form: 'pandit-review', id: application.id }, values: { revision: '7', status: 'ACTION_REQUIRED', feedback: 'Synthetic correction request.' } });
  assert.equal(context.sent[0].url, `/api/admin/pandits/${application.id}/review`);
  assert.equal(context.sent[0].payload.revision, 7);
  assert.equal(context.loads, 1);
  assert.ok(context.notices.every(n => !n.error));
});

test('evidence verification, appeal and reverification send minimal fresh-revision payloads', async () => {
  const { context, api } = ui();
  await api.actionClick({ dataset: { action: 'pandit-verify', id: application.id, evidence: 'synthetic-evidence', revision: '7', verified: 'true' } });
  assert.equal(context.sent[0].url, `/api/admin/pandits/${application.id}/evidence/synthetic-evidence/verify`);
  assert.equal(JSON.stringify(context.sent[0].payload), JSON.stringify({ revision: 7, verified: true }));
  await api.actionClick({ dataset: { action: 'pandit-appeal', revision: '8' } });
  assert.equal(context.sent[1].url, '/api/pandit-application/appeal');
  await api.actionClick({ dataset: { action: 'pandit-reverify', revision: '9', reason: 'BANK_DETAILS_CHANGED' } });
  assert.equal(JSON.stringify(context.sent[2].payload), JSON.stringify({ revision: 9, reason: 'BANK_DETAILS_CHANGED' }));
});

test('boot discovers reviewer capabilities and logout clears all private Pandit state', async () => {
  const { context, api } = ui();
  context.responses['/api/me'] = { user: { id: 'synthetic-viewer', name: 'SYNTHETIC TEST USER', role: 'user' } };
  context.responses['/api/pandit-application'] = { capabilities: { role: 'COMPLIANCE' }, policy, application, reviews: [] };
  await api.loadCommon();
  assert.equal(api.state.panditCapabilities.role, 'COMPLIANCE');
  api.state.panditReviewData = { applications: [application] };
  await api.actionClick({ dataset: { action: 'logout' } });
  assert.equal(api.state.panditReviewData, null);
  assert.equal(api.state.panditPolicy, null);
  assert.equal(api.state.panditApplication, null);
  assert.equal(api.state.panditCapabilities.role, null);
});

test('UI escapes profile text and every Pandit badge uses the exact status code', () => {
  const { api } = ui();
  assert.doesNotMatch(api.panditApplicationForm({ display_name: '<script>bad</script>' }), /<script>/);
  for (const status of ['PENDING_VERIFICATION','ACTION_REQUIRED','APPROVED','REJECTED']) {
    assert.match(api.panditApplicationForm({ ...application, status }), new RegExp(`>${status}<\\/span>`));
  }
});

test('evidence controls explain missing owner policy beside the inputs without bypassing it', () => {
  const { api } = ui();
  const html = api.panditApplicationForm({ ...application, status: 'ACTION_REQUIRED' });
  assert.match(html, /id="evidence-upload-help"[^>]*role="status">Uploads are paused until the owner approves exact approved-evidence retention, rejected-evidence retention, and appeal periods/);
  assert.match(html, /Do not upload real documents yet/);
  assert.equal((html.match(/aria-describedby="evidence-upload-help" disabled/g) || []).length, 3);
  assert.match(html, /value="submit"[^>]*disabled/);
  assert.doesNotMatch(html, /value="save"[^>]*disabled/);
});

test('save-first, saved-draft, rejected and simulation upload states stay distinct', () => {
  const { api } = ui();
  api.state.panditPolicy = policy; // Disposable UI fixture, not owner-approved settings.
  const unsaved = api.panditApplicationForm(null);
  assert.match(unsaved, /Save draft first to enable the file selectors/);
  assert.equal((unsaved.match(/aria-describedby="evidence-upload-help" disabled/g) || []).length, 3);
  const saved = api.panditApplicationForm({ ...application, status: 'ACTION_REQUIRED' });
  assert.equal((saved.match(/aria-describedby="evidence-upload-help" /g) || []).length, 3);
  assert.doesNotMatch(saved, /aria-describedby="evidence-upload-help" disabled/);
  assert.match(saved, /Choose a file to upload it immediately/);
  assert.match(saved, /SIMULATION — synthetic test profile only/);
  assert.match(saved, /Never use real ID, background-check, or education documents/);
  const rejected = api.panditApplicationForm({ ...application, status: 'REJECTED' });
  assert.match(rejected, /Evidence cannot be changed while rejected. Open an available appeal first/);
  assert.equal((rejected.match(/aria-describedby="evidence-upload-help" disabled/g) || []).length, 3);
});

test('policy UI presents the approved three-year default and accepts only one approved retention unit', () => {
  const { api } = ui();
  api.state.panditPolicy = policy;
  const ready = api.adminPanditsContent({ role: 'SUPER_ADMIN', policy, applications: [], reviews: [] });
  assert.match(ready, /Approved evidence retention \(calendar years\)/);
  assert.match(ready, /value="3"/);
  assert.match(ready, /rejected government IDs for 90 elapsed UTC day\(s\)/);
  assert.match(ready, /appeals for 30 elapsed UTC day\(s\)/);
  api.state.panditPolicy = legacyPolicy;
  assert.equal(api.state.panditPolicy.approved_retention_years, null);
  assert.match(api.adminPanditsContent({ role: 'SUPER_ADMIN', policy: legacyPolicy, applications: [], reviews: [] }), /legacy elapsed days/);
});

test('applicant and reviewer surfaces expose UTC evidence, retention, expiry, and appeal metadata', () => {
  const { api } = ui();
  api.state.panditPolicy = policy;
  const applicant = api.panditApplicationForm({ ...application, status: 'REJECTED', appeal_until: '2030-02-01T00:00:00.000Z' });
  assert.match(applicant, /<time datetime="2033-01-01T00:00:00.000Z">2033-01-01T00:00:00.000Z<\/time>/);
  assert.match(applicant, /Approved evidence removed at/);
  assert.match(applicant, /Rejected evidence final purge at/);
  assert.match(applicant, /Evidence expired at/);
  assert.match(applicant, /Appeal status:<\/strong> OPENED/);
  const reviewer = api.adminPanditsContent({ role: 'CHECKER', applications: [{ ...application, status: 'PENDING_VERIFICATION' }] });
  assert.match(reviewer, /removal at <time datetime="2030-04-01T00:00:00.000Z">/);
  assert.match(reviewer, /Approved evidence removed at/);
});

test('new owner-approved retention settings render, serialize exact 90 days, and explicit blanks remain null', async () => {
  const { context, api } = ui();
  api.state.panditPolicy = policy;
  const fields = ['pending_evidence_retention_days', 'rejected_background_check_retention_days', 'rejected_education_retention_days'];
  const html = api.adminPanditsContent({ role: 'SUPER_ADMIN', policy });
  for (const field of fields) assert.match(html, new RegExp(`name="${field}"[^>]*value="90"`));
  assert.match(html, /after last applicant activity/);
  assert.match(html, /from rejection/);
  const values = Object.fromEntries(Object.entries(policy).map(([key, value]) => [key, value == null ? '' : String(value)]));
  await api.formSubmit({ dataset: { form: 'pandit-policy' }, values });
  for (const field of fields) assert.equal(context.sent[0].payload[field], 90);
  await api.formSubmit({ dataset: { form: 'pandit-policy' }, values: { ...values, ...Object.fromEntries(fields.map(field => [field, ''])) } });
  for (const field of fields) assert.equal(context.sent[1].payload[field], null);
  for (const field of fields) {
    api.state.panditPolicy = { ...policy, [field]: null };
    assert.match(api.panditApplicationForm(application), /data-evidence-kind="GOVERNMENT_ID"[^>]*disabled/);
  }
});
