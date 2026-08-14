# CI → Google Play automation

Goal: on a version tag (`v*`), build the signed release AAB and upload it to a
Play track, no manual console upload.

## The blocker to know up front

The release AAB needs the real `libsync_ffi.so`, which is cross-compiled from the
**private** desktop repo (`Minutist/minutist`, `crates/sync-ffi`). A
GitHub-hosted runner cannot reach it — the existing `android` CI job deliberately
builds a *shell APK with no native lib* and marks it not-installable. So the
publish job cannot run on `ubuntu-latest`. It needs one of:

1. A **self-hosted runner** with the `minutist/android-build:local` image and
   read access to the desktop repo (mirrors the desktop's `ci/runner/`). It runs
   `scripts/build-sync-ffi.sh <desktop-repo> release` then the gradle publish.
   This is the same dependency as the "wire native .so into mobile CI" task and
   is the recommended path.
2. A **published native artifact**: the desktop repo publishes the release
   `.so` pair (both ABIs) as a versioned artifact; the mobile publish job
   downloads it with a cross-repo token instead of cross-compiling.

Until one exists, the release is built and uploaded from a dev host (Telie),
which is exactly the flow already proven for v1.0.0.

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

## Workflow sketch (self-hosted, tag-triggered)

    on:
      push:
        tags: ['v*']
    jobs:
      publish:
        runs-on: [self-hosted, android]   # runner with the build image + desktop-repo access
        steps:
          - uses: actions/checkout@v4
          - run: scripts/build-sync-ffi.sh "$DESKTOP_REPO" release   # real .so, both ABIs
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
