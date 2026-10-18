(() => {
'use strict';

/* ------------------------------------------------------------------ basics */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

let cfg = { appName: 'Be a Guardian', emergencyNumber: '112', vapidPublicKey: '', pushAvailable: false };
let token = localStorage.getItem('token');
let me = null;                 // the logged-in user
let myAlert = null;            // woman: her live alert
let helperAlerts = new Map();  // helper: live alerts near them
let screen = 'welcome';        // welcome | reg-woman | reg-helper | login (when logged out)
let formError = '', busy = false, sosError = '', locPerm = 'unknown';
let lastPos = null, locWatch = null, lastSent = 0;
let stream = null, streamTimer = null, streamLive = false;
let wake = null, ctx = null, sirenTimer = null, installEvt = null;
let shakeOn = localStorage.getItem('shake') === '1', shakeTimes = [];
let holdTimer = null, countdownTimer = null;
let silenced = new Set(), alarmOn = false, alarmTimer = null, vibTimer = null, alarmStart = 0;

const SVG_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5l-8-3zm-1 5h2v6h-2V7zm0 8h2v2h-2v-2z"/></svg>';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    if (res.status === 401 && token && !/\/(login|register)$/.test(path)) forceLogout();
    throw err;
  }
  return data;
}

function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
const ago = (ts) => { const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); return m < 1 ? 'just now' : m + ' min ago'; };
const dist = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const fmtDist = (m) => (m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + ' m' : (m / 1000).toFixed(1) + ' km');
const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '');

/* -------------------------------------------------------------- sound etc. */
function audio() {
  if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (C) ctx = new C(); }
  if (ctx && ctx.state === 'suspended') ctx.resume();
  return ctx;
}
// Quiet mode (women only): no sound or vibration from the SOS button and countdown.
let quietOn = localStorage.getItem('quiet') === '1';
const isQuiet = () => quietOn && me && me.role === 'woman';
function beep(freq, ms, when = 0, gain = 0.25) {
  if (isQuiet()) return;
  const c = audio(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'square'; o.frequency.value = freq; g.gain.value = gain;
  o.connect(g); g.connect(c.destination);
  const t = c.currentTime + when; o.start(t); o.stop(t + ms / 1000);
}
const alertBeep = () => [0, 0.35, 0.7].forEach((w) => beep(880, 250, w));
function toggleSiren() {
  if (sirenTimer) { clearInterval(sirenTimer); sirenTimer = null; return; }
  let hi = false;
  const tick = () => { beep(hi ? 950 : 650, 450); hi = !hi; };
  tick(); sirenTimer = setInterval(tick, 460);
}
function stopSiren() { if (sirenTimer) { clearInterval(sirenTimer); sirenTimer = null; } }
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!on && wake) { await wake.release(); wake = null; }
  } catch (e) { /* not supported or refused: fine */ }
}
const vibrate = (p) => { try { if (!isQuiet() && navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } };

/* --------------------------------------------------------------- location */
function getPos(timeoutMs = 7000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(freshLast());
    navigator.geolocation.getCurrentPosition(
      (p) => { lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; resolve(lastPos); },
      () => resolve(freshLast()),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15000 }
    );
  });
}
const freshLast = () => (lastPos && Date.now() - lastPos.at < 5 * 60000 ? lastPos : null);
const shouldShare = () => !!me && ((me.role === 'helper' && me.status === 'approved' && me.onDuty) || (me.role === 'woman' && !!myAlert));
function postLocation() {
  if (!shouldShare() || !lastPos) return;
  lastSent = Date.now();
  api('/api/location', { method: 'POST', body: { lat: lastPos.lat, lng: lastPos.lng, acc: lastPos.acc } }).catch(() => {});
}
function onPos(p) {
  lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
  if (!shouldShare()) return;
  if (Date.now() - lastSent >= (me.role === 'woman' ? 4000 : 20000)) {
    postLocation();
    if (me.role === 'helper' && helperAlerts.size) render();
  }
}
function startSharing() {
  if (locWatch != null || !navigator.geolocation) return;
  locWatch = navigator.geolocation.watchPosition(onPos, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function stopSharing() {
  if (locWatch != null && !shouldShare()) { navigator.geolocation.clearWatch(locWatch); locWatch = null; }
}
setInterval(() => { if (shouldShare() && lastPos) postLocation(); }, 60000); // heartbeat so a stationary helper stays "fresh"

async function checkLocPerm() {
  try {
    if (!navigator.permissions) return;
    const st = await navigator.permissions.query({ name: 'geolocation' });
    const set = () => { if (locPerm !== st.state) { locPerm = st.state; render(); } };
    locPerm = st.state; st.onchange = set;
  } catch (e) { /* older browsers */ }
}

/* ------------------------------------------------------------ live stream */
async function connectStream() {
  if (!token || stream) return;
  try {
    const { ticket } = await api('/api/stream-ticket', { method: 'POST' });
    const es = new EventSource('/api/stream?t=' + encodeURIComponent(ticket));
    stream = es;
    es.onopen = () => { if (!streamLive) { streamLive = true; render(); } };
    es.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    es.onerror = () => {
      es.close(); if (stream === es) stream = null;
      if (streamLive) { streamLive = false; render(); }
      clearTimeout(streamTimer); streamTimer = setTimeout(connectStream, 3000);
    };
  } catch (e) { clearTimeout(streamTimer); streamTimer = setTimeout(connectStream, 5000); }
}
function disconnectStream() { clearTimeout(streamTimer); if (stream) { stream.close(); stream = null; } streamLive = false; }

function handleEvent(ev) {
  switch (ev.type) {
    case 'my_alert':
      myAlert = ev.alert; sosError = ''; startSharing(); keepAwake(true); render(); break;
    case 'my_alert_end':
      myAlert = null; stopSiren(); keepAwake(false); stopSharing();
      toast(ev.reason === 'expired' ? 'The alert timed out. If you still need help, call ' + cfg.emergencyNumber + '.' : 'Alert ended.');
      render(); break;
    case 'helper_alert': {
      const isNew = !helperAlerts.has(ev.alert.id);
      helperAlerts.set(ev.alert.id, ev.alert);
      if (isNew) { silenced.delete(ev.alert.id); keepAwake(true); }
      render(); break;
    }
    case 'helper_alert_end':
      helperAlerts.delete(ev.id); silenced.delete(ev.id);
      if (ev.reason === 'safe') toast('Good news: she is safe and ended the alert.');
      if (!helperAlerts.size) keepAwake(false);
      render(); break;
    default: break;
  }
}

/* ----------------------------------------------------------------- session */
async function loadState() {
  const s = await api('/api/state');
  me = s.me; myAlert = s.alert || null;
  helperAlerts = new Map((s.alerts || []).map((a) => [a.id, a]));
}
function afterLogin() {
  connectStream();
  if (shouldShare()) startSharing();
  if (me.role === 'woman' && shakeOn) enableShake();
  if (me.role === 'helper') refreshPush();
  checkLocPerm();
}
function forceLogout() {
  token = null; me = null; myAlert = null; helperAlerts = new Map();
  localStorage.removeItem('token');
  disconnectStream(); stopSiren(); silenced = new Set(); stopAlarm(); keepAwake(false);
  if (locWatch != null) { navigator.geolocation.clearWatch(locWatch); locWatch = null; }
  screen = 'welcome'; render();
}
async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  forceLogout();
}

/* ------------------------------------------------------------------- push */
const urlB64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const b = (s + p).replace(/-/g, '+').replace(/_/g, '/'); const r = atob(b); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };
async function enablePush() {
  if (!cfg.pushAvailable) return toast('Lock-screen alerts are not switched on for this server yet.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
    return toast(isIOS() ? 'On iPhone, first add this app to your Home Screen (Share, then Add to Home Screen), then open it from there.' : 'This browser cannot show lock-screen alerts.', 7000);
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notifications are blocked. Allow them in your phone settings for this app.', 6000);
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(cfg.vapidPublicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    me.pushEnabled = true; render(); toast('Lock-screen alerts are on.');
  } catch (e) { toast('Could not turn on alerts: ' + e.message, 6000); }
}
async function refreshPush() {
  try {
    if (!cfg.pushAvailable || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  } catch (e) { /* ignore */ }
}

/* -------------------------------------------------------------------- SOS */
function showOverlay(html) { const o = $('#overlay'); if (o._sig !== html) { o.innerHTML = html; o._sig = html; } o.hidden = false; }
function hideOverlay() { const o = $('#overlay'); o.hidden = true; o.innerHTML = ''; o._sig = ''; if (o.classList) o.classList.remove('alarm'); }

/* Full-screen alarm for helpers: takes over the app, sirens and vibrates until they respond. */
const pendingAlarms = () => (me && me.role === 'helper'
  ? [...helperAlerts.values()].filter((a) => !a.my && !silenced.has(a.id)).sort((x, y) => y.createdAt - x.createdAt) : []);
function startAlarm() {
  if (alarmOn) return;
  alarmOn = true; alarmStart = Date.now(); keepAwake(true);
  let hi = false;
  const tick = () => {
    if (Date.now() - alarmStart > 180000) { clearInterval(alarmTimer); alarmTimer = null; return; } // stop the noise after 3 minutes
    beep(hi ? 1100 : 700, 330, 0, 0.5); hi = !hi;
  };
  tick(); alarmTimer = setInterval(tick, 360);
  const buzz = () => vibrate([500, 200, 500, 200, 900]);
  buzz(); vibTimer = setInterval(buzz, 2600);
}
function stopAlarm() {
  if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
  if (vibTimer) { clearInterval(vibTimer); vibTimer = null; }
  if (alarmOn) { alarmOn = false; vibrate(0); hideOverlay(); }
}
function updateAlarm() {
  const list = pendingAlarms();
  if (!list.length) { stopAlarm(); return; }
  const a = list[0];
  const d = lastPos ? fmtDist(dist(lastPos, a)) : 'near you';
  const o = $('#overlay');
  showOverlay('<div class="pulse"></div><p class="tag-big">SOS NEARBY</p><h1>' + esc(a.name) + ' needs help</h1>' +
    '<p class="dist">' + esc(d) + (lastPos ? ' away' : '') + '</p>' +
    (a.othersComing ? '<p>' + a.othersComing + ' other helper' + (a.othersComing > 1 ? 's are' : ' is') + ' already on the way.</p>' : '') +
    '<button class="btn go" data-act="respond" data-id="' + esc(a.id) + '" data-r="coming">I AM COMING</button>' +
    '<a class="btn call" href="tel:' + esc(cfg.emergencyNumber) + '">Call ' + esc(cfg.emergencyNumber) + '</a>' +
    '<button class="btn ghost" data-act="respond" data-id="' + esc(a.id) + '" data-r="cannot">I cannot help</button>' +
    '<button class="link" data-act="silence" data-id="' + esc(a.id) + '">Silence the alarm</button>' +
    (list.length > 1 ? '<p class="small">+ ' + (list.length - 1) + ' more alert' + (list.length > 2 ? 's' : '') + ' nearby</p>' : '') +
    '<small>Call ' + esc(cfg.emergencyNumber) + ' first or together with going. Do not confront anyone alone. Be seen, stay with her.</small>');
  if (o.classList) o.classList.add('alarm');
  startAlarm();
}

async function startSOS() {
  if (myAlert || busy || !me || me.role !== 'woman') return;
  busy = true; sosError = '';
  audio(); // unlock sound while we still have a user gesture
  showOverlay('<h1>Sending alert…</h1><p>Finding your location</p>');
  const pos = await getPos(7000);
  if (!pos) {
    busy = false; hideOverlay();
    sosError = 'We could not get your location, so helpers could not be alerted.';
    render(); return;
  }
  try {
    const r = await api('/api/sos', { method: 'POST', body: { lat: pos.lat, lng: pos.lng, acc: pos.acc } });
    myAlert = r.alert; startSharing(); keepAwake(true);
  } catch (e) { sosError = e.message || 'Could not reach the server.'; }
  busy = false; hideOverlay(); render();
}
function startCountdown() {
  if (countdownTimer || myAlert || busy) return;
  let n = 5; vibrate([300, 100, 300]);
  const paint = () => showOverlay('<p>Sending SOS in</p><div class="num">' + n + '</div><button class="btn safe" data-act="cancel-countdown">Cancel</button>');
  paint();
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) { clearInterval(countdownTimer); countdownTimer = null; hideOverlay(); startSOS(); } else paint();
  }, 1000);
}
function cancelCountdown() { clearInterval(countdownTimer); countdownTimer = null; hideOverlay(); }

async function endAlert(reason) {
  const pin = ($('#pin') || {}).value || '';
  if (!/^\d{4,6}$/.test(pin)) return toast('Enter your 4 to 6 digit PIN');
  try {
    await api('/api/sos/' + myAlert.id + '/cancel', { method: 'POST', body: { pin, reason } });
    myAlert = null; stopSiren(); keepAwake(false); stopSharing(); toast('Alert ended. Stay safe.'); render();
  } catch (e) { toast(e.message); }
}

/* shake to send SOS (works only while the app is open on screen) */
function onMotion(e) {
  const a = e.accelerationIncludingGravity; if (!a) return;
  const m = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
  if (m < 28) return;
  const now = Date.now();
  if (shakeTimes.length && now - shakeTimes[shakeTimes.length - 1] < 250) return;
  shakeTimes = shakeTimes.filter((t) => now - t < 2000); shakeTimes.push(now);
  if (shakeTimes.length >= 4) { shakeTimes = []; startCountdown(); }
}
async function enableShake() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') { shakeOn = false; localStorage.setItem('shake', '0'); toast('Motion access was refused.'); return render(); }
    }
    window.removeEventListener('devicemotion', onMotion);
    window.addEventListener('devicemotion', onMotion);
  } catch (e) { /* unsupported */ }
}
function disableShake() { window.removeEventListener('devicemotion', onMotion); }

/* ------------------------------------------------------------------ views */
const header = () => '<header class="top"><div class="brand">' + SVG_LOGO + esc(cfg.appName) + '</div>' +
  (me ? '<span class="pill ' + (streamLive ? 'ok' : 'warn') + '">' + (streamLive ? 'Live' : 'Connecting…') + '</span>' : '') + '</header>';
const errBox = () => (formError ? '<div class="err" role="alert">' + esc(formError) + '</div>' : '');

function vWelcome() {
  return '<main class="center"><h1 style="margin-top:12vh">' + esc(cfg.appName) + '</h1>' +
    '<p class="lead">Press and hold for help. Verified volunteers near you are alerted with your location, and your family is told.</p>' +
    '<button class="btn primary" data-act="go-reg-woman">I want a safety button</button>' +
    '<button class="btn" data-act="go-reg-helper">I want to be a volunteer helper</button>' +
    '<button class="link" data-act="go-login">I already have an account</button>' +
    '<p class="small" style="margin-top:28px">This app supports the police, it does not replace them. In an emergency, always call ' + esc(cfg.emergencyNumber) + '.</p></main>';
}
function vLogin() {
  return header() + '<main><h1>Log in</h1>' + errBox() +
    '<form data-form="login"><label for="phone">Phone number</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required>' +
    '<label for="pin">PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="current-password" required>' +
    '<button class="btn primary" ' + (busy ? 'disabled' : '') + '>Log in</button></form>' +
    '<button class="link" data-act="go-forgot">Forgot my PIN</button> ' +
    '<button class="link" data-act="go-welcome">Back</button></main>';
}
let forgotStep = 1, forgotPhone = '';
function vForgot() {
  if (forgotStep === 1) {
    return header() + '<main><h1>Forgot PIN</h1>' + errBox() +
      '<p class="small">Enter your registered phone number. We will send a 6-digit code by SMS.</p>' +
      '<form data-form="forgot1"><label for="phone">Phone number</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required value="' + esc(forgotPhone) + '">' +
      '<button class="btn primary" ' + (busy ? 'disabled' : '') + '>Send code</button></form>' +
      '<button class="link" data-act="go-login">Back to log in</button></main>';
  }
  return header() + '<main><h1>Set a new PIN</h1>' + errBox() +
    '<p class="small">If ' + esc(forgotPhone) + ' is registered, a 6-digit code was sent. It works for 10 minutes.</p>' +
    '<form data-form="forgot2"><label for="code">6-digit code</label><input id="code" name="code" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required>' +
    '<label for="pin">New PIN (4 to 6 digits)</label><input id="pin" name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" required>' +
    '<button class="btn primary" ' + (busy ? 'disabled' : '') + '>Save new PIN and log in</button></form>' +
    '<button class="link" data-act="go-forgot">Send a new code</button> <button class="link" data-act="go-login">Back to log in</button></main>';
}
function vRegister(role) {
  const woman = role === 'woman';
  return header() + '<main><h1>' + (woman ? 'Set up your safety button' : 'Become a helper') + '</h1>' + errBox() +
    '<form data-form="register" data-role="' + role + '">' +
    '<label for="name">Your name</label><input id="name" name="name" type="text" autocomplete="name" required>' +
    '<label for="phone">Phone number</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required>' +
    '<label for="pin">Choose a PIN (4 to 6 digits)</label><input id="pin" name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" required>' +
    '<small>You need this PIN to log in and to end an alert, so nobody else can switch it off.</small>' +
    (woman
      ? '<h3 style="margin-top:20px">Emergency contacts</h3><small>They are told when you press SOS. Add at least one.</small>' +
        '<label for="c1n">Contact 1 name</label><input id="c1n" name="c1n" type="text" required>' +
        '<label for="c1p">Contact 1 phone</label><input id="c1p" name="c1p" type="tel" inputmode="tel" required>' +
        '<label for="c2n">Contact 2 name (optional)</label><input id="c2n" name="c2n" type="text">' +
        '<label for="c2p">Contact 2 phone</label><input id="c2p" name="c2p" type="tel" inputmode="tel">' +
        '<label class="check"><input type="checkbox" id="terms" name="terms"><span>I understand this app shares my live location with verified volunteers and my contacts while an alert is active, and that it does not replace calling ' + esc(cfg.emergencyNumber) + '. I have read the <a href="/terms" target="_blank" rel="noopener">terms</a> and <a href="/privacy" target="_blank" rel="noopener">privacy policy</a>.</span></label>'
      : '<label for="idType">ID you will show us</label><select id="idType" name="idType"><option>Aadhaar</option><option>Driving licence</option><option>Voter ID</option><option>Passport</option><option>PAN</option></select>' +
        '<label for="idLast4">Last 4 digits of that ID</label><input id="idLast4" name="idLast4" type="text" inputmode="numeric" maxlength="4" required>' +
        '<small>We keep only the last 4 digits. An admin may call you to verify.</small>' +
        '<label for="note">Why do you want to help? Where do you work or study?</label><textarea id="note" name="note" rows="3" maxlength="300"></textarea>' +
        '<details class="card"><summary>Helper code of conduct</summary><ul>' +
        '<li>Call ' + esc(cfg.emergencyNumber) + ' first or at the same time. Never act as a replacement for the police.</li>' +
        '<li>Do not confront anyone alone. Your job is to reach her safely, be a visible presence and stay with her.</li>' +
        '<li>Never contact, follow or share information about anyone you meet through alerts.</li>' +
        '<li>Misuse (stalking, harassment, fake responses) means a permanent ban and a report to the police.</li></ul></details>' +
        '<label class="check"><input type="checkbox" id="terms" name="terms"><span>I agree to the code of conduct and to a verification check. I have read the <a href="/terms" target="_blank" rel="noopener">terms</a> and <a href="/privacy" target="_blank" rel="noopener">privacy policy</a>.</span></label>') +
    '<button class="btn primary" ' + (busy ? 'disabled' : '') + '>' + (woman ? 'Create my safety button' : 'Apply to be a helper') + '</button></form>' +
    '<button class="link" data-act="go-welcome">Back</button></main>';
}

function reportCard() {
  return '<details class="card"><summary><b>Report a problem</b></summary>' +
    '<p class="small">Tell us if a helper or a user behaved badly, or an alert was misused. An admin will look at it, linked to your most recent alert.</p>' +
    '<form data-form="report"><textarea name="text" rows="3" maxlength="500" placeholder="What happened?" aria-label="What happened?" required></textarea>' +
    '<button class="btn primary">Send report</button></form></details>';
}
function contactLinks(dark) {
  const p = lastPos;
  const where = p ? 'My location: https://maps.google.com/?q=' + p.lat + ',' + p.lng : 'I could not get my location.';
  const msg = encodeURIComponent((me.name || 'I') + ' pressed the SOS button and may be in danger. ' + where + ' Please call me or call ' + cfg.emergencyNumber + '.');
  return (me.contacts || []).map((c) =>
    '<div class="contact-line"><span>' + esc(c.name) + '</span><span>' +
    '<a href="tel:+' + esc(c.phone) + '">Call</a>' +
    '<a href="https://wa.me/' + esc(c.phone) + '?text=' + msg + '" target="_blank" rel="noopener">WhatsApp</a>' +
    '<a href="sms:+' + esc(c.phone) + '?body=' + msg + '">SMS</a></span></div>').join('');
}
function installCard() {
  if (isStandalone()) return '';
  return '<div class="card"><h3>Install on your phone</h3>' +
    (installEvt ? '<button class="btn small primary" data-act="install">Install app</button>'
      : '<p class="small">' + (isIOS() ? 'In Safari tap Share, then <b>Add to Home Screen</b>.' : 'In Chrome tap the menu (⋮), then <b>Install app</b> or <b>Add to Home screen</b>.') + ' It then opens like a normal app.</p>') + '</div>';
}

function vWomanHome() {
  const contacts = (me.contacts || []).map((c, i) =>
    '<li><span>' + esc(c.name) + ' · +' + esc(c.phone) + '</span><button class="link danger" data-act="rm-contact" data-i="' + i + '">Remove</button></li>').join('');
  return header() + '<main>' +
    (locPerm === 'denied' ? '<div class="card warn"><b>Location is blocked.</b> Helpers cannot find you without it. Allow location for this app in your phone settings.</div>' : '') +
    (locPerm === 'prompt' ? '<div class="card warn"><b>Allow location now</b><p class="small">So help can find you the moment you need it.</p><button class="btn small primary" data-act="allow-loc">Allow location</button></div>' : '') +
    '<section class="sos-wrap"><button class="sos" data-hold aria-label="Hold for two seconds to send an SOS"><span class="fill"></span><span class="sos-text">SOS</span><span class="sos-sub">Hold 2 seconds</span></button>' +
    '<p class="hint">Nearby verified helpers and your contacts are alerted with your location. <b>Always call ' + esc(cfg.emergencyNumber) + ' too.</b></p></section>' +
    '<a class="btn call" href="tel:' + esc(cfg.emergencyNumber) + '">Call ' + esc(cfg.emergencyNumber) + ' (Police)</a>' +
    '<div class="card"><h3>Your emergency contacts</h3><ul class="plain">' + contacts + '</ul>' +
    '<form data-form="add-contact" class="row"><input id="cn" name="name" type="text" placeholder="Name" aria-label="Contact name"><input id="cp" name="phone" type="tel" inputmode="tel" placeholder="Phone" aria-label="Contact phone"><button class="btn small primary">Add</button></form></div>' +
    '<div class="card"><label class="row between" style="margin:0;font-weight:400"><span><b>Shake to send SOS</b><br><small>Shake hard 4 times while the app is open. You get 5 seconds to cancel.</small></span><input type="checkbox" id="shake" data-act="toggle-shake"' + (shakeOn ? ' checked' : '') + '></label></div>' +
    '<div class="card"><label class="row between" style="margin:0;font-weight:400"><span><b>Quiet mode</b><br><small>No sound or vibration when you press SOS, so nobody near you notices. Helpers are still alerted.</small></span><input type="checkbox" id="quiet" data-act="toggle-quiet"' + (quietOn ? ' checked' : '') + '></label></div>' +
    '<div class="card"><h3>Good to know</h3><p class="small">Keep location switched on. Alerts only reach helpers who are on duty close to you, so always call ' + esc(cfg.emergencyNumber) + ' as well.</p></div>' +
    reportCard() +
    installCard() +
    '<button class="link center-link" data-act="logout">Log out</button></main>';
}
function statText(a) {
  if (a.arrived) return a.arrived + ' helper' + (a.arrived > 1 ? 's have' : ' has') + ' reached you. Stay where you are if it is safe.';
  if (a.coming) return a.coming + ' helper' + (a.coming > 1 ? 's are' : ' is') + ' on the way.';
  if (a.notified) return a.notified + ' helper' + (a.notified > 1 ? 's' : '') + ' alerted within ' + fmtDist(a.radiusM) + '. Waiting for someone to respond…';
  return 'No helpers nearby yet. We keep widening the search (now ' + fmtDist(a.radiusM) + '). Call ' + cfg.emergencyNumber + ' now.';
}
function vWomanAlert() {
  return '<main class="alert-screen"><div class="pulse"></div><h1>Your alert is live</h1>' +
    '<p class="lead" id="astat">' + esc(statText(myAlert)) + '</p>' +
    '<a class="btn call" href="tel:' + esc(cfg.emergencyNumber) + '">Call ' + esc(cfg.emergencyNumber) + ' now</a>' +
    '<div class="card dark"><h3>Tell your contacts</h3>' + contactLinks() + '</div>' +
    (quietOn ? '<small>Quiet mode is on: no sound or vibration.</small>' : '<button class="btn ghost" data-act="siren">' + (sirenTimer ? 'Stop alarm sound' : 'Play loud alarm sound') + '</button>') +
    '<div class="card dark"><label for="pin" style="margin-top:0">Enter your PIN to end the alert</label>' +
    '<input id="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off">' +
    '<div class="row" style="margin-top:10px"><button class="btn safe" data-act="end-safe">I am safe</button><button class="btn ghost" data-act="end-false">False alarm</button></div></div>' +
    '<small>Your live location is shared only while this alert is active and is deleted when it ends.</small></main>';
}
function vSosError() {
  return '<main class="alert-screen"><h1>Call ' + esc(cfg.emergencyNumber) + ' now</h1>' +
    '<p class="lead">' + esc(sosError) + '</p>' +
    '<a class="btn call" href="tel:' + esc(cfg.emergencyNumber) + '">Call ' + esc(cfg.emergencyNumber) + '</a>' +
    '<div class="card dark"><h3>Tell your contacts directly</h3>' + contactLinks() + '</div>' +
    '<button class="btn ghost" data-act="sos-retry">Try sending the alert again</button>' +
    '<button class="link" data-act="sos-dismiss">Back</button></main>';
}

function cardAlert(a) {
  const d = lastPos ? fmtDist(dist(lastPos, a)) : '…';
  const nav = 'https://www.google.com/maps/dir/?api=1&destination=' + a.lat + ',' + a.lng + '&travelmode=walking';
  let actions;
  if (a.my === 'arrived') actions = '<p><b>You are there.</b> Stay with her until the police or her family arrive. Do not leave her alone.</p>';
  else if (a.my === 'coming') actions = '<button class="btn primary" data-act="respond" data-id="' + a.id + '" data-r="arrived">I have arrived</button><button class="btn" data-act="respond" data-id="' + a.id + '" data-r="cannot">I can no longer come</button>';
  else actions = '<button class="btn primary" data-act="respond" data-id="' + a.id + '" data-r="coming">I am coming</button><button class="btn" data-act="respond" data-id="' + a.id + '" data-r="cannot">I cannot help</button>';
  return '<div class="card alert-card"><div class="tag">SOS · ' + esc(ago(a.createdAt)) + '</div><h2>' + esc(a.name) + ' needs help</h2>' +
    '<p class="big">' + esc(d) + ' away</p>' +
    (a.othersComing ? '<p>' + a.othersComing + ' other helper' + (a.othersComing > 1 ? 's are' : ' is') + ' on the way.</p>' : '') +
    '<a class="btn" target="_blank" rel="noopener" href="' + nav + '">Open directions</a>' +
    '<a class="btn call" href="tel:' + esc(cfg.emergencyNumber) + '">Call ' + esc(cfg.emergencyNumber) + '</a>' + actions +
    '<small>Call ' + esc(cfg.emergencyNumber) + ' first or together with going. Do not confront anyone alone. Be a visible presence and stay with her.</small></div>';
}
function vHelper() {
  const alerts = [...helperAlerts.values()].sort((x, y) => y.createdAt - x.createdAt);
  let body = alerts.map(cardAlert).join('');
  if (me.status === 'pending') {
    body += '<div class="card"><h3>Application under review</h3><p>Thank you for volunteering. We check every helper before they can receive alerts, and we may call you on +' + esc(me.phone) + '. This screen updates when you are approved.</p><button class="btn small" data-act="refresh">Check status</button></div>';
  } else if (me.status === 'rejected') {
    body += '<div class="card warn"><h3>Application not approved</h3><p>We could not approve your application this time.</p></div>';
  } else {
    const needPush = cfg.pushAvailable && !(typeof Notification !== 'undefined' && Notification.permission === 'granted' && me.pushEnabled);
    body += '<div class="card"><label class="row between" style="margin:0;font-weight:400"><span><b>On duty</b><br><small>' +
      (me.onDuty ? (lastPos ? 'Sharing your location while the app is open.' : 'Waiting for your location…') : 'Switch on to get alerts near you.') +
      '</small></span><input type="checkbox" id="duty" data-act="toggle-duty"' + (me.onDuty ? ' checked' : '') + '></label>' +
      (me.onDuty ? '<p class="small" style="margin-bottom:0">Keep this app open. Phones pause location sharing when an app is closed.</p>' : '') + '</div>';
    if (needPush) body += '<div class="card"><h3>Get alerts on your lock screen</h3><p class="small">' + (isIOS() && !isStandalone() ? 'On iPhone, first add this app to your Home Screen, then open it from there.' : 'Allow notifications so you hear about alerts even when your screen is off.') + '</p><button class="btn small primary" data-act="enable-push">Turn on alerts</button></div>';
    body += reportCard();
    body += '<div class="card"><h3>How to help safely</h3><ul style="padding-left:20px;margin:0"><li>Call ' + esc(cfg.emergencyNumber) + ' first or at the same time.</li><li>Never confront anyone alone. Go to be seen, to stay with her and to bring others.</li><li>If it looks dangerous, stay back and tell the police exactly where.</li><li>Stay until the police or her family arrive.</li></ul></div>';
  }
  body += installCard();
  return header() + '<main><h1 style="font-size:22px">Hello, ' + esc(me.name.split(' ')[0]) + '</h1>' + body + '<button class="link center-link" data-act="logout">Log out</button></main>';
}

function view() {
  if (!me) {
    if (screen === 'login') return vLogin();
    if (screen === 'forgot') return vForgot();
    if (screen === 'reg-woman') return vRegister('woman');
    if (screen === 'reg-helper') return vRegister('helper');
    return vWelcome();
  }
  if (me.role === 'woman') return myAlert ? vWomanAlert() : (sosError ? vSosError() : vWomanHome());
  return vHelper();
}

function render() {
  // keep what the person has typed while the screen refreshes
  const keep = {};
  app.querySelectorAll('input[id],select[id],textarea[id]').forEach((el) => { keep[el.id] = { v: el.value, c: el.checked }; });
  const focusId = document.activeElement && document.activeElement.id;
  document.body.classList.toggle('alerting', !!(me && me.role === 'woman' && (myAlert || sosError)));
  app.innerHTML = view();
  app.querySelectorAll('input[id],select[id],textarea[id]').forEach((el) => {
    const k = keep[el.id]; if (!k) return;
    if (el.type === 'checkbox') { if (!el.hasAttribute('data-act')) el.checked = k.c; } else el.value = k.v;
  });
  if (focusId) { const f = document.getElementById(focusId); if (f && f.focus) f.focus(); }
  updateAlarm();
}

/* ----------------------------------------------------------- interactions */
const actions = {
  'go-welcome': () => { screen = 'welcome'; formError = ''; render(); },
  'go-login': () => { screen = 'login'; formError = ''; render(); },
  'go-forgot': () => { screen = 'forgot'; forgotStep = 1; formError = ''; render(); },
  'go-reg-woman': () => { screen = 'reg-woman'; formError = ''; render(); },
  'go-reg-helper': () => { screen = 'reg-helper'; formError = ''; render(); },
  logout,
  refresh: async () => { try { await loadState(); render(); } catch (e) { toast(e.message); } },
  'allow-loc': async () => { await getPos(10000); checkLocPerm(); render(); },
  'toggle-shake': async (el) => {
    shakeOn = el.checked; localStorage.setItem('shake', shakeOn ? '1' : '0');
    if (shakeOn) await enableShake(); else disableShake();
  },
  'toggle-quiet': (el) => { quietOn = el.checked; localStorage.setItem('quiet', quietOn ? '1' : '0'); },
  'rm-contact': async (el) => {
    const list = (me.contacts || []).filter((_, i) => i !== Number(el.dataset.i));
    try { const r = await api('/api/me/contacts', { method: 'POST', body: { contacts: list } }); me = r.me; render(); } catch (e) { toast(e.message); }
  },
  siren: () => { toggleSiren(); render(); },
  silence: (el) => { silenced.add(el.dataset.id); render(); },
  'end-safe': () => endAlert('safe'),
  'end-false': () => endAlert('false_alarm'),
  'sos-retry': () => { sosError = ''; startSOS(); },
  'sos-dismiss': () => { sosError = ''; render(); },
  'cancel-countdown': cancelCountdown,
  install: async () => { if (installEvt) { installEvt.prompt(); try { await installEvt.userChoice; } catch (e) { /* ignore */ } installEvt = null; render(); } },
  'enable-push': enablePush,
  'toggle-duty': async (el) => {
    const on = el.checked;
    try {
      if (on) { audio(); await getPos(8000); }
      const r = await api('/api/duty', { method: 'POST', body: { onDuty: on } });
      me = r.me;
      if (on) { startSharing(); postLocation(); } else stopSharing();
      render();
    } catch (e) { el.checked = !on; toast(e.message); }
  },
  respond: async (el) => {
    const id = el.dataset.id, r = el.dataset.r;
    if (r === 'coming') { // open directions in the same tap (must happen before any await, or the browser blocks it)
      const al = helperAlerts.get(id);
      if (al && al.lat != null && al.lng != null) {
        try { window.open('https://www.google.com/maps/dir/?api=1&destination=' + al.lat + ',' + al.lng + '&travelmode=walking', '_blank', 'noopener'); } catch (e) { /* the Open directions button is still on the card */ }
      }
    }
    try {
      await api('/api/sos/' + id + '/respond', { method: 'POST', body: { response: r } });
      if (r === 'cannot') helperAlerts.delete(id);
      else { const a = helperAlerts.get(id); if (a) a.my = r; }
      render();
    } catch (e) { toast(e.message); helperAlerts.delete(id); render(); }
  },
};
app.addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el, e);
});
$('#overlay').addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el, e);
});

const forms = {
  async login(f) {
    const d = Object.fromEntries(new FormData(f));
    busy = true; formError = ''; render();
    try {
      const r = await api('/api/login', { method: 'POST', body: { phone: d.phone, pin: d.pin } });
      token = r.token; localStorage.setItem('token', token);
      await loadState(); busy = false; render(); afterLogin();
    } catch (e) { busy = false; formError = e.message; render(); }
  },
  async forgot1(f) {
    const d = Object.fromEntries(new FormData(f));
    forgotPhone = d.phone; busy = true; formError = ''; render();
    try {
      await api('/api/pin/forgot', { method: 'POST', body: { phone: d.phone } });
      busy = false; forgotStep = 2; render();
    } catch (e) { busy = false; formError = e.message; render(); }
  },
  async forgot2(f) {
    const d = Object.fromEntries(new FormData(f));
    busy = true; formError = ''; render();
    try {
      const r = await api('/api/pin/reset', { method: 'POST', body: { phone: forgotPhone, code: d.code, pin: d.pin } });
      token = r.token; localStorage.setItem('token', token);
      await loadState(); busy = false; screen = 'welcome'; forgotStep = 1; render(); afterLogin();
      toast('Your PIN has been changed.', 5000);
    } catch (e) { busy = false; formError = e.message; render(); }
  },
  async register(f) {
    const d = Object.fromEntries(new FormData(f));
    const role = f.dataset.role;
    const body = { role, name: d.name, phone: d.phone, pin: d.pin, acceptTerms: !!d.terms };
    if (role === 'woman') body.contacts = [{ name: d.c1n, phone: d.c1p }, { name: d.c2n, phone: d.c2p }];
    else Object.assign(body, { idType: d.idType, idLast4: d.idLast4, note: d.note });
    busy = true; formError = ''; render();
    try {
      const r = await api('/api/register', { method: 'POST', body });
      token = r.token; localStorage.setItem('token', token);
      await loadState(); busy = false; screen = 'welcome'; render(); afterLogin();
      if (role === 'woman') toast('All set. Test it once: hold the SOS button, then end the alert with your PIN.', 7000);
    } catch (e) { busy = false; formError = e.message; render(); }
  },
  async report(f) {
    const d = Object.fromEntries(new FormData(f));
    try {
      await api('/api/report', { method: 'POST', body: { text: d.text } });
      f.reset(); toast('Thank you. Your report was sent to the admin.', 5000);
    } catch (e) { toast(e.message); }
  },
  async 'add-contact'(f) {
    const d = Object.fromEntries(new FormData(f));
    if (!d.name || !d.phone) return toast('Enter a name and a phone number');
    try {
      const r = await api('/api/me/contacts', { method: 'POST', body: { contacts: [...(me.contacts || []), { name: d.name, phone: d.phone }] } });
      me = r.me; render();
    } catch (e) { toast(e.message); }
  },
};
app.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (forms[f.dataset.form]) forms[f.dataset.form](f);
});

/* hold-to-send button */
function cancelHold() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  app.querySelectorAll('.holding').forEach((x) => x.classList.remove('holding'));
}
function beginHold(e) {
  const b = e.target.closest && e.target.closest('[data-hold]');
  if (!b) return;
  if (e.cancelable) e.preventDefault();
  cancelHold();
  b.classList.add('holding'); vibrate(40);
  holdTimer = setTimeout(() => { holdTimer = null; b.classList.remove('holding'); vibrate([250]); startSOS(); }, 1500);
}
app.addEventListener('pointerdown', beginHold);
app.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) beginHold(e); });
app.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') cancelHold(); });
app.addEventListener('pointerout', (e) => {
  if (e.target.closest && e.target.closest('[data-hold]') && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-hold]'))) cancelHold();
});
window.addEventListener('pointerup', cancelHold);
window.addEventListener('pointercancel', cancelHold);
app.addEventListener('contextmenu', (e) => { if (e.target.closest && e.target.closest('[data-hold]')) e.preventDefault(); });

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; render(); });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !token) return;
  if (!stream) connectStream();
  try { await loadState(); render(); } catch (e) { /* ignore */ }
  if (myAlert || helperAlerts.size) keepAwake(true);
  if (shouldShare() && lastPos) postLocation();
});

['pointerdown', 'touchend', 'keydown'].forEach((t) => document.addEventListener(t, () => audio(), { once: true }));

/* ------------------------------------------------------------------- boot */
async function boot() {
  try { cfg = Object.assign(cfg, await api('/api/config')); } catch (e) { /* offline: defaults */ }
  document.title = cfg.appName;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (token) {
    try { await loadState(); } catch (e) { if (e.status === 401) { token = null; localStorage.removeItem('token'); } }
  }
  render();
  if (me) afterLogin();
}
boot();
})();
