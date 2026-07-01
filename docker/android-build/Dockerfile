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
# This image also carries the native-sync toolchain (Android NDK + a pinned Rust
# toolchain + cargo-ndk), so the desktop `sync` crate can be cross-compiled to an
# aarch64-linux-android .so (via UniFFI) and bundled by gradle. The shell build
# itself (sync stubbed) is pure Kotlin/Java + a webview and uses none of it.
FROM ghcr.io/cirruslabs/android-sdk:35

ENV DEBIAN_FRONTEND=noninteractive

# Node 22 LTS via NodeSource — needed for `npm ci`, `vite build`, and
# `npx cap sync` inside the same image (Capacitor 8 requires Node >= 22).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
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

# --- Native sync plugin toolchain (Rust + Android NDK + cargo-ndk) ----------
# The phone reuses the desktop Rust `sync` crate compiled to an aarch64
# .so via UniFFI; the .so is built with cargo-ndk and bundled by gradle.
# iroh's MSRV is 1.91, so the Rust toolchain is PINNED (not floating stable) —
# the host's default stable (1.89) is rejected by iroh@1.0. Keep the rustls
# CryptoProvider on `ring` (NOT aws-lc-sys): ring is the supported, easy Android
# cross-compile; only ring needs the NDK clang, every other dep is pure Rust.
ARG ANDROID_NDK_VERSION=27.2.12479018
ARG RUST_VERSION=1.91.0
ARG CARGO_NDK_VERSION=4.1.2

RUN yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "ndk;${ANDROID_NDK_VERSION}"
ENV ANDROID_NDK_HOME="${ANDROID_HOME}/ndk/${ANDROID_NDK_VERSION}"
ENV ANDROID_NDK_ROOT="${ANDROID_HOME}/ndk/${ANDROID_NDK_VERSION}"

# Rust in a world-readable/writable shared prefix so both the build-time root
# user and the runtime --user uid can use the toolchain and write the registry
# cache. cargo-ndk wires CC/AR/linker to the NDK's aarch64-linux-androidNN-clang.
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain "${RUST_VERSION}" --profile minimal \
    && rustup target add aarch64-linux-android \
    && cargo install cargo-ndk --version "${CARGO_NDK_VERSION}" --locked \
    && chmod -R a+rwX /opt/cargo /opt/rustup

# Builds run as the host uid via `--user "$(id -u):$(id -g)"` (the repo's
# ephemeral-container convention) so generated android/app/build artefacts are
# host-owned. Gradle home is expected to be a host-mounted cache so the SDK and
# dependency downloads are not re-fetched every run.
WORKDIR /workspace
