(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let key = sessionStorage.getItem('adminKey') || '';
let tab = 'pending', data = null;

async function call(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: { 'x-admin-key': key, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'Error');
  return j;
}
const when = (t) => new Date(t).toLocaleString();

async function load() {
  try {
    data = await call('/api/admin/overview');
    $('#login').hidden = true; $('#panel').hidden = false;
    $('#summary').textContent = data.onDutyNow + ' helper(s) on duty with a fresh location right now · ' +
      data.helpers.filter((h) => h.status === 'pending').length + ' waiting for review · ' +
      (data.reports || []).filter((r) => !r.resolved).length + ' open report(s)';
    draw();
  } catch (e) {
    sessionStorage.removeItem('adminKey');
    $('#login').hidden = false; $('#panel').hidden = true;
    $('#err').hidden = false; $('#err').textContent = e.message;
  }
}
function verifiedCell(h) {
  if (!h.verifiedUntil) return '<span title="No police or ID check date recorded">not recorded</span>';
  const d = new Date(h.verifiedUntil).toLocaleDateString();
  return h.verifiedUntil < Date.now() ? '<b>EXPIRED ' + esc(d) + '</b>' : esc(d);
}
const extraBtns = (u) =>
  (u.verifiedUntil !== undefined ? '<button class="btn small" data-do="verify" data-id="' + esc(u.id) + '" data-name="' + esc(u.name) + '">Set verified date</button>' : '') +
  '<button class="btn small" data-do="setpin" data-id="' + esc(u.id) + '" data-name="' + esc(u.name) + '">Set new PIN</button>' +
  '<button class="btn small" data-do="delete" data-id="' + esc(u.id) + '" data-name="' + esc(u.name) + '">Delete</button>';
function checksCell(h) {
  if (!(h.checks || []).length) return '<span title="Nobody has checked this person yet">no check recorded</span>' + (h.idLast4 ? '<br><small>(old form: ' + esc(h.idType) + ' ····' + esc(h.idLast4) + ')</small>' : '');
  return h.checks.map((c) => esc(c.label) + (c.idType ? ' (' + esc(c.idType) + ')' : '') + '<br><small>' + esc(new Date(c.at).toLocaleDateString()) + (c.note ? ' · ' + esc(c.note) : '') + '</small>').join('<br>');
}
function helperRows(list) {
  if (!list.length) return '<p>Nothing here.</p>';
  return '<table><tr><th>Name</th><th>Phone</th><th>Reference</th><th>Study or work</th><th>Checks done</th><th>Verified until</th><th>Status</th><th>Applied</th><th></th></tr>' +
    list.map((h) => '<tr><td>' + esc(h.name) + '</td><td>+' + esc(h.phone) + '</td><td>' + (h.refName ? esc(h.refName) + '<br><small>+' + esc(h.refPhone) + '</small>' : '<small>none</small>') + '</td><td>' + esc(h.note) + '</td><td>' + checksCell(h) + '</td><td>' + verifiedCell(h) + '</td><td>' +
      esc(h.status) + (h.onDuty ? ' (on duty)' : '') + (h.strikes ? ' · strikes ' + h.strikes : '') + '</td><td>' + esc(when(h.createdAt)) + '</td><td>' +
      (h.selfieAt ? '<button class="btn small" data-photo="' + esc(h.id) + '" data-kind="selfie">View selfie</button>' : '') + (h.idPhotoAt ? '<button class="btn small" data-photo="' + esc(h.id) + '">View ID photo</button><button class="btn small" data-do="deleteidphoto" data-id="' + esc(h.id) + '">Delete photo</button>' : '<small>No ID photo</small> ') +
      '<button class="btn small" data-do="check" data-id="' + esc(h.id) + '" data-name="' + esc(h.name) + '">Record a check</button>' +
      (h.status !== 'approved' && h.status !== 'banned' ? ((h.checks || []).length && h.idPhotoAt && h.selfieAt ? '<button class="btn small primary" data-do="approve" data-id="' + esc(h.id) + '">Approve</button>' : '<small>Needs a recorded check, an ID photo and a selfie</small>') : '') +
      (h.status === 'pending' ? '<button class="btn small" data-do="reject" data-id="' + esc(h.id) + '">Reject</button>' : '') +
      (h.status !== 'banned' ? '<button class="btn small" data-do="ban" data-id="' + esc(h.id) + '">Ban</button>' : '<button class="btn small" data-do="unban" data-id="' + esc(h.id) + '">Unban</button>') +
      extraBtns(h) + '</td></tr>').join('') + '</table>';
}
function draw() {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  let html = '';
  if (tab === 'pending') html = helperRows(data.helpers.filter((h) => h.status === 'pending'));
  else if (tab === 'helpers') html = helperRows(data.helpers);
  else if (tab === 'women') {
    html = data.women.length ? '<table><tr><th>Name</th><th>Phone</th><th>Status</th><th>Strikes</th><th>Joined</th><th></th></tr>' +
      data.women.map((w) => '<tr><td>' + esc(w.name) + '</td><td>+' + esc(w.phone) + '</td><td>' + esc(w.status) + '</td><td>' + w.strikes + '</td><td>' + esc(when(w.createdAt)) + '</td><td>' +
        (w.status === 'banned' ? '<button class="btn small" data-do="unban" data-id="' + esc(w.id) + '">Unban</button>' : '<button class="btn small" data-do="ban" data-id="' + esc(w.id) + '">Ban</button>') + extraBtns(w) + '</td></tr>').join('') + '</table>' : '<p>Nothing here.</p>';
  } else if (tab === 'reports') {
    html = (data.reports || []).length ? '<table><tr><th>When</th><th>From</th><th>What they wrote</th><th>People on that alert</th><th></th></tr>' +
      data.reports.map((r) => '<tr><td>' + esc(when(r.createdAt)) + '</td><td>' + esc(r.by) + ' (' + esc(r.byRole) + ')<br><small>+' + esc(r.byPhone) + '</small></td><td>' + esc(r.text) + '</td><td>' +
        (r.alertAt ? '<small>Alert at ' + esc(when(r.alertAt)) + '</small><br>' + r.helpers.map((h) => esc(h.name) + ' +' + esc(h.phone) + ' (' + esc(h.response) + ')').join('<br>') : '<small>No alert linked</small>') +
        '</td><td>' + (r.resolved ? 'resolved' : '<button class="btn small" data-report="' + esc(r.id) + '">Mark resolved</button>') + '</td></tr>').join('') + '</table>' : '<p>No reports.</p>';
  } else {
    html = data.alerts.length ? '<table><tr><th>When</th><th>Who</th><th>Status</th><th>Helpers alerted</th><th>Responded</th><th></th></tr>' +
      data.alerts.map((a) => '<tr><td>' + esc(when(a.createdAt)) + '</td><td>' + esc(a.user) + '<br><small>+' + esc(a.phone) + '</small></td><td>' + esc(a.status) + (a.endReason ? ' (' + esc(a.endReason) + ')' : '') + '</td><td>' + a.notified + '</td><td>' + a.coming + '</td><td>' +
        (a.flaggedFalse ? 'flagged false' : '<button class="btn small" data-alert="' + esc(a.id) + '">Mark as false alarm (strike)</button>') + '</td></tr>').join('') + '</table>' : '<p>No alerts yet.</p>';
  }
  $('#table').innerHTML = html;
}
$('#go').addEventListener('click', () => { key = $('#key').value.trim(); sessionStorage.setItem('adminKey', key); load(); });
$('#key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#go').click(); });
$('#reload').addEventListener('click', load);
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) { tab = t.dataset.tab; return draw(); }
  const d = e.target.closest('[data-do]');
  if (d) {
    if (d.dataset.do === 'ban' && !confirm('Ban this user?')) return;
    if (d.dataset.do === 'deleteidphoto' && !confirm('Delete the stored ID photo?')) return;
    let body;
    if (d.dataset.do === 'delete') {
      if (!confirm('PERMANENTLY delete ' + d.dataset.name + '? This removes the account and any alerts, and cannot be undone.')) return;
      if (!confirm('Last check: really delete ' + d.dataset.name + '?')) return;
    }
    if (d.dataset.do === 'verify') {
      const until = prompt('Police or ID check for ' + d.dataset.name + ' is valid until (YYYY-MM-DD). Leave blank to clear. After this date they are no longer alerted.');
      if (until === null) return;
      body = { until: until.trim() };
    }
    if (d.dataset.do === 'check') {
      const m = prompt('How did you check ' + d.dataset.name + '? Type a number:\n1 = Video call, ID seen\n2 = College or work ID checked\n3 = Police verification certificate\n4 = Reference called\n5 = Other');
      if (m === null) return;
      const method = { 1: 'video_id', 2: 'college_id', 3: 'police_certificate', 4: 'reference_called', 5: 'other' }[m.trim()];
      if (!method) return alert('Type a number from 1 to 5.');
      body = { method };
      if (method === 'video_id') {
        const t = prompt('Which ID did you see? Type a number:\n1 = Aadhaar\n2 = Passport\n3 = Driving licence\n4 = Voter ID\n5 = College or work ID');
        if (t === null) return;
        body.idType = { 1: 'Aadhaar', 2: 'Passport', 3: 'Driving licence', 4: 'Voter ID', 5: 'College or work ID' }[t.trim()] || 'Aadhaar';
      }
      const n = prompt('A short note for your records (optional, do NOT type ID numbers):');
      if (n === null) return;
      body.note = n.trim();
      const u = prompt('This check is valid until (YYYY-MM-DD), or leave blank to skip:');
      if (u === null) return;
      if (u.trim()) body.until = u.trim();
    }
    if (d.dataset.do === 'setpin') {
      const pin = prompt('Type a temporary 4 to 6 digit PIN for ' + d.dataset.name + '. Tell them to use it to log in. They are signed out of other devices.');
      if (pin === null) return;
      body = { pin: pin.trim() };
    }
    try { await call('/api/admin/users/' + encodeURIComponent(d.dataset.id) + '/' + d.dataset.do, 'POST', body); await load(); if (d.dataset.do === 'setpin') alert('PIN changed.'); } catch (err) { alert(err.message); }
  }
  const ph = e.target.closest('[data-photo]');
  if (ph) {
    try {
      const r = await fetch('/api/admin/users/' + encodeURIComponent(ph.dataset.photo) + '/idphoto?kind=' + (ph.dataset.kind || 'id'), { headers: { 'x-admin-key': key } });
      if (!r.ok) throw new Error('No photo');
      const url = URL.createObjectURL(await r.blob());
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:99;cursor:pointer';
      const im = document.createElement('img'); im.src = url; im.style.cssText = 'max-width:95%;max-height:95%';
      ov.appendChild(im); ov.addEventListener('click', () => { URL.revokeObjectURL(url); ov.remove(); });
      document.body.appendChild(ov);
    } catch (err) { alert(err.message); }
    return;
  }
  const rp = e.target.closest('[data-report]');
  if (rp) {
    try { await call('/api/admin/reports/' + encodeURIComponent(rp.dataset.report) + '/resolve', 'POST'); await load(); } catch (err) { alert(err.message); }
    return;
  }
  const a = e.target.closest('[data-alert]');
  if (a) {
    if (!confirm('Mark as false alarm? The user gets a strike (3 strikes = ban).')) return;
    try { await call('/api/admin/alerts/' + encodeURIComponent(a.dataset.alert) + '/false', 'POST'); await load(); } catch (err) { alert(err.message); }
  }
});
if (key) load();
})();
