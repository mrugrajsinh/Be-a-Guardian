# Be a Guardian: women's safety app (working prototype)

A woman holds one button. Verified volunteers within walking distance are alerted with her live location, her emergency contacts get a ready-made message with a map link, and a big **Call 112** button is always on screen.

It installs on Android and iPhone from the browser (no app store), and it has a small admin page where you approve volunteers.

---

## Read this first: what it does NOT do yet

| Limit | What it means | Fix |
|---|---|---|
| **No background location.** A web app cannot track location once it is closed or the screen is off. | A helper only receives alerts while "On duty" **and** the app has been open recently (location older than 30 min is ignored). Lock-screen notifications work, but they are sent to helpers whose *last known* position is near her. | Build a native Android/iOS app (Phase 2). This is the main reason to graduate from this prototype. |
| **Full-screen takeover works only while the app is open.** | With the app open (and the screen on), a helper's whole screen turns red with a loud siren and vibration until they tap I AM COMING, I cannot help, or Silence. With the phone **locked or the app closed**, a web app can only show a notification; it cannot light up the lock screen or ring over silent mode. | Phase 2 native app: Android can show a full-screen "incoming call" style alert over the lock screen. iPhone only allows this with Apple's Critical Alerts permission, which Apple must approve. |
| **Push delivery is untested on real phones.** | I tested everything else end to end, but my test environment had no phones and could not install the push library. | Do the 15-minute phone test below before showing anyone. |
| **Phone numbers are not verified by OTP.** | Anyone can type any number. | Add an SMS/WhatsApp OTP provider before launch. |
| **Not connected to the police.** | "Call 112" opens the dialer. Nothing is sent to police automatically. | Partner with your city police / 112 control room, or an existing platform. |
| **Helper vetting is manual.** | You review each applicant on the admin page and are expected to phone them. | Police verification / employer or college endorsement. |
| **Not legally reviewed.** | India's DPDP Act 2023 applies to this data (location, phone numbers). | Talk to a lawyer before real users. See the checklist at the bottom. |

**Safety design you should keep:** volunteers are told to call 112 and never confront anyone alone. A stranger rushing to a violent situation can be hurt or can escalate it. Treat helpers as "a visible presence who stays with her until police arrive", not as rescuers.

---

## Put it online (about 20 minutes, ~US$7/month)

You need a place that runs the server all day. Render.com is the simplest.

1. **Unzip** the file you downloaded (right-click, Extract All). Open the folder: you should see `server.js`, `package.json`, `render.yaml` and a folder called `public`.
2. Make a free account at **github.com**. Click **+ → New repository**, name it `Be-a-Guardian`, keep it **Private**, create it. Click **uploading an existing file**, drag in everything from inside the unzipped folder (the files themselves, **never the .zip file**), then **Commit changes**.
3. Make an account at **render.com** (sign in with GitHub). Click **New + → Blueprint**, choose your `Be-a-Guardian` repository, leave **Blueprint Path** empty (or `render.yaml`), and click **Apply**.
4. It asks for **ADMIN_KEY**. Type a long password you will remember (this opens your admin page). Confirm. It will ask for a payment card: the plan is the "Starter" size (check Render's current price). The free plan is not suitable because it goes to sleep and would miss alerts.
5. Wait 3 to 5 minutes. Render shows your address, like `https://be-a-guardian-abcd.onrender.com`. That is your app.

If the Blueprint screen looks different, create a **Web Service** manually: runtime Node, build command `npm install`, start command `npm start`, add a 1 GB disk mounted at `/var/data`, and set environment variables `DATA_DIR=/var/data`, `APP_NAME=Be a Guardian`, `ADMIN_KEY=<your password>`.

**Your admin page:** `https://<your-address>/admin`. Enter the ADMIN_KEY.

---

## Do this test before anything else (two phones, 15 minutes)

Use two phones in the same building.

1. **Phone A (she):** open your address in Chrome (Android) or Safari (iPhone). Tap **I want a safety button**, sign up, add a contact. Install it: Android menu (⋮) → *Install app*; iPhone Share → *Add to Home Screen*. Open it from the home screen and tap *Allow location*.
2. **Phone B (helper):** same address → **I want to be a volunteer helper**, sign up. Install it to the home screen the same way.
3. **You, on a computer or any phone:** open `/admin`, enter your key, press **Approve** next to the helper.
4. **Phone B:** tap *Check status*, switch **On duty** on, allow location, then tap **Turn on alerts** and allow notifications.
5. **Phone A:** press and hold **SOS** for 2 seconds.
6. **Phone B**, with the app open, should turn fully red with a siren, vibration, the distance, and a big green **I AM COMING** button. (Turn the phone volume up. Phones block sound until you have touched the app once, so tap the screen first.) Then tap *Silence the alarm* to see the alert card with a directions link. Next lock Phone B's screen and press SOS on Phone A again: you should get a lock-screen notification. **If that notification does not arrive, tell me or your developer; it is the one part I could not test.**
7. On Phone A, enter the PIN and tap **I am safe**. Phone B's card disappears.

While testing, do not press the green call button after tapping "Call 112".

---

## How an alert works

1. She holds SOS for 2 seconds (or shakes the phone 4 times while the app is open, with a 5 second cancel countdown).
2. The server finds helpers who are **approved**, **on duty**, and have shared a location in the last 30 minutes, within **1 km**. On their phone the **whole screen turns into a siren alarm** (see the limit above for locked phones), and they also get a push notification.
3. If nobody says "I'm coming" within 45 seconds, the search widens to **2.5 km**, then **5 km**.
4. She sees live counts: *alerted, on the way, arrived*. Her phone shows one-tap Call, WhatsApp and SMS to each emergency contact, with a map link to where she is.
5. Only she can end the alert, with her PIN. After 5 wrong PINs it locks for 15 minutes. Alerts auto-expire after 60 minutes.
6. When it ends, her location is erased from the database. Helpers' live positions are never written to disk at all.

**Anti-misuse built in:** helpers must be approved by you; admin can mark an alert as a false alarm (3 strikes = ban) and ban anyone instantly; max 5 alerts per woman per hour; helpers see only her first name and position; no ID numbers or photos are collected. A guardian gives a reference and says which ID they will show; an admin checks them (usually on a video call), records the check, and only then can approve them.

---

## Settings (all optional)

Set these as environment variables on Render (Environment tab).

| Name | Default | Meaning |
|---|---|---|
| `ADMIN_KEY` | (generated, shown in logs) | Password for `/admin` |
| `APP_NAME` | Be a Guardian | Name shown in the app |
| `EMERGENCY_NUMBER` | 112 | Number the Call button dials |
| `DEFAULT_COUNTRY_CODE` | 91 | Added to 10-digit phone numbers |
| `RADIUS_STEPS_M` | 1000,2500,5000 | Search rings in metres |
| `EXPAND_AFTER_MS` | 45000 | Wait before widening the search |
| `LOCATION_MAX_AGE_MIN` | 30 | Helper location older than this is ignored |
| `ALERT_TTL_MIN` | 60 | Alerts auto-end after this long |
| `MAX_ALERTS_PER_HOUR` | 5 | Per woman |
| `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | off | If all three are set, the server also texts her contacts automatically the moment she presses SOS. In India, bulk SMS needs DLT registration, so a local provider may be easier. |
| `VAPID_PUBLIC`, `VAPID_PRIVATE` | auto-generated and saved | Push keys. Only set if you move servers and want existing helpers to keep working. |

---

## Before real people use it (checklist)

- [ ] Two-phone test above passes, including the lock-screen notification.
- [ ] A lawyer reviews: consent and privacy policy (DPDP Act 2023), terms, what you promise users, liability if a volunteer is hurt or someone misuses data. Add a privacy policy and terms page.
- [ ] OTP verification of phone numbers.
- [ ] A written helper-vetting process (police verification or endorsement by a college / employer / NGO) and someone who phones each applicant.
- [ ] Someone watching the admin page and answering reports, every day.
- [ ] Start with **one dense, trusted place** (one campus or company), not a whole city. Alerts only work if enough on-duty helpers are within a few minutes.
- [ ] Talk to your local police or women's helpline so they know the app exists and what to do if a volunteer calls them.
- [ ] Phase 2: native app for background location, and a security review by a professional.

---

## What is inside

```
server.js        the whole server (no installs needed to run it)
public/          the app itself: index.html, app.js, style.css, sw.js, admin page, icons
render.yaml      one-click Render setup
test.js          65 automated checks of the alert flow (node test.js)
test-ui.js       49 automated checks of the phone screens and alarm (node test-ui.js)
```

Run on your own computer: install Node 18+, then `node server.js` and open http://localhost:3000. (Phones will not allow location or install without HTTPS, so use Render for real tests.)

## Pilot-readiness features
- **Privacy and Terms pages** at `/privacy` and `/terms` (drafts; fill in the contact and date placeholders and get a lawyer to review before real users).
- **Helper verification date**: in Admin, "Set verified date" records when a helper's police or ID check expires. After that date they are no longer alerted. Set `REQUIRE_VERIFIED=1` to alert only helpers who have a valid date.
- **Report a problem**: women and helpers can report an issue; Admin has a Reports tab showing who was on that alert.
- **Quiet mode** (women): silences beeps and vibration on her own phone.
- **Forgot PIN** needs an SMS provider: set `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` on Render.

## One account for everyone
- Everyone signs up once (name, phone, PIN, at least one emergency contact) and gets the SOS button. Anyone can need help.
- "Guardian" is optional: tick it at sign-up or apply later from the home screen. An admin approves guardians. Only approved, on-duty guardians with a fresh location are alerted.
- An alert never goes to the person who sent it. A guardian who presses SOS stops being a responder on other alerts and is not sent to help others while their own alert is live.
- Internally `role: 'woman'` means a plain member and `role: 'helper'` means a guardian (kept for compatibility with existing accounts).
- Tests: `node test.js`, `node test-ui.js`, `node test-roles.js`.

## Guardian verification (no ID numbers stored)
- Applicants give: where they study or work, one reference (name and phone) and which ID they will show on a video call.
- In Admin, "Record a check" notes how the person was checked (video call with ID seen, college or work ID, police certificate, reference called, other), an optional note and an optional "valid until" date.
- "Approve" only works after at least one check is recorded. Expired "valid until" dates stop alerts.
- Accounts approved before this change keep working.


## Guardian ID photo
- Guardians must upload a photo of an ID and a selfie (the app shrinks it and removes camera metadata). Tell people to cover the first 8 digits of an Aadhaar card.
- Photos are encrypted (AES-256-GCM) in `DATA_DIR/ids/`, never in `db.json`. **Set an `ID_KEY` environment variable** on the host so the key is not stored next to the photos. If you change or lose `ID_KEY`, old photos cannot be opened.
- Only the admin page can open a photo ("View ID photo"). Each view is written to the server log.
- Photos are deleted automatically after `ID_PHOTO_DAYS` (default 180), when an application is rejected, when an account is deleted, or with "Delete photo".
- Approval needs a recorded check and a photo (`REQUIRE_ID_PHOTO=0` turns the photo requirement off).
- Render's disk must be a persistent disk (the same one as `DATA_DIR`), or photos disappear on redeploy.
