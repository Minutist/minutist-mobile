# Build + signing runbook

## Web build

```sh
npm ci
npm run build          # tsc --noEmit && vite build -> dist/
npm test               # vitest
npm run lint           # eslint
```

## Android debug APK (headless, no device)

The host has no Android SDK; the build runs in the pinned build image.

```sh
# One-time: build the image (base is ghcr.io/cirruslabs/android-sdk:35).
docker build -t minutist/android-build:local docker/android-build

# Assemble. Host-uid so artefacts are host-owned; mount a persistent Gradle
# home so the SDK + dependency downloads are not re-fetched each run.
docker run --rm \
  -v "$(pwd):$(pwd)" -w "$(pwd)" \
  -v "$HOME/.gradle-minutist-mobile:/home/builder/.gradle" \
  --user "$(id -u):$(id -g)" \
  minutist/android-build:local \
  bash -lc 'npm ci && npm run build && npx cap sync android && cd android && ./gradlew assembleDebug'
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Debug builds use the auto-generated debug keystore — no secrets needed.

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

These produce evidence the build/test/review loop requests but cannot run:

- **Instrumented / Espresso tests** — need an emulator (KVM) or device.
- **The 1-hour locked-screen + Doze background-recording acceptance** — the
  make-or-break test, on a real low-end Android handset, including a mid-session
  interruption (incoming call). An emulator cannot reproduce OEM Doze /
  battery-killer behaviour.
- **Permission-prompt UX** (RECORD_AUDIO grant, battery-optimisation exemption).
