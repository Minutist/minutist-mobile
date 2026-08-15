# CI → Google Play automation

Goal: on a version tag (`v*`), build the signed release AAB and upload it to a
Play track, no manual console upload.

## What the publish job needs

The release AAB needs the real `libsync_ffi.so`, cross-compiled from the desktop
repo (`Minutist/minutist`, `crates/sync-ffi`). That repo is public, so a
GitHub-hosted runner checks it out with no credentials — access is not a
constraint on where this job runs, and neither is cost, since public repos carry
no charge on standard hosted runners.

What a hosted runner lacks is the cross-compile toolchain.
`scripts/build-sync-ffi.sh` runs `cargo ndk` inside `minutist/android-build`
(`docker/android-build/Dockerfile` — NDK, pinned Rust, cargo-ndk), and that image
is built locally and published nowhere. The existing `android` CI job therefore
builds a *shell APK with no native lib* and marks it not-installable. Closing
that is ordinary CI work, one of:

1. **Publish the build image** to GHCR from this repo, and have the publish job
   pull it and run `scripts/build-sync-ffi.sh <desktop-checkout> release`
   unchanged. Keeps one toolchain definition for local and CI builds.
2. **Provision the toolchain in the job** with NDK + `cargo-ndk` setup actions,
   bypassing the image. Fewer moving parts in CI, but the toolchain is then
   pinned in two places and can drift from the local build.
3. **Consume a published native artifact**: the desktop repo publishes the
   release `.so` pair (both ABIs) as a versioned release asset and the publish
   job downloads it. Costs no cross-compile time per release, and the same
   artifact channel serves the iOS `.xcframework` (see `docs/IOS_ROADMAP.md`).

Until one is wired, the release is built and uploaded from a dev host (Telie),
the flow already proven for v1.0.0.

## Upload tooling — Gradle Play Publisher

Use `com.github.triplet.play` (Gradle Play Publisher, GPP). It fits the existing
gradle build; `./gradlew publishReleaseBundle` uploads the AAB via the Play
Developer Publishing API. Do NOT commit this wiring until the service account
exists and one end-to-end upload has been proven — it is recorded here ready to
drop in.

Root `android/build.gradle` buildscript classpath:

    classpath 'com.github.triplet.gradle:play-publisher:3.11.0'

`android/app/build.gradle`, applied + configured (gate on the credential so a
build without it still configures):

    apply plugin: 'com.github.triplet.play'

    def playCreds = System.getenv('ANDROID_PUBLISHER_CREDENTIALS')
    if (playCreds) {
        play {
            serviceAccountCredentials.set(file(playCreds))
            track.set(System.getenv('PLAY_TRACK') ?: 'internal')
            defaultToAppBundles.set(true)
            // 'completed' publishes immediately; use 'draft' for the very first
            // upload (Play requires the first release to be promoted by hand).
            releaseStatus.set(com.github.triplet.gradle.androidpublisher.ReleaseStatus.DRAFT)
        }
    }

Publish command (release build, signed with the upload key):

    cd android && ./gradlew publishReleaseBundle \
      -PMINUTIST_UPLOAD_STORE_FILE=$KS -PMINUTIST_UPLOAD_STORE_PASSWORD=… \
      -PMINUTIST_UPLOAD_KEY_ALIAS=minutist-upload -PMINUTIST_UPLOAD_KEY_PASSWORD=…

## Andrew's one-time setup

1. Create the app in the Play Console (package `ai.minutist.companion`), fill the
   listing + data-safety + content-rating, and upload v1.0.0 by hand once (Play
   requires the first release to be promoted manually before the API can push).
2. In Google Cloud, create a **service account**; in the Play Console →
   Users & permissions, invite that service account and grant it release
   permission on the app (Release manager, or a custom role with "Release to
   testing/production").
3. Download the service-account JSON key. Store it as a runner secret, never in
   the repo. It is the credential that can publish releases — treat it like the
   keystore.

## Secrets the publish job needs

- `ANDROID_PUBLISHER_CREDENTIALS` — path to the Play service-account JSON.
- `MINUTIST_UPLOAD_STORE_FILE` + the three `MINUTIST_UPLOAD_*` passwords — the
  upload key (already generated; on Telie at `minutist-secrets/`, backed up to
  pilap).

## Track strategy

Start on the **internal** track (near-instant availability, up to 100 testers) to
prove the pipeline, then promote to production. `releaseStatus DRAFT` on the very
first API push, `completed` after.

## Workflow sketch (hosted, tag-triggered)

Assumes option 1 above — the build image published to GHCR.

    on:
      push:
        tags: ['v*']
    jobs:
      publish:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
          - uses: actions/checkout@v4          # public; no token needed
            with:
              repository: Minutist/minutist
              path: desktop
          - run: scripts/build-sync-ffi.sh "$GITHUB_WORKSPACE/desktop" release   # real .so, both ABIs
          - run: npm ci && npm run build && npx cap sync android
          - run: cd android && ./gradlew publishReleaseBundle
            env:
              ANDROID_PUBLISHER_CREDENTIALS: ${{ secrets.PLAY_SA_JSON_PATH }}
              MINUTIST_UPLOAD_STORE_FILE: ${{ secrets.UPLOAD_STORE_FILE }}
              MINUTIST_UPLOAD_STORE_PASSWORD: ${{ secrets.UPLOAD_STORE_PASSWORD }}
              MINUTIST_UPLOAD_KEY_ALIAS: minutist-upload
              MINUTIST_UPLOAD_KEY_PASSWORD: ${{ secrets.UPLOAD_KEY_PASSWORD }}

Version bumping: GPP reads `versionCode` from the merged manifest. Each upload
needs a higher `versionCode` than the last — bump `versionCode` (currently 1) per
release, tag, push.
