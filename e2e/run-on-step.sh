#!/usr/bin/env bash
# run-on-step.sh — build (if needed), transfer APK + flows to the step host,
# then run the full Maestro flow suite on the provisioned KVM emulator.
#
# Environment variables:
#   STEP_HOST   SSH host name/alias for the emulator host  (default: step)
#   APK         Local path to the debug APK to test
#               (default: android/app/build/outputs/apk/debug/app-debug.apk
#                relative to the repo root; built automatically if absent)
#
# Prerequisites on this (calling) machine:
#   - SSH key-auth to $STEP_HOST already configured.
#   - rsync available.
#   - docker available if the APK needs to be built.
#
# Exit code propagates from Maestro (0 = all flows passed).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STEP_HOST="${STEP_HOST:-step}"
APK="${APK:-${REPO_ROOT}/android/app/build/outputs/apk/debug/app-debug.apk}"
REMOTE_APK='~/minutist-app-debug.apk'
REMOTE_FLOWS_DIR='~/minutist-emulator/flows-repo'

# ---------------------------------------------------------------------------
# Build the APK if it is absent
# ---------------------------------------------------------------------------
if [ ! -f "$APK" ]; then
  echo "[build] APK not found at $APK — building via docker image..."
  cd "$REPO_ROOT"

  # Prepare the webview bundle on the host (Node is not in the build image).
  npm ci
  npm run build
  npx cap sync android

  # Mount a persistent Gradle home cache to avoid re-downloading on each run.
  GRADLE_CACHE="${GRADLE_CACHE:-$HOME/.gradle-mm}"
  mkdir -p "$GRADLE_CACHE"

  docker run --rm \
    -v "$(pwd):$(pwd)" -w "$(pwd)" \
    -v "${GRADLE_CACHE}:/gradle-home" \
    -e GRADLE_USER_HOME=/gradle-home \
    -e HOME=/tmp \
    --user "$(id -u):$(id -g)" \
    minutist/android-build:local \
    bash -lc 'cd android && ./gradlew assembleDebug'

  echo "[build] APK assembled."
fi

[ -f "$APK" ] || { echo "APK still missing after build: $APK" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Transfer APK to step
# ---------------------------------------------------------------------------
echo "[transfer] copying APK to ${STEP_HOST}:~/minutist-app-debug.apk ..."
scp "$APK" "${STEP_HOST}:~/minutist-app-debug.apk"

# ---------------------------------------------------------------------------
# Sync flows to step (clear first so deleted flows don't linger)
# ---------------------------------------------------------------------------
echo "[transfer] syncing flows to ${STEP_HOST}:${REMOTE_FLOWS_DIR} ..."
ssh "$STEP_HOST" 'rm -rf ~/minutist-emulator/flows-repo && mkdir -p ~/minutist-emulator/flows-repo'
rsync -az --delete "${REPO_ROOT}/e2e/flows/" "${STEP_HOST}:~/minutist-emulator/flows-repo/"

# ---------------------------------------------------------------------------
# Run the Maestro suite on step and propagate its exit code
# ---------------------------------------------------------------------------
echo "[run] launching run-emulator-tests.sh on ${STEP_HOST} ..."
ssh "$STEP_HOST" '~/minutist-emulator/run-emulator-tests.sh ~/minutist-app-debug.apk ~/minutist-emulator/flows-repo'
