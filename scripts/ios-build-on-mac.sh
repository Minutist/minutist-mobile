#!/usr/bin/env bash
# ios-build-on-mac.sh — rsync the worktree to the macOS build host, build the
# iOS app for the simulator via xcodebuild, then (unless --build-only) boot a
# simulator, install and launch the app, and capture a screenshot as a
# headless smoke check.
#
# Usage:
#   ios-build-on-mac.sh [--build-only]
#
#   --build-only   Sync and build only; skip the simulator install/launch/
#                  screenshot leg entirely.
#
# Environment variables:
#   MAC_HOST     SSH host name/alias for the macOS build host (default: mm)
#   REMOTE_DIR   Remote directory the worktree is rsynced into and built from
#                (default: ~/minutist-ios)
#   SCREENSHOT   Local path the simulator screenshot is copied back to
#                (default: /tmp/minutist-ios-simulator-screenshot.png)
#   SIMULATOR    Simulator device name or UDID to boot
#                (default: the first available iPhone device on the host)
#
# Prerequisites on this (calling) machine:
#   - SSH key-auth to $MAC_HOST already configured.
#   - rsync and scp available.
#
# Prerequisites on the remote macOS host:
#   - Xcode with an iOS SDK and at least one installed iOS Simulator runtime.
#   - Node 22, exported from ~/.zshenv (non-interactive, non-login ssh
#     commands read ~/.zshenv; ~/.zshrc is not read).
#
# The build and the simulator smoke are simulator-only and need no
# codesigning identity or provisioning profile.
#
# Exit code: 0 only if the remote build succeeds and, unless --build-only,
# the app installs, launches, is still running on the host after settling,
# and a non-empty PNG screenshot is fetched back. Non-zero otherwise.
set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
BUILD_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAC_HOST="${MAC_HOST:-mm}"
REMOTE_DIR="${REMOTE_DIR:-~/minutist-ios}"
# Resolve REMOTE_DIR to an absolute remote path before anything derives from
# it. The default carries a tilde, which the remote shell expands when the
# value is interpolated into an ssh/rsync argument but NOT when it is passed
# into the remote smoke script as a quoted variable, so the smoke leg would
# otherwise test a literal "~/..." path that never exists.
REMOTE_DIR="$(ssh "$MAC_HOST" "mkdir -p ${REMOTE_DIR} && cd ${REMOTE_DIR} && pwd")"
SCREENSHOT="${SCREENSHOT:-/tmp/minutist-ios-simulator-screenshot.png}"
SIMULATOR="${SIMULATOR:-}"
# Distinct colours the screenshot must show across the app area to count as
# rendered. A blank WebView measures 1; the Capture view measures ~1365.
MIN_SCREENSHOT_COLOURS="${MIN_SCREENSHOT_COLOURS:-50}"

BUNDLE_ID="ai.minutist.companion"
REMOTE_DERIVED_DATA="${REMOTE_DIR}/DerivedData"
REMOTE_APP_PATH="${REMOTE_DERIVED_DATA}/Build/Products/Debug-iphonesimulator/App.app"
REMOTE_BUILD_LOG="${REMOTE_DIR}/xcodebuild.log"
REMOTE_SCREENSHOT="${REMOTE_DIR}/ios-simulator-screenshot.png"

# ---------------------------------------------------------------------------
# Sync the worktree to the Mac
# ---------------------------------------------------------------------------
# Installing Apple's Command Line Tools — which Homebrew's bootstrap does —
# repoints the active developer directory away from Xcode.app, and
# CommandLineTools carries no iOS SDK. Builds then fail at the link step by
# pulling in macOS frameworks, with an error that names neither the SDK nor
# xcode-select. Assert the iOS SDK is reachable before spending a full sync and
# compile on it.
echo "[pre] checking the iOS SDK is reachable on ${MAC_HOST} ..."
if ! IOS_SDK="$(ssh "$MAC_HOST" 'xcrun --sdk iphoneos --show-sdk-path 2>/dev/null')"    || [ -z "$IOS_SDK" ]; then
  ACTIVE="$(ssh "$MAC_HOST" 'xcode-select -p 2>&1' || true)"
  echo "[pre] no iOS SDK: the active developer directory is '${ACTIVE}'." >&2
  echo "[pre] fix with: ssh ${MAC_HOST} 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer'" >&2
  exit 1
fi
echo "[pre] iOS SDK: ${IOS_SDK}"

echo "[sync] rsyncing worktree to ${MAC_HOST}:${REMOTE_DIR} ..."
# Build outputs that live on the Mac and not here must be excluded BY NAME, or
# --delete destroys them: they are absent locally, so rsync treats them as
# extraneous. The SyncFfi.xcframework costs ~25 minutes to rebuild.
#
# The excludes are bare basenames on purpose. --filter=':- .gitignore' is kept
# because it catches build outputs nobody thought to list, but rsync's gitignore
# emulation does not honour a multi-segment rule like `a/b/name/` the way git
# does, so it cannot be relied on alone — and a path-anchored exclude silently
# stops matching the moment a directory moves.
rsync -az --delete \
  --filter=':- .gitignore' \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'dist' \
  --exclude 'ios/App/CapApp-SPM/.build' \
  --exclude 'ios/App/build' \
  --exclude 'DerivedData' \
  --exclude 'SyncFfi.xcframework' \
  "${REPO_ROOT}/" "${MAC_HOST}:${REMOTE_DIR}/"

# ---------------------------------------------------------------------------
# Remote build — webview bundle, cap sync, then xcodebuild for the simulator
# ---------------------------------------------------------------------------
echo "[build] npm ci && npm run build && npx cap sync ios on ${MAC_HOST} ..."
ssh "$MAC_HOST" "cd ${REMOTE_DIR} && npm ci && npm run build && npx cap sync ios"

echo "[build] xcodebuild -project ios/App/App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' build ..."
# tee preserves the log for the failure branch below; `set -o pipefail` on the
# remote shell (zsh honours the same option name as bash) makes the pipeline's
# exit status xcodebuild's, not tee's, so `set -e` here still catches a build
# failure instead of being fooled by tee's own success.
if ! ssh "$MAC_HOST" "set -o pipefail; cd ${REMOTE_DIR} && xcodebuild -project ios/App/App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' -derivedDataPath ${REMOTE_DERIVED_DATA} build 2>&1 | tee ${REMOTE_BUILD_LOG}"; then
  echo "[build] xcodebuild failed — last 100 lines of ${REMOTE_BUILD_LOG}:" >&2
  ssh "$MAC_HOST" "tail -n 100 ${REMOTE_BUILD_LOG}" >&2 || true
  exit 1
fi
echo "[build] xcodebuild succeeded."

if $BUILD_ONLY; then
  echo "[build] --build-only set; skipping the simulator leg."
  exit 0
fi

# ---------------------------------------------------------------------------
# Simulator leg — resolve device, boot, install, launch, settle, screenshot
# ---------------------------------------------------------------------------
echo "[sim] running the simulator smoke on ${MAC_HOST} ..."
# ssh joins a command and its trailing arguments into a single string with
# plain spaces before handing it to the remote shell — it does not preserve
# argv boundaries or quoting, so a truly empty argument (SIMULATOR unset,
# the documented default) vanishes from the joined string instead of landing
# as an empty positional parameter, shifting every arg after it left. Passing
# the values as NAME=value environment assignments in a single, locally-built
# and locally-quoted command string sidesteps this: each assignment is
# non-empty text even when its value is empty (e.g. `SIMULATOR_SPEC=`), so
# nothing is lost in the join, and the values reach the script as environment
# variables rather than positional parameters.
REMOTE_CMD="$(printf 'BUNDLE_ID=%q APP_PATH=%q SIMULATOR_SPEC=%q SCREENSHOT_REMOTE=%q bash -s' \
  "$BUNDLE_ID" "$REMOTE_APP_PATH" "$SIMULATOR" "$REMOTE_SCREENSHOT")"
ssh "$MAC_HOST" "$REMOTE_CMD" <<'REMOTE_SCRIPT'
set -euo pipefail

# Resolve the target device: an explicit UDID, an explicit device name, or
# (default) the first available iPhone device on the host.
if [ -n "$SIMULATOR_SPEC" ] && echo "$SIMULATOR_SPEC" | grep -qE '^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$'; then
  DEVICE_ID="$SIMULATOR_SPEC"
elif [ -n "$SIMULATOR_SPEC" ]; then
  # `|| true` keeps a no-match (or a SIGPIPE from head closing the pipe early)
  # from tripping `set -e` on the assignment itself, so the empty-DEVICE_ID
  # guard below is reachable and reports the cause.
  DEVICE_ID="$(xcrun simctl list devices available | grep -F "$SIMULATOR_SPEC (" | head -1 | sed -E 's/.*\(([0-9A-Fa-f-]+)\).*/\1/' || true)"
else
  DEVICE_ID="$(xcrun simctl list devices available | grep -E 'iPhone' | head -1 | sed -E 's/.*\(([0-9A-Fa-f-]+)\).*/\1/' || true)"
fi
if [ -z "$DEVICE_ID" ]; then
  echo "[sim] could not resolve a simulator device (SIMULATOR=$SIMULATOR_SPEC)" >&2
  exit 1
fi
echo "[sim] using device $DEVICE_ID"

# Diagnostics on exit regardless of outcome; a failure in this query must not
# itself fail the script or hide the real pass/fail from the checks below.
# One EXIT handler, because a second `trap ... EXIT` would silently replace the
# first rather than adding to it. WE_BOOTED is read at exit time, so it may be
# assigned after this point.
WE_BOOTED=false
on_exit() {
  xcrun simctl spawn "$DEVICE_ID" log show --last 1m \
    --predicate "eventMessage CONTAINS[c] \"error\" OR eventMessage CONTAINS[c] \"exception\" OR eventMessage CONTAINS[c] \"crash\"" \
    2>&1 | tail -n 100 || echo "[sim] log query failed (non-fatal, diagnostics only)"
  if $WE_BOOTED; then
    echo "[sim] shutting down the simulator this run booted"
    xcrun simctl shutdown "$DEVICE_ID" >/dev/null 2>&1 || true
  fi
}
trap on_exit EXIT

# Track whether this run booted the simulator. A booted simulator's
# diagnosticd and apsd keep burning CPU indefinitely — measured at roughly 30%
# of a two-core host after being left up for two days — and the memory pressure
# that causes is also when WebKit's content process gets killed, which is what
# produces a blank render. So shut down what we started, and leave alone what
# was already running (someone may be using it).
if BOOT_OUT="$(xcrun simctl boot "$DEVICE_ID" 2>&1)"; then
  echo "[sim] booted $DEVICE_ID"
  WE_BOOTED=true
elif ! echo "$BOOT_OUT" | grep -qi 'Unable to boot device in current state: Booted'; then
  echo "$BOOT_OUT" >&2
  echo "[sim] simctl boot failed" >&2
  exit 1
else
  echo "[sim] $DEVICE_ID already booted (leaving it running)"
fi

xcrun simctl bootstatus "$DEVICE_ID" -b

if TERM_OUT="$(xcrun simctl terminate "$DEVICE_ID" "$BUNDLE_ID" 2>&1)"; then
  echo "[sim] terminated any running instance of $BUNDLE_ID"
# "found nothing to terminate" is simctl's wording when the app is not running,
# which is the normal case on a freshly booted simulator. It is benign and must
# not fail the run.
elif ! echo "$TERM_OUT" | grep -qiE 'no such process|not running|not installed|found nothing to terminate'; then
  echo "$TERM_OUT" >&2
  echo "[sim] simctl terminate failed" >&2
  exit 1
else
  echo "[sim] $BUNDLE_ID was not running"
fi

echo "[sim] installing $APP_PATH"
xcrun simctl install "$DEVICE_ID" "$APP_PATH"

echo "[sim] launching $BUNDLE_ID"
LAUNCH_OUT="$(xcrun simctl launch "$DEVICE_ID" "$BUNDLE_ID")"
echo "$LAUNCH_OUT"
# `simctl launch` (without --console/--wait-for-debugger) prints "bundle-id: pid".
PID="$(echo "$LAUNCH_OUT" | sed -E 's/^.*: *([0-9]+)[[:space:]]*$/\1/')"
case "$PID" in
  ''|*[!0-9]*)
    echo "[sim] simctl launch did not report a numeric pid: $LAUNCH_OUT" >&2
    exit 1
    ;;
esac

echo "[sim] settling 5s, then confirming the process survived launch ..."
sleep 5

# `simctl launch` exiting 0 only means the request was accepted, not that the
# app is still alive; the simulator's app processes are real host processes,
# so a crash-on-launch is caught here via ps rather than trusted away.
if ! ps -p "$PID" > /dev/null 2>&1; then
  echo "[sim] process $PID (from simctl launch) is no longer running after settling" >&2
  exit 1
fi
echo "[sim] pid $PID still running after settle"

# A live process is not a painted one. On a cold-booted simulator WKWebView
# takes appreciably longer than the liveness settle to paint, so poll the
# screenshot until the app's area stops being a single flat colour rather than
# guessing at a fixed delay. Distinguishing "did not render" from "had not
# rendered yet" is the whole point.
echo "[sim] waiting for the web view to paint ..."
PAINTED=false
for attempt in $(seq 1 12); do
  xcrun simctl io "$DEVICE_ID" screenshot "$SCREENSHOT_REMOTE" >/dev/null 2>&1 || true
  if [ -s "$SCREENSHOT_REMOTE" ]; then
    COLOURS="$(python3 - "$SCREENSHOT_REMOTE" <<'PY' 2>/dev/null
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
# Exclude the status bar and home indicator: they paint regardless of the web
# view, so including them would mask a blank page.
body = im.crop((0, int(h * 0.06), w, int(h * 0.96)))
print(len(body.getcolors(maxcolors=1 << 20) or []))
PY
)"
    if [ -n "${COLOURS:-}" ] && [ "$COLOURS" -ge 50 ]; then
      echo "[sim] painted after ${attempt} attempt(s) (${COLOURS} distinct colours)"
      PAINTED=true
      break
    fi
  fi
  sleep 5
done
if ! $PAINTED; then
  echo "[sim] the app never painted: still ${COLOURS:-0} distinct colours after 12 attempts" >&2
  exit 1
fi

REMOTE_SCRIPT

# ---------------------------------------------------------------------------
# Fetch and verify the screenshot
# ---------------------------------------------------------------------------
echo "[sim] fetching screenshot to ${SCREENSHOT} ..."
scp "${MAC_HOST}:${REMOTE_SCREENSHOT}" "${SCREENSHOT}"

if [ ! -s "$SCREENSHOT" ]; then
  echo "[sim] fetched screenshot is missing or empty: $SCREENSHOT" >&2
  exit 1
fi
PNG_MAGIC="89504e470d0a1a0a"
ACTUAL_MAGIC="$(head -c 8 "$SCREENSHOT" | od -An -tx1 | tr -d ' \n')"
if [ "$ACTUAL_MAGIC" != "$PNG_MAGIC" ]; then
  echo "[sim] fetched screenshot is not a PNG (magic: $ACTUAL_MAGIC): $SCREENSHOT" >&2
  exit 1
fi
# PNG magic only proves a PNG arrived. A blank WebView yields a single flat
# colour across the app's area, while the rendered Capture view yields over a
# thousand, so a distinct-colour count separates them decisively. Pillow is not
# a hard dependency of this script, so an absent one downgrades to a loud
# warning rather than a false pass.
if python3 -c 'import PIL' >/dev/null 2>&1; then
  COLOURS="$(python3 - "$SCREENSHOT" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
w, h = im.size
# Crop off the status bar and home indicator: those render regardless of
# whether the web view painted anything, so they would mask a blank page.
body = im.crop((0, int(h * 0.06), w, int(h * 0.96)))
print(len(body.getcolors(maxcolors=1 << 20) or []))
PY
)"
  if [ "$COLOURS" -lt "$MIN_SCREENSHOT_COLOURS" ]; then
    echo "[smoke] screenshot shows $COLOURS distinct colours in the app area, below the" >&2
    echo "        minimum of $MIN_SCREENSHOT_COLOURS: the app launched but rendered nothing." >&2
    exit 1
  fi
  echo "[smoke] screenshot shows a rendered UI ($COLOURS distinct colours): $SCREENSHOT"
else
  echo "[smoke] WARNING: python3 with Pillow is unavailable, so the screenshot's" >&2
  echo "        contents were NOT asserted; only that a PNG arrived." >&2
  echo "[smoke] screenshot fetched (contents unverified): $SCREENSHOT"
fi
