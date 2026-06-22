# Headless Android build image for the Minutist companion.
#
# Base: cirruslabs Android SDK image — Ubuntu 24.04, OpenJDK 21 (matches
# Capacitor's recommended JDK), command-line tools with SDK licences
# pre-accepted. Pinned by digest-bearing tag; never a floating `latest`.
#
# This image builds a DEBUG APK headless — no emulator, no display, no KVM. It
# does NOT run instrumented tests or the background-recording acceptance; those
# need a real device (see ../../docs/BUILD.md).
#
# NDK NOTE: this base has no Android NDK. The current shell build (sync stubbed)
# is pure Kotlin/Java + a webview and needs none. When the native sync plugin
# lands (the desktop `sync` crate cross-compiled to aarch64-linux-android via
# UniFFI), switch the base to the cirruslabs `-ndk` variant and add the Rust
# `aarch64-linux-android` target here.
FROM ghcr.io/cirruslabs/android-sdk:35

ENV DEBIAN_FRONTEND=noninteractive

# Node 20 LTS via NodeSource — needed for `npm ci`, `vite build`, and
# `npx cap sync` inside the same image (Capacitor needs Node >= 20).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Pin the SDK components the Gradle build resolves to. Idempotent if the base
# already carries them. Keep these in lockstep with android/app/build.gradle
# (compileSdk / build-tools) — a drift here is a CI failure, by design.
RUN yes | sdkmanager --licenses >/dev/null \
    && sdkmanager \
        "platforms;android-36" \
        "build-tools;35.0.0" \
        "platform-tools"

# Builds run as the host uid via `--user "$(id -u):$(id -g)"` (the repo's
# ephemeral-container convention) so generated android/app/build artefacts are
# host-owned. Gradle home is expected to be a host-mounted cache so the SDK and
# dependency downloads are not re-fetched every run.
WORKDIR /workspace
