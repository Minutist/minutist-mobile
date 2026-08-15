# Build + signing runbook

## Test layers

Two automated test runners, both KVM-free:

| Runner | Scope | Command | Needs KVM? |
|---|---|---|---|
| **vitest** (jsdom) | Webview / TypeScript unit tests | `npm test` | No |
| **Robolectric** (`testDebugUnitTest`) | Android-native unit tests on the JVM | `./gradlew testDebugUnitTest` | No |

Both run in CI on every push (see `.github/workflows/ci.yml`, jobs `web` and
`android`).

A third lane exists but is **not wired into CI on this host** because it needs
KVM or a real device:

- **Maestro flow tests** — end-to-end UI automation against a running emulator.
- **Espresso / forced-Doze instrumented tests** (`connectedAndroidTest`) —
  on-device or emulator. The make-or-break Doze behaviour requires a real
  low-end handset; an emulator cannot reproduce OEM battery-killer policies.

When a KVM-capable runner or device farm is available, add a separate CI job
for `connectedAndroidTest` and Maestro — do not fold them into the existing
`android` job.

## Web build

```sh
npm ci
npm run build          # tsc --noEmit && vite build -> dist/
npm test               # vitest (webview unit tests, jsdom)
npm run lint           # eslint
```

## Android native unit tests (KVM-free, Robolectric)

```sh
# Prepare the webview bundle and sync the Capacitor project on the host.
npm ci && npm run build && npx cap sync android

# Run only the Gradle step inside the pinned build image.
docker run --rm \
  -v "$(pwd):$(pwd)" -w "$(pwd)" \
  -v "$HOME/.gradle-mm:/gradle-home" \
  -e GRADLE_USER_HOME=/gradle-home \
  -e HOME=/tmp \
  --user "$(id -u):$(id -g)" \
  minutist/android-build:local \
  bash -lc 'cd android && ./gradlew testDebugUnitTest'
# -> android/app/build/reports/tests/testDebugUnitTest/
```

## Android debug APK (headless, no device)

The host has no Android SDK; the build runs in the pinned build image.

```sh
# One-time: build the image (base is ghcr.io/cirruslabs/android-sdk:35).
docker build -t minutist/android-build:local docker/android-build

# Prepare the webview bundle and sync the Capacitor project on the host.
# build:sync-ffi cross-compiles the multi-ABI libsync_ffi.so (arm64-v8a +
# x86_64) and regenerates the UniFFI bindings; without it the APK JNI-fails
# at sync start.
npm ci && npm run build:sync-ffi && npm run build && npx cap sync android

# Assemble inside the pinned build image. Host-uid so artefacts are
# host-owned; mount a persistent Gradle home so the SDK + dependency
# downloads are not re-fetched each run.
docker run --rm \
  -v "$(pwd):$(pwd)" -w "$(pwd)" \
  -v "$HOME/.gradle-mm:/gradle-home" \
  -e GRADLE_USER_HOME=/gradle-home \
  -e HOME=/tmp \
  --user "$(id -u):$(id -g)" \
  minutist/android-build:local \
  bash -lc 'cd android && ./gradlew testDebugUnitTest assembleDebug'
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Debug builds sign with the committed fixed debug keystore at
`android/app/debug.keystore` (wired via `signingConfigs.debug` in
`android/app/build.gradle`, standard `android`/`androiddebugkey` credentials — a
non-secret debug key that cannot sign a release). This is committed on purpose so
every build on every machine (Telie docker, `step`, CI) signs with the same key,
keeping `adb install -r` stable — no `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, no
uninstall, so on-device app data survives across rebuilds. The ephemeral build
container would otherwise auto-generate a fresh key each run.

`android/app/build.gradle` carries hand-maintained blocks — the `ndk` `abiFilters`,
the `jniLibs`/native-`.so` wiring, and `signingConfigs.debug` — that a full
Capacitor re-scaffold (`cap add android`) must not drop.

## Release signing (human-gated, out of the automated loop)

Release builds need a keystore and signing config supplied out-of-band, never
committed:

1. Generate/keep a keystore (`*.jks`) outside the repo.
2. Provide `keystore.properties` (gitignored) or env vars
   (`ANDROID_KEYSTORE_*`) to `android/app/build.gradle`'s `signingConfigs`,
   gated so an absent secret falls back to an unsigned build (mirror the app
   repo's "set signing env only when non-empty" pattern).
3. `./gradlew bundleRelease` -> AAB for Play upload.

## What CANNOT be automated (real-device gate)

These produce evidence the build/test/review loop requests but cannot run
without KVM or a device:

- **Instrumented / Espresso tests** (`connectedAndroidTest`) — need an
  emulator (KVM) or device.
- **Maestro flow tests** — need a running emulator.
- **The 1-hour locked-screen + Doze background-recording acceptance** — the
  make-or-break test, on a real low-end Android handset, including a mid-session
  interruption (incoming call). An emulator cannot reproduce OEM Doze /
  battery-killer behaviour.
- **Permission-prompt UX** (RECORD_AUDIO grant, battery-optimisation exemption).

## iOS (not yet buildable)

**Toolchain prerequisites, for when a macOS host exists:** macOS with Xcode
and the Command Line Tools; CocoaPods; `@capacitor/ios` (added via
`npm i @capacitor/ios && npx cap add ios` — not yet run here); for the sync
library, a Rust toolchain with the `aarch64-apple-ios`,
`aarch64-apple-ios-sim` and `x86_64-apple-ios` targets plus `uniffi-bindgen`
Swift output (the `scripts/build-sync-ffi-ios.sh` sibling of
`scripts/build-sync-ffi.sh` does not exist yet). All three slices are needed:
the simulator is x86_64 on an Intel Mac and arm64 on Apple Silicon and on the
GitHub-hosted macOS runners, and the device is arm64. An Apple Developer
Program membership is needed for device deployment and TestFlight;
simulator-only work is not.

**What is not possible today:** there is no `ios/` directory, no
`SyncPlugin.swift`, no `SyncFfi.xcframework`, and no iOS CI lane —
`.github/workflows/ci.yml` runs only ubuntu jobs. No command in this file
produces a working iOS build. The platform seam exists in `src/` as
TypeScript branches (`src/sync/client.ts`, `src/capture/foregroundService.ts`),
but no native iOS target consumes it.

See `docs/IOS_ROADMAP.md` for the phased plan, the decision gates, and the
per-phase gates.
