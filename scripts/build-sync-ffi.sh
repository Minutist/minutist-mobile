#!/usr/bin/env bash
# Build the sync-ffi native library + UniFFI Kotlin bindings and place them in the
# Android project. This is the cross-repo handoff: the .so + bindings are produced
# from the desktop repo's `crates/sync-ffi` (the UniFFI wrapper over the `sync`
# crate's SyncEngine) and consumed by this app's Capacitor `SyncPlugin`.
#
# The cross-compile runs inside the `minutist/android-build:local` image (NDK r27
# + cargo-ndk + the pinned Rust 1.91 toolchain — see docker/android-build/). It
# writes two outputs:
#   android/app/src/main/jniLibs/arm64-v8a/libsync_ffi.so    (gitignored artifact)
#   android/app/src/main/java/uniffi/sync_ffi/sync_ffi.kt     (committed, generated)
#
# Re-run this whenever crates/sync-ffi changes (a new FFI method / type) so the
# committed bindings stay in lockstep with the .so's ABI.
#
# Usage:
#   scripts/build-sync-ffi.sh [DESKTOP_REPO] [PROFILE]
#     DESKTOP_REPO  path to the minutist desktop repo (default: ../minutist)
#     PROFILE       debug | release (default: debug — faster; use release to ship)
set -euo pipefail

MOBILE_REPO="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_REPO="${1:-$(cd "$MOBILE_REPO/../minutist" && pwd)}"
PROFILE="${2:-debug}"
IMAGE="minutist/android-build:local"

REL_FLAG=""
[ "$PROFILE" = "release" ] && REL_FLAG="--release"

echo "sync-ffi: cross-compiling ($PROFILE) from $DESKTOP_REPO in $IMAGE ..."
docker run --rm \
  -v "$DESKTOP_REPO:$DESKTOP_REPO" \
  -v "$MOBILE_REPO:$MOBILE_REPO" \
  -w "$DESKTOP_REPO" \
  --user "$(id -u):$(id -g)" \
  "$IMAGE" \
  bash -c "
    set -euo pipefail
    # cargo-ndk 4.x: the API-level flag is --platform (NOT -p, which cargo reads
    # as --package).
    cargo ndk -t arm64-v8a --platform 24 build -p sync-ffi $REL_FLAG
    SO='$DESKTOP_REPO/target/aarch64-linux-android/$PROFILE/libsync_ffi.so'
    OUT_JNI='$MOBILE_REPO/android/app/src/main/jniLibs/arm64-v8a'
    OUT_KT='$MOBILE_REPO/android/app/src/main/java'
    mkdir -p \"\$OUT_JNI\"
    cp \"\$SO\" \"\$OUT_JNI/libsync_ffi.so\"
    # Library-mode bindgen reads the UniFFI metadata embedded in the .so and emits
    # uniffi/sync_ffi/sync_ffi.kt under OUT_KT (Kotlin package uniffi.sync_ffi).
    cargo run -q -p sync-ffi --bin uniffi-bindgen -- generate --library \"\$SO\" --language kotlin --out-dir \"\$OUT_KT\"
  "
echo "sync-ffi: .so       -> android/app/src/main/jniLibs/arm64-v8a/libsync_ffi.so"
echo "sync-ffi: bindings  -> android/app/src/main/java/uniffi/sync_ffi/sync_ffi.kt"
