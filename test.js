'use strict';
// End-to-end test of the real alert flow. Run with:  node test.js
// Starts its own server on a spare port with a throw-away database.
const PHOTO = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'saathi-test-'));
const PUSHLOG = path.join(DATA, 'push.log');
const FAKE_PUSH = path.join(DATA, 'fake-webpush.js');
// A stand-in for the optional "web-push" package that records what would be sent.
fs.writeFileSync(FAKE_PUSH, `
const fs=require('fs');
exports.setVapidDetails=()=>{};
exports.sendNotification=async(sub,payload)=>{ fs.appendFileSync(${JSON.stringify(PUSHLOG)}, JSON.stringify({endpoint:sub.endpoint,payload:JSON.parse(payload)})+'\\n');
  if(sub.endpoint.includes('gone')){ const e=new Error('gone'); e.statusCode=410; throw e; } };
`);

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, { method = 'GET', body, token, admin } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, admin ? { 'x-admin-key': admin } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ...j };
}

/* A live event-stream client (what the phone's EventSource does). */
async function openStream(token) {
  const { ticket } = await api('/api/stream-ticket', { method: 'POST', token });
  const res = await fetch(BASE + '/api/stream?t=' + ticket);
  const events = [];
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});
  return { events, status: res.status, has: (type) => events.filter((e) => e.type === type) };
}

const HOME = { lat: 12.9716, lng: 77.5946 };          // the woman
const north = (m) => ({ lat: HOME.lat + m / 111195, lng: HOME.lng });

(async () => {
  const server = spawn('node', [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: DATA, ADMIN_KEY: 'testkey', EXPAND_AFTER_MS: '700',
      WEBPUSH_MODULE: FAKE_PUSH, TRUST_PROXY: '0', RATE_REGISTER_PER_HOUR: '500',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50 && !log.includes('listening'); i++) await sleep(100);
  if (!log.includes('listening')) { console.log('server did not start:\n' + log); process.exit(1); }

  try {
    console.log('\nAccounts');
    let r = await api('/api/register', { method: 'POST', body: { role: 'woman', name: 'Priya Sharma', phone: '9876500001', pin: '4321', contacts: [{ name: 'Mum', phone: '9876500099' }], acceptTerms: true } });
    ok(r.status === 200 && r.token, 'woman can register');
    const W = r.token;
    ok((await api('/api/register', { method: 'POST', body: { role: 'woman', name: 'X', phone: '9876500001', pin: '1111', contacts: [{ name: 'a', phone: '9876500098' }], acceptTerms: true } })).status === 400, 'duplicate phone is rejected');
    ok((await api('/api/register', { method: 'POST', body: { role: 'woman', name: 'X', phone: '9876500002', pin: '12', contacts: [{ name: 'a', phone: '9876500098' }], acceptTerms: true } })).status === 400, 'weak PIN is rejected');
    ok((await api('/api/register', { method: 'POST', body: { role: 'woman', name: 'X', phone: '9876500002', pin: '1234', contacts: [], acceptTerms: true } })).status === 400, 'woman must add an emergency contact');

    const helpers = {};
    for (const [key, phone] of [['near', '9876510001'], ['mid', '9876510002'], ['far', '9876510003'], ['pending', '9876510004'], ['offduty', '9876510005'], ['decline', '9876510006']]) {
      const h = await api('/api/register', { method: 'POST', body: { role: 'helper', name: 'Helper ' + key, phone, pin: '1234', idType: 'Passport', note: 'Delhi college', refName: 'Ref Person', refPhone: '9876500095', idPhoto: PHOTO, selfie: PHOTO, contacts: [{ name: 'Kin', phone: '9876500096' }], acceptTerms: true } });
      helpers[key] = { token: h.token, id: h.me.id, status: h.me.status };
    }
    ok(helpers.near.status === 'pending', 'new helpers start as pending');
    ok((await api('/api/duty', { method: 'POST', token: helpers.near.token, body: { onDuty: true } })).status === 403, 'unapproved helper cannot go on duty');

    console.log('\nAdmin');
    ok((await api('/api/admin/overview')).status === 401, 'admin API needs the key');
    ok((await api('/api/admin/overview', { admin: 'wrong' })).status === 401, 'wrong admin key is refused');
    const ov = await api('/api/admin/overview', { admin: 'testkey' });
    ok(ov.helpers.length === 6 && ov.helpers.every((h) => !('pinHash' in h) && !('idLast4' in h && h.idLast4)), 'admin sees applicants (no secrets)');
    ok((await api('/api/admin/users/' + helpers.near.id + '/approve', { method: 'POST', admin: 'testkey' })).status === 400, 'approval needs a recorded check first');
    for (const k of ['near', 'mid', 'far', 'offduty', 'decline']) {
      await api('/api/admin/users/' + helpers[k].id + '/check', { method: 'POST', admin: 'testkey', body: { method: 'video_id', idType: 'Passport', note: 'test' } });
      await api('/api/admin/users/' + helpers[k].id + '/approve', { method: 'POST', admin: 'testkey' });
    }

    console.log('\nHelpers go on duty');
    const place = { near: north(300), mid: north(1700), far: north(6700), pending: north(200), offduty: north(250), decline: north(400) };
    for (const k of ['near', 'mid', 'far', 'decline']) {
      ok((await api('/api/duty', { method: 'POST', token: helpers[k].token, body: { onDuty: true } })).status === 200, k + ' helper on duty');
    }
    for (const k of ['near', 'mid', 'far', 'decline', 'pending', 'offduty']) {
      await api('/api/location', { method: 'POST', token: helpers[k].token, body: place[k] });
    }
    ok((await api('/api/push/subscribe', { method: 'POST', token: helpers.near.token, body: { subscription: { endpoint: 'https://push.example/near', keys: { p256dh: 'a', auth: 'b' } } } })).status === 200, 'near helper registers for push');
    await api('/api/push/subscribe', { method: 'POST', token: helpers.decline.token, body: { subscription: { endpoint: 'https://push.example/gone', keys: { p256dh: 'a', auth: 'b' } } } });

    const S = {};
    for (const k of Object.keys(helpers)) S[k] = await openStream(helpers[k].token);
    const SW = await openStream(W);
    ok(S.near.status === 200, 'live stream connects');
    ok((await fetch(BASE + '/api/stream?t=nope')).status === 401, 'stream refuses a bad ticket');
    const t1 = (await api('/api/stream-ticket', { method: 'POST', token: W })).ticket;
    await fetch(BASE + '/api/stream?t=' + t1).then((x) => x.body.cancel());
    ok((await fetch(BASE + '/api/stream?t=' + t1)).status === 401, 'a stream ticket works only once');

    console.log('\nSOS');
    ok((await api('/api/sos', { method: 'POST', token: helpers.near.token, body: {} })).status === 400, 'a guardian account may use SOS too (refused here only for the missing location)');
    ok((await api('/api/sos', { method: 'POST', token: W, body: {} })).status === 400, 'SOS without location is refused with a clear message');
    r = await api('/api/sos', { method: 'POST', token: W, body: HOME });
    ok(r.status === 200 && r.alert && r.alert.notified === 2, 'SOS alerts helpers within 1 km (near + decline = 2), got ' + (r.alert && r.alert.notified));
    const alertId = r.alert.id;
    await sleep(250);
    ok(S.near.has('helper_alert').length >= 1, 'near helper gets the alert instantly');
    ok(S.near.has('helper_alert')[0].alert.name === 'Priya' && S.near.has('helper_alert')[0].alert.lat === HOME.lat, 'alert shows first name and location only');
    ok(S.mid.has('helper_alert').length === 0, 'helper 1.7 km away is NOT alerted yet');
    ok(S.far.has('helper_alert').length === 0, 'helper 6.7 km away is NOT alerted');
    ok(S.pending.has('helper_alert').length === 0, 'unapproved helper is never alerted');
    ok(S.offduty.has('helper_alert').length === 0, 'off-duty helper is never alerted');
    const pushed = fs.existsSync(PUSHLOG) ? fs.readFileSync(PUSHLOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    ok(pushed.some((p) => p.endpoint.endsWith('/near') && /Someone nearby/.test(p.payload.title) && p.payload.url.includes(alertId)), 'near helper is also sent a lock-screen push');
    ok(!JSON.stringify(pushed).includes(String(HOME.lat)), 'push payload does not contain her coordinates');
    ok(r.emergencyNumber === '112', 'response carries the emergency number');

    const dup = await api('/api/sos', { method: 'POST', token: W, body: HOME });
    ok(dup.alert.id === alertId, 'pressing SOS twice does not create a second alert');

    console.log('\nRadius expansion (no one has responded)');
    await sleep(1100);
    ok(S.mid.has('helper_alert').length >= 1, 'after the wait, the 2.5 km ring alerts the mid helper');
    ok(S.far.has('helper_alert').length === 0, 'far helper (beyond 5 km) is still not alerted');
    ok(SW.has('my_alert').some((e) => e.alert.radiusM === 2500), 'she sees the search widen');

    console.log('\nResponses');
    ok((await api('/api/sos/' + alertId + '/respond', { method: 'POST', token: helpers.far.token, body: { response: 'coming' } })).status === 404, 'a helper who was not alerted cannot respond');
    ok((await api('/api/sos/' + alertId + '/respond', { method: 'POST', token: helpers.near.token, body: { response: 'coming' } })).status === 200, 'near helper says "coming"');
    await sleep(200);
    const last = SW.has('my_alert').slice(-1)[0].alert;
    ok(last.coming === 1, 'she is told 1 helper is on the way');
    ok(S.mid.has('helper_alert').slice(-1)[0].alert.othersComing === 1, 'other helpers see that someone is already coming');
    await api('/api/sos/' + alertId + '/respond', { method: 'POST', token: helpers.decline.token, body: { response: 'cannot' } });
    await sleep(150);
    ok(S.decline.has('helper_alert_end').length === 1, 'a helper who declines has the card removed');

    console.log('\nLive location while the alert runs');
    await api('/api/location', { method: 'POST', token: W, body: north(120) });
    await sleep(200);
    ok(Math.abs(S.near.has('helper_alert').slice(-1)[0].alert.lat - north(120).lat) < 1e-9, 'helpers see her updated position');
    await api('/api/location', { method: 'POST', token: helpers.far.token, body: north(2000) }); // far helper drives closer
    await sleep(200);
    ok(S.far.has('helper_alert').length >= 1, 'a helper who moves into range mid-alert is alerted');

    console.log('\nEnding the alert');
    ok((await api('/api/sos/' + alertId + '/cancel', { method: 'POST', token: helpers.near.token, body: { pin: '4321' } })).status === 404, "someone else cannot end her alert");
    ok((await api('/api/sos/' + alertId + '/cancel', { method: 'POST', token: W, body: { pin: '0000' } })).status === 403, 'wrong PIN does not end the alert');
    ok((await api('/api/state', { token: W })).alert !== null, 'alert still active after wrong PIN');
    ok((await api('/api/sos/' + alertId + '/cancel', { method: 'POST', token: W, body: { pin: '4321', reason: 'safe' } })).status === 200, 'correct PIN ends the alert');
    await sleep(250);
    ok(S.near.has('helper_alert_end').length === 1 && S.mid.has('helper_alert_end').length === 1, 'all alerted helpers are told it ended');
    ok(SW.has('my_alert_end').length === 1, 'she gets the end confirmation');
    ok((await api('/api/state', { token: W })).alert === null, 'no active alert remains');
    const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
    for (let i = 0; i < 20 && Object.values(db.alerts).some((a) => a.lat != null); i++) await sleep(100);
    const rec = Object.values(JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).alerts)[0];
    ok(rec && rec.lat === null && rec.lng === null, 'her location is erased from the database once the alert ends');
    ok(!fs.readFileSync(path.join(DATA, 'db.json'), 'utf8').includes(String(north(300).lat).slice(0, 8)), "helpers' live locations are never written to disk");
    const dbtext = fs.readFileSync(path.join(DATA, 'db.json'), 'utf8');
    ok(!dbtext.includes('4321') && !dbtext.includes('"pin"'), 'PINs are not stored in plain text');
    ok(!dbtext.includes(W), 'login tokens are stored only as hashes');

    console.log('\nPIN lock-out and abuse limits');
    const W2 = (await api('/api/register', { method: 'POST', body: { role: 'woman', name: 'Neha', phone: '9876500003', pin: '5555', contacts: [{ name: 'Dad', phone: '9876500097' }], acceptTerms: true } })).token;
    const a2 = (await api('/api/sos', { method: 'POST', token: W2, body: HOME })).alert;
    for (let i = 0; i < 5; i++) await api('/api/sos/' + a2.id + '/cancel', { method: 'POST', token: W2, body: { pin: '0000' } });
    ok((await api('/api/sos/' + a2.id + '/cancel', { method: 'POST', token: W2, body: { pin: '5555' } })).status === 429, 'after 5 wrong PINs the PIN is locked (even the right one)');
    ok((await api('/api/login', { method: 'POST', body: { phone: '9876500003', pin: '5555' } })).status === 429, 'login is locked too');
    const strikeId = (await api('/api/admin/overview', { admin: 'testkey' })).alerts[0].id;
    ok((await api('/api/admin/alerts/' + strikeId + '/false', { method: 'POST', admin: 'testkey' })).status === 200, 'admin can flag a false alarm');
    const ban = (await api('/api/admin/overview', { admin: 'testkey' })).women.find((w) => w.phone === '919876500003');
    ok(ban.strikes === 1, 'the flag adds a strike');

    console.log('\nLogin and security basics');
    const lg = await api('/api/login', { method: 'POST', body: { phone: '+91 98765 00001', pin: '4321' } });
    ok(lg.status === 200 && lg.me.name === 'Priya Sharma', 'login accepts a formatted phone number');
    ok((await api('/api/login', { method: 'POST', body: { phone: '9876500001', pin: '9999' } })).status === 401, 'wrong PIN cannot log in');
    ok((await api('/api/state')).status === 401, 'no token, no access');
    ok((await api('/api/state', { token: 'garbage' })).status === 401, 'bad token, no access');
    await api('/api/admin/users/' + helpers.mid.id + '/ban', { method: 'POST', admin: 'testkey' });
    ok((await api('/api/state', { token: helpers.mid.token })).status === 401, 'a banned user is locked out immediately');
    const page = await fetch(BASE + '/');
    ok(page.status === 200 && /content-security-policy/i.test([...page.headers.keys()].join(',')), 'app page is served with a security policy');
    ok((await fetch(BASE + '/manifest.webmanifest')).status === 200, 'install manifest is served');
    ok((await fetch(BASE + '/icon-512.png')).status === 200, 'icons are served');
    ok((await fetch(BASE + '/server.js')).status === 404, 'server source is not downloadable');
    ok((await fetch(BASE + '/data/db.json')).status === 404, 'database is not downloadable');
  } catch (e) {
    fail++; console.log('  CRASH', e);
  } finally {
    server.kill();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
