# Play Store submission — Minutist companion

Working doc for the first Google Play release of the Minutist phone companion.
Draft copy is in Andrew's register and is a proposal to voice-edit, not final.

## Read this first — the positioning problem

The phone app is a **companion**, not a standalone product. It records audio and
typed notes and syncs them to a Minutist desktop, which does the transcription,
diarisation and summarising locally. Without a desktop on the same account, the
phone app is a recorder and a viewer and nothing else.

That matters for a Production launch:

- A user who finds "Minutist" in the store, installs it, and expects on-device
  transcription gets a recorder that appears to do nothing. That is a one-star
  review and, for an app that needs separate software to function, a possible
  Play policy flag.
- The connected tier (account + sync relay) is on the paid-billing path (Polar).
  If sign-in / sync needs a subscription the user doesn't have, the app is inert
  on first run.

Options worth a decision before submitting to Production:
1. Ship the **desktop** distribution first (or alongside), and frame the phone
   listing honestly as "companion to Minutist desktop".
2. Ship the phone app to a **closed track** first anyway (invite testers who
   already run the desktop), even though you chose Production — it de-risks the
   listing and the store pipeline without the public exposure.
3. Proceed to Production with the companion framing below, accepting the
   standalone-usefulness gap.

This is a product call, flagged not decided.

## Listing copy (draft — Andrew's voice)

**App name** (30 char max): `Minutist`

**Short description** (80 char max):

> Records meetings on your phone, syncs to your own computer for transcription.

**Full description** (4000 char max):

> Minutist records your meetings and keeps the notes on hardware you control.
>
> This is the phone companion to the Minutist desktop app. It records a meeting,
> captures the notes you type during it, and syncs both to your own computer over
> an encrypted connection. The desktop does the transcription, speaker separation
> and summarising — locally, on your machine, not in someone else's cloud. The
> phone is the thing in your pocket that captures; your computer is the thing that
> processes and keeps the record.
>
> What it does:
> - Records meeting audio and the notes you type during the meeting.
> - Syncs to your Minutist desktop automatically once both are signed in to the
>   same account. No cables, no manual pairing.
> - Shows the finished transcript and summary back on the phone once the desktop
>   has processed them.
> - Sync is end-to-end encrypted. The relay that passes data between your devices
>   stores ciphertext it cannot read.
>
> What it does not do:
> - It does not transcribe or summarise on the phone. That needs the Minutist
>   desktop app running on your computer. Without a desktop on your account, this
>   app is a recorder and a viewer, nothing more.
> - It does not send your meetings to us. We cannot read them.
>
> You need the Minutist desktop app and a Minutist account.

(Pricing / connected-tier line to be added once the billing wording is settled.)

## Data safety form — mapping to actual behaviour

Scoped to what the **phone app** does (the desktop's connector-to-AI channel is a
desktop feature and is declared on the desktop's own surface, not here).

| Play question | Answer | Basis |
|---|---|---|
| Audio recordings collected? | Yes | Records meeting audio locally. |
| Audio shared with third parties? | No | Synced E2E to the user's own devices; the relay holds ciphertext it cannot read. |
| Other in-app content (notes, transcripts, summaries)? | Yes, collected | Typed notes recorded; transcript/summary synced back from the desktop. |
| That content shared with third parties? | No | Same E2E channel. |
| Personal identifiers (account email)? | Yes, collected | Sign-in to the sync account. |
| Data encrypted in transit? | Yes | E2E for sync; TLS to the account service. |
| Can the user request deletion? | Yes (confirm the account-deletion path exists) | Meetings deletable; account deletion needs confirming. |
| Ads / analytics / tracking SDKs? | None | Verified: no Firebase / analytics / crash / tracking dependency in package.json or gradle, no google-services.json. Plugins are secure-storage, app, browser, share, status-bar, audio-recorder only. |

Open confirmation before filling the form:
- Confirm an account-deletion path (Play requires a deletion route for accounts).

## Signing and build

Release signing reads the upload-key credentials from Gradle properties or env —
nothing secret is committed (`*.keystore` and `keystore.properties` are
gitignored). Google Play App Signing holds the app signing key; this is only the
upload key.

Generate the upload keystore once (Andrew owns and backs it up — losing it means
never being able to update the app):

    keytool -genkeypair -v -keystore minutist-upload.jks \
      -alias minutist-upload -keyalg RSA -keysize 4096 -validity 10000

Build a signed release bundle (from the mobile repo):

    npm run build && npx cap sync android
    cd android && ./gradlew bundleRelease \
      -PMINUTIST_UPLOAD_STORE_FILE=/abs/path/minutist-upload.jks \
      -PMINUTIST_UPLOAD_STORE_PASSWORD=… \
      -PMINUTIST_UPLOAD_KEY_ALIAS=minutist-upload \
      -PMINUTIST_UPLOAD_KEY_PASSWORD=…
    # -> android/app/build/outputs/bundle/release/app-release.aab

The `.so` must be the RELEASE build (`scripts/build-sync-ffi.sh <desktop-repo>
release`), not the debug one — the debug library is ~150 MB and is not
representative of the shipping size.

## Size check (measured, release, cd4cf93)

Built with `RUSTFLAGS=-C strip=symbols` (the workspace has no release-profile
strip), both ABIs, then `bundleRelease`.

| Artifact | Size |
|---|---|
| `libsync_ffi.so` debug (per ABI) | ~152 MB (not shipped) |
| `libsync_ffi.so` release, stripped — arm64 | 22.3 MB on disk, 9.06 MB in the AAB (59% compressed) |
| `libsync_ffi.so` release, stripped — x86_64 | 24.4 MB on disk, 9.62 MB in the AAB |
| Full AAB (both ABIs, unsigned) | 22.6 MB |
| Shared (dex + web assets + res), compressed | ~3.9 MB |
| **Per-device install download — arm64 phone** | **~13 MB** (base + one ABI split) |
| Per-device install download — x86_64 | ~13.5 MB |

Play serves one ABI per device via the automatic split, so a real phone pulls
~13 MB. Well under Play's 200 MB base limit — no asset delivery or extra splitting
needed. Size is not a constraint.

## Assets

| Asset | Status |
|---|---|
| Phone screenshots (1080×2400, light+dark) | Have — 8 from the website shoot |
| App icon (512×512) | Have — brand icon (trademark-reserved, see TRADEMARKS.md) |
| Feature graphic (1024×500) | Needed |
| Short + full description | Drafted above |
| Privacy policy URL | minutist.ai has a privacy page (still has a placeholder contact email) |

## Open items / decisions (Andrew)

- Positioning: which of the three options above (companion-first framing, closed
  track first, or straight to Production).
- Play Console account: US$25 + Google identity/organisation verification. Andrew
  only; cannot be done here.
- Upload keystore: generate and back up (see command above).
- Trademark: a Production listing is the D8 public-launch gate. "Minutist" is
  recorded as trademark-unverified (class 9/42); see
  `planning/research/minutist-trademark-search-2026-06-11.md` in the desktop repo.
- Licence note: the app is AGPL-3.0-only. Play distribution is fine as the rights
  holder, but AGPL's network-use clause means the corresponding source offer must
  be reachable by users. Consistent with the dual-build roadmap; flagged, not a
  blocker.
- Feature graphic (1024×500) needs producing.
