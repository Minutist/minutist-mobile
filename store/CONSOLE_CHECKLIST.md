# Play Console — remaining manual steps (in order)

The signed AAB (version code 1), listing text, feature graphic, icon, screenshots
and changelog are already uploaded (via `fastlane android internal`) and sit on
the **internal track as a draft**. What's left is console-only and can't be done
via the API. Do it in this order — App content gates the rollout, so it comes
first. Left-nav paths are from the app dashboard.

## 1. Test and release → Setup → App signing

Confirm Play App Signing is enrolled. On the first AAB upload Google generates
the app signing key and keeps our upload key (SHA-256
`20:A9:E1:C4:80:DE:02:04:BA:55:49:89:4B:EF:C5:39:EF:E7:D3:D5:C8:1A:E8:98:D8:41:8F:1F:18:DF:42:2E`)
as the upload key. Nothing to change; just verify it shows enrolled.

## 2. Policy and programs → App content

Each declaration below must show "Completed". This is what actually gates
distribution.

- **Privacy policy**: paste the URL — `https://minutist.ai/privacy`.
- **App access**: declare **"All or some functionality is restricted"** (there is
  a visible Sign in button, so do NOT claim no access is needed — reviewers hit
  it and a mismatch draws a rejection). Add one restricted-access entry with a
  test account:

  > Name: Account sign-in (sync)
  >
  > Instructions: Recording meetings and viewing locally captured meetings work
  > without signing in — open the Capture tab and record to see the core flow.
  > The Sign in button (top-right, and on the Meetings tab) enables cross-device
  > sync. To review the signed-in experience, sign in with the username and
  > password below. This account already has example meetings synced to it, so
  > the Meetings tab shows a processed meeting with its transcript and summary.
  > A live sync round-trip from a NEW recording additionally requires the Minutist
  > desktop app signed in to the same account, so that step cannot be reproduced
  > from the phone alone.
  >
  > Username: TEST_ACCOUNT_USERNAME   ← fill once the test account is created
  > Password: TEST_ACCOUNT_PASSWORD
- **Ads**: No, the app contains no ads.
- **Content ratings**: fill the IARC questionnaire. Category: "Utility,
  Productivity, Communication, or Other". Answer No to violence, sexual content,
  language, controlled substances, gambling. "Do users interact or share
  content?" → No (sync is between the user's own devices, not between different
  users). Expected rating: Everyone / PEGI 3. Submit to get the certificate.
- **Target audience and content**: target age 18 and over (a work tool, not aimed
  at children). "Is your app designed for children?" → No. This keeps it out of
  the Families programme requirements.
- **Data safety**: the big one. Fill from `store/data-safety-answers.md`. Either
  answer the form directly from that sheet, or use *Import to CSV* — export the
  template first (its question IDs are app-specific), then set the values per the
  sheet and `store/data-safety-draft.csv`. Key answers: collects audio + notes/
  transcript/summary + email + a sync id; nothing shared with third parties;
  encrypted in transit; no tracking SDK.
- **Data deletion**: declare in-app deletion of meetings. Account deletion is the
  open item — if there's no in-app account-deletion yet, provide a web request
  route (a `minutist.ai` deletion page or a support email) so this passes.
- **Government apps / News / Health / Financial features**: No to each (billing
  is web-side, not in this app).

## 3. Grow → Store presence → Main store listing

Already populated by fastlane (title, short + full description, feature graphic,
icon, 4 phone screenshots). Just review it renders correctly. Re-pushing copy
later: `fastlane android metadata` (once a release exists) or another
`fastlane android internal`.

## 4. Grow → Store presence → Store settings

- **App category**: Productivity.
- **Store listing contact details**: support email + `https://minutist.ai`.
- Tags: pick the closest (note-taking / productivity).

## 5. Test and release → Testing → Internal testing

- **Testers**: add an email list or a Google Group of internal testers, and
  save. Without testers, the draft has no one to go to.
- **Releases**: open the existing draft (version code 1). Review it — it should
  show the AAB, the release notes, and no blocking errors once App content (step
  2) is complete.
- **Roll out**: "Start rollout to Internal testing". Share the opt-in URL the
  console gives you with the testers; they must accept the invite before the app
  appears for them.

## 6. Later — production

When you're ready to go public: `fastlane android promote_production` (promotes
the internal release), or in the console promote internal → Production. Production
needs the same App content complete plus a production release review, which can
take longer than internal.

## Re-running the pipeline for a new build

Bump `versionCode` in `android/app/build.gradle` (must increase each upload),
rebuild the signed AAB (`bundleRelease` with the `MINUTIST_UPLOAD_*` creds), then
`fastlane android internal`. Add a `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`
for that build's release notes.
