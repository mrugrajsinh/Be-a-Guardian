(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let key = sessionStorage.getItem('adminKey') || '';
let tab = 'pending', data = null;

async function call(path, method = 'GET') {
  const res = await fetch(path, { method, headers: { 'x-admin-key': key, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
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
      data.helpers.filter((h) => h.status === 'pending').length + ' waiting for review';
    draw();
  } catch (e) {
    sessionStorage.removeItem('adminKey');
    $('#login').hidden = false; $('#panel').hidden = true;
    $('#err').hidden = false; $('#err').textContent = e.message;
  }
}
function helperRows(list) {
  if (!list.length) return '<p>Nothing here.</p>';
  return '<table><tr><th>Name</th><th>Phone</th><th>ID (last 4)</th><th>Why / where</th><th>Status</th><th>Applied</th><th></th></tr>' +
    list.map((h) => '<tr><td>' + esc(h.name) + '</td><td>+' + esc(h.phone) + '</td><td>' + esc(h.idType) + ' ····' + esc(h.idLast4) + '</td><td>' + esc(h.note) + '</td><td>' +
      esc(h.status) + (h.onDuty ? ' (on duty)' : '') + (h.strikes ? ' · strikes ' + h.strikes : '') + '</td><td>' + esc(when(h.createdAt)) + '</td><td>' +
      (h.status !== 'approved' && h.status !== 'banned' ? '<button class="btn small primary" data-do="approve" data-id="' + esc(h.id) + '">Approve</button>' : '') +
      (h.status === 'pending' ? '<button class="btn small" data-do="reject" data-id="' + esc(h.id) + '">Reject</button>' : '') +
      (h.status !== 'banned' ? '<button class="btn small" data-do="ban" data-id="' + esc(h.id) + '">Ban</button>' : '<button class="btn small" data-do="unban" data-id="' + esc(h.id) + '">Unban</button>') +
      '</td></tr>').join('') + '</table>';
}
function draw() {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  let html = '';
  if (tab === 'pending') html = helperRows(data.helpers.filter((h) => h.status === 'pending'));
  else if (tab === 'helpers') html = helperRows(data.helpers);
  else if (tab === 'women') {
    html = data.women.length ? '<table><tr><th>Name</th><th>Phone</th><th>Status</th><th>Strikes</th><th>Joined</th><th></th></tr>' +
      data.women.map((w) => '<tr><td>' + esc(w.name) + '</td><td>+' + esc(w.phone) + '</td><td>' + esc(w.status) + '</td><td>' + w.strikes + '</td><td>' + esc(when(w.createdAt)) + '</td><td>' +
        (w.status === 'banned' ? '<button class="btn small" data-do="unban" data-id="' + esc(w.id) + '">Unban</button>' : '<button class="btn small" data-do="ban" data-id="' + esc(w.id) + '">Ban</button>') + '</td></tr>').join('') + '</table>' : '<p>Nothing here.</p>';
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
    try { await call('/api/admin/users/' + encodeURIComponent(d.dataset.id) + '/' + d.dataset.do, 'POST'); await load(); } catch (err) { alert(err.message); }
  }
  const a = e.target.closest('[data-alert]');
  if (a) {
    if (!confirm('Mark as false alarm? The user gets a strike (3 strikes = ban).')) return;
    try { await call('/api/admin/alerts/' + encodeURIComponent(a.dataset.alert) + '/false', 'POST'); await load(); } catch (err) { alert(err.message); }
  }
});
if (key) load();
})();
