#!/usr/bin/env bash
# Build the sync-ffi static libraries + UniFFI Swift bindings for iOS and
# assemble them into SyncFfi.xcframework. The iOS counterpart of
# scripts/build-sync-ffi.sh: same cross-repo handoff, from the desktop repo's
# `crates/sync-ffi` (the UniFFI wrapper over the `sync` crate's SyncEngine) to
# this app.
#
# MUST RUN ON macOS. Unlike the Android script there is no container: the
# toolchain is the host's Xcode, and Apple ships no Linux cross-compiler for
# iOS. Drive it over ssh from another machine if that is where you work.
#
# Writes:
#   ios/App/App/Generated/sync_ffi.swift   (committed, generated)
#   ios/SyncFfi.xcframework/               (gitignored — binary)
#
# Three slices, not two. Simulator architecture follows the host, so an Intel
# Mac needs x86_64 while Apple Silicon and the GitHub macOS runners need arm64;
# both simulator arches are lipo'd into one slice because an xcframework cannot
# hold two slices for the same platform.
#
# Re-run whenever crates/sync-ffi changes (a new FFI method or type) so the
# committed bindings stay in lockstep with the library's ABI.
#
# Usage:
#   scripts/build-sync-ffi-ios.sh [DESKTOP_REPO] [PROFILE]
#     DESKTOP_REPO  path to the minutist desktop repo (default: ../minutist)
#     PROFILE       debug | release (default: release — debug static libs are
#                   enormous and there is no reason to ship or link them)
set -euo pipefail

MOBILE_REPO="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_REPO="${1:-$(cd "$MOBILE_REPO/../minutist" && pwd)}"
PROFILE="${2:-release}"

# Match the app's floor. Rust otherwise defaults these targets to iOS 10, which
# makes the linker warn that every object was built for a newer iOS than it is
# being linked for.
export IPHONEOS_DEPLOYMENT_TARGET=15.0

REL_FLAG=""
[ "$PROFILE" = "release" ] && REL_FLAG="--release"

DEVICE_TARGET=aarch64-apple-ios
SIM_TARGETS=(aarch64-apple-ios-sim x86_64-apple-ios)

OUT_SWIFT="${MOBILE_REPO}/ios/App/App/Generated"
OUT_FRAMEWORK="${MOBILE_REPO}/ios/SyncFfi.xcframework"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Installing Apple's Command Line Tools — which Homebrew's bootstrap does —
# repoints the active developer directory away from Xcode.app, and
# CommandLineTools carries no iOS SDK. Without this check the build fails much
# later at the link step, pulling in macOS frameworks, with an error that names
# neither the SDK nor xcode-select.
if ! IOS_SDK="$(xcrun --sdk iphoneos --show-sdk-path 2>/dev/null)" || [ -z "$IOS_SDK" ]; then
  echo "no iOS SDK; active developer dir is '$(xcode-select -p 2>&1)'." >&2
  echo "fix with: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi

echo "sync-ffi(ios): SDK $IOS_SDK"
echo "sync-ffi(ios): building $PROFILE static libs from $DESKTOP_REPO ..."
cd "$DESKTOP_REPO"
for target in "$DEVICE_TARGET" "${SIM_TARGETS[@]}"; do
  rustup target add "$target" >/dev/null 2>&1 || true
  echo "  $target"
  # --lib is required: the package also exposes the uniffi-bindgen bin, and
  # --crate-type can only apply to a single target. staticlib rather than the
  # crate's declared cdylib because UniFFI's Swift story assumes a static
  # library and it avoids embedding a dylib in the app bundle.
  cargo rustc -q -p sync-ffi --lib --target "$target" $REL_FLAG --crate-type staticlib
done

lib_for() { echo "${DESKTOP_REPO}/target/$1/${PROFILE}/libsync_ffi.a"; }

echo "sync-ffi(ios): generating Swift bindings ..."
# Library mode reads the UniFFI metadata out of a built library, so the bindings
# cannot drift from the ABI they were generated against.
mkdir -p "$STAGE/swift"
cargo run -q -p sync-ffi --bin uniffi-bindgen -- \
  generate --library "$(lib_for "$DEVICE_TARGET")" --language swift --out-dir "$STAGE/swift"

mkdir -p "$OUT_SWIFT"
cp "$STAGE/swift/sync_ffi.swift" "$OUT_SWIFT/sync_ffi.swift"

# xcodebuild wants the C header beside a modulemap named exactly
# module.modulemap; uniffi emits it as <namespace>FFI.modulemap.
mkdir -p "$STAGE/headers"
cp "$STAGE"/swift/*.h "$STAGE/headers/"
cp "$STAGE"/swift/*.modulemap "$STAGE/headers/module.modulemap"

echo "sync-ffi(ios): combining simulator architectures ..."
mkdir -p "$STAGE/sim"
lipo -create "$(lib_for "${SIM_TARGETS[0]}")" "$(lib_for "${SIM_TARGETS[1]}")" \
  -output "$STAGE/sim/libsync_ffi.a"

echo "sync-ffi(ios): assembling the xcframework ..."
rm -rf "$OUT_FRAMEWORK"
xcodebuild -create-xcframework \
  -library "$(lib_for "$DEVICE_TARGET")" -headers "$STAGE/headers" \
  -library "$STAGE/sim/libsync_ffi.a" -headers "$STAGE/headers" \
  -output "$OUT_FRAMEWORK" >/dev/null

# Assert the result rather than trusting the exit code: a framework missing a
# slice still builds locally and then fails only on the other architecture.
for slice in ios-arm64 ios-arm64_x86_64-simulator; do
  [ -f "$OUT_FRAMEWORK/$slice/libsync_ffi.a" ] || {
    echo "xcframework is missing the $slice slice" >&2; exit 1; }
  echo "  $slice: $(lipo -info "$OUT_FRAMEWORK/$slice/libsync_ffi.a" | sed 's/.*: //')"
done

echo "sync-ffi(ios): bindings   -> ios/App/App/Generated/sync_ffi.swift"
echo "sync-ffi(ios): xcframework -> ios/SyncFfi.xcframework"
