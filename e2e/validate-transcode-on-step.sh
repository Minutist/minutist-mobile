#!/usr/bin/env bash
# validate-transcode-on-step.sh — install the debug APK on the step KVM emulator,
# drive a short record/stop cycle, pull the produced audio.opus, and validate its
# binary format (Ogg container, Opus codec, 1 channel, 16 kHz input sample rate).
#
# The gate calls this AFTER the APK has already been assembled.
#
# Environment variables:
#   STEP_HOST   SSH host alias for the emulator host  (default: step)
#   APK         Local path to the debug APK
#               (default: android/app/build/outputs/apk/debug/app-debug.apk
#                relative to the repo root)
#
# Validation criteria (all must pass):
#   1. The output file is non-empty.
#   2. First 4 bytes == 'OggS'  (Ogg capture pattern).
#   3. The byte sequence 'OpusHead' appears in the first 512 bytes.
#   4. OpusHead channel count byte == 1  (mono).
#   5. OpusHead input sample rate (4-byte LE at offset 12 inside OpusHead) == 16000.
#
# Exit codes:
#   0  all checks pass
#   1  a check failed (message printed to stderr)
#   2  setup error (APK missing, SSH unreachable, etc.)
#
# Requirements on this (calling) machine:
#   - SSH key-auth to $STEP_HOST configured.
#   - Python3 available (used for the binary-format checks — no external deps needed).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STEP_HOST="${STEP_HOST:-step}"
APK="${APK:-${REPO_ROOT}/android/app/build/outputs/apk/debug/app-debug.apk}"
APP_ID="ai.minutist.companion"

# ---------------------------------------------------------------------------
# Verify APK exists
# ---------------------------------------------------------------------------
if [ ! -f "$APK" ]; then
  echo "ERROR: APK not found at $APK" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Transfer APK to step
# ---------------------------------------------------------------------------
echo "[validate] copying APK to ${STEP_HOST}:~/minutist-validate-debug.apk ..."
scp "$APK" "${STEP_HOST}:~/minutist-validate-debug.apk"

# ---------------------------------------------------------------------------
# All subsequent work runs on the step host
# ---------------------------------------------------------------------------
ssh "$STEP_HOST" bash -s <<'REMOTE'
set -euo pipefail

APP_ID="ai.minutist.companion"
AVD_NAME="minutist-test"
OPUS_REMOTE_PATH="/data/data/${APP_ID}/files/captures"

# Source the emulator environment (sets ANDROID_HOME, AVD paths, etc.)
# shellcheck disable=SC1090
source ~/minutist-emulator/env.sh

EMULATOR="${ANDROID_HOME}/emulator/emulator"
ADB="${ANDROID_HOME}/platform-tools/adb"

# ---------------------------------------------------------------------------
# Boot the emulator (headless)
# ---------------------------------------------------------------------------
echo "[validate] booting ${AVD_NAME} headless ..."
"$EMULATOR" -avd "$AVD_NAME" -no-window -no-audio -no-snapshot &
EMULATOR_PID=$!

# Register teardown — always kill the emulator on exit.
cleanup() {
  echo "[validate] tearing down emulator ..."
  "$ADB" emu kill 2>/dev/null || true
  wait "$EMULATOR_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the device to be online (up to 120 s).
echo "[validate] waiting for device ..."
"$ADB" wait-for-device
"$ADB" shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done'
echo "[validate] device is ready."

# ---------------------------------------------------------------------------
# Install the APK
# ---------------------------------------------------------------------------
"$ADB" uninstall "$APP_ID" 2>/dev/null || true
"$ADB" install -r ~/minutist-validate-debug.apk
echo "[validate] APK installed."

# ---------------------------------------------------------------------------
# Grant permissions and drive the record/stop flow via Maestro
# ---------------------------------------------------------------------------
# Maestro is expected to be installed in ~/maestro on the step host.
MAESTRO="${MAESTRO:-$HOME/.maestro/bin/maestro}"

# Write a minimal inline flow so this script is self-contained and does not
# depend on the flows-repo being synced to step.
FLOW_FILE="$(mktemp /tmp/validate-transcode-XXXXXX.yaml)"
cat > "$FLOW_FILE" <<'FLOW'
appId: ai.minutist.companion
---
- launchApp:
    appId: ai.minutist.companion
    clearState: true
    permissions:
      all: allow
- assertVisible: "Ready"
- tapOn: "Start recording"
- assertVisible: "Recording"
- waitForAnimationToEnd:
    timeout: 3000
- tapOn: "Stop recording"
- assertVisible: "Recorded — awaiting a desktop"
FLOW

echo "[validate] running Maestro flow ..."
"$MAESTRO" test --format junit --output /tmp/validate-transcode-results.xml "$FLOW_FILE" || {
  echo "ERROR: Maestro flow failed — see output above." >&2
  exit 1
}
echo "[validate] Maestro flow passed."

# ---------------------------------------------------------------------------
# Pull the produced audio.opus off the device
# ---------------------------------------------------------------------------
# The file lives at: <filesDir>/captures/<captureId>/audio.opus
# In a debug build the app-private directory is readable via run-as.
# We enumerate the captures dir to find the most recent captureId.
CAPTURE_DIR="$("$ADB" exec-out run-as "$APP_ID" ls /data/data/"$APP_ID"/files/captures/ 2>/dev/null | head -1 | tr -d '\r')"
if [ -z "$CAPTURE_DIR" ]; then
  echo "ERROR: No capture directory found under files/captures/ — transcode may not have run." >&2
  exit 1
fi

REMOTE_OPUS="/data/data/${APP_ID}/files/captures/${CAPTURE_DIR}/audio.opus"
LOCAL_OPUS="/tmp/validate-audio.opus"

echo "[validate] pulling ${REMOTE_OPUS} ..."
"$ADB" exec-out run-as "$APP_ID" cat "$REMOTE_OPUS" > "$LOCAL_OPUS"

if [ ! -s "$LOCAL_OPUS" ]; then
  echo "ERROR: Pulled audio.opus is empty." >&2
  exit 1
fi
echo "[validate] audio.opus pulled ($(wc -c < "$LOCAL_OPUS") bytes)."

# ---------------------------------------------------------------------------
# Binary format validation (pure Python3 — no external deps)
# ---------------------------------------------------------------------------
python3 - "$LOCAL_OPUS" <<'PYEOF'
import sys, struct

path = sys.argv[1]
data = open(path, 'rb').read()

# Check 1: non-empty
if len(data) == 0:
    sys.exit("FAIL: audio.opus is empty")

# Check 2: Ogg magic at offset 0
if data[:4] != b'OggS':
    sys.exit(f"FAIL: Missing Ogg magic 'OggS' — got {data[:4]!r}")
print("PASS: Ogg magic 'OggS' found.")

# Check 3: OpusHead header present in first 512 bytes
OPUS_HEAD = b'OpusHead'
pos = data.find(OPUS_HEAD, 0, 512)
if pos == -1:
    sys.exit("FAIL: 'OpusHead' not found in first 512 bytes")
print(f"PASS: 'OpusHead' found at offset {pos}.")

# The OpusHead packet structure (RFC 7845 §5.1):
#   offset 0  : 8 bytes  — magic "OpusHead"
#   offset 8  : 1 byte   — version (must be 1)
#   offset 9  : 1 byte   — channel count
#   offset 10 : 2 bytes  — pre-skip (LE)
#   offset 12 : 4 bytes  — input sample rate (LE)
#   offset 16 : 2 bytes  — output gain (LE)
#   offset 18 : 1 byte   — channel mapping family
payload = data[pos:]  # slice from the magic

if len(payload) < 19:
    sys.exit(f"FAIL: OpusHead payload too short ({len(payload)} bytes)")

# Check 4: channel count == 1 (mono)
channels = payload[8]
if channels != 1:
    sys.exit(f"FAIL: OpusHead channel count == {channels}, expected 1 (mono)")
print(f"PASS: OpusHead channel count == {channels} (mono).")

# Check 5: input sample rate == 16000
input_rate = struct.unpack_from('<I', payload, 12)[0]
if input_rate != 16000:
    sys.exit(f"FAIL: OpusHead input sample rate == {input_rate}, expected 16000")
print(f"PASS: OpusHead input sample rate == {input_rate} Hz.")

print("ALL CHECKS PASSED — audio.opus is 16 kHz mono Ogg-Opus.")
PYEOF

REMOTE
