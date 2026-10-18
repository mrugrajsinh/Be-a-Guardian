// One account for everyone: anyone can send SOS, guardians are optional and admin-approved.
const PHOTO = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles'));
const PORT = 4561;
const srv = spawn('node', [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, ADMIN_KEY: 'k' } });
const call = async (p, body, o = {}) => {
  const r = await fetch('http://localhost:' + PORT + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(o.admin ? { 'x-admin-key': 'k' } : {}), ...(o.token ? { authorization: 'Bearer ' + o.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return [r.status, j];
};
let fails = 0; const ok = (c, m) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) fails++; };
const C = [{ name: 'Kin', phone: '9123456780' }];
const reg = async (name, phone, extra = {}) => (await call('/api/register', { name, phone, pin: '1234', acceptTerms: true, contacts: C, ...extra }))[1];
const HERE = { lat: 28.6139, lng: 77.2090, acc: 10 };
const near = (m) => ({ lat: HERE.lat + m / 111000, lng: HERE.lng, acc: 10 });
setTimeout(async () => {
  try {
    const A = await reg('Asha', '9000000001');                  // plain member
    const G = await reg('Gita', '9000000002', { guardian: { idType: 'Aadhaar', note: 'DU college', refName: 'Ref', refPhone: '9111111111', idPhoto: PHOTO, selfie: PHOTO } });
    const H = await reg('Hari', '9000000003', { role: 'helper', idType: 'Passport', note: 'Metro area', refName: 'Ref2', refPhone: '9222222222', idPhoto: PHOTO, selfie: PHOTO }); // older style still works
    const B = await reg('Bina', '9000000004');
    ok(A.me.role === 'woman' && A.me.status === 'active', 'a plain sign-up is an active member with the SOS button');
    ok(G.me.role === 'helper' && G.me.status === 'pending', 'ticking "guardian" at sign-up starts a pending guardian application');
    ok(H.me.role === 'helper' && H.me.contacts.length === 1, 'the older role:helper sign-up still works and also needs contacts');
    ok((await call('/api/register', { name: 'NoC', phone: '9000000009', pin: '1234', acceptTerms: true, guardian: { note: 'x college', refName: 'R', refPhone: '9111111111' } }))[0] === 400, 'everyone must add an emergency contact, guardians too');
    ok((await call('/api/register', { name: 'NoId', phone: '9000000008', pin: '1234', acceptTerms: true, contacts: C, guardian: { note: 'college', idPhoto: PHOTO, selfie: PHOTO } }))[0] === 400, 'a guardian application needs a reference person');
    ok((await call('/api/register', { name: 'NoPh', phone: '9000000007', pin: '1234', acceptTerms: true, contacts: C, guardian: { note: 'college', refName: 'R', refPhone: '9111111111' } }))[0] === 400, 'a guardian application needs an ID photo');
    ok((await call('/api/register', { name: 'BadPh', phone: '9000000006', pin: '1234', acceptTerms: true, contacts: C, guardian: { note: 'college', refName: 'R', refPhone: '9111111111', idPhoto: 'data:image/jpeg;base64,AAAA' } }))[0] === 400, 'a fake or tiny photo is refused');

    // a member can apply later
    ok((await call('/api/guardian/apply', { note: 'college', idPhoto: PHOTO, selfie: PHOTO, acceptTerms: true }, { token: B.token }))[0] === 400, 'apply needs a reference');
    ok((await call('/api/guardian/apply', { note: 'college', refName: 'R', refPhone: '9333333333', idPhoto: PHOTO, selfie: PHOTO }, { token: B.token }))[0] === 400, 'apply needs the agreement');
    const ap = await call('/api/guardian/apply', { idType: 'Driving licence', note: 'college', refName: 'R', refPhone: '9333333333', idPhoto: PHOTO, selfie: PHOTO, acceptTerms: true }, { token: B.token });
    ok(ap[0] === 200 && ap[1].me.role === 'helper' && ap[1].me.status === 'pending', 'a member can apply to become a guardian later');
    ok((await call('/api/guardian/apply', { note: 'college', refName: 'R', refPhone: '9333333333', acceptTerms: true }, { token: B.token }))[0] === 400, 'cannot apply twice');
    ok((await call('/api/guardian/apply', { note: 'college', refName: 'R', refPhone: '9333333333', acceptTerms: true }))[0] === 401, 'apply needs login');

    // pending guardian still has the SOS button; guardians can edit contacts
    ok((await call('/api/me/contacts', { contacts: [{ name: 'Z', phone: '9123456781' }] }, { token: G.token }))[0] === 200, 'guardians can edit their contacts');

    const ovp = (await call('/api/admin/overview', null, { admin: true }))[1];
    const gid = ovp.helpers.find((h) => h.name === 'Gita').id;
    ok(!!ovp.helpers.find((h) => h.name === 'Gita').idPhotoAt && !('idPhoto' in ovp.helpers[0]), 'overview says a photo exists but never includes it');
    ok((await call('/api/admin/users/' + gid + '/idphoto', null, { admin: true }))[0] === 200 && (await call('/api/admin/users/' + gid + '/idphoto?kind=selfie', null, { admin: true }))[0] === 200, 'admin can open the ID photo and the selfie');
    ok((await call('/api/register', { name: 'NoSelfie', phone: '9000000005', pin: '1234', acceptTerms: true, contacts: C, guardian: { note: 'college', refName: 'R', refPhone: '9111111111', idPhoto: PHOTO } }))[0] === 400, 'a guardian application needs a selfie too');
    ok((await call('/api/admin/users/' + gid + '/idphoto', null))[0] === 401, 'nobody else can open the ID photo');
    ok((await call('/api/admin/users/' + gid + '/idphoto', null, { token: G.token }))[0] === 401, 'the guardian herself cannot fetch it back through the admin route');
    const files = fs.readdirSync(path.join(dir, 'ids'));
    ok(files.length >= 4 && !fs.readFileSync(path.join(dir, 'ids', files[0])).includes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7, 7])), 'photos are encrypted on disk');
    ok(!fs.readFileSync(path.join(dir, 'db.json'), 'utf8').includes('/9j/'), 'photo is not inside db.json');
    const ov = (await call('/api/admin/overview', null, { admin: true }))[1];
    const id = (n) => ov.helpers.find((h) => h.name === n).id;
    ok((await call('/api/admin/users/' + id('Gita') + '/approve', {}, { admin: true }))[0] === 400, 'cannot approve before a check is recorded');
    ok((await call('/api/admin/users/' + id('Gita') + '/check', { method: 'nope' }, { admin: true }))[0] === 400, 'an unknown check method is refused');
    for (const n of ['Gita', 'Hari']) {
      ok((await call('/api/admin/users/' + id(n) + '/check', { method: 'video_id', idType: 'Passport', note: 'seen on video', until: '2027-12-31' }, { admin: true }))[0] === 200, 'admin records a check for ' + n);
      ok((await call('/api/admin/users/' + id(n) + '/approve', {}, { admin: true }))[0] === 200, n + ' can be approved after a check');
    }
    const ovc = (await call('/api/admin/overview', null, { admin: true }))[1].helpers.find((h) => h.name === 'Gita');
    ok(ovc.checks.length === 1 && ovc.checks[0].label === 'Video call, ID seen' && ovc.checks[0].idType === 'Passport' && ovc.refName === 'Ref' && !ovc.idLast4, 'overview shows the recorded check and the reference, with no ID digits');
    for (const [t, m] of [[G.token, 100], [H.token, 300]]) {
      await call('/api/duty', { onDuty: true }, { token: t });
      await call('/api/location', near(m), { token: t });
    }
    ok((await call('/api/admin/overview', null, { admin: true }))[1].onDutyNow === 2, 'two approved guardians are on duty');

    // a member's SOS reaches the guardians
    const s1 = await call('/api/sos', HERE, { token: A.token });
    ok(s1[0] === 200 && s1[1].alert.notified === 2, 'a member SOS alerts both nearby guardians');
    let st = (await call('/api/state', null, { token: G.token }))[1];
    ok(st.alerts.length === 1 && st.alert === null, 'the guardian sees the alert in "alerts" and has no alert of their own');
    await call('/api/sos/' + s1[1].alert.id + '/respond', { response: 'coming' }, { token: G.token });
    ok((await call('/api/state', null, { token: A.token }))[1].alert.coming === 1, 'the member sees one guardian coming');

    // photo rules: reject deletes it; delete-photo action; approve needs a photo
    const Z = await reg('Zed', '9000000011', { guardian: { note: 'college', refName: 'R', refPhone: '9111111111', idPhoto: PHOTO, selfie: PHOTO } });
    const zid = (await call('/api/admin/overview', null, { admin: true }))[1].helpers.find((h) => h.name === 'Zed').id;
    await call('/api/admin/users/' + zid + '/check', { method: 'video_id' }, { admin: true });
    ok((await call('/api/admin/users/' + zid + '/deleteidphoto', {}, { admin: true }))[0] === 200 && (await call('/api/admin/users/' + zid + '/idphoto', null, { admin: true }))[0] === 404, 'admin can delete a stored ID photo');
    ok((await call('/api/admin/users/' + zid + '/approve', {}, { admin: true }))[0] === 400, 'cannot approve without an ID photo');
    ok((await call('/api/guardian/id-photo', { idPhoto: PHOTO, selfie: PHOTO }, { token: Z.token }))[0] === 200, 'the guardian can upload the photo later');
    ok((await call('/api/admin/users/' + zid + '/reject', {}, { admin: true }))[0] === 200 && (await call('/api/admin/users/' + zid + '/idphoto', null, { admin: true }))[0] === 404, 'rejecting an application deletes the ID photo');
    ok((await call('/api/guardian/id-photo', { idPhoto: PHOTO, selfie: PHOTO }, { token: A.token }))[0] === 400, 'a plain member cannot upload an ID photo');

    // the guardian now needs help herself
    const s2 = await call('/api/sos', near(100), { token: G.token });
    ok(s2[0] === 200, 'a guardian can press SOS');
    ok(s2[1].alert.notified === 1, 'her SOS goes to the other guardian only, never to herself');
    st = (await call('/api/state', null, { token: G.token }))[1];
    ok(st.alert && st.alert.id === s2[1].alert.id && st.alerts.length === 0, 'she has her own alert and no longer holds the earlier one');
    ok((await call('/api/state', null, { token: A.token }))[1].alert.coming === 0, 'the first member no longer counts her as coming');
    const ov2 = (await call('/api/admin/overview', null, { admin: true }))[1];
    ok(ov2.alerts.find((a) => a.id === s1[1].alert.id).responders.some((r) => r.name === 'Gita' && r.status === 'cannot'), 'admin sees her response as withdrawn');
    st = (await call('/api/state', null, { token: H.token }))[1];
    ok(st.alerts.some((a) => a.id === s2[1].alert.id), 'the other guardian sees her alert');

    // while in danger she is not sent to help others
    const C2 = await reg('Chitra', '9000000005');
    const s3 = await call('/api/sos', near(150), { token: C2.token });
    ok(s3[0] === 200 && s3[1].alert.notified === 1, 'a guardian with her own live alert is not alerted for others (only Hari is)');
    // ending her alert returns her to normal
    ok((await call('/api/sos/' + s2[1].alert.id + '/cancel', { pin: '1234', reason: 'safe' }, { token: G.token }))[0] === 200, 'she can end her own alert with her PIN');
    st = (await call('/api/state', null, { token: G.token }))[1];
    ok(st.alert === null, 'her alert is gone');
  } catch (e) { console.log('  CRASH', e.stack); fails++; }
  console.log(fails ? fails + ' FAILED' : 'ALL OK'); srv.kill(); process.exit(fails ? 1 : 0);
}, 1500);
