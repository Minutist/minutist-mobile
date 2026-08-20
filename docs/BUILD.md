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

## iOS

### Host prerequisites

- macOS with Xcode (the current build host runs 16.4, iOS 18.5 SDK, Swift
  6.1.2) and at least one installed Simulator runtime.
- Node 22.
- SSH key-auth from the calling machine to the Mac host (no interactive
  password prompt).
- For the sync library specifically — not needed for this build, which runs
  the mock sync client — a Rust toolchain with the `aarch64-apple-ios`,
  `aarch64-apple-ios-sim` and `x86_64-apple-ios` targets.

CocoaPods is not required and is not installed on the build host. Capacitor 8
builds this project through Swift Package Manager: `ios/App/CapApp-SPM/`
declares the plugin dependencies and there is no `Podfile` and no
`.xcworkspace`, so every `xcodebuild` invocation below takes `-project
ios/App/App.xcodeproj`, not `-workspace`.

Commands run over a non-interactive, non-login `ssh` read the host's
`~/.zshenv` for `PATH`/`LANG` (Node, Rust); `~/.zshrc` is not read on that
path, so anything exported only there is invisible to these builds.

### One-command path

```sh
MAC_HOST=mm scripts/ios-build-on-mac.sh
```

`scripts/ios-build-on-mac.sh` rsyncs the worktree to `$MAC_HOST` (default
`mm`), runs `npm ci && npm run build && npx cap sync ios` there, then the
`xcodebuild` simulator build below, then — unless `--build-only` is passed —
boots a Simulator device, installs and launches the app, confirms the
launched process is still alive after a settle period, and pulls back a
screenshot, failing the run if any leg fails or the screenshot is missing or
not a PNG. Other environment variables: `REMOTE_DIR` (default `~/minutist-ios`,
the directory the worktree is synced into), `SCREENSHOT` (local path the
screenshot is copied to), `SIMULATOR` (device name or UDID to boot; default
the first available iPhone on the host). Exit code is non-zero on any
failure, so it is safe to gate on.

### Manual path

For a build without the simulator smoke, or with different flags:

```sh
# On the Mac host: prepare the webview bundle and sync the Capacitor project.
npm ci && npm run build && npx cap sync ios

# -project, not -workspace: the SPM layout has no .xcworkspace.
# generic/platform=iOS Simulator builds both simulator archs without pinning
# to one booted device.
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' build
```

Then, to install and launch it on a booted simulator:

```sh
xcrun simctl install <device-id> \
  ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch <device-id> ai.minutist.companion
xcrun simctl io <device-id> screenshot out.png
```

### Asset regeneration

```sh
npm run assets:generate -- --ios --android  # both native platforms, from assets/
npm run assets:generate -- --ios            # iOS only; leaves android/app/**/res untouched
```

Pass the platforms explicitly. With no platform flag `capacitor-assets`
defaults to `ios`, `android` and `pwa`, and it only drops `ios`/`android` when
those project folders are missing — `pwa` is always attempted, though this
project ships no PWA.

Both write into the platform's generated asset catalogue —
`ios/App/App/Assets.xcassets/AppIcon.appiconset` and `.../Splash.imageset` on
the iOS side — and those generated files are committed, the same treatment
Android's `mipmap`/`drawable` output gets.

### What still cannot be done here

- **Physical-device deployment.** The Mac host holds no codesigning identity,
  and device work additionally needs an Apple Developer Program membership.
  For the test iPhone specifically, it runs iOS 15.8, and Xcode 16.4 ships
  `DeviceSupport` for 15.0–16.4 but not that exact 15.8 build, so the device
  is not attachable until that support file is supplied.
- **Sync against a real relay.** There is no `SyncFfi.xcframework` and no
  `SyncPlugin.swift`; the iOS app runs against the mock sync client through
  the `case 'ios'` arm of `createSyncClient()` in `src/sync/client.ts`.
- **CI.** There is no iOS job in `.github/workflows/ci.yml` and no Maestro
  iOS lane.

The current Mac host is an Intel Mac; the app links a fat x86_64 + arm64
Simulator Mach-O there, since `generic/platform=iOS Simulator` builds both
simulator architectures regardless of host CPU. The GitHub-hosted macOS
runners that will run the CI lane (`docs/IOS_ROADMAP.md`, Phases 8–9) are
arm64.

### Hand-maintained blocks

`ios/App/App/Info.plist`, `ios/App/App.xcodeproj/project.pbxproj`, the shared
scheme at `ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`, and
`ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`
carry hand-maintained content a full Capacitor re-scaffold (`cap add ios`)
must not drop: `Info.plist`'s hand-added keys
(`NSMicrophoneUsageDescription`, `UIBackgroundModes: [audio]`,
`ITSAppUsesNonExemptEncryption`); `project.pbxproj`'s build settings
`MARKETING_VERSION` (`1.0.0`), `CURRENT_PROJECT_VERSION`,
`IPHONEOS_DEPLOYMENT_TARGET` (`15.0`) and `PRODUCT_BUNDLE_IDENTIFIER`
(`ai.minutist.companion`) — `Info.plist` only resolves
`CFBundleShortVersionString`/`CFBundleVersion`/`CFBundleIdentifier` through
these via `$(...)` substitution, it does not hold the values itself; the
`App.xcscheme` itself (`cap add ios` writes no `xcschemes` directory at all;
`xcodebuild` would autocreate an equivalent scheme in memory, so committing one
pins the per-action configurations — Debug for build/test/run/analyze, Release
for profile/archive — rather than making the build possible); and the resolved SPM
dependency versions (`Package.resolved`, pinning `capacitor-swift-pm` and
`keychain-swift`) that a fresh `cap add ios` would re-resolve rather than
reproduce exactly.

See `docs/IOS_ROADMAP.md` for the phased plan, the decision gates, and the
per-phase gates.
