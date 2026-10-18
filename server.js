'use strict';
/**
 * Saathi - women's safety SOS prototype server (zero required dependencies).
 *
 * Flow: a woman holds the SOS button -> the server finds approved, on-duty helpers
 * with a fresh location inside an expanding radius -> alerts them live (server-sent
 * events) and by push notification (optional `web-push` package), and optionally
 * texts her emergency contacts. Her screen always offers "Call 112": volunteers are
 * a supplement to the police, never a substitute.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ config */
const PORT = Number(process.env.PORT) || 3000;
const APP_NAME = process.env.APP_NAME || 'Be a Guardian';
const EMERGENCY_NUMBER = process.env.EMERGENCY_NUMBER || '112';
const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE || '91';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const RADIUS_STEPS = (process.env.RADIUS_STEPS_M || '1000,2500,5000').split(',').map(Number);
const EXPAND_AFTER_MS = Number(process.env.EXPAND_AFTER_MS) || 45000;
const LOCATION_MAX_AGE_MS = (Number(process.env.LOCATION_MAX_AGE_MIN) || 30) * 60000;
const ALERT_TTL_MS = (Number(process.env.ALERT_TTL_MIN) || 60) * 60000;
const MAX_ALERTS_PER_HOUR = Number(process.env.MAX_ALERTS_PER_HOUR) || 5;
const KEEP_ALERT_RECORDS_MS = 30 * 24 * 3600 * 1000;
// Set REQUIRE_VERIFIED=1 so only helpers with a current "verified until" date (set by admin) are alerted.
const REQUIRE_VERIFIED = process.env.REQUIRE_VERIFIED === '1';
// Guardian ID photos: stored encrypted on disk (never in db.json), only admins can open them, deleted automatically after this many days.
const ID_PHOTO_DAYS = Number(process.env.ID_PHOTO_DAYS) || 180;
const REQUIRE_ID_PHOTO = process.env.REQUIRE_ID_PHOTO !== '0';
const ID_PHOTO_MAX_BYTES = 600 * 1024;
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
// Per-IP limits. Kept generous because a campus or office shares one IP address.
const RATE_REGISTER = Number(process.env.RATE_REGISTER_PER_HOUR) || 60;
const RATE_LOGIN = Number(process.env.RATE_LOGIN_PER_15MIN) || 60;

/* Optional: lock-screen push notifications. Everything else works without it. */
let webpush = null;
try { webpush = require(process.env.WEBPUSH_MODULE || 'web-push'); }
catch { console.log('Note: "web-push" is not installed, so lock-screen push is off. In-app alerts still work.'); }

/* ---------------------------------------------------------------- database */
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, alerts: {}, reports: {}, vapid: null, adminKey: null };
try {
  if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (e) {
  // Refuse to start rather than overwrite a damaged file with an empty database.
  console.error('Could not read database file:', e.message);
  process.exit(1);
}
let saveTimer = null;
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { flush(); } catch (e) { console.error('save failed', e.message); } }, 200);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { flush(); } catch {} process.exit(0); });

/* -------------------------------------------------------------------- keys */
const b64u = (b) => Buffer.from(b).toString('base64url');
function genVapid() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const priv = ecdh.getPrivateKey();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(Buffer.concat([Buffer.alloc(32 - priv.length), priv])) };
}
if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
  db.vapid = { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE };
} else if (!db.vapid) { db.vapid = genVapid(); save(); }
if (webpush) {
  try { webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', db.vapid.publicKey, db.vapid.privateKey); }
  catch (e) { console.error('Push setup failed, push disabled:', e.message); webpush = null; }
}

if (!db.idKey) { db.idKey = crypto.randomBytes(32).toString('hex'); save(); }
// Set ID_KEY on the host so the encryption key is NOT kept next to the encrypted photos.
const ID_ENC_KEY = crypto.createHash('sha256').update(process.env.ID_KEY || db.idKey).digest();
const ID_DIR = path.join(DATA_DIR, 'ids');

let ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  if (!db.adminKey) {
    db.adminKey = crypto.randomBytes(12).toString('hex');
    save();
    console.log('\n  Generated admin key (open /admin.html and paste it):  ' + db.adminKey + '\n');
  }
  ADMIN_KEY = db.adminKey;
}

/* ----------------------------------------------------------------- helpers */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const safeEq = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a), 'hex'), Buffer.from(sha(b), 'hex'));

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const fmtDist = (m) => (m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km');

function normPhone(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else { d = d.replace(/^0+/, ''); if (d.length === 10) d = DEFAULT_CC + d; }
  return /^\d{10,15}$/.test(d) ? d : null;
}
const ID_TYPES = ['Aadhaar', 'Passport', 'Driving licence', 'Voter ID', 'College or work ID'];
const CHECK_METHODS = { video_id: 'Video call, ID seen', college_id: 'College or work ID checked', police_certificate: 'Police verification certificate', reference_called: 'Reference called', other: 'Other' };
// A guardian application collects NO ID numbers. An admin later checks the person (usually on a video call) and records it.
function parseGuardian(g) {
  g = g && typeof g === 'object' ? g : {};
  const org = String(g.note || '').trim().slice(0, 300);
  if (org.length < 3) return { error: 'Tell us where you study or work' };
  const refName = String(g.refName || '').trim().slice(0, 60), refPhone = normPhone(g.refPhone);
  if (!refName || !refPhone) return { error: 'Add the name and phone number of one person who knows you (a reference)' };
  const idType = ID_TYPES.includes(g.idType) ? g.idType : ID_TYPES[0];
  return { ok: { idType, note: org, refName, refPhone } };
}
// ID photo: a JPEG sent as a data URL (the app shrinks and re-encodes it, which also drops camera metadata).
function parsePhoto(v) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(v || ''));
  if (!m) return { error: 'Add a clear photo of your ID' };
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 2000 || buf.length > ID_PHOTO_MAX_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return { error: 'That photo could not be used. Take it again.' };
  return { ok: buf };
}
const idFile = (u, kind) => path.join(ID_DIR, String(u.id).replace(/[^a-z0-9]/gi, '') + (kind === 'selfie' ? '-selfie' : '') + '.enc');
function saveIdPhoto(u, buf, kind) {
  fs.mkdirSync(ID_DIR, { recursive: true, mode: 0o700 });
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', ID_ENC_KEY, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  fs.writeFileSync(idFile(u, kind), Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
  if (kind === 'selfie') u.selfieAt = Date.now(); else u.idPhotoAt = Date.now();
}
function readIdPhoto(u, kind) {
  try {
    const raw = fs.readFileSync(idFile(u, kind));
    const d = crypto.createDecipheriv('aes-256-gcm', ID_ENC_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  } catch { return null; }
}
function removeIdPhoto(u) { for (const k of ['id', 'selfie']) { try { fs.unlinkSync(idFile(u, k)); } catch {} } delete u.idPhotoAt; delete u.selfieAt; }
setInterval(() => {
  const cutoff = Date.now() - ID_PHOTO_DAYS * 86400e3; let n = 0;
  for (const u of Object.values(db.users)) if ((u.idPhotoAt || u.selfieAt) && Math.min(u.idPhotoAt || Infinity, u.selfieAt || Infinity) < cutoff) { removeIdPhoto(u); n++; }
  if (n) save();
}, 6 * 3600e3).unref();
function cleanContacts(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list.slice(0, 5) : []) {
    const name = String((c && c.name) || '').trim().slice(0, 60);
    const phone = normPhone(c && c.phone);
    if (name && phone) out.push({ name, phone });
  }
  return out;
}
function parseLoc(b) {
  const lat = Number(b && b.lat), lng = Number(b && b.lng), acc = Number(b && b.acc) || null;
  if (b == null || b.lat == null || b.lng == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, acc };
}

/* PINs (used to log in and to end an alert) */
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
function checkPin(u, pin) {
  const now = Date.now();
  if (u.lockedUntil && u.lockedUntil > now) return 'locked';
  const ok = crypto.timingSafeEqual(Buffer.from(hashPin(pin, u.pinSalt), 'hex'), Buffer.from(u.pinHash, 'hex'));
  if (ok) { u.pinFails = 0; return 'ok'; }
  u.pinFails = (u.pinFails || 0) + 1;
  if (u.pinFails >= 5) { u.lockedUntil = now + 15 * 60000; u.pinFails = 0; }
  save();
  return 'bad';
}

/* Tiny in-memory rate limiter */
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr); return true;
}
setInterval(() => hits.clear(), 3600e3).unref();

/* Indexes */
const byToken = new Map();
const byPhone = new Map();
function reindex() {
  byToken.clear(); byPhone.clear();
  for (const u of Object.values(db.users)) {
    byPhone.set(u.phone, u.id);
    for (const t of u.tokens || []) byToken.set(t, u.id);
  }
}
reindex();
function issueToken(u) {
  const token = crypto.randomBytes(24).toString('hex');
  u.tokens = [...(u.tokens || []), sha(token)].slice(-5);
  reindex(); save();
  return token;
}
const publicUser = (u) => ({
  id: u.id, role: u.role, name: u.name, phone: u.phone, status: u.status,
  onDuty: !!u.onDuty, hasIdPhoto: !!u.idPhotoAt, hasSelfie: !!u.selfieAt, contacts: u.contacts || [], pushEnabled: !!(u.pushSubs && u.pushSubs.length),
});

/* Live helper locations are kept ONLY in memory - never written to disk. */
const live = new Map(); // userId -> {lat,lng,acc,at}

/* --------------------------------------------------------------- real-time */
const clients = new Map(); // userId -> Set<http.ServerResponse> (server-sent-event streams)
const tickets = new Map(); // one-time stream tickets, so the login token never appears in a URL
const writeEvent = (res, msg) => { try { res.write('data: ' + JSON.stringify(msg) + '\n\n'); } catch {} };
function send(uid, msg) { const set = clients.get(uid); if (set) for (const res of set) writeEvent(res, msg); }
setInterval(() => {
  for (const set of clients.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch {} }
  const now = Date.now();
  for (const [t, v] of tickets) if (v.exp < now) tickets.delete(t);
}, 20000).unref();

function sendPush(u, payload) {
  if (!webpush) return;
  for (const sub of (u.pushSubs || []).slice()) {
    Promise.resolve()
      .then(() => webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: 'high' }))
      .catch((e) => {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          u.pushSubs = (u.pushSubs || []).filter((s) => s.endpoint !== sub.endpoint);
          save();
        } else console.error('push failed:', (e && (e.statusCode || e.message)) || e);
      });
  }
}

/* ------------------------------------------------------------------ alerts */
const timers = new Map();
const activeAlertOf = (uid) => Object.values(db.alerts).find((a) => a.userId === uid && a.status === 'active') || null;
const responders = (a) => Object.values(a.responses).filter((r) => r.status === 'coming' || r.status === 'arrived');

function womanView(a) {
  const r = responders(a);
  return {
    id: a.id, status: a.status, createdAt: a.createdAt, radiusM: RADIUS_STEPS[a.radiusIdx],
    notified: a.notified.length, coming: r.length, arrived: r.filter((x) => x.status === 'arrived').length,
    lat: a.lat, lng: a.lng,
  };
}
function helperView(a, hid) {
  const mine = a.responses[hid];
  const others = responders(a).length - (mine && (mine.status === 'coming' || mine.status === 'arrived') ? 1 : 0);
  return {
    id: a.id, name: a.firstName, lat: a.lat, lng: a.lng, acc: a.acc,
    createdAt: a.createdAt, updatedAt: a.updatedAt, my: mine ? mine.status : null, othersComing: others,
  };
}
function broadcast(a) {
  send(a.userId, { type: 'my_alert', alert: womanView(a) });
  for (const hid of a.notified) {
    const r = a.responses[hid];
    if (r && r.status === 'cannot') continue;
    send(hid, { type: 'helper_alert', alert: helperView(a, hid) });
  }
}

function eligibleHelpers() {
  const now = Date.now(), out = [];
  for (const u of Object.values(db.users)) {
    if (u.role !== 'helper' || u.status !== 'approved' || !u.onDuty) continue;
    if (activeAlertOf(u.id)) continue; // someone who is in danger themselves is not sent to help others
    if (u.verifiedUntil ? u.verifiedUntil < now : REQUIRE_VERIFIED) continue; // verification expired (or required but never set)
    const l = live.get(u.id);
    if (!l || now - l.at > LOCATION_MAX_AGE_MS) continue;
    out.push({ u, l });
  }
  return out;
}
function notifyOne(a, u, d) {
  a.notified.push(u.id);
  send(u.id, { type: 'helper_alert', alert: helperView(a, u.id) });
  sendPush(u, {
    title: 'Someone nearby needs help',
    body: `${a.firstName} pressed SOS about ${fmtDist(d)} from you. Tap to see where. Call ${EMERGENCY_NUMBER} too.`,
    alertId: a.id, url: '/?alert=' + a.id,
  });
}
function notifyHelpers(a) {
  const radius = RADIUS_STEPS[a.radiusIdx];
  let n = 0;
  for (const { u, l } of eligibleHelpers()) {
    if (u.id === a.userId || a.notified.includes(u.id)) continue;
    const d = haversine(a.lat, a.lng, l.lat, l.lng);
    if (d > radius) continue;
    notifyOne(a, u, d); n++;
  }
  if (n) save();
  return n;
}
function notifyHelperIfNear(u) { // a helper opened the app / moved while an alert is live
  const l = live.get(u.id);
  if (!l || activeAlertOf(u.id)) return;
  for (const a of Object.values(db.alerts)) {
    if (a.status !== 'active' || a.notified.includes(u.id) || a.userId === u.id) continue;
    const d = haversine(a.lat, a.lng, l.lat, l.lng);
    if (d <= RADIUS_STEPS[a.radiusIdx]) { notifyOne(a, u, d); save(); broadcast(a); }
  }
}
function scheduleExpansion(a) {
  clearTimeout(timers.get(a.id));
  if (a.status !== 'active' || a.radiusIdx >= RADIUS_STEPS.length - 1) return;
  timers.set(a.id, setTimeout(() => {
    const cur = db.alerts[a.id];
    if (!cur || cur.status !== 'active') return;
    if (responders(cur).length === 0) { cur.radiusIdx++; notifyHelpers(cur); broadcast(cur); save(); }
    scheduleExpansion(cur);
  }, EXPAND_AFTER_MS));
}
async function smsContacts(user, a) { // optional, only if Twilio env vars are set
  const sid = process.env.TWILIO_SID, tok = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !tok || !from) return;
  const text = `${user.name} pressed the ${APP_NAME} SOS button and may be in danger. Their location when they pressed it: https://maps.google.com/?q=${a.lat},${a.lng} . Please call them, and call ${EMERGENCY_NUMBER} if you cannot reach her.`;
  for (const c of user.contacts || []) {
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64') },
        body: new URLSearchParams({ To: '+' + c.phone, From: from, Body: text }),
      });
      if (!r.ok) console.error('sms failed', r.status);
    } catch (e) { console.error('sms error', e.message); }
  }
}
function startAlert(user, loc) {
  const now = Date.now();
  const recent = Object.values(db.alerts).filter((x) => x.userId === user.id && now - x.createdAt < 3600e3).length;
  if (recent >= MAX_ALERTS_PER_HOUR) return null;
  const a = {
    id: rid(8), userId: user.id, firstName: user.name.split(/\s+/)[0],
    lat: loc.lat, lng: loc.lng, acc: loc.acc, createdAt: now, updatedAt: now,
    status: 'active', radiusIdx: 0, notified: [], responses: {}, endedAt: null, endReason: null,
  };
  db.alerts[a.id] = a;
  notifyHelpers(a);
  scheduleExpansion(a);
  smsContacts(user, a);
  broadcast(a);
  save();
  return a;
}
function endAlert(a, reason) {
  if (a.status !== 'active') return;
  a.status = 'ended'; a.endedAt = Date.now(); a.endReason = reason;
  a.lat = a.lng = a.acc = null; // privacy: her location is erased as soon as the alert ends
  clearTimeout(timers.get(a.id)); timers.delete(a.id);
  send(a.userId, { type: 'my_alert_end', id: a.id, reason });
  for (const hid of a.notified) send(hid, { type: 'helper_alert_end', id: a.id, reason });
  save();
}
setInterval(() => {
  const now = Date.now();
  for (const a of Object.values(db.alerts)) {
    if (a.status === 'active' && now - a.createdAt > ALERT_TTL_MS) endAlert(a, 'expired');
    if (a.status === 'ended' && now - a.endedAt > KEEP_ALERT_RECORDS_MS) { delete db.alerts[a.id]; save(); }
  }
  for (const [id, l] of live) if (now - l.at > 24 * 3600e3) live.delete(id);
}, 30000).unref();
for (const a of Object.values(db.alerts)) if (a.status === 'active') scheduleExpansion(a); // resume after a restart

/* ------------------------------------------------------- tiny http router */
const routes = [];
function route(method, pattern, ...handlers) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handlers });
}
const get = (p, ...h) => route('GET', p, ...h);
const post = (p, ...h) => route('POST', p, ...h);
function matchRoute(method, p) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(p);
    if (m) return { handlers: r.handlers, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
function runChain(handlers, req, res) {
  let i = 0;
  const next = () => { const h = handlers[i++]; if (h) h(req, res, next); };
  next();
}
function readBody(req, max = 20000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch { reject(Object.assign(new Error('Bad request'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xf.length) return xf[xf.length - 1]; // the entry added by our own proxy
  }
  return req.socket.remoteAddress || '?';
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
};
function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return bad(res, 'Not found', 404);
  let p = decodeURIComponent(req.path);
  if (p === '/admin') p = '/admin.html';
  else if (p === '/privacy') p = '/privacy.html';
  else if (p === '/terms') p = '/terms.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return bad(res, 'Not found', 404);
  fs.readFile(file, (err, buf) => {
    if (err) return bad(res, 'Not found', 404);
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(o));
  };
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' data:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'");
  req.ip = clientIp(req);
  try {
    const url = new URL(req.url, 'http://localhost');
    req.path = url.pathname; req.query = url.searchParams;
    if (req.path.startsWith('/api/') || req.path === '/healthz' || req.path === '/manifest.webmanifest') {
      const r = matchRoute(req.method, req.path);
      if (!r) return bad(res, 'Not found', 404);
      req.params = r.params;
      req.body = req.method === 'POST' ? await readBody(req, ['/api/register', '/api/guardian/apply', '/api/guardian/id-photo'].includes(req.path) ? 900000 : 20000) : {};
      return runChain(r.handlers, req, res);
    }
    serveStatic(req, res);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e && e.status) return bad(res, e.message, e.status);
    console.error('server error:', e && e.message);
    bad(res, 'Server error', 500);
  }
});

/* ---------------------------------------------------------- auth middleware */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const uid = t && byToken.get(sha(t));
  const u = uid && db.users[uid];
  if (!u || u.status === 'banned') return bad(res, 'Please log in again', 401);
  req.user = u; req.tokenHash = sha(t);
  next();
}
function adminAuth(req, res, next) {
  const k = String(req.headers['x-admin-key'] || '');
  if (k && safeEq(k, ADMIN_KEY)) return next();
  if (!limit('admfail:' + req.ip, 10, 600e3)) return bad(res, 'Too many attempts', 429);
  bad(res, 'Wrong admin key', 401);
}

/* ------------------------------------------------------------------ routes */
get('/healthz', (req, res) => res.json({ ok: true }));
get('/api/config', (req, res) => res.json({
  appName: APP_NAME, emergencyNumber: EMERGENCY_NUMBER, vapidPublicKey: db.vapid.publicKey, pushAvailable: !!webpush,
  otpAvailable: smsConfigured(),
}));
get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.end(JSON.stringify({
    name: APP_NAME, short_name: APP_NAME, start_url: '/', display: 'standalone',
    background_color: '#ffffff', theme_color: '#b3123f',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }));
});

/* ---- accounts */
post('/api/register', (req, res) => {
  if (!limit('reg:' + req.ip, RATE_REGISTER, 3600e3)) return bad(res, 'Too many attempts. Try again later.', 429);
  const b = req.body || {};
  // One account for everyone: anyone can send SOS. "guardian" (or the older role:'helper') also applies to help others, after admin review.
  const wantsGuardian = b.role === 'helper' || !!b.guardian;
  const role = wantsGuardian ? 'helper' : 'woman'; // internal names: 'woman' = member with the SOS button, 'helper' = guardian
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return bad(res, 'Please enter your name');
  const phone = normPhone(b.phone);
  if (!phone) return bad(res, 'Enter a valid phone number');
  if (byPhone.has(phone)) return bad(res, 'This phone number is already registered. Please log in.');
  const pin = String(b.pin || '');
  if (!/^\d{4,6}$/.test(pin)) return bad(res, 'PIN must be 4 to 6 digits');
  if (!b.acceptTerms) return bad(res, 'Please accept the terms to continue');

  const u = { id: rid(8), role, name, phone, createdAt: Date.now(), acceptedTermsAt: Date.now(), strikes: 0 };
  u.pinSalt = rid(8); u.pinHash = hashPin(pin, u.pinSalt);
  u.contacts = cleanContacts(b.contacts);
  if (!u.contacts.length) return bad(res, 'Add at least one emergency contact (name and phone)');
  u.status = 'active';
  if (role === 'helper') {
    const src = b.guardian && typeof b.guardian === 'object' ? b.guardian : b;
    const pg = parseGuardian(src);
    if (pg.error) return bad(res, pg.error);
    const ph = parsePhoto(src.idPhoto), sf = parsePhoto(src.selfie);
    if (ph.error && REQUIRE_ID_PHOTO) return bad(res, ph.error);
    if (sf.error && REQUIRE_ID_PHOTO) return bad(res, 'Add a clear selfie of your face');
    Object.assign(u, pg.ok, { checks: [] });
    u.status = 'pending'; u.onDuty = false;
    if (ph.ok) saveIdPhoto(u, ph.ok, 'id');
    if (sf.ok) saveIdPhoto(u, sf.ok, 'selfie');
  }
  db.users[u.id] = u;
  reindex();
  res.json({ token: issueToken(u), me: publicUser(u) });
});
post('/api/login', (req, res) => {
  if (!limit('login:' + req.ip, RATE_LOGIN, 900e3)) return bad(res, 'Too many attempts. Try again later.', 429);
  const phone = normPhone(req.body.phone);
  const u = phone && db.users[byPhone.get(phone)];
  if (!u || u.status === 'banned') return bad(res, 'Wrong phone number or PIN', 401);
  const r = checkPin(u, req.body.pin || '');
  if (r === 'locked') return bad(res, 'Too many wrong PINs. Try again in 15 minutes.', 429);
  if (r !== 'ok') return bad(res, 'Wrong phone number or PIN', 401);
  res.json({ token: issueToken(u), me: publicUser(u) });
});
/* ---- forgot PIN: a 6-digit code is sent by SMS, then she picks a new PIN */
const otps = new Map(); // phone -> { hash, exp, tries, sentAt } (memory only, never saved to disk)
const OTP_TTL_MS = 10 * 60000;
const smsConfigured = () => !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM);
async function sendSms(phone, text) {
  const sid = process.env.TWILIO_SID, tok = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
  const base = process.env.SMS_API_BASE || 'https://api.twilio.com'; // override only for tests
  const r = await fetch(`${base}/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64') },
    body: new URLSearchParams({ To: '+' + phone, From: from, Body: text }),
  });
  if (!r.ok) throw new Error('sms status ' + r.status);
}
const otpHash = (phone, code) => crypto.createHash('sha256').update(phone + ':' + code + ':' + (db.vapid.publicKey || '')).digest('hex');
post('/api/pin/forgot', async (req, res) => {
  if (!smsConfigured()) return bad(res, 'PIN reset by SMS is not switched on yet. Please contact the ' + APP_NAME + ' team.', 503);
  if (!limit('otpip:' + req.ip, 20, 3600e3)) return bad(res, 'Too many attempts. Try again later.', 429);
  const phone = normPhone((req.body || {}).phone);
  if (!phone) return bad(res, 'Enter a valid phone number');
  const same = { ok: true, message: 'If this number is registered, a 6-digit code has been sent by SMS.' };
  const u = db.users[byPhone.get(phone)];
  if (!u || u.status === 'banned') return res.json(same); // do not reveal who is registered
  const old = otps.get(phone);
  if (old && Date.now() - old.sentAt < 60000) return bad(res, 'Please wait a minute before asking for another code.', 429);
  if (!limit('otpph:' + phone, 5, 3600e3)) return bad(res, 'Too many codes requested for this number. Try again in an hour.', 429);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  otps.set(phone, { hash: otpHash(phone, code), exp: Date.now() + OTP_TTL_MS, tries: 0, sentAt: Date.now() });
  try { await sendSms(phone, `${code} is your ${APP_NAME} code to reset your PIN. It works for 10 minutes. Never share it with anyone.`); }
  catch (e) { otps.delete(phone); console.error('otp sms error', e.message); return bad(res, 'Could not send the SMS. Please try again.', 502); }
  res.json(same);
});
post('/api/pin/reset', (req, res) => {
  if (!limit('otpreset:' + req.ip, 30, 3600e3)) return bad(res, 'Too many attempts. Try again later.', 429);
  const b = req.body || {};
  const phone = normPhone(b.phone);
  const code = String(b.code || '').trim(), pin = String(b.pin || '');
  if (!/^\d{4,6}$/.test(pin)) return bad(res, 'PIN must be 4 to 6 digits');
  const o = phone && otps.get(phone);
  const u = phone && db.users[byPhone.get(phone)];
  if (!o || !u || u.status === 'banned' || o.exp < Date.now()) return bad(res, 'The code is wrong or has expired. Ask for a new one.', 400);
  if (++o.tries > 5) { otps.delete(phone); return bad(res, 'Too many wrong codes. Ask for a new one.', 429); }
  const a = Buffer.from(otpHash(phone, code), 'hex'), c = Buffer.from(o.hash, 'hex');
  if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(a, c)) return bad(res, 'The code is wrong or has expired. Ask for a new one.', 400);
  otps.delete(phone);
  u.pinSalt = rid(8); u.pinHash = hashPin(pin, u.pinSalt);
  u.pinFails = 0; u.lockedUntil = 0;
  u.tokens = []; u.pushSubs = []; live.delete(u.id); // sign her out of every other device
  reindex(); save();
  res.json({ token: issueToken(u), me: publicUser(u) });
});
post('/api/logout', auth, (req, res) => {
  req.user.tokens = (req.user.tokens || []).filter((t) => t !== req.tokenHash);
  req.user.pushSubs = []; live.delete(req.user.id);
  reindex(); save(); res.json({ ok: true });
});
get('/api/state', auth, (req, res) => {
  const u = req.user, out = { me: publicUser(u), alert: null, alerts: [] };
  const own = activeAlertOf(u.id); out.alert = own ? womanView(own) : null;
  out.alerts = Object.values(db.alerts)
    .filter((a) => a.status === 'active' && a.userId !== u.id && a.notified.includes(u.id) && !(a.responses[u.id] && a.responses[u.id].status === 'cannot'))
    .map((a) => helperView(a, u.id));
  res.json(out);
});
/* a member can apply to become a guardian (helper) at any time; an admin reviews it */
post('/api/guardian/apply', auth, (req, res) => {
  const u = req.user, b = req.body || {};
  if (u.role === 'helper' && u.status !== 'rejected') return bad(res, 'You have already applied.');
  const pg = parseGuardian(b);
  if (pg.error) return bad(res, pg.error);
  if (!b.acceptTerms) return bad(res, 'Please agree to the code of conduct and the verification check');
  const ph = parsePhoto(b.idPhoto), sf = parsePhoto(b.selfie);
  if (ph.error && REQUIRE_ID_PHOTO) return bad(res, ph.error);
  if (sf.error && REQUIRE_ID_PHOTO) return bad(res, 'Add a clear selfie of your face');
  u.role = 'helper'; u.status = 'pending'; u.onDuty = false;
  Object.assign(u, pg.ok, { checks: u.checks || [] });
  if (ph.ok) saveIdPhoto(u, ph.ok, 'id');
  if (sf.ok) saveIdPhoto(u, sf.ok, 'selfie');
  save(); res.json({ me: publicUser(u) });
});
/* a guardian who applied earlier (or whose photo was removed) can add or replace the ID photo */
post('/api/guardian/id-photo', auth, (req, res) => {
  const u = req.user;
  if (u.role !== 'helper' || u.status === 'banned') return bad(res, 'Only guardians can add an ID photo');
  const b = req.body || {}, ph = b.idPhoto ? parsePhoto(b.idPhoto) : null, sf = b.selfie ? parsePhoto(b.selfie) : null;
  if (!ph && !sf) return bad(res, 'Add a photo');
  if ((ph && ph.error) || (sf && sf.error)) return bad(res, (ph && ph.error) || sf.error);
  if (ph) saveIdPhoto(u, ph.ok, 'id');
  if (sf) saveIdPhoto(u, sf.ok, 'selfie');
  save(); res.json({ me: publicUser(u) });
});
post('/api/me/contacts', auth, (req, res) => {
  const contacts = cleanContacts(req.body.contacts);
  if (!contacts.length) return bad(res, 'Keep at least one emergency contact');
  req.user.contacts = contacts; save(); res.json({ me: publicUser(req.user) });
});

/* ---- reports: any user can report a problem; it is attached to the alert they were last part of */
post('/api/report', auth, (req, res) => {
  if (!limit('report:' + req.user.id, 10, 24 * 3600e3)) return bad(res, 'Too many reports today. Please call ' + EMERGENCY_NUMBER + ' if it is urgent.', 429);
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (text.length < 5) return bad(res, 'Please describe what happened (at least a few words)');
  const u = req.user;
  const mine = Object.values(db.alerts)
    .filter((a) => a.userId === u.id || a.notified.includes(u.id))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const r = { id: rid(6), userId: u.id, role: u.role, alertId: mine ? mine.id : null, text, createdAt: Date.now(), resolved: false };
  db.reports[r.id] = r;
  save();
  res.json({ ok: true });
});

/* ---- live stream (server-sent events) */
post('/api/stream-ticket', auth, (req, res) => {
  const t = crypto.randomBytes(16).toString('hex');
  tickets.set(t, { uid: req.user.id, exp: Date.now() + 30000 });
  res.json({ ticket: t });
});
get('/api/stream', (req, res) => {
  const t = req.query.get('t') || '';
  const tk = tickets.get(t); tickets.delete(t);
  const u = tk && tk.exp > Date.now() && db.users[tk.uid];
  if (!u || u.status === 'banned') return bad(res, 'Please log in again', 401);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  if (!clients.has(u.id)) clients.set(u.id, new Set());
  clients.get(u.id).add(res);
  res.on('close', () => { const s = clients.get(u.id); if (s) { s.delete(res); if (!s.size) clients.delete(u.id); } });
  writeEvent(res, { type: 'ready' });
  const own = activeAlertOf(u.id); if (own) writeEvent(res, { type: 'my_alert', alert: womanView(own) });
  for (const a of Object.values(db.alerts)) {
    const r = a.responses[u.id];
    if (a.status === 'active' && a.userId !== u.id && a.notified.includes(u.id) && !(r && r.status === 'cannot')) writeEvent(res, { type: 'helper_alert', alert: helperView(a, u.id) });
  }
});

/* ---- helpers: push, duty, location */
post('/api/push/subscribe', auth, (req, res) => {
  const s = req.body.subscription;
  if (!s || typeof s.endpoint !== 'string' || !s.keys || !s.keys.p256dh || !s.keys.auth) return bad(res, 'Bad subscription');
  const u = req.user;
  u.pushSubs = [...(u.pushSubs || []).filter((x) => x.endpoint !== s.endpoint), { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }].slice(-5);
  save(); res.json({ ok: true });
});
post('/api/duty', auth, (req, res) => {
  const u = req.user;
  if (u.role !== 'helper' || u.status !== 'approved') return bad(res, 'Your helper account is not approved yet', 403);
  u.onDuty = !!req.body.onDuty;
  if (!u.onDuty) live.delete(u.id);
  save(); res.json({ me: publicUser(u) });
});
post('/api/location', auth, (req, res) => {
  const loc = parseLoc(req.body);
  if (!loc) return bad(res, 'Bad location');
  const u = req.user;
  if (u.role === 'helper' && u.status === 'approved' && u.onDuty) { live.set(u.id, { ...loc, at: Date.now() }); notifyHelperIfNear(u); }
  const a = activeAlertOf(u.id);
  if (a) { Object.assign(a, loc, { updatedAt: Date.now() }); broadcast(a); }
  res.json({ ok: true });
});

/* ---- SOS */
post('/api/sos', auth, (req, res) => {
  const u = req.user;
  const loc = parseLoc(req.body);
  if (!loc) return bad(res, 'Location unavailable. Turn on location, and call ' + EMERGENCY_NUMBER + '.');
  let a = activeAlertOf(u.id);
  if (a) { Object.assign(a, loc, { updatedAt: Date.now() }); broadcast(a); }
  else {
    // a guardian who is on their way to someone else and now needs help themselves stops being a responder
    for (const o of Object.values(db.alerts)) {
      const r = o.status === 'active' && o.responses[u.id];
      if (r && r.status !== 'cannot') { o.responses[u.id] = { status: 'cannot', at: Date.now() }; send(u.id, { type: 'helper_alert_end', id: o.id, reason: 'declined' }); broadcast(o); }
    }
    a = startAlert(u, loc);
    if (!a) return bad(res, 'Too many alerts in the last hour. Please call ' + EMERGENCY_NUMBER + '.', 429);
  }
  res.json({ alert: womanView(a), emergencyNumber: EMERGENCY_NUMBER });
});
post('/api/sos/:id/cancel', auth, (req, res) => {
  const a = db.alerts[req.params.id];
  if (!a || a.userId !== req.user.id || a.status !== 'active') return bad(res, 'No active alert', 404);
  const r = checkPin(req.user, req.body.pin || '');
  if (r === 'locked') return bad(res, 'Too many wrong PINs. Try again in 15 minutes.', 429);
  if (r !== 'ok') return bad(res, 'Wrong PIN', 403);
  endAlert(a, req.body.reason === 'false_alarm' ? 'false_alarm' : 'safe');
  res.json({ ok: true });
});
post('/api/sos/:id/respond', auth, (req, res) => {
  const a = db.alerts[req.params.id], u = req.user, r = req.body.response;
  if (!a || a.status !== 'active' || u.role !== 'helper' || !a.notified.includes(u.id)) return bad(res, 'Alert not found', 404);
  if (!['coming', 'cannot', 'arrived'].includes(r)) return bad(res, 'Bad response');
  a.responses[u.id] = { status: r, at: Date.now() };
  save(); broadcast(a);
  if (r === 'cannot') send(u.id, { type: 'helper_alert_end', id: a.id, reason: 'declined' });
  res.json({ ok: true });
});

/* ---- admin */
get('/api/admin/overview', adminAuth, (req, res) => {
  const users = Object.values(db.users);
  const helpers = users.filter((u) => u.role === 'helper').map((u) => ({
    id: u.id, name: u.name, phone: u.phone, status: u.status, idType: u.idType, idLast4: u.idLast4,
    refName: u.refName || '', refPhone: u.refPhone || '',
    checks: (u.checks || []).map((c) => ({ method: c.method, label: CHECK_METHODS[c.method] || c.method, idType: c.idType || '', note: c.note || '', at: c.at })),
    note: u.note, createdAt: u.createdAt, onDuty: !!u.onDuty, strikes: u.strikes || 0,
    verifiedUntil: u.verifiedUntil || null, idPhotoAt: u.idPhotoAt || null, selfieAt: u.selfieAt || null,
  }));
  const women = users.filter((u) => u.role === 'woman').map((u) => ({
    id: u.id, name: u.name, phone: u.phone, status: u.status, strikes: u.strikes || 0, createdAt: u.createdAt,
  }));
  const alerts = Object.values(db.alerts).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map((a) => ({
    id: a.id, user: (db.users[a.userId] || {}).name, phone: (db.users[a.userId] || {}).phone,
    createdAt: a.createdAt, status: a.status, endReason: a.endReason,
    notified: a.notified.length, coming: responders(a).length, flaggedFalse: !!a.flaggedFalse, endedAt: a.endedAt || null,
    responders: Object.entries(a.responses || {}).map(([hid, r]) => {
      const h = db.users[hid] || {};
      return { name: h.name || '(deleted)', phone: h.phone || '', status: r.status, at: r.at };
    }),
  }));
  const reports = Object.values(db.reports || {}).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map((r) => {
    const by = db.users[r.userId] || {}, al = r.alertId && db.alerts[r.alertId];
    const who = al ? [...new Set([...Object.keys(al.responses), ...al.notified])].map((id) => {
      const h = db.users[id]; return h ? { id, name: h.name, phone: h.phone, response: (al.responses[id] || {}).status || 'alerted' } : null;
    }).filter(Boolean) : [];
    return { id: r.id, by: by.name || '(deleted user)', byPhone: by.phone, byRole: r.role, text: r.text, createdAt: r.createdAt,
      resolved: !!r.resolved, alertAt: al ? al.createdAt : null, helpers: who };
  });
  res.json({ helpers, women, alerts, reports, checkMethods: CHECK_METHODS, idTypes: ID_TYPES, onDutyNow: eligibleHelpers().length, requireVerified: REQUIRE_VERIFIED });
});
get('/api/admin/users/:id/idphoto', adminAuth, (req, res) => {
  const u = db.users[req.params.id];
  const kind = req.query.get('kind') === 'selfie' ? 'selfie' : 'id';
  const buf = u && (kind === 'selfie' ? u.selfieAt : u.idPhotoAt) ? readIdPhoto(u, kind) : null;
  if (!buf) return bad(res, 'No photo', 404);
  console.log(kind + ' photo viewed by admin:', u.id, new Date().toISOString());
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
});
post('/api/admin/users/:id/:action', adminAuth, (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return bad(res, 'Not found', 404);
  const act = req.params.action;
  if (act === 'delete') { // permanent: removes the account, frees the phone number, erases her alerts
    for (const a of Object.values(db.alerts)) {
      if (a.userId === u.id) { endAlert(a, 'account deleted'); delete db.alerts[a.id]; }
      else { a.notified = a.notified.filter((x) => x !== u.id); delete a.responses[u.id]; }
    }
    live.delete(u.id); removeIdPhoto(u);
    delete db.users[u.id];
    reindex(); save(); return res.json({ ok: true });
  }
  if (act === 'setpin') { // admin gives a temporary PIN (for someone who lost theirs)
    const pin = String((req.body || {}).pin || '');
    if (!/^\d{4,6}$/.test(pin)) return bad(res, 'PIN must be 4 to 6 digits');
    u.pinSalt = rid(8); u.pinHash = hashPin(pin, u.pinSalt);
    u.pinFails = 0; u.lockedUntil = 0; u.tokens = []; u.pushSubs = []; live.delete(u.id);
    reindex(); save(); return res.json({ ok: true });
  }
  if (act === 'verify' && u.role === 'helper') { // record that this helper's police/ID check is valid until a date (blank = clear it)
    const raw = String((req.body || {}).until || '').trim();
    if (!raw) { delete u.verifiedUntil; save(); return res.json({ ok: true }); }
    const t = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(raw + 'T23:59:59+05:30') : NaN;
    if (!Number.isFinite(t) || t < Date.now() || t > Date.now() + 800 * 86400e3) return bad(res, 'Use a future date like 2027-10-16 (within about 2 years)');
    u.verifiedUntil = t; save(); return res.json({ ok: true });
  }
  if (act === 'check' && u.role === 'helper') { // an admin records that they checked this person
    const b = req.body || {};
    if (!CHECK_METHODS[b.method]) return bad(res, 'Choose how the person was checked');
    const c = { method: b.method, at: Date.now() };
    if (b.method === 'video_id') c.idType = ID_TYPES.includes(b.idType) ? b.idType : ID_TYPES[0];
    c.note = String(b.note || '').trim().slice(0, 200);
    u.checks = [...(u.checks || []), c].slice(-20);
    if (b.until) {
      const t = /^\d{4}-\d{2}-\d{2}$/.test(String(b.until)) ? Date.parse(b.until + 'T23:59:59+05:30') : NaN;
      if (!Number.isFinite(t) || t < Date.now() || t > Date.now() + 800 * 86400e3) return bad(res, 'Use a future date like 2027-10-16 for "valid until"');
      u.verifiedUntil = t;
    }
    save(); return res.json({ ok: true });
  }
  if (act === 'approve' && u.role === 'helper') {
    if (!(u.checks || []).length && u.status !== 'banned') return bad(res, 'Record at least one check (for example a video call) before approving');
    if (REQUIRE_ID_PHOTO && !u.idPhotoAt) return bad(res, 'This guardian has not uploaded an ID photo yet');
    if (REQUIRE_ID_PHOTO && !u.selfieAt) return bad(res, 'This guardian has not uploaded a selfie yet');
    u.status = 'approved';
  }
  else if (act === 'reject' && u.role === 'helper') { u.status = 'rejected'; u.onDuty = false; live.delete(u.id); removeIdPhoto(u); }
  else if (act === 'deleteidphoto') removeIdPhoto(u);
  else if (act === 'ban') { u.status = 'banned'; u.onDuty = false; live.delete(u.id); }
  else if (act === 'unban') u.status = u.role === 'helper' ? 'pending' : 'active';
  else return bad(res, 'Unknown action');
  save(); res.json({ ok: true });
});
post('/api/admin/reports/:id/resolve', adminAuth, (req, res) => {
  const r = (db.reports || {})[req.params.id];
  if (!r) return bad(res, 'Not found', 404);
  r.resolved = true; save(); res.json({ ok: true });
});
post('/api/admin/alerts/:id/false', adminAuth, (req, res) => {
  const a = db.alerts[req.params.id];
  if (!a) return bad(res, 'Not found', 404);
  if (!a.flaggedFalse) {
    a.flaggedFalse = true;
    const u = db.users[a.userId];
    if (u) { u.strikes = (u.strikes || 0) + 1; if (u.strikes >= 3) u.status = 'banned'; }
    save();
  }
  res.json({ ok: true });
});

server.listen(PORT, () => console.log(`${APP_NAME} server listening on port ${PORT}`));
