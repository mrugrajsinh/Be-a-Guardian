'use strict';
// Runs the real public/app.js (the phone code) against the real server, with a
// simulated phone: one woman's app and one helper's app, driven through the actual
// screens and buttons. Run with:  node test-ui.js   (no real browser needed)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'saathi-ui-'));
const APP_JS = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };

class FakeES { // EventSource, implemented with fetch streaming
  constructor(url) {
    this.ac = new AbortController();
    fetch(BASE + url, { signal: this.ac.signal }).then(async (res) => {
      if (!res.ok) { this.onerror && this.onerror(); return; }
      this.onopen && this.onopen();
      const dec = new TextDecoder(); let buf = '';
      for await (const ch of res.body) {
        buf += dec.decode(ch, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const blk = buf.slice(0, i); buf = buf.slice(i + 2);
          const l = blk.split('\n').find((x) => x.startsWith('data: '));
          if (l && this.onmessage) this.onmessage({ data: l.slice(6) });
        }
      }
    }).catch(() => { if (!this.closed) this.onerror && this.onerror(); });
  }
  close() { this.closed = true; this.ac.abort(); }
}

function makePhone(pos) {
  const store = new Map();
  const handlers = {};
  const pinEl = { value: '' };
  const toasts = [];
  const app = { _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; }, querySelectorAll: () => [], addEventListener: (t, f) => { handlers[t] = f; } };
  const overlayClasses = new Set();
  const overlay = { hidden: true, _html: '', classList: { add: (c) => overlayClasses.add(c), remove: (c) => overlayClasses.delete(c) }, set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, addEventListener: (t, f) => { handlers['ov-' + t] = f; } };
  const toast = { textContent: '', hidden: true };
  const errors = [];
  const audioLog = { tones: 0, buzzes: 0 };
  const sb = {
    AudioContext: class { constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
      createOscillator() { audioLog.tones++; return { frequency: {}, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: {}, connect() {} }; } resume() {} },
    console: { log() {}, error: (...a) => errors.push(a.join(' ')) },
    setTimeout, clearTimeout, setInterval, clearInterval, atob, encodeURIComponent, URLSearchParams,
    fetch: (u, o) => fetch(BASE + u, o),
    FormData: class { constructor(f) { this.f = f; } [Symbol.iterator]() { return Object.entries(this.f.__data).values(); } },
    EventSource: FakeES,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    navigator: {
      userAgent: 'test', vibrate: (p) => { if (p) audioLog.buzzes++; },
      geolocation: {
        getCurrentPosition: (ok2) => setTimeout(() => ok2({ coords: { latitude: pos.lat, longitude: pos.lng, accuracy: 12 } }), 5),
        watchPosition: (ok2) => { setTimeout(() => ok2({ coords: { latitude: pos.lat, longitude: pos.lng, accuracy: 12 } }), 5); return 1; },
        clearWatch() {},
      },
    },
    document: {
      title: '', visibilityState: 'visible', activeElement: null,
      body: { classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); } } },
      querySelector: (s) => ({ '#app': app, '#overlay': overlay, '#toast': toast, '#pin': pinEl }[s] || null),
      getElementById: () => null, addEventListener() {},
    },
  };
  sb.window = sb;
  sb.window.addEventListener = () => {}; sb.window.removeEventListener = () => {};
  sb.window.matchMedia = () => ({ matches: false });
  Object.defineProperty(toast, 'textContent', { get() { return this._t; }, set(v) { this._t = v; toasts.push(v); } });
  vm.createContext(sb);
  vm.runInContext(APP_JS, sb);

  const el = (props) => Object.assign({ dataset: {}, classList: { add() {}, remove() {} } }, props);
  const evt = (target, extra) => Object.assign({ target, cancelable: false, preventDefault() {} }, extra);
  const phone = {
    errors, toasts, pinEl, audioLog,
    get html() { return app.innerHTML; },
    get overlayHtml() { return overlay.innerHTML; },
    get overlayHidden() { return overlay.hidden; },
    get overlayIsAlarm() { return overlayClasses.has('alarm'); },
    get alerting() { return sb.document.body.classList._s.has('alerting'); },
    storage: store,
    async click(act, data = {}, checked) {
      const e = el({ dataset: Object.assign({ act }, data), checked });
      handlers.click(evt({ closest: (s) => (s === '[data-act]' ? e : null) }));
      await sleep(250);
    },
    async clickOverlay(act, data = {}) {
      const e = el({ dataset: Object.assign({ act }, data) });
      handlers['ov-click'](evt({ closest: (s) => (s === '[data-act]' ? e : null) }));
      await sleep(100);
    },
    async submit(form, role, data) {
      const f = { dataset: { form, role }, __data: data };
      handlers.submit({ preventDefault() {}, target: f });
      await sleep(500);
    },
    async holdSOS(ms) {
      const b = el({ hold: true });
      handlers.pointerdown(evt({ closest: (s) => (s === '[data-hold]' ? b : null) }));
      await sleep(ms);
    },
  };
  return phone;
}

(async () => {
  const server = spawn('node', [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA, ADMIN_KEY: 'uikey', TRUST_PROXY: '0', EXPAND_AFTER_MS: '60000' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50 && !log.includes('listening'); i++) await sleep(100);

  const HOME = { lat: 12.9716, lng: 77.5946 };
  try {
    const W = makePhone(HOME);
    const H = makePhone({ lat: HOME.lat + 0.002, lng: HOME.lng });
    await sleep(400);

    console.log('\nWoman: sign-up');
    ok(/Press and hold for help/.test(W.html) && /Create my free account/.test(W.html), 'welcome screen shows');
    await W.click('go-reg');
    ok(/Create your account/.test(W.html) && /Emergency contacts/.test(W.html) && /also want to be a guardian/.test(W.html), 'one sign-up form shows, with an optional guardian switch');
    ok(!/ID you will show us/.test(W.html), 'guardian fields stay hidden until the switch is ticked');
    await W.submit('register', null, { name: '<img src=x onerror=1> Asha Rao', phone: '9876543210', pin: '2468', c1n: 'Mum', c1p: '9876500011', c2n: '', c2p: '', terms: 'on' });
    ok(/class="sos"/.test(W.html), 'after sign-up she sees the big SOS button');
    ok(/Mum/.test(W.html) && /\+919876500011/.test(W.html), 'her emergency contact is listed');
    ok(/tel:112/.test(W.html), 'a Call 112 button is always on the home screen');
    ok(W.storage.get('token'), 'she stays logged in');

    console.log('\nHelper: sign-up, approval, duty');
    await H.click('go-reg');
    await H.click('toggle-reg-guardian', {}, true);
    ok(/ID you will show us/.test(H.html), 'ticking the guardian switch shows the ID fields');
    await H.submit('register', null, { name: 'Ravi Kumar', phone: '9123456780', pin: '1357', c1n: 'Dad', c1p: '9123456799', idType: 'Aadhaar', idLast4: '4321', note: 'works nearby', terms: 'on' });
    ok(/Guardian application under review/.test(H.html), 'new guardian sees "under review"');
    ok(/class="sos"/.test(H.html), 'a pending guardian still has the SOS button');
    ok(!/Guardian on duty/.test(H.html), 'pending guardian cannot go on duty');
    const ov = await (await fetch(BASE + '/api/admin/overview', { headers: { 'x-admin-key': 'uikey' } })).json();
    const hid = ov.helpers.find((h) => h.name === 'Ravi Kumar').id;
    ok(ov.helpers[0].idLast4 === '4321' && !JSON.stringify(ov).includes('9123456780'.slice(0, 0) + 'pinHash'), 'admin sees the application');
    await fetch(BASE + '/api/admin/users/' + hid + '/approve', { method: 'POST', headers: { 'x-admin-key': 'uikey' } });
    await H.click('refresh');
    ok(/Guardian on duty/.test(H.html) && /How to help safely/.test(H.html), 'after approval the guardian sees duty switch and safety guidance');
    await H.click('toggle-duty', {}, true);
    ok(/Sharing your location|Waiting for your location/.test(H.html), 'helper is on duty and sharing location');

    console.log('\nWoman presses and holds SOS');
    await W.holdSOS(300);
    ok(!/Your alert is live/.test(W.html), 'a short press does NOT send an alert');
    await sleep(1400);
    ok(/Your alert is live/.test(W.html), 'holding for 2 seconds sends the alert');
    ok(W.alerting, 'her screen switches to the red alert mode');
    ok(/Call 112 now/.test(W.html) && /tel:112/.test(W.html), 'Call 112 is the biggest button during an alert');
    ok(/1 guardian alerted within 1(\.0)? km|guardian alerted/.test(W.html), 'she is told a helper was alerted');
    const wa = (W.html.match(/href="(https:\/\/wa\.me\/919876500011[^"]*)"/) || [])[1] || '';
    const waText = decodeURIComponent(wa.split('text=')[1] || '').replace(/&amp;/g, '&');
    console.log('       message her contact would receive: ' + waText);
    ok(/wa\.me\/919876500011/.test(wa) && /https:\/\/maps\.google\.com\/\?q=12\.97\d*,77\.59\d*/.test(waText), 'one-tap WhatsApp/SMS to her contact includes her location');

    console.log('\nHelper receives the alert');
    await sleep(500);
    ok(/needs help/.test(H.html), 'the helper app shows the alert card');
    ok(!/<img/i.test(H.html) && /&lt;img/.test(H.html), 'her name is shown safely (no HTML injection)');
    ok(/2\d\d m away|[12]\d\d m away/.test(H.html), 'helper sees how far away she is: ' + (H.html.match(/(\d+ m|[\d.]+ km) away/) || [''])[0]);
    ok(/google\.com\/maps\/dir[^"]*destination=12\.97/.test(H.html), 'there is a directions link to her position');
    ok(/tel:112/.test(H.html) && /Do not confront anyone alone/.test(H.html), 'helper is told to call 112 and not to confront alone');

    console.log('\nFull-screen alarm on the helper phone');
    ok(!H.overlayHidden && H.overlayIsAlarm, 'the alarm takes over the whole helper screen');
    ok(/SOS NEARBY/.test(H.overlayHtml) && /I AM COMING/.test(H.overlayHtml) && /tel:112/.test(H.overlayHtml), 'it has a huge I AM COMING button and Call 112');
    ok(/\d+ m away/.test(H.overlayHtml) && /&lt;img/.test(H.overlayHtml) && !/<img/i.test(H.overlayHtml), 'it shows the distance, and her name safely');
    const alertId = (H.html.match(/data-id="([a-f0-9]+)"/) || [])[1];
    await sleep(900);
    ok(H.audioLog.tones >= 4 && H.audioLog.buzzes >= 1, 'the siren is sounding and the phone is vibrating (' + H.audioLog.tones + ' siren tones so far)');
    await H.clickOverlay('silence', { id: alertId });
    ok(H.overlayHidden, '"Silence the alarm" closes the full-screen alarm');
    const toneCount = H.audioLog.tones;
    await sleep(900);
    ok(H.audioLog.tones === toneCount, 'and the siren stops immediately');
    ok(/needs help/.test(H.html), 'the alert card is still there after silencing');

    console.log('\nHelper responds');
    await H.click('respond', { id: alertId, r: 'coming' });
    ok(/I have arrived/.test(H.html), 'after "I am coming" the helper gets an "arrived" button');
    await sleep(400);
    ok(/1 guardian is on the way/.test(W.html), 'the woman is told one helper is on the way');
    await H.click('respond', { id: alertId, r: 'arrived' });
    await sleep(400);
    ok(/has reached you/.test(W.html), 'the woman is told a helper has reached her');
    ok(/Stay with them/.test(H.html), 'the helper is reminded to stay with her');

    console.log('\nEnding the alert');
    W.pinEl.value = '0000';
    await W.click('end-safe');
    ok(/Your alert is live/.test(W.html), 'wrong PIN does not end the alert');
    W.pinEl.value = '2468';
    await W.click('end-safe');
    ok(/class="sos"/.test(W.html) && !W.alerting, 'correct PIN ends it and returns to the home screen');
    await sleep(400);
    ok(!/needs help/.test(H.html), 'the helper card disappears when she is safe');
    ok(H.toasts.some((t) => /they are safe/i.test(t)), 'the helper is told she is safe');

    console.log('\nSecond alert: answering straight from the full-screen alarm');
    await W.holdSOS(1700);
    await sleep(600);
    ok(/Your alert is live/.test(W.html), 'she sends another SOS');
    ok(!H.overlayHidden && /SOS NEARBY/.test(H.overlayHtml), 'the full-screen alarm appears again on the helper phone');
    const id2 = (H.overlayHtml.match(/data-id="([a-f0-9]+)"/) || [])[1];
    await H.clickOverlay('respond', { id: id2, r: 'coming' });
    ok(H.overlayHidden, 'tapping I AM COMING on the alarm closes it');
    await sleep(500);
    ok(/1 guardian is on the way/.test(W.html), 'and she is told someone is on the way');
    W.pinEl.value = '2468';
    await W.click('end-safe');
    await sleep(400);
    ok(H.overlayHidden, 'alarm stays closed after the alert ends');
    await W.holdSOS(1700);
    await sleep(600);
    ok(!H.overlayHidden, 'a third alert triggers the alarm again');
    W.pinEl.value = '2468';
    await W.click('end-false');
    await sleep(500);
    ok(H.overlayHidden, 'if she ends the alert while the alarm is ringing, it stops by itself');

    console.log('\nFailure behaviour');
    const W3 = makePhone(HOME);
    await sleep(300);
    await W3.click('go-reg');
    await W3.submit('register', null, { name: 'Test', phone: '9876543210', pin: '1', c1n: 'a', c1p: '9876500012', terms: 'on' });
    ok(/already registered|PIN must be/.test(W3.html), 'sign-up errors are shown on the form');
    await W3.click('go-welcome'); await W3.click('go-login');
    await W3.submit('login', null, { phone: '9876543210', pin: '9999' });
    ok(/Wrong phone number or PIN/.test(W3.html), 'wrong login PIN shows an error');
    await W3.submit('login', null, { phone: '98765 43210', pin: '2468' });
    ok(/class="sos"/.test(W3.html), 'logging in on another phone works and shows her button');
    // server rejects SOS (alert limit) -> she must still be pointed to 112 and her contacts
    for (let i = 0; i < 6; i++) { await W3.holdSOS(1700); await sleep(400); if (/Call 112 now/.test(W3.html) && !/Your alert is live/.test(W3.html)) break; if (/Your alert is live/.test(W3.html)) { W3.pinEl.value = '2468'; await W3.click('end-false'); } }
    ok(/Call 112 now/.test(W3.html) && /wa\.me/.test(W3.html), 'if the server refuses, she still gets Call 112 + direct messages to her contacts');

    ok(W.errors.length + H.errors.length + W3.errors.length === 0, 'no JavaScript errors were logged: ' + [...W.errors, ...H.errors, ...W3.errors].join(' | ').slice(0, 200));
  } catch (e) { fail++; console.log('  CRASH', e); }
  finally {
    server.kill();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
