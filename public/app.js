'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const initials = value => String(value || 'H').trim().split(/\s+/).slice(0, 2).map(word => word[0] || '').join('').toUpperCase();
const icon = (name, size = 17) => {
  const paths = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/><path d="M3 10h18"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
    shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11z"/><path d="m9 12 2 2 4-4"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8z"/>',
    comment: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
    share: '<path d="M18 8a3 3 0 1 0-2.8-4M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8.7 16.2l6.6-3.4M8.7 14.8l6.6-3.4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pin: '<path d="m16 3 5 5-4 1-4 4 1 5-2 2-3-6-5-5 2-2 5 1 4-4z"/><path d="m3 21 6-6"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    flag: '<path d="M4 22V4m0 1c6-4 10 4 16 0v12c-6 4-10-4-16 0"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.3a1.7 1.7 0 1 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9h-.3a1.7 1.7 0 1 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2v-.3a1.7 1.7 0 1 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.3a1.7 1.7 0 1 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    arrow: '<path d="M5 12h14m-7-7 7 7-7 7"/>'
  };
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.home}</svg>`;
};
const dateTime = (value, options = {}) => { try { return new Intl.DateTimeFormat(undefined, { dateStyle: options.dateStyle || 'medium', ...(options.time ? { timeStyle: 'short' } : {}) }).format(new Date(value)); } catch { return value || ''; } };
const localDateTimeInput = value => { const date = new Date(value); if (!Number.isFinite(date.getTime())) return ''; date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0,16); };
const timeAgo = value => {
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${Math.max(1, Math.floor(diff / 60000))}m ago`;
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24); return days < 7 ? `${days}d ago` : dateTime(value);
};
const state = { user: null, page: 'feed', authMode: 'register', communities: [], categories: [], tags: [], posts: [], events: [], notifications: [], reports: [], admin: null, pandits: [], panditApplication: null, panditReviews: [], panditPolicy: null, panditCapabilities: { role: null }, panditReviewData: null, community: null, communitySection: 'posts', selectedCommunity: null, selectedEvent: null, expandedPosts: new Set(), adminTab: 'overview', reportFilter: 'open', modalCommunityId: null, search: '' };
const app = $('#app');

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  let value;
  try { value = await response.json(); }
  catch { throw new Error(response.ok ? 'The server returned an invalid response. Please try again.' : `Request failed (${response.status})`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The server returned an invalid response. Please try again.');
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}
const post = (path, data = {}) => request(path, { method: 'POST', body: JSON.stringify(data) });
const patch = (path, data = {}) => request(path, { method: 'PATCH', body: JSON.stringify(data) });
const del = path => request(path, { method: 'DELETE', body: JSON.stringify({}) });
function toast(message, error = false) {
  const region = $('#toast-region'); const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`; node.textContent = message; region.append(node); setTimeout(() => node.remove(), 3600);
}
let formLabelSequence = 0;
function associateFormLabels(root) {
  for (const field of $$('.form-field', root)) {
    const label = $('label', field);
    const control = $('input:not([type="hidden"]),textarea,select', field);
    if (!label || !control || label.htmlFor || label.contains?.(control)) continue;
    if (!control.id) control.id = `form-control-${++formLabelSequence}`;
    label.htmlFor = control.id;
  }
}
function enhancePageSemantics() {
  associateFormLabels(app);
  for (const button of $$('nav [data-page]', app)) {
    if (button.dataset.page === state.page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}
function focusMainContent() {
  const target = $('.main-column h1') || $('#main');
  if (target) { target.setAttribute('tabindex', '-1'); target.focus(); }
}
let modalRestoreFocus = null;
function showModal(title, subtitle, content, options = {}) {
  const previousFocus = document.activeElement;
  closeModal(false);
  modalRestoreFocus = previousFocus && !previousFocus.closest?.('#modal-root') ? previousFocus : null;
  const wrap = document.createElement('div'); wrap.className = 'modal-backdrop'; wrap.id = 'modal-root';
  const describedBy = subtitle ? ' aria-describedby="modal-subtitle"' : '';
  wrap.innerHTML = `<section class="modal${options.narrow ? ' narrow' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"${describedBy}><div class="modal-head"><div><h2 id="modal-title">${esc(title)}</h2>${subtitle ? `<p id="modal-subtitle">${esc(subtitle)}</p>` : ''}</div><button class="close-button" type="button" data-action="close-modal" aria-label="Close">×</button></div>${content}</section>`;
  wrap.addEventListener('click', event => { if (event.target === wrap) closeModal(); });
  wrap.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
    if (event.key !== 'Tab') return;
    const focusable = $$('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])', wrap);
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  document.body.append(wrap); associateFormLabels(wrap); app.inert = true; $('input,textarea,select,button', wrap)?.focus();
}
function closeModal(restore = true) {
  const modal = $('#modal-root');
  if (!modal) return;
  modal.remove(); app.inert = false;
  if (restore) { const target = modalRestoreFocus; modalRestoreFocus = null; target?.focus?.(); }
}
function authHeader() { return `<header class="topbar"><a class="brand" href="#" data-page="feed"><span class="brand-mark">H</span><span><span class="brand-name">Hometown Hub</span><span class="brand-sub">a home for your hometown</span></span></a><div class="top-actions"><span class="post-meta">A calmer place to stay connected</span></div></header>`; }
function navButton(page, label, iconName, badge = 0) { return `<button class="nav-button${state.page === page ? ' active' : ''}" data-page="${page}"${state.page === page ? ' aria-current="page"' : ''}>${icon(iconName)} ${label}${badge ? `<span class="badge">${badge}</span>` : ''}</button>`; }
function header() {
  const unread = state.notifications.filter(note => !note.read_at).length;
  return `<header class="topbar"><a class="brand" href="#" data-page="feed"><span class="brand-mark">H</span><span><span class="brand-name">Hometown Hub</span><span class="brand-sub">a home for your hometown</span></span></a><nav class="top-nav" aria-label="Main navigation">${navButton('feed','Home','home')}${navButton('communities','Communities','users')}${navButton('events','Events','calendar')}${navButton('pandits','Pandits','user')}${navButton('notifications','Updates','bell',unread)}${navButton('reports','My reports','flag')}${state.user.role === 'admin' ? navButton('admin','Admin','shield') : ''}${['CHECKER','COMPLIANCE','SUPER_ADMIN'].includes(state.panditCapabilities?.role) ? navButton('pandit-review','Review','shield') : ''}</nav><div class="top-actions"><button class="icon-button" data-action="open-profile" title="Edit profile" aria-label="Edit profile">${icon('user')}</button><button class="button secondary small" data-action="logout">Sign out</button><div class="user-chip"><span class="avatar">${esc(initials(state.user.name))}</span><span>${esc(state.user.name)}<small>${esc(state.user.hometown || 'Your hometown')}</small></span></div></div></header>`;
}
function sidebar() {
  const my = state.communities.filter(c => c.status === 'approved' && c.my_status === 'active');
  const links = my.slice(0, 6).map(c => `<button class="side-community" data-action="open-community" data-id="${esc(c.id)}"><span class="community-dot">${esc(initials(c.name).slice(0,1))}</span><span>${esc(c.name)}</span></button>`).join('');
  return `<aside class="sidebar"><div class="side-card"><div class="profile-mini"><span class="avatar">${esc(initials(state.user.name))}</span><div><strong>${esc(state.user.name)}</strong><small>${esc(state.user.hometown || 'Add your hometown')}</small></div></div><div class="side-label">Your space</div><nav class="side-nav"><button class="side-link${state.page==='feed'?' active':''}" data-page="feed">${icon('home')} Community feed</button><button class="side-link${state.page==='communities'?' active':''}" data-page="communities">${icon('users')} Find communities</button><button class="side-link${state.page==='events'?' active':''}" data-page="events">${icon('calendar')} Local events</button><button class="side-link${state.page==='pandits'?' active':''}" data-page="pandits">${icon('user')} Pandits</button><button class="side-link${state.page==='notifications'?' active':''}" data-page="notifications">${icon('bell')} Updates${state.notifications.some(n=>!n.read_at)?'<span class="badge">!</span>':''}</button><button class="side-link${state.page==='reports'?' active':''}" data-page="reports">${icon('flag')} My reports</button><button class="side-link" data-action="open-profile">${icon('user')} My profile</button>${state.user.role==='admin'?'<button class="side-link" data-page="admin">'+icon('shield')+' Platform admin</button>':''}${['CHECKER','COMPLIANCE','SUPER_ADMIN'].includes(state.panditCapabilities?.role)?'<button class="side-link" data-page="pandit-review">'+icon('shield')+' Review</button>':''}</nav><div class="side-label">Your communities</div>${links || '<p class="help-text">Your joined communities will show up here.</p>'}<button class="side-link" data-page="communities">${icon('plus')} Explore communities</button></div><p class="side-footnote">A thoughtful space for local connections. Be kind, protect personal details, and follow each community’s guidelines.</p></aside>`;
}
function rail() {
  const memberCommunities = state.communities.filter(c => c.status === 'approved' && c.my_status === 'active');
  const upcoming = state.events.filter(e => e.status === 'open' && new Date(e.starts_at) > new Date()).slice(0, 2);
  return `<aside class="right-rail"><section class="rail-card"><p class="eyebrow">Your local circle</p><h3>Small town energy, wherever you are.</h3><p>Follow the places and people that still feel like home.</p><div class="rail-link"><span><strong>Communities joined</strong><small>Only visible to you</small></span><span class="count-pill">${memberCommunities.length}</span></div><button class="button secondary small full" data-page="communities">Browse communities ${icon('arrow',14)}</button></section><section class="rail-card"><h3>Coming up</h3><p>Community-created events you’ve joined.</p>${upcoming.length ? upcoming.map(e=>`<div class="rail-link"><span><strong>${esc(e.title)}</strong><small>${esc(e.community_name)} · ${esc(dateTime(e.starts_at,{time:true}))}</small></span></div>`).join('') : '<p>No upcoming community events yet.</p>'}<button class="button subtle small full" data-page="events">Explore events</button></section><section class="rail-card"><h3>Community care</h3><p>Only share details you’re comfortable making visible to your community. Report content that feels unsafe or out of place.</p></section></aside>`;
}
function bottomNav() { return `<nav class="mobile-bottom" aria-label="Mobile navigation"><button class="${state.page==='feed'?'active':''}" data-page="feed">${icon('home')}<span>Home</span></button><button class="${state.page==='communities'?'active':''}" data-page="communities">${icon('users')}<span>Places</span></button><button class="${state.page==='events'?'active':''}" data-page="events">${icon('calendar')}<span>Events</span></button><button class="${state.page==='pandits'?'active':''}" data-page="pandits">${icon('user')}<span>Pandits</span></button><button class="${state.page==='notifications'?'active':''}" data-page="notifications">${icon('bell')}<span>Updates</span></button><button class="${state.page==='reports'?'active':''}" data-page="reports">${icon('flag')}<span>Reports</span></button>${state.user.role==='admin'?`<button class="${state.page==='admin'?'active':''}" data-page="admin">${icon('shield')}<span>Admin</span></button>`:''}${['CHECKER','COMPLIANCE','SUPER_ADMIN'].includes(state.panditCapabilities?.role)?`<button class="${state.page==='pandit-review'?'active':''}" data-page="pandit-review">${icon('shield')}<span>Review</span></button>`:''}</nav>`; }
function heading(eyebrow, title, description, action = '') { return `<div class="page-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ''}</div>${action}</div>`; }
function emptyState(title, detail, action = '') { return `<div class="empty-state"><span class="empty-icon">${icon('map',21)}</span><h3>${esc(title)}</h3><p>${esc(detail)}</p>${action}</div>`; }
function communitySelector(selectedId = '') { const joined = state.communities.filter(c=>c.status==='approved'&&c.my_status==='active'); return joined.map(c=>`<option value="${esc(c.id)}"${c.id===selectedId?' selected':''}>${esc(c.name)}</option>`).join(''); }
function composer(communityId = '') {
  const joined = state.communities.filter(c=>c.status==='approved'&&c.my_status==='active');
  if (!joined.length) return `<div class="welcome-banner"><h2>Find the places that feel like home.</h2><p>Join or create a hometown community to start sharing updates, asking for help, and planning something together.</p><button class="button primary" data-page="communities">Explore communities ${icon('arrow',14)}</button></div>`;
  return `<section class="panel composer"><div class="composer-top"><span class="avatar">${esc(initials(state.user.name))}</span><button class="composer-prompt" data-action="compose" data-community="${esc(communityId)}">Share something with your community…</button></div><div class="composer-bottom"><span>${icon('image',14)} Share a photo, question, or update</span><button class="button subtle small" data-action="compose" data-community="${esc(communityId)}">Create a post</button></div></section>`;
}
function postCard(p) {
  const expanded = state.expandedPosts.has(p.id);
  const canModerate = p.can_moderate || state.user.role === 'admin';
  return `<article class="post-card" id="post-${esc(p.id)}"><div class="post-head"><span class="avatar">${esc(initials(p.author_name))}</span><div class="post-head-main"><div class="post-author">${esc(p.author_name)}</div><div class="post-meta"><button data-action="open-community" data-id="${esc(p.community_id)}">${esc(p.community_name)}</button> · ${esc(timeAgo(p.created_at))}${p.pinned?` · ${icon('pin',12)} Pinned`:''}</div></div><span class="post-tag${p.kind==='announcement'?' announcement':''}">${esc(p.kind==='announcement'?'Announcement':p.category)}</span></div><p class="post-text">${esc(p.body)}</p>${p.image_path?`<img class="post-image" loading="lazy" src="${esc(p.image_path)}" alt="Image attached to a community post">`:''}<div class="post-actions"><button class="post-action${p.liked_by_me?' selected':''}" data-action="like" data-id="${esc(p.id)}">${icon('heart',15)} ${p.like_count||0} Like</button><button class="post-action" data-action="toggle-comments" data-id="${esc(p.id)}">${icon('comment',15)} ${p.comment_count||0} Comment</button><button class="post-action" data-action="share" data-id="${esc(p.id)}">${icon('share',15)} Share</button>${canModerate?`<button class="post-action" data-action="pin" data-id="${esc(p.id)}" data-pinned="${p.pinned?1:0}">${icon('pin',14)} ${p.pinned?'Unpin':'Pin'}</button>`:''}${canModerate||p.user_id===state.user.id?`<button class="post-action" data-action="delete-post" data-id="${esc(p.id)}">Remove</button>`:''}<button class="post-action danger-action" data-action="report" data-type="post" data-id="${esc(p.id)}">${icon('flag',14)} Report post</button></div>${expanded?`<div class="comments">${p.comments.map(c=>`<div class="comment-row"><strong>${esc(c.user_name)}</strong> ${esc(c.body)}${c.user_id===state.user.id||canModerate?` <button class="post-action" data-action="delete-comment" data-id="${esc(c.id)}">Remove</button>`:''}${c.user_id!==state.user.id?` <button class="post-action" data-action="report" data-type="comment" data-id="${esc(c.id)}">Report</button>`:''}</div>`).join('')}<form class="comment-form" data-form="comment" data-id="${esc(p.id)}"><input name="body" class="inline-input" aria-label="Your comment" maxlength="1200" placeholder="Add a kind, useful comment…" required><button class="button secondary small">Send</button></form></div>`:''}</article>`;
}
function feedContent(posts) {
  if (!posts.length) return emptyState('Your feed is ready for its first story.', 'Posts from communities you join will appear here. Start by finding your hometown community.', '<button class="button primary" data-page="communities">Find a community</button>');
  return `<div class="feed-list">${posts.map(postCard).join('')}</div>`;
}
function feedPage() {
  return `${heading('Your hometown, together','Community feed','Local notes, useful questions, and shared moments from your communities.')}${composer()}${feedContent(state.posts)}`;
}
function communityCard(c) {
  const status = c.status === 'pending' ? '<span class="status-label">Awaiting platform review</span>' : c.status === 'rejected' ? '<span class="status-label">Not approved</span>' : c.my_status === 'pending' ? '<span class="status-label">Request pending</span>' : '';
  const action = c.status !== 'approved' ? (c.created_by===state.user.id ? `<button class="button secondary small" disabled>Pending review</button>` : '') : c.my_status === 'active' ? `<button class="button secondary small" data-action="open-community" data-id="${esc(c.id)}">Open community</button>` : c.my_status === 'pending' ? `<button class="button secondary small" disabled>Request sent</button>` : `<button class="button primary small" data-action="join-community" data-id="${esc(c.id)}">Request to join</button>`;
  return `<article class="community-card" data-search="${esc((c.name+' '+c.location+' '+c.description+' '+c.category).toLowerCase())}"><div class="community-card-top"><span class="community-emblem">${esc(initials(c.name).slice(0,1))}</span><div><h3>${esc(c.name)}</h3><div class="community-location">${esc(c.location)} · ${Number(c.member_count)||0} member${Number(c.member_count)===1?'':'s'}</div></div></div><p>${esc(c.description)}</p><div class="tag-row"><span class="tag">${esc(c.category)}</span>${(c.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><div class="card-actions">${status}${action}</div></article>`;
}
function communitiesPage() {
  const approved = state.communities.filter(c=>c.status==='approved');
  const cards = state.communities.length ? state.communities.map(communityCard).join('') : '';
  return `${heading('Find your people','Communities','Discover hometown circles, local interest groups, and people who share your roots.', '<button class="button primary" data-action="create-community">'+icon('plus',15)+' Create a community</button>')}<div class="search-row"><input id="community-search" type="search" placeholder="Search by name, city, or topic" aria-label="Search communities"> <span class="count-pill">${approved.length} approved</span></div>${cards?`<div class="community-grid">${cards}</div>`:emptyState('No communities yet','When communities are created and approved, they’ll be listed here. You can submit the first request.','<button class="button primary" data-action="create-community">Create a community</button>')}`;
}
function eventCard(e) {
  const date = new Date(e.starts_at); const going = e.my_rsvp === 'going'; const atCapacity = e.capacity !== null && e.attendee_count >= e.capacity;
  const canManage = e.created_by===state.user.id||e.my_role==='moderator'||state.user.role==='admin';
  return `<article class="event-card" id="event-${esc(e.id)}"><div class="event-date"><strong>${date.toLocaleDateString(undefined,{day:'2-digit'})}</strong><small>${esc(date.toLocaleDateString(undefined,{month:'short'}))}</small></div><div class="event-community">${esc(e.community_name)}</div><h3>${esc(e.title)}</h3><p>${esc(e.description)}</p><div class="event-detail"><span>◷ ${esc(dateTime(e.starts_at,{time:true}))}</span><span>⌖ ${esc(e.location)}</span><span>${Number(e.attendee_count)||0}${e.capacity!==null?` / ${Number(e.capacity)}`:''} going</span></div><div class="event-footer"><span class="event-capacity">${e.status==='cancelled'?'Cancelled':atCapacity&&!going?'Capacity reached':going?'You’re going':'Community event'}</span><div>${canManage&&e.status==='open'?`<button class="button secondary small" data-action="edit-event" data-id="${esc(e.id)}">Edit</button><button class="button secondary small" data-action="cancel-event" data-id="${esc(e.id)}">Cancel</button>`:''}<button class="button ${going?'secondary':'primary'} small" data-action="rsvp" data-id="${esc(e.id)}" data-going="${going?1:0}" ${e.status==='cancelled'||(atCapacity&&!going)?'disabled':''}>${going?'Cancel RSVP':e.status==='cancelled'?'Cancelled':atCapacity?'Full':'I’m going'}</button></div></div></article>`;
}
function eventsPage() {
  const active = state.events.filter(e=>e.status==='open'); const cancelled = state.events.filter(e=>e.status!=='open');
  const action = state.communities.some(c=>c.status==='approved'&&c.my_status==='active')?`<button class="button primary" data-action="create-event">${icon('plus',15)} Create an event</button>`:'';
  return `${heading('Make time for each other','Community events','Gatherings created by members. Capacity is set by each event host.',action)}${active.length?`<div class="event-grid">${active.map(eventCard).join('')}</div>`:emptyState('No events on the calendar yet','Join a community and create a local gathering when you’re ready.','<button class="button primary" data-page="communities">Explore communities</button>')}${cancelled.length?`<h2 class="section-title section-title-spaced">Past or cancelled</h2><div class="event-grid">${cancelled.map(eventCard).join('')}</div>`:''}`;
}
function notificationsPage() {
  const action = state.notifications.some(n=>!n.read_at)?'<button class="button secondary small" data-action="mark-all-read">Mark all read</button>':'';
  return `${heading('Keep up with your circles','Updates','Membership requests, replies, and community news.',action)}${state.notifications.length?`<div class="notification-list">${state.notifications.map(n=>`<article class="notification-card${n.read_at?'':' unread'}"><span class="notification-dot"></span><div><p>${esc(n.message)}</p><small>${esc(timeAgo(n.created_at))}</small></div><div class="table-actions">${n.link?`<button class="button subtle small" data-action="open-notification" data-id="${esc(n.id)}" data-link="${esc(n.link)}">Open</button>`:''}<button class="button secondary small" data-action="mark-read" data-id="${esc(n.id)}" ${n.read_at?'disabled':''}>${n.read_at?'Read':'Mark read'}</button></div></article>`).join('')}</div>`:emptyState('Nothing new for now','Community notifications will appear here when there’s something to catch up on.')}`;
}
function reportStatusLabel(status) { return ({ open: 'Open', in_review: 'In review', resolved: 'Resolved', dismissed: 'Dismissed' })[status] || status; }
function reportsPage() {
  if(!state.reports.length) return `${heading('Your cases','My reports','Track reports you submit, share additional details, and request another review if needed.')}${emptyState('No reports submitted','Reports you send to platform administrators will appear here with their review status.')}`;
  const cases=state.reports.map(report=>{
    const messages=(report.messages||[]).map(message=>`<div class="report-message${message.author_role==='admin'?' admin-message':''}"><strong>${message.author_role==='admin'?'Platform admin':'You'}</strong><p>${esc(message.body)}</p><small>${esc(dateTime(message.created_at,{time:true}))}</small></div>`).join('');
    const history=(report.history||[]).map(item=>`<li>${esc(reportStatusLabel(item.from_status)||'Submitted')} → ${esc(reportStatusLabel(item.to_status))} · ${esc(dateTime(item.created_at,{time:true}))}</li>`).join('');
    const closed=report.status==='resolved'||report.status==='dismissed';
    return `<article class="panel report-case"><div class="report-case-head"><span class="report-status ${esc(report.status)}">${esc(reportStatusLabel(report.status))}</span><small>Submitted ${esc(dateTime(report.created_at))}</small></div><h3>${esc(report.target_type)}: ${esc(report.target_summary)}</h3><p class="report-context">${esc(report.target_context||'The reported item is no longer available.')}</p>${report.target_link?`<a class="report-link" href="${esc(report.target_link)}" target="_blank" rel="noopener noreferrer">Open reported item</a>`:''}<div class="report-detail"><h3>Your report</h3><p>${esc(report.reason)}</p></div><section class="report-thread"><h3>Case discussion</h3>${messages||'<p class="help-text">No follow-up messages yet.</p>'}</section>${history?`<details class="report-timeline"><summary>Case timeline</summary><ol>${history}</ol></details>`:''}<form class="stack-form report-reply" data-form="report-message" data-id="${esc(report.id)}"><div class="form-field"><label>${closed?'Appeal or request reopening':'Add information'}</label><textarea name="message" minlength="10" maxlength="1500" required placeholder="Share relevant details with the review team."></textarea><span class="help-text">${closed?'Sending this update will reopen the case for review.':'Your message will be visible to you and platform administrators.'}</span></div><button class="button ${closed?'secondary':'primary'} small">${closed?'Request another review':'Send update'}</button></form></article>`;
  }).join('');
  return `${heading('Your cases','My reports','Track reports you submit, share additional details, and request another review if needed.')}${cases}`;
}
function profilePage() {
  return `${heading('About you','Your profile','Keep your hometown details current for the communities you join.')}<section class="panel profile-panel"><div class="profile-top"><span class="avatar large">${esc(initials(state.user.name))}</span><div><h2>${esc(state.user.name)}</h2><p>${esc(state.user.email)} · Member since ${esc(dateTime(state.user.created_at))}</p></div></div><form class="stack-form" data-form="profile"><div class="form-grid"><div class="form-field"><label for="profile-name">Name</label><input id="profile-name" name="name" value="${esc(state.user.name)}" maxlength="80" required></div><div class="form-field"><label for="profile-hometown">Hometown or region</label><input id="profile-hometown" name="hometown" value="${esc(state.user.hometown||'')}" maxlength="120" placeholder="e.g. hometown, state / region"></div><div class="form-field full-span"><label for="profile-bio">A little about you</label><textarea id="profile-bio" name="bio" maxlength="400" placeholder="Share only what you’re comfortable making visible.">${esc(state.user.bio||'')}</textarea><span class="help-text">Your email is not shown in community posts. Community moderators can see your hometown when reviewing a membership request; your bio is not publicly displayed in this version.</span></div></div><button class="button primary profile-save-button">Save profile</button></form></section>`;
}
function communityPage() {
  const c = state.community;
  if (!c) return emptyState('Loading community…','Please wait a moment.');
  if (c.status !== 'approved') return `${heading('Community request','Awaiting review','This community request is not visible to the public until approved.')}<section class="panel admin-card"><h3>${esc(c.name)}</h3><p>${esc(c.location)} · ${esc(c.category)}</p><p>${esc(c.description)}</p><span class="status-label">${esc(c.status)}</span></section>`;
  const moderator = c.my_membership?.role === 'moderator' || state.user.role === 'admin';
  const tabs = `<div class="admin-tabs"><button class="admin-tab${state.communitySection==='posts'?' active':''}" data-action="community-section" data-section="posts">Posts</button><button class="admin-tab${state.communitySection==='events'?' active':''}" data-action="community-section" data-section="events">Events</button><button class="admin-tab${state.communitySection==='about'?' active':''}" data-action="community-section" data-section="about">About & rules</button>${moderator?`<button class="admin-tab" data-action="membership-requests">Member requests</button>`:''}</div>`;
  const body = state.communitySection === 'events' ? `${state.events.length?`<div class="event-grid">${state.events.map(eventCard).join('')}</div>`:emptyState('No events yet','Create the first get-together for this community.')}<button class="button primary community-create-event" data-action="create-event" data-community="${esc(state.selectedCommunity)}">${icon('plus',15)} Create event</button>`
    : state.communitySection === 'about' ? `<section class="panel admin-card"><h3>${esc(c.name)}</h3><p>${esc(c.description)}</p><p><strong>Location:</strong> ${esc(c.location)}</p><p><strong>Category:</strong> ${esc(c.category)}</p><p><strong>Members:</strong> ${Number(c.member_count)||0}</p><div class="rules-box">${esc(c.rules||'No community guidelines have been added yet.')}</div>${moderator?'<button class="button secondary small" data-action="edit-rules">Edit guidelines</button>':''}<button class="button danger small community-report-button" data-action="report" data-type="community" data-id="${esc(c.id)}">Report community</button></section>`
    : `${composer(state.selectedCommunity)}${state.posts.length?`<div class="feed-list">${state.posts.map(postCard).join('')}</div>`:emptyState('Start a good conversation.','There are no posts in this community yet.',`<button class="button primary" data-action="compose" data-community="${esc(state.selectedCommunity)}">Write the first post</button>`)}`;
  return `<div class="community-feed-head"><div><p class="eyebrow">${esc(c.location)} · ${esc(c.category)}</p><h2>${esc(c.name)}</h2><p>${Number(c.member_count)||0} members${c.my_membership?.role==='moderator'?' · You moderate this community':''}</p></div><button class="button secondary small" data-page="communities">All communities</button></div>${tabs}${body}`;
}
function adminTableCommunities(rows) {
  return rows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Community</th><th>Location</th><th>Requested by</th><th>Action</th></tr></thead><tbody>${rows.map(c=>`<tr><td><strong>${esc(c.name)}</strong><br>${esc(c.category)}</td><td>${esc(c.location)}</td><td>${esc(c.creator_name||'Member')}</td><td><div class="table-actions"><button class="button primary small" data-action="review-community" data-id="${esc(c.id)}" data-review="approve">Approve</button><button class="button danger small" data-action="review-community" data-id="${esc(c.id)}" data-review="reject">Decline</button></div></td></tr>`).join('')}</tbody></table></div>`:emptyState('No pending community requests','New community requests will show here when submitted.');
}
function formatPercent(value) { return value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}%`; }
function analyticsGrowthDetail(growth) {
  const direction = growth.growth_percent === null ? 'Growth rate needs a prior-period baseline.' : `${formatPercent(growth.growth_percent)} vs. the previous 30 days.`;
  return `+${Number(growth.current)||0} this period · ${Number(growth.previous)||0} in the prior period · ${direction}`;
}
function adminAnalyticsContent(analytics) {
  const a = analytics || {}, event = a.event_participation || { going_rsvps: 0, eligible_member_event_pairs: 0, rate_percent: null };
  const cards = [
    ['Daily active members (DAU)', Number(a.dau)||0, 'Unique non-admin members active today (UTC).'],
    ['Active members · 7d', Number(a.active_users_7d)||0, 'Unique non-admin members with activity in the last 7 UTC days.'],
    ['Active members · 30d', Number(a.active_users_30d)||0, 'Unique non-admin members with activity in the last 30 UTC days.'],
    ['Engaged members · 30d', `${Number(a.engaged_users_30d)||0} · ${formatPercent(a.engagement_rate_30d)}`, 'Members who posted, commented, liked, shared, or RSVP’d, as a share of 30-day active members.'],
    ['Posts with engagement · 30d', formatPercent(a.post_engagement_rate_30d), 'Share of posts created in the last 30 days that received at least one like, comment, or share.'],
    ['Upcoming event RSVP rate', formatPercent(event.rate_percent), `${Number(event.going_rsvps)||0} going RSVPs / ${Number(event.eligible_member_event_pairs)||0} active member-event opportunities; not verified attendance.`],
    ['Member growth · 30d', formatPercent(a.user_growth?.growth_percent), analyticsGrowthDetail(a.user_growth || { current: 0, previous: 0, growth_percent: null })],
    ['Community growth · 30d', formatPercent(a.community_growth?.growth_percent), analyticsGrowthDetail(a.community_growth || { current: 0, previous: 0, growth_percent: null })]
  ];
  const trend = a.daily_active_trend || [], max = Math.max(1, ...trend.map(day => Number(day.active_users)||0));
  const bars = trend.map(day => {
    const value = Number(day.active_users)||0, level = Math.min(8, Math.round(value / max * 8));
    const label = new Date(`${day.day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `<div class="analytics-bar-column" title="${esc(label)}: ${value} active members"><span class="analytics-bar level-${level}"></span><small>${esc(day.day.slice(-2))}</small><span class="sr-only">${esc(label)}: ${value} active members</span></div>`;
  }).join('');
  return `<div class="analytics-grid">${cards.map(([label,value,detail])=>`<article class="analytics-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><p>${esc(detail)}</p></article>`).join('')}</div><section class="admin-section analytics-trend"><h3>Daily active members · last 30 days</h3><p class="help-text">A member is counted once on a UTC day when they make an authenticated request to a core community feature.</p><div class="analytics-chart" role="img" aria-label="Daily active members for the last 30 days; most recent value ${Number(a.dau)||0}.">${bars||'<p>No activity has been recorded yet.</p>'}</div><details class="analytics-data"><summary>View daily activity data</summary><div class="table-wrap"><table class="data-table"><caption>Daily active members (UTC)</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Active members</th></tr></thead><tbody>${trend.map(day=>`<tr><th scope="row">${esc(day.day)}</th><td>${Number(day.active_users)||0}</td></tr>`).join('')||'<tr><td colspan="2">No activity has been recorded yet.</td></tr>'}</tbody></table></div></details></section><p class="help-text analytics-footnote">Growth compares approved communities or registered members created in the current 30-day period with the preceding 30 days. A rate is shown only when the prior period has a non-zero baseline. Activity is recorded at daily granularity; no third-party analytics service is used.</p>`;
}
function adminReportsContent(d) {
  const all = d.reports || [], filter = state.reportFilter || 'open';
  const rows = all.filter(report => filter === 'all' || report.status === filter);
  const options = [['open','Open'],['in_review','In review'],['resolved','Resolved'],['dismissed','Dismissed'],['all','All statuses']].map(([value,label])=>`<option value="${value}"${filter===value?' selected':''}>${label}</option>`).join('');
  const body = rows.length ? rows.map(report=>`<tr><td><strong>${esc(report.target_type)} · ${esc(report.target_summary)}</strong><br><small>${esc(report.target_context||'')}</small>${report.target_link?`<br><a class="report-link" href="${esc(report.target_link)}" target="_blank" rel="noopener noreferrer">Open original</a>`:''}</td><td>${esc(report.reason)}<br><small>Reported by ${esc(report.reporter_name)} · ${esc(dateTime(report.created_at))}</small></td><td><span class="report-status ${esc(report.status)}">${esc(reportStatusLabel(report.status))}</span>${report.resolved_at?`<br><small>Reviewed ${esc(dateTime(report.resolved_at))}</small>`:''}${report.resolution_note?`<br><small class="resolution-note">Admin note: ${esc(report.resolution_note)}</small>`:''}</td><td><button class="button secondary small" data-action="open-report" data-id="${esc(report.id)}">Review</button></td></tr>`).join('') : `<tr><td colspan="4">${filter==='open'?'No open reports.':`No ${esc(filter)} reports.`}</td></tr>`;
  return `<div class="report-toolbar"><label for="report-filter">Status</label><select id="report-filter">${options}</select><span class="help-text">Showing ${rows.length} of ${all.length} latest reports.</span></div><div class="table-wrap"><table class="data-table report-table"><thead><tr><th>Reported item</th><th>Concern and reporter</th><th>Case status / private note</th><th>Review</th></tr></thead><tbody>${body}</tbody></table></div><p class="help-text report-help-spaced">Reports are reviewed by people. Review notes are private to platform administrators; they are not shared with the reporter.</p>`;
}
function adminContent() {
  if (!state.admin) return emptyState('Loading admin workspace','Please wait a moment.');
  const d=state.admin, counts=d.counts;
  const tabs=['overview','analytics','communities','people','reports','categories'];
  const nav=`<div class="admin-tabs">${tabs.map(t=>`<button class="admin-tab${state.adminTab===t?' active':''}" data-action="admin-tab" data-tab="${t}">${t[0].toUpperCase()+t.slice(1)}</button>`).join('')}</div>`;
  let content='';
  if(state.adminTab==='analytics') content=adminAnalyticsContent(d.analytics);
  if(state.adminTab==='overview') content=`<div class="stat-grid">${[['Members',counts.users],['Communities',counts.communities],['Pending review',counts.pending_communities],['Posts',counts.posts],['Upcoming events',counts.upcoming_events],['Active reports',counts.open_reports]].map(([label,num])=>`<div class="stat-card"><strong>${Number(num)||0}</strong><span>${esc(label)}</span></div>`).join('')}</div><div class="admin-section"><h3>Community requests awaiting review</h3>${adminTableCommunities(d.communities)}</div><p class="help-text admin-overview-note">Counts are calculated from records in this project database; no sample activity is seeded.</p>`;
  if(state.adminTab==='communities') content=`<div class="admin-section"><h3>Community creation requests</h3>${adminTableCommunities(d.communities)}</div>`;
  if(state.adminTab==='people') content=`<div class="admin-section"><h3>Accounts</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>Name / email</th><th>Hometown</th><th>Role</th><th>Access</th><th>Action</th></tr></thead><tbody>${d.users.map(u=>`<tr><td><strong>${esc(u.name)}</strong><br>${esc(u.email)}</td><td>${esc(u.hometown||'—')}</td><td>${esc(u.role)}</td><td>${u.disabled?'Disabled':'Active'}</td><td>${u.role==='admin'?'—':`<button class="button ${u.disabled?'primary':'danger'} small" data-action="toggle-user" data-id="${esc(u.id)}" data-disabled="${u.disabled?1:0}">${u.disabled?'Enable':'Disable'}</button>`}</td></tr>`).join('')||'<tr><td colspan="5">No accounts.</td></tr>'}</tbody></table></div></div><div class="admin-section"><h3>Manage community moderators</h3><p class="help-text">Only active members of approved communities can be assigned moderator access.</p><div class="table-wrap"><table class="data-table"><thead><tr><th>Community</th><th>Member</th><th>Current role</th><th>Action</th></tr></thead><tbody>${d.memberships.map(m=>`<tr><td>${esc(m.community_name)}</td><td>${esc(m.user_name)}</td><td>${esc(m.role)}</td><td><button class="button secondary small" data-action="set-moderator" data-community="${esc(m.community_id)}" data-user="${esc(m.user_id)}" data-role="${m.role==='moderator'?'member':'moderator'}">${m.role==='moderator'?'Remove moderator':'Make moderator'}</button></td></tr>`).join('')||'<tr><td colspan="4">No active memberships yet.</td></tr>'}</tbody></table></div></div>`;
    if(state.adminTab==='reports') content=`<div class="admin-section"><h3>Abuse reports</h3><p class="help-text">Inspect reported content, record a private resolution note, or reopen a case for further review.</p>${adminReportsContent(d)}</div>`;
  if(state.adminTab==='categories') content=`<section class="panel admin-card"><h3>Content categories</h3><p class="help-text">Manage the choices members can use for posts and community descriptions. Existing records keep their original category label if it is removed.</p><div class="category-chips category-chips-spaced">${d.categories.map(c=>`<span class="category-chip">${esc(c.name)}${c.name==='General'?'':`<button aria-label="Remove ${esc(c.name)}" data-action="delete-category" data-name="${esc(c.name)}">×</button>`}</span>`).join('')}</div><form class="comment-form" data-form="category"><input class="inline-input" name="name" aria-label="New category name" maxlength="40" placeholder="New category name" required><button class="button primary small">Add category</button></form><div class="admin-section"><h3>Community tags</h3><p class="help-text">Tags are an administrator-managed vocabulary available when a member creates a community. Existing communities retain tags that have since been removed.</p><div class="category-chips category-chips-spaced">${d.tags.map(t=>`<span class="category-chip">${esc(t.name)}<button aria-label="Remove ${esc(t.name)}" data-action="delete-tag" data-name="${esc(t.name)}">×</button></span>`).join('')}</div><form class="comment-form" data-form="tag"><input class="inline-input" name="name" aria-label="New tag" maxlength="30" placeholder="New tag" required><button class="button primary small">Add tag</button></form></div></section>`;
  return `${heading('Platform operations','Admin dashboard','Review communities, manage accounts, and respond to member reports.')}${nav}<section class="panel admin-card">${content}</section>`;
}



function renderAuth() {
  const register=state.authMode==='register';
  app.innerHTML=`${authHeader()}<main id="main" class="auth-wrap"><section class="auth-story"><span class="auth-kicker">Rooted in where you’re from</span><h1>Your hometown.<br><em>Still part of you.</em></h1><p>A welcoming digital home for the places and people that shaped you. Catch up, share a local story, and make time for one another — wherever life takes you.</p><div class="story-points"><span class="story-point"><i class="story-check">✓</i> Find your community</span><span class="story-point"><i class="story-check">✓</i> Keep local traditions close</span><span class="story-point"><i class="story-check">✓</i> Plan a real-world get-together</span></div><div class="auth-footer">A private project prototype · No public communities or sample activity are preloaded.</div></section><section class="auth-card"><h2>${register?'Find your way back.':'Welcome home.'}</h2><p>${register?'Create an account to find or start a hometown community.':'Sign in to see what your communities are sharing.'}</p><div class="auth-switch"><button class="${register?'active':''}" data-action="auth-mode" data-mode="register">Create account</button><button class="${!register?'active':''}" data-action="auth-mode" data-mode="login">Sign in</button></div><form class="stack-form" data-form="auth"><input type="hidden" name="mode" value="${register?'register':'login'}">${register?`<div class="form-field"><label for="auth-name">Your name</label><input id="auth-name" name="name" maxlength="80" autocomplete="name" required placeholder="How people know you"></div>`:''}<div class="form-field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"></div><div class="form-field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="${register?'new-password':'current-password'}" minlength="10" maxlength="128" required placeholder="${register?'At least 10 characters':'Your password'}"></div><button class="button primary full">${register?'Create my account':'Sign in'}</button></form><p class="auth-notice">Your account details are stored by Hometown Hub to provide the service. Use an email and password you control; never share credentials in community posts.</p></section></main>`;
}
function render() {
  if (!state.user) { renderAuth(); enhancePageSemantics(); return; }
  const activePages=['feed','communities','events','pandits','notifications','reports','admin','pandit-review','community','profile'];
  if(!activePages.includes(state.page)) state.page='feed';
  app.innerHTML=`${header()}<main id="main" class="layout">${sidebar()}<section class="main-column">${mainContent()}</section>${rail()}</main>${bottomNav()}`;
  enhancePageSemantics();
}
async function loadCommon() {
  const [meta, me] = await Promise.all([request('/api/meta'), request('/api/me')]);
  state.categories=meta.categories||[]; state.tags=meta.tags||[]; state.user=me.user;
  if(state.user){ const [communities, notes]=await Promise.all([request('/api/communities'),request('/api/notifications')]); state.communities=communities.communities||[]; state.notifications=notes.notifications||[]; try { const mine=await request('/api/pandit-application'); state.panditCapabilities=mine.capabilities||{role:null}; state.panditPolicy=mine.policy||null; state.panditApplication=mine.application||null; state.panditReviews=mine.reviews||[]; } catch (error) { state.panditCapabilities={role:null}; state.panditPolicy=null; state.panditApplication=null; state.panditReviews=[]; state.panditReviewData=null; } }
}
async function loadPage() {
  if(state.page==='pandit-review'){state.panditReviewData=null;state.panditReviews=[];}
  render();
  if(!state.user)return;
  try {
    if(state.page==='feed') { const data=await request('/api/feed'); state.posts=data.posts||[]; }
    else if(state.page==='communities') { const data=await request('/api/communities'); state.communities=data.communities||[]; }
    else if(state.page==='events') { const data=await request('/api/events'); state.events=data.events||[]; }
    else if(state.page==='pandits') { const [directory, mine]=await Promise.all([request('/api/pandits'),request('/api/pandit-application')]); state.pandits=directory.pandits||[]; state.panditApplication=mine.application||null; state.panditReviews=mine.reviews||[]; state.panditPolicy=mine.policy||null; state.panditCapabilities=mine.capabilities||{role:null}; } else if(state.page==='pandit-review') { state.panditReviewData=null; state.panditReviews=[]; state.panditPolicy=null; const mine=await request('/api/pandit-application'); state.panditCapabilities=mine.capabilities||{role:null}; state.panditPolicy=mine.policy||null; if(state.panditCapabilities.role) state.panditReviewData=await request('/api/admin/pandits'); }
    else if(state.page==='notifications') { const data=await request('/api/notifications'); state.notifications=data.notifications||[]; }
    else if(state.page==='reports') { const data=await request('/api/reports'); state.reports=data.reports||[]; }
    else if(state.page==='community'&&state.selectedCommunity){
      const detail=await request(`/api/communities/${encodeURIComponent(state.selectedCommunity)}`); state.community=detail.community;
      if(state.community.status==='approved'&&state.community.my_membership?.status==='active'){
        if(state.communitySection==='events'){const data=await request(`/api/events?community=${encodeURIComponent(state.selectedCommunity)}`);state.events=data.events||[];}
        else if(state.communitySection==='posts'){const data=await request(`/api/feed?community=${encodeURIComponent(state.selectedCommunity)}`);state.posts=data.posts||[];}
      }
    }
    else if(state.page==='admin'&&state.user.role==='admin'){state.admin=await request('/api/admin/dashboard');}
    render();
    if(state.page==='events'&&state.selectedEvent)setTimeout(()=>document.getElementById(`event-${CSS.escape(state.selectedEvent)}`)?.scrollIntoView({behavior:'smooth',block:'center'}),120);
  } catch(error) { if(state.page==='pandit-review'){state.panditReviewData=null;render();} toast(error.message,true); if(error.message.includes('sign in')){state.user=null;render();} }
}
function openCreateCommunity() {
  const cats=state.categories.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const tags=state.tags.map(tag=>`<option value="${esc(tag)}">${esc(tag)}</option>`).join('');
  showModal('Create a community','Enter a community name (at least 3 characters), a city, village, or region (at least 2 characters), and a description of at least 20 characters. New communities require platform review.',`<form class="stack-form" data-form="create-community"><div class="form-grid"><div class="form-field"><label for="community-name">Community name</label><input id="community-name" name="name" minlength="3" maxlength="100" required placeholder="e.g. People from your hometown"><span class="help-text">Required · at least 3 characters.</span></div><div class="form-field"><label for="community-location">City, village, or region</label><input id="community-location" name="location" minlength="2" maxlength="120" required placeholder="Where the community is rooted"><span class="help-text">Required · at least 2 characters.</span></div><div class="form-field"><label>Category</label><select name="category" required>${cats}</select></div><div class="form-field"><label>Community tags</label><select name="tags" multiple size="4">${tags}</select><span class="help-text">Optional. Choose from the labels maintained by platform admins.</span></div><div class="form-field full-span"><label for="community-description">Description</label><textarea id="community-description" name="description" minlength="20" maxlength="1200" required placeholder="Who is this community for, and what will members do together?"></textarea><span class="help-text">Required · at least 20 characters.</span></div></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancel</button><button class="button primary">Submit for review</button></div></form>`);
}
function openComposer(communityId = '') {
  const options=communitySelector(communityId); if(!options){toast('Join an approved community before posting.',true);return;}
  const cats=state.categories.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  showModal('Share with your community','A useful update, question, or announcement can bring neighbors closer.',`<form class="stack-form" data-form="create-post"><div class="form-field"><label>Community</label><select name="community_id" required>${options}</select></div><div class="form-field"><label>Type</label><select name="kind"><option value="post">Community post</option><option value="announcement">Announcement</option></select></div><div class="form-field"><label>Category</label><select name="category">${cats}</select></div><div class="form-field"><label>Your message</label><textarea name="body" maxlength="4000" required placeholder="What would you like your community to know?"></textarea></div><div class="form-field"><label>Optional image</label><input name="image" type="file" accept="image/png,image/jpeg,image/webp"><span class="help-text">PNG, JPEG, or WebP · maximum 1.5 MB</span></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancel</button><button class="button primary">Publish post</button></div></form>`);
}
function openCreateEvent(communityId = '') {
  const options=communitySelector(communityId); if(!options){toast('Join an approved community before creating an event.',true);return;}
  showModal('Create a community event','Choose a future date and set the capacity if the venue has a limit.',`<form class="stack-form" data-form="create-event"><div class="form-field"><label>Community</label><select name="community_id" required>${options}</select></div><div class="form-grid"><div class="form-field"><label>Event name</label><input name="title" maxlength="120" required placeholder="A neighborhood get-together"></div><div class="form-field"><label>Location</label><input name="location" maxlength="160" required placeholder="Venue or meeting point"></div><div class="form-field"><label>Date and time</label><input name="starts_at" type="datetime-local" required></div><div class="form-field"><label>Capacity <span class="help-text">(optional)</span></label><input name="capacity" type="number" min="1" max="100000" placeholder="No limit"></div><div class="form-field full-span"><label>Details</label><textarea name="description" minlength="10" maxlength="1500" required placeholder="What should attendees know?"></textarea></div></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancel</button><button class="button primary">Create event</button></div></form>`);
}
function openEditEvent(id) {
  const event=state.events.find(item=>item.id===id);if(!event){toast('That event is no longer available.',true);return;}
  showModal('Edit community event','People who have RSVP’d will receive an update when event details change.',`<form class="stack-form" data-form="update-event" data-id="${esc(event.id)}"><div class="form-grid"><div class="form-field"><label>Event name</label><input name="title" maxlength="120" minlength="3" required value="${esc(event.title)}"></div><div class="form-field"><label>Location</label><input name="location" maxlength="160" minlength="2" required value="${esc(event.location)}"></div><div class="form-field"><label>Date and time</label><input name="starts_at" type="datetime-local" required value="${esc(localDateTimeInput(event.starts_at))}"></div><div class="form-field"><label>Capacity <span class="help-text">(optional)</span></label><input name="capacity" type="number" min="1" max="100000" value="${event.capacity===null?'':esc(event.capacity)}" placeholder="No limit"><span class="help-text">Cannot be set below current going RSVPs.</span></div><div class="form-field full-span"><label>Details</label><textarea name="description" minlength="10" maxlength="1500" required>${esc(event.description)}</textarea></div></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancel</button><button class="button primary">Save event</button></div></form>`);
}

function openReport(type,id) {
  showModal('Report content','Reports go to platform administrators for review. Please describe the concern clearly.',`<form class="stack-form" data-form="report" data-type="${esc(type)}" data-id="${esc(id)}"><div class="form-field"><label>What is the issue?</label><textarea name="reason" minlength="10" maxlength="1000" required placeholder="Describe why this should be reviewed."></textarea></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancel</button><button class="button danger">Submit report</button></div></form>`,{narrow:true});
}
function openReportReview(id) {
  const report=state.admin?.reports?.find(item=>item.id===id);if(!report){toast('That report is no longer available.',true);return;}
  const options=[['open','Open'],['in_review','In review'],['resolved','Resolved'],['dismissed','Dismissed']].map(([value,label])=>`<option value="${value}"${report.status===value?' selected':''}>${label}</option>`).join('');
  const link=report.target_link?`<p><a class="report-link" href="${esc(report.target_link)}" target="_blank" rel="noopener noreferrer">Open the reported item</a></p>`:'<p class="help-text">The reported account has no public content link.</p>';
  const messages=(report.messages||[]).map(message=>`<div class="report-message${message.author_role==='admin'?' admin-message':''}"><strong>${message.author_role==='admin'?'Platform admin':esc(message.author_name)}</strong><p>${esc(message.body)}</p><small>${esc(dateTime(message.created_at,{time:true}))}</small></div>`).join('');
  const history=(report.history||[]).map(item=>`<li>${esc(reportStatusLabel(item.from_status)||'Submitted')} → ${esc(reportStatusLabel(item.to_status))} · ${esc(item.actor_name)} · ${esc(dateTime(item.created_at,{time:true}))}</li>`).join('');
  showModal('Review abuse report',`Submitted by ${report.reporter_name} · ${dateTime(report.created_at)}. Administrator notes are private; responses are visible to the reporter.`, `<div class="report-detail"><strong>${esc(report.target_type)}: ${esc(report.target_summary)}</strong><p>${esc(report.target_context||'')}</p>${link}<h3>Reported concern</h3><p>${esc(report.reason)}</p></div><section class="report-thread"><h3>Reporter communication</h3>${messages||'<p class="help-text">No follow-up messages yet.</p>'}</section>${history?`<details class="report-timeline"><summary>Status history</summary><ol>${history}</ol></details>`:''}<form class="stack-form" data-form="review-report" data-id="${esc(report.id)}"><div class="form-field"><label for="report-status">Case status</label><select id="report-status" name="status" required>${options}</select></div><div class="form-field"><label for="report-response">Message to reporter <span class="help-text">(visible to the reporter)</span></label><textarea id="report-response" name="response" maxlength="1500" placeholder="Share a concise update or decision explanation."></textarea></div><div class="form-field"><label for="report-resolution-note">Private admin note <span class="help-text">(visible only to platform administrators)</span></label><textarea id="report-resolution-note" name="resolution_note" maxlength="1000" placeholder="Record internal review notes or next steps.">${esc(report.resolution_note||'')}</textarea></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancel</button><button class="button primary">Save review</button></div></form>`);
}
async function fileAsDataUrl(file) {
  if(!file)return '';
  if(file.size>1_500_000)throw new Error('Image must be 1.5 MB or smaller.');
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read the selected image.'));reader.readAsDataURL(file);});
}
async function formSubmit(form, submitter = null) {
  const data=new FormData(form);
  if(submitter?.name)data.set(submitter.name,submitter.value);
  const value=Object.fromEntries(data.entries());
  try {
    const kind=form.dataset.form;
    if(kind==='pandit-application'){
      const payload={action:value.action,revision:Number(value.revision||0),display_name:value.display_name,location:value.location,description:value.description,traditions:value.traditions,languages:value.languages,ritual_skills:value.ritual_skills,experience_years:value.experience_years===''?0:Number(value.experience_years)};
      const result=await post('/api/pandit-application',payload); state.panditApplication=result.application; toast(value.action==='submit'?'Application submitted for administrator review.':'Draft saved.'); await loadPage();
    }
    if(kind==='pandit-withdraw'){await post('/api/pandit-application/withdraw',{revision:Number(value.revision||0)});toast('Application withdrawn and hidden from the directory.');await loadPage();}
    if(kind==='pandit-review'){await post(`/api/admin/pandits/${form.dataset.id}/review`,{status:value.status,revision:Number(value.revision),feedback:value.feedback});toast('Pandit review saved.');state.panditReviewData=null;await loadPage();}
    if(kind==='pandit-policy'){
      const approvedYears=value.approved_retention_years===''?null:Number(value.approved_retention_years); const payload={approved_retention_years:approvedYears,approved_retention_days:approvedYears===null&&value.approved_retention_days!==''?Number(value.approved_retention_days):null,rejected_evidence_retention_days:value.rejected_evidence_retention_days===''?null:Number(value.rejected_evidence_retention_days),appeal_days:value.appeal_days===''?null:Number(value.appeal_days),...Object.fromEntries(['pending_evidence_retention_days','rejected_background_check_retention_days','rejected_education_retention_days'].map(k=>[k,value[k]===''?null:Number(value[k])])),recheck_years:Number(value.recheck_years)};
      const result=await request('/api/admin/pandits/policy',{method:'PUT',body:JSON.stringify(payload)}); state.panditPolicy=result.policy; state.panditReviewData=null; toast('Pandit policy saved.'); await loadPage();
    }
    if(kind==='pandit-role'){
      const role=value.role===''?null:value.role; await post('/api/admin/pandits/roles',{user_id:value.user_id,role}); state.panditReviewData=null; state.panditReviews=[]; state.panditPolicy=null; state.panditCapabilities={role:null}; toast('Reviewer role updated.'); await loadPage();
    }
    if(kind==='auth'){
      const mode=value.mode;
      if(mode==='register'){
        const result=await post('/api/auth/register',{name:value.name,email:value.email,password:value.password});
        state.authMode='login'; render();
        const intro=$('.auth-card > p'); if(intro){intro.textContent=result.message;intro.setAttribute('role','status');intro.setAttribute('aria-live','polite');}
        const email=$('#auth-email'); if(email){email.value=value.email;email.focus();}
        return;
      }
      const result=await post('/api/auth/login',{email:value.email,password:value.password}); state.user=result.user; await loadCommon(); applyDeepLink(); toast('You’re signed in.'); await loadPage(); if(location.hash)window.dispatchEvent(new Event('hashchange'));
    }
    if(kind==='create-community'){
      const tags=[...form.elements.tags.selectedOptions].map(option=>option.value);
      await post('/api/communities',{name:value.name,location:value.location,description:value.description,category:value.category,tags}); closeModal(); state.communities=(await request('/api/communities')).communities; toast('Community request submitted for platform review.'); await loadPage();
    }
    if(kind==='create-post'){
      const file=form.elements.image.files[0];const image=file?await fileAsDataUrl(file):'';
      await post('/api/posts',{community_id:value.community_id,kind:value.kind,category:value.category,body:value.body,image});closeModal();toast('Your post has been shared.');await refreshNotifications();await loadPage();
    }
    if(kind==='create-event'){
      await post('/api/events',{community_id:value.community_id,title:value.title,location:value.location,description:value.description,starts_at:new Date(value.starts_at).toISOString(),capacity:value.capacity||null});closeModal();toast('Event created.');await refreshNotifications();await loadPage();
    }
    if(kind==='update-event'){
      await patch(`/api/events/${form.dataset.id}`,{title:value.title,location:value.location,description:value.description,starts_at:new Date(value.starts_at).toISOString(),capacity:value.capacity||null});closeModal();toast('Event details updated.');await refreshNotifications();await loadPage();
    }
    if(kind==='comment'){
      await post(`/api/posts/${form.dataset.id}/comments`,{body:value.body});state.expandedPosts.add(form.dataset.id);toast('Comment added.');await loadPage();
    }
    if(kind==='profile'){
      const result=await post('/api/profile',{name:value.name,hometown:value.hometown,bio:value.bio});state.user={...state.user,...result.user};toast('Profile updated.');await loadPage();
    }
    if(kind==='report'){
      await post('/api/reports',{target_type:form.dataset.type,target_id:form.dataset.id,reason:value.reason});closeModal();toast('Report sent to the platform review queue.');state.page='reports';await loadPage();
    }
    if(kind==='report-message'){
      const result=await post(`/api/reports/${form.dataset.id}/messages`,{message:value.message});toast(result.status==='open'?'Your update was sent and the case reopened for review.':'Your update was sent.');await loadPage();
    }
    if(kind==='review-report'){
      await post(`/api/admin/reports/${form.dataset.id}/resolve`,{status:value.status,resolution_note:value.resolution_note,response:value.response});closeModal();toast(value.status==='open'?'Report reopened.':value.status==='in_review'?'Report marked in review.':'Report review saved.');state.admin=await request('/api/admin/dashboard');await loadPage();
    }
    if(kind==='rules'){
      await post(`/api/communities/${state.selectedCommunity}/rules`,{rules:value.rules});closeModal();toast('Community guidelines updated.');await loadPage();
    }
    if(kind==='category'){
      await post('/api/admin/categories',{name:value.name});toast('Category added.');state.admin=await request('/api/admin/dashboard');await loadPage();
    }
    if(kind==='tag'){
      await post('/api/admin/tags',{name:value.name});toast('Community tag added.');state.admin=await request('/api/admin/dashboard');state.tags=state.admin.tags.map(tag=>tag.name);await loadPage();
    }
  } catch(error) { toast(error.message,true); }
}
async function refreshNotifications(){try{const d=await request('/api/notifications');state.notifications=d.notifications||[];}catch{}}
async function actionClick(button) {
  const action=button.dataset.action,id=button.dataset.id;
  try {
    if(action==='pandit-verify'){
      await post(`/api/admin/pandits/${id}/evidence/${button.dataset.evidence}/verify`,{revision:Number(button.dataset.revision),verified:button.dataset.verified==='true'});
      state.panditReviewData=null; toast(button.dataset.verified==='true'?'Evidence marked verified.':'Evidence marked not verified.'); await loadPage();
    }
    if(action==='pandit-appeal'){
      const result=await post('/api/pandit-application/appeal',{revision:Number(button.dataset.revision)}); state.panditApplication=result.application; toast('Appeal opened.'); await loadPage();
    }
    if(action==='pandit-reverify'){
      const result=await post('/api/pandit-application/reverify',{revision:Number(button.dataset.revision),reason:button.dataset.reason}); state.panditApplication=result.application; toast('Reverification requested.'); await loadPage();
    }
    if(action==='close-modal')closeModal();
    if(action==='reload')location.reload();
    if(action==='logout'){await post('/api/auth/logout');state.user=null;state.page='feed';state.posts=[];state.communities=[];state.pandits=[];state.panditApplication=null;state.panditReviews=[];state.panditPolicy=null;state.panditCapabilities={role:null};state.panditReviewData=null;state.admin=null;render();}
    if(action==='auth-mode'){state.authMode=button.dataset.mode;render();}
    if(action==='open-profile'){state.page='profile';await loadPage();}
    if(action==='create-community')openCreateCommunity();
    if(action==='compose')openComposer(button.dataset.community||'');
    if(action==='create-event')openCreateEvent(button.dataset.community||'');
    if(action==='open-community'){state.selectedCommunity=id;state.communitySection='posts';state.page='community';await loadPage();}
    if(action==='join-community'){await post(`/api/communities/${id}/join`,{});toast('Join request sent to the community moderators.');state.communities=(await request('/api/communities')).communities;await loadPage();}
    if(action==='toggle-comments'){state.expandedPosts.has(id)?state.expandedPosts.delete(id):state.expandedPosts.add(id);render();}
    if(action==='like'){await post(`/api/posts/${id}/like`,{});await loadPage();}
    if(action==='share'){
      const result=await post(`/api/posts/${id}/share`,{});const full=new URL(result.url,location.origin).href;
      try{if(navigator.share)await navigator.share({title:'Hometown Hub post',url:full});else{await navigator.clipboard.writeText(full);toast('Community post link copied.');}}catch(error){if(error.name!=='AbortError')toast('Link ready to share: '+full);}
    }
    if(action==='pin'){await post(`/api/posts/${id}/pin`,{pinned:button.dataset.pinned!=='1'});toast(button.dataset.pinned==='1'?'Post unpinned.':'Post pinned.');await loadPage();}
    if(action==='delete-post'){if(confirm('Remove this post and its comments?')){await del(`/api/posts/${id}`);toast('Post removed.');await loadPage();}}
    if(action==='delete-comment'){if(confirm('Remove this comment?')){await del(`/api/comments/${id}`);toast('Comment removed.');await loadPage();}}
    if(action==='report')openReport(button.dataset.type,id);
    if(action==='rsvp'){const going=button.dataset.going==='1';await post(`/api/events/${id}/rsvp`,{action:going?'cancel':'going'});toast(going?'RSVP cancelled.':'You’re on the list.');await loadPage();}
    if(action==='cancel-event'){if(confirm('Cancel this event? People who RSVP’d will be notified.')){await del(`/api/events/${id}`);toast('Event cancelled.');await refreshNotifications();await loadPage();}}
    if(action==='edit-event')openEditEvent(id);
    if(action==='community-section'){state.communitySection=button.dataset.section;await loadPage();}
    if(action==='edit-rules'){
      const current=state.community?.rules||'';showModal('Community guidelines','Keep the rules clear, welcoming, and relevant.',`<form class="stack-form" data-form="rules"><div class="form-field"><label>Guidelines</label><textarea name="rules" maxlength="3000" placeholder="Share community-specific expectations.">${esc(current)}</textarea></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancel</button><button class="button primary">Save guidelines</button></div></form>`);
    }
    if(action==='membership-requests'){
      const r=await request(`/api/communities/${state.selectedCommunity}/requests`);
      showModal('Membership requests','Review requests from people who would like to join.',r.requests.length?`<div class="feed-list">${r.requests.map(u=>`<article class="notification-card"><span class="avatar">${esc(initials(u.name))}</span><div><p><strong>${esc(u.name)}</strong>${u.hometown?' · '+esc(u.hometown):''}</p><small>${esc(dateTime(u.requested_at))}</small></div><div class="table-actions"><button class="button primary small" data-action="membership-decision" data-community="${esc(state.selectedCommunity)}" data-user="${esc(u.id)}" data-decision="approve">Approve</button><button class="button danger small" data-action="membership-decision" data-community="${esc(state.selectedCommunity)}" data-user="${esc(u.id)}" data-decision="reject">Decline</button></div></article>`).join('')}</div>`:emptyState('No requests right now','New member requests will appear here.'),{narrow:true});
    }
    if(action==='membership-decision'){await post(`/api/communities/${button.dataset.community}/requests/${button.dataset.user}`,{action:button.dataset.decision});toast(button.dataset.decision==='approve'?'Member approved.':'Request declined.');button.closest('.notification-card')?.remove();await refreshNotifications();}
    if(action==='mark-read'){await post(`/api/notifications/read/${id}`,{});await refreshNotifications();await loadPage();}
    if(action==='mark-all-read'){await post('/api/notifications/read',{});await loadPage();}
    if(action==='open-notification'){
      if(id)await post(`/api/notifications/read/${id}`,{});
      const destination=new URL(button.dataset.link,location.origin);
      if(destination.origin!==location.origin)throw new Error('That notification destination is not valid.');
      const community=destination.searchParams.get('community'),event=destination.searchParams.get('event');
      if(community){state.selectedCommunity=community;state.communitySection='posts';state.page='community';}
      else if(event){state.selectedEvent=event;state.page='events';}
      else if(destination.searchParams.get('page')==='pandits'){state.page='pandits';state.selectedCommunity=null;state.selectedEvent=null;}
      await refreshNotifications();await loadPage();
    }
    if(action==='admin-tab'){state.adminTab=button.dataset.tab;if(state.adminTab==='pandits'&&state.admin){state.admin.pandits=await request('/api/admin/pandits');}render();}
    if(action==='open-report')openReportReview(id);
    if(action==='review-community'){await post(`/api/admin/communities/${id}/review`,{action:button.dataset.review});toast(button.dataset.review==='approve'?'Community approved.':'Community declined.');state.admin=await request('/api/admin/dashboard');await loadPage();}
    if(action==='toggle-user'){const disabled=button.dataset.disabled!=='1';await post(`/api/admin/users/${id}/status`,{disabled});toast(disabled?'Account disabled.':'Account enabled.');state.admin=await request('/api/admin/dashboard');await loadPage();}
    if(action==='delete-category'){if(confirm(`Remove category “${button.dataset.name}” from the available choices? Existing posts remain unchanged.`)){await del(`/api/admin/categories/${encodeURIComponent(button.dataset.name)}`);state.admin=await request('/api/admin/dashboard');state.categories=state.admin.categories.map(c=>c.name);await loadPage();}}
    if(action==='delete-tag'){if(confirm(`Remove tag “${button.dataset.name}” from the available choices? Existing communities keep their tag.`)){await del(`/api/admin/tags/${encodeURIComponent(button.dataset.name)}`);state.admin=await request('/api/admin/dashboard');state.tags=state.admin.tags.map(tag=>tag.name);await loadPage();}}
    if(action==='set-moderator'){const role=button.dataset.role;await post(`/api/admin/communities/${button.dataset.community}/members/${button.dataset.user}/role`,{role});toast(role==='moderator'?'Moderator role assigned.':'Moderator role removed.');state.admin=await request('/api/admin/dashboard');await loadPage();}
  } catch(error) { toast(error.message,true); }
}

document.addEventListener('click', async event => {
  const nav=event.target.closest('[data-page]');
  if(nav){event.preventDefault();state.page=nav.dataset.page;state.selectedCommunity=null;state.selectedEvent=null;state.community=null;state.communitySection='posts';await loadPage();focusMainContent();return;}
  const button=event.target.closest('[data-action]');if(button){event.preventDefault();await actionClick(button);}
});
document.addEventListener('submit', async event => {
  const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();await formSubmit(form,event.submitter);
});
document.addEventListener('input', event=>{
  if(event.target.id==='community-search'){
    const term=event.target.value.trim().toLowerCase();$$('.community-card').forEach(card=>card.hidden=!card.dataset.search.includes(term));
  }
});
document.addEventListener('change', event=>{
  if(event.target.id==='report-filter'){state.reportFilter=event.target.value;render();}
});
window.addEventListener('hashchange',()=>{const id=location.hash.replace(/^#post-/,'');if(id){state.expandedPosts.add(id);setTimeout(()=>document.getElementById(`post-${CSS.escape(id)}`)?.scrollIntoView({behavior:'smooth',block:'center'}),150);}});
function applyDeepLink(){const url=new URL(location.href),community=url.searchParams.get('community'),event=url.searchParams.get('event'),page=url.searchParams.get('page'); if(page==='pandits')state.page='pandits';if(community){state.selectedCommunity=community;state.page='community';if(location.hash.startsWith('#post-'))state.expandedPosts.add(location.hash.slice(6));}else if(event){state.selectedEvent=event;state.page='events';}}

/* Pandit application contract: only public profile fields are collected; evidence stays private. */
function panditStatusLabel(status){return ({ACTION_REQUIRED:'Action required',PENDING_VERIFICATION:'Pending verification',APPROVED:'Approved',REJECTED:'Rejected'})[status]||'Action required';}
function panditBadge(status){return `<span class="pandit-status ${esc(status||'ACTION_REQUIRED')}"><span class="sr-only">Status: </span>${esc(status||'ACTION_REQUIRED')}</span>`;}
function panditField(name,label,value,opts={}){const type=opts.type||'text', id=`pandit-${name}`, val=esc(value??''); const attrs=`id="${id}" name="${name}" value="${type==='textarea'?'':val}" maxlength="${opts.max||300}" ${opts.min?`minlength="${opts.min}"`:''} ${opts.required?'required':''} ${type==='number'?'min="0"':''}`; return `<div class="form-field${opts.full?' full-span':''}"><label for="${id}">${esc(label)}</label>${type==='textarea'?`<textarea ${attrs}>${val}</textarea>`:`<input type="${type}" ${attrs}>`}</div>`;}
function policyReady(){const p=state.panditPolicy||{};const years=Number(p.approved_retention_years),days=Number(p.approved_retention_days);return !!(p&&!(years>0&&days>0)&&(years>0||days>0)&&['rejected_evidence_retention_days','pending_evidence_retention_days','rejected_background_check_retention_days','rejected_education_retention_days','appeal_days'].every(k=>Number.isSafeInteger(p[k])&&p[k]>0)&&[1,2].includes(Number(p.recheck_years)));}
function utcTime(value){return value?`<time datetime="${esc(value)}">${esc(value)}</time>`:'<span>Not set</span>';}
function applicationRetentionSummary(a){const parts=[];if(a?.approved_record_until)parts.push(`<span><strong>Approved evidence removed at:</strong> ${utcTime(a.approved_record_until)}</span>`);if(a?.rejected_evidence_until)parts.push(`<span><strong>Rejected evidence final purge at:</strong> ${utcTime(a.rejected_evidence_until)}</span>`);if(a?.evidence_expired_at)parts.push(`<span><strong>Evidence expired at:</strong> ${utcTime(a.evidence_expired_at)}</span>`);if(a?.appeal_status)parts.push(`<span><strong>Appeal status:</strong> ${esc(a.appeal_status)}</span>`);return parts.length?`<div class="pandit-retention" aria-label="Retention and appeal dates">${parts.join(' · ')}</div>`:'';}
function evidenceUploadBlockReason(a){if(!policyReady())return 'Uploads are paused until the owner approves exact approved-evidence retention, rejected-evidence retention, and appeal periods. You can still save a draft. Do not upload real documents yet.';if(!a?.id)return 'Save draft first to enable the file selectors.';if(a.status==='REJECTED')return 'Evidence cannot be changed while rejected. Open an available appeal first.';return '';}
function evidenceList(a, role){return (a?.evidence||[]).map(e=>{const link=['CHECKER','COMPLIANCE'].includes(role)&&a.user_id!==state.user?.id?`<a href="/api/admin/pandits/${esc(encodeURIComponent(a.id))}/evidence/${esc(encodeURIComponent(e.id))}" download="private-${esc(e.kind.toLowerCase())}" class="evidence-download">Download private evidence</a>`:''; const deadline=e.delete_after?` <span class="help-text">removal at ${utcTime(e.delete_after)}</span>`:''; const verify=role==='CHECKER'&&a.status==='PENDING_VERIFICATION'&&a.user_id!==state.user?.id&&policyReady()?` <button type="button" class="button secondary small" data-action="pandit-verify" data-id="${esc(a.id)}" data-evidence="${esc(e.id)}" data-revision="${Number(a.revision||0)}" data-verified="${e.verified?'false':'true'}">${e.verified?'Mark not verified':'Verify evidence'}</button>`:''; return `<li><span>${esc(e.kind)} — ${e.verified?'VERIFIED':'NOT VERIFIED'}</span>${deadline}${link}${verify}</li>`}).join('')||'<li>No evidence uploaded.</li>';}
function panditApplicationForm(a){a=a||{}; const uploadBlock=evidenceUploadBlockReason(a); const status=a.status||'ACTION_REQUIRED', locked=status==='REJECTED', appealOpen=status==='REJECTED'&&a.appeal_until&&new Date(a.appeal_until)>new Date(), canSubmit=policyReady()&&(a.evidence||[]).every(e=>['GOVERNMENT_ID','BACKGROUND_CHECK','EDUCATION'].includes(e.kind))&&new Set((a.evidence||[]).map(e=>e.kind)).size===3&&status!=='REJECTED'; return `<section class="panel pandit-apply"><div class="section-heading"><div><p class="eyebrow">Your application</p><h2>${a.id?'Update your Pandit profile':'Share your practice'}</h2></div>${panditBadge(status)}</div><p class="help-text">Approval is a platform review, not certification. Only approved profile fields appear in the signed-in directory. Never enter ID numbers or bank details.</p>${['APPROVED','PENDING_VERIFICATION'].includes(status)?'<p class="pandit-warning"><strong>Editing resets review.</strong> Saving or withdrawing hides the profile and requires fresh review.</p>':''}${!policyReady()?'<p class="pandit-warning"><strong>Owner policy approval is pending.</strong> Evidence uploads, submissions, and reviews remain paused until the owner approves exact retention and appeal periods. Save draft is still available.</p>':''}${applicationRetentionSummary(a)}${status==='REJECTED'?`<p class="help-text">Appeal window ends: <strong>${utcTime(a.appeal_until)}</strong>.</p>${appealOpen?`<button type="button" class="button primary" data-action="pandit-appeal" data-revision="${Number(a.revision||0)}">Open appeal</button>`:'<p class="help-text">The appeal window is closed.</p>'}`:''}${status==='APPROVED'&&a.reverify_at?`<p class="help-text">Reverification due: <strong>${esc(dateTime(a.reverify_at))}</strong></p><div class="table-actions"><button type="button" class="button secondary" data-action="pandit-reverify" data-reason="BANK_DETAILS_CHANGED" data-revision="${Number(a.revision||0)}">Reverify: BANK_DETAILS_CHANGED</button><button type="button" class="button secondary" data-action="pandit-reverify" data-reason="OFFICIAL_ID_CHANGED" data-revision="${Number(a.revision||0)}">Reverify: OFFICIAL_ID_CHANGED</button></div>`:''}<form class="stack-form" data-form="pandit-application"><input type="hidden" name="revision" value="${Number(a.revision||0)}"><div class="form-grid">${panditField('display_name','Display name',a.display_name,{max:80,min:2,required:true})}${panditField('location','Location',a.location,{max:120,min:2,required:true})}${panditField('traditions','Traditions or lineages',a.traditions,{max:300,min:2,required:true})}${panditField('languages','Languages',a.languages,{max:200,min:2,required:true})}${panditField('ritual_skills','Ritual skills',a.ritual_skills,{max:500,min:2,required:true})}${panditField('experience_years','Years of experience',a.experience_years??0,{type:'number',max:3})}${panditField('description','Public description',a.description,{type:'textarea',max:1200,min:20,required:true,full:true})}</div><div class="evidence-box"><strong>Private evidence</strong>${a.is_simulation?'<p class="pandit-warning"><strong>SIMULATION — synthetic test profile only.</strong> Never use real ID, background-check, or education documents in a simulation.</p>':''}<p class="help-text">Upload one PDF or PNG/JPEG for each required type. Private files are limited to 1 MiB each.</p><p id="evidence-upload-help" class="${uploadBlock?'pandit-warning':'help-text'}" role="status">${esc(uploadBlock||'Choose a file to upload it immediately. Wait for the uploaded confirmation before choosing the next file.')}</p><ul>${evidenceList(a)}</ul>${applicationRetentionSummary(a)}<div class="form-grid">${['GOVERNMENT_ID','BACKGROUND_CHECK','EDUCATION'].map(k=>`<div class="form-field"><label for="evidence-${k}">${k.replaceAll('_',' ')}</label><input id="evidence-${k}" data-evidence-kind="${k}" type="file" accept="application/pdf,image/png,image/jpeg" aria-describedby="evidence-upload-help" ${uploadBlock?'disabled':''}></div>`).join('')}</div></div><div class="pandit-form-actions"><button class="button secondary" name="action" value="save" type="submit" formnovalidate ${locked?'disabled':''}>Save draft</button><button class="button primary" name="action" value="submit" type="submit" ${canSubmit?'':'disabled'}>Submit for review</button>${a.id?`<button class="button danger" data-action="pandit-withdraw" data-revision="${Number(a.revision||0)}" type="button" ${locked?'disabled':''}>Withdraw</button>`:''}</div></form>${a.review_feedback?`<div class="pandit-feedback"><strong>Review feedback</strong><p>${esc(a.review_feedback)}</p></div>`:''}</section>`;}
function panditsPage(){const a=state.panditApplication?.user_id===state.user.id?state.panditApplication:null;return `${heading('Signed-in community directory','Pandits','Approved public profiles only. Administrator review is not identity or religious-credential certification.') }<div class="pandit-grid">${state.pandits.length?state.pandits.map(p=>`<article class="panel pandit-card"><div class="pandit-card-head"><span class="avatar large">${esc(initials(p.display_name))}</span><div><h2>${esc(p.display_name)}</h2><p>${esc(p.location)}</p></div></div><span class="pandit-reviewed">${icon('check',14)} APPROVED — Administrator reviewed</span><p>${esc(p.description)}</p><dl><div><dt>Traditions</dt><dd>${esc(p.traditions)}</dd></div><div><dt>Languages</dt><dd>${esc(p.languages)}</dd></div><div><dt>Ritual skills</dt><dd>${esc(p.ritual_skills)}</dd></div><div><dt>Experience</dt><dd>${Number(p.experience_years)||0} years</dd></div></dl></article>`).join(''):'<section class="panel empty-state"><h2>No approved profiles yet</h2><p>Approved public profiles will appear here.</p></section>'}</div>${panditApplicationForm(a)}`;}
function roleAssignmentForm(users=[]){return `<form class="stack-form" data-form="pandit-role"><div class="form-field"><label for="pandit-role-user">User ID to assign</label><input id="pandit-role-user" name="user_id" required placeholder="Paste an active user ID" value=""></div><div class="form-field"><label for="pandit-role-value">Reviewer role</label><select id="pandit-role-value" name="role"><option value="CHECKER">CHECKER</option><option value="COMPLIANCE">COMPLIANCE</option><option value="">Remove role</option></select></div><button class="button primary">Save reviewer role</button></form>`;}
function auditList(reviews=[]){return `<section class="admin-section"><h3>Metadata-only audit history</h3><ul>${reviews.map(r=>`<li>${esc(r.event)} · actor ${esc(r.actor_id)} · application ${esc(r.application_id)} · ${esc(r.from_status)} → ${esc(r.to_status)} · ${esc(dateTime(r.created_at,{time:true}))}</li>`).join('')||'<li>No audit events yet.</li>'}</ul></section>`;}
function adminPanditsContent(data){const role=data.role||state.panditCapabilities?.role; if(role==='SUPER_ADMIN')return `<div class="admin-section"><h3>Pandit policy and roles</h3><p class="help-text">Manage retention policy and reviewer access. Evidence is never shown to Super Admins.</p>${panditPolicyForm(data.policy)}${roleAssignmentForm(state.admin?.users||[])}${auditList(data.reviews||[])}</div>`; if(!['CHECKER','COMPLIANCE'].includes(role))return emptyState('Review access required','Only assigned Pandit reviewers can access application data.'); const apps=data.applications||[];return `<div class="admin-section"><h3>Pandit applications</h3><p class="help-text">Evidence is private. Approval is not certification. ${apps.length?'':'No applications yet.'}</p>${apps.map(a=>`<article class="admin-pandit-card"><h4>${esc(a.display_name)} ${panditBadge(a.status)}</h4><p>${esc(a.location)} · ${esc(a.languages)} · ${esc(a.ritual_skills)}</p><div class="pandit-review-copy"><p><strong>Description:</strong> ${esc(a.description)}</p><p><strong>Evidence:</strong></p><ul>${evidenceList(a,role)}</ul>${applicationRetentionSummary(a)}</div>${a.user_id===state.user.id?'<p class="help-text">You cannot review your own application.</p>':reviewControls(a,role)}</article>`).join('')}</div>`;}
function reviewControls(a,role){if(a.status!=='PENDING_VERIFICATION')return '<p class="help-text">Review is closed until the applicant resubmits.</p>';const final=role==='COMPLIANCE';return `<form class="stack-form" data-form="pandit-review" data-id="${esc(a.id)}"><input type="hidden" name="revision" value="${Number(a.revision||0)}"><label for="review-status-${esc(a.id)}">Review status</label><select id="review-status-${esc(a.id)}" name="status" required>${(final?['APPROVED','REJECTED']:['ACTION_REQUIRED','PENDING_VERIFICATION']).map(s=>`<option value="${s}">${s}</option>`).join('')}</select><label for="review-feedback-${esc(a.id)}">Applicant feedback</label><textarea id="review-feedback-${esc(a.id)}" name="feedback" minlength="10" maxlength="1000" required placeholder="Feedback without ID numbers or sensitive document details"></textarea><button class="button primary" ${policyReady()?'':'disabled'}>${final?'Submit final review':'Save recommendation'}</button></form>`;}
function panditPolicyForm(policy={}){const ready=policyReady();return `<form class="stack-form" data-form="pandit-policy"><p class="help-text">${ready?'Ready policy: approved evidence is retained for '+(policy.approved_retention_years?esc(policy.approved_retention_years)+' calendar year(s)':esc(policy.approved_retention_days)+' elapsed day(s)')+', rejected government IDs for '+esc(policy.rejected_evidence_retention_days)+' elapsed UTC day(s), pending evidence for '+esc(policy.pending_evidence_retention_days)+' elapsed UTC day(s) after last applicant activity, rejected background checks for '+esc(policy.rejected_background_check_retention_days)+' elapsed UTC day(s) and rejected education for '+esc(policy.rejected_education_retention_days)+' elapsed UTC day(s) from rejection, and appeals for '+esc(policy.appeal_days)+' elapsed UTC day(s).':'Pending policy: choose exactly one approved-evidence retention unit; uploads, submissions, and reviews remain paused until all values are approved.'}</p><div class="form-grid"><div class="form-field"><label for="policy-approved-retention-years">Approved evidence retention (calendar years)</label><input id="policy-approved-retention-years" name="approved_retention_years" type="number" min="1" value="${policy.approved_retention_years==null?'':Number(policy.approved_retention_years)}"><span class="help-text">Default approved policy: 3 years. Mutually exclusive with legacy days.</span></div><div class="form-field"><label for="policy-approved-retention-days">Approved evidence retention (legacy elapsed days)</label><input id="policy-approved-retention-days" name="approved_retention_days" type="number" min="1" value="${policy.approved_retention_days==null?'':Number(policy.approved_retention_days)}"><span class="help-text">Legacy alternative; leave blank when years is set.</span></div><div class="form-field"><label for="policy-rejected-evidence-retention-days">Rejected government ID purge (elapsed UTC days)</label><input id="policy-rejected-evidence-retention-days" name="rejected_evidence_retention_days" type="number" min="1" value="${policy.rejected_evidence_retention_days==null?'':Number(policy.rejected_evidence_retention_days)}"></div>${[['pending_evidence_retention_days','Pending evidence after last applicant activity'],['rejected_background_check_retention_days','Rejected background check from rejection'],['rejected_education_retention_days','Rejected education from rejection']].map(([key,label])=>`<div class="form-field"><label for="policy-${key}">${label} (elapsed UTC days)</label><input id="policy-${key}" name="${key}" type="number" min="1" value="${policy[key]==null?'':Number(policy[key])}"></div>`).join('')}<div class="form-field"><label for="policy-appeal-days">Appeal window (elapsed UTC days)</label><input id="policy-appeal-days" name="appeal_days" type="number" min="1" value="${policy.appeal_days==null?'':Number(policy.appeal_days)}"></div><div class="form-field"><label for="policy-recheck">Recheck interval (years, 1 or 2)</label><select id="policy-recheck" name="recheck_years"><option value="1" ${Number(policy.recheck_years)===1?'selected':''}>1</option><option value="2" ${Number(policy.recheck_years)===2?'selected':''}>2</option></select></div></div><button class="button primary">Save policy</button></form>`;}
function panditReviewPage(){const d=state.panditReviewData||{};return `${heading('Staff workspace','Pandit review','Review applications according to your assigned capability. Evidence stays private.')}${adminPanditsContent(d)}`;}
function mainContent(){switch(state.page){case'communities':return communitiesPage();case'events':return eventsPage();case'pandits':return panditsPage();case'pandit-review':return panditReviewPage();case'notifications':return notificationsPage();case'reports':return reportsPage();case'profile':return profilePage();case'admin':return adminContent();case'community':return communityPage();default:return feedPage();}}

document.addEventListener('change', async event=>{const input=event.target.closest('[data-evidence-kind]');if(!input||!input.files?.[0])return;try{const blocked=evidenceUploadBlockReason(state.panditApplication);if(blocked)throw new Error(blocked);const file=input.files[0];if(file.size>1048576)throw new Error('Evidence must be at most 1 MiB.');if(!['application/pdf','image/png','image/jpeg'].includes(file.type))throw new Error('Evidence must be PDF, PNG, or JPEG.');const content_base64=await fileAsDataUrl(file);const result=await post('/api/pandit-application/evidence',{revision:Number(state.panditApplication.revision||0),kind:input.dataset.evidenceKind,content_type:file.type,content_base64:content_base64.split(',')[1]||''});state.panditApplication=result.application;toast('Private evidence uploaded.');await loadPage();}catch(error){toast(error.message,true);input.value='';}});
document.addEventListener('click', async event=>{const b=event.target.closest('[data-action="pandit-withdraw"]');if(!b)return;event.preventDefault();try{await post('/api/pandit-application/withdraw',{revision:Number(b.dataset.revision||0)});toast('Application withdrawn.');await loadPage();}catch(error){toast(error.message,true);}});
(async function boot(){
  try{await loadCommon();applyDeepLink();render();if(state.user){await loadPage();if(location.hash)window.dispatchEvent(new Event('hashchange'));if(state.selectedEvent)setTimeout(()=>document.getElementById(`event-${CSS.escape(state.selectedEvent)}`)?.scrollIntoView({behavior:'smooth',block:'center'}),150);}}
  catch(error){app.innerHTML=`${authHeader()}<main id="main" tabindex="-1" class="auth-wrap"><section class="auth-card"><h1>Hometown Hub is starting</h1><p>${esc(error.message)}</p><button class="button primary" data-action="reload">Try again</button></section></main>`;}
})();
