export const meta = {
  name: 'aac-to-opus-transcode',
  description: 'Implement on-phone AAC->16kHz-mono-Ogg-Opus transcode (so the desktop audio.opus ingest invariant is preserved with no Rust/sync change), wired into the capture-stop flow; verify the produced audio.opus on the step emulator',
  phases: [{ title: 'Build', detail: 'Sonnet builds the native transcoder -> Haiku runs gate + on-emulator opus validation -> Opus reviews -> loop' }],
}

const REPO = '/mnt/bulk/nas/projects/minutist-mobile'
const IMAGE = 'minutist/android-build:local'
const MAX_ATTEMPTS = 3

const GATE = `cd ${REPO}
set -o pipefail
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npx cap sync android
mkdir -p "$HOME/.gradle-mm"
docker run --rm -v "${REPO}:${REPO}" -w "${REPO}" \
  -v "$HOME/.gradle-mm:/gradle-home" -e GRADLE_USER_HOME=/gradle-home -e HOME=/tmp \
  --user "$(id -u):$(id -g)" \
  ${IMAGE} bash -lc 'cd android && ./gradlew --no-daemon testDebugUnitTest assembleDebug'
# On-emulator verification of the actual transcode output:
STEP_HOST=step APK="${REPO}/android/app/build/outputs/apk/debug/app-debug.apk" bash ${REPO}/e2e/validate-transcode-on-step.sh`

const SHARED = `Repo: ${REPO} — the Minutist Android phone companion (Capacitor 8 + React/Vite; native Android in android/app/src/main/java/ai/minutist/companion/). The phone records meeting audio via @capgo/capacitor-audio-recorder, which produces AAC/M4A. The DESKTOP pipeline ingests "audio.opus" — specifically 16 kHz MONO Ogg-Opus (the desktop reader uses the ogg crate; the architecture mandates 16 kHz mono uniformly). So the phone must TRANSCODE its captured AAC to 16 kHz mono Ogg-Opus before that file is handed to sync — this keeps the desktop's audio.opus invariant intact with ZERO Rust/sync/persistence change.

THE TASK
1. Add an Android AAC->Opus transcoder (Kotlin, in android/app/src/main/java/ai/minutist/companion/): MediaExtractor + MediaCodec to decode the captured AAC/M4A to PCM, resample to 16 kHz MONO (downmix stereo->mono + sample-rate convert), MediaCodec Opus encoder, MediaMuxer with OUTPUT_FORMAT_OGG to write a valid Ogg-Opus "audio.opus". (Ogg-Opus via MediaMuxer + Opus encoder needs API 29+; the app minSdk is 24 — guard the transcode for API 29+ and document that pre-29 falls back to shipping AAC for the desktop to transcode, OR require 29+ for the feature; pick one, state it, keep the build green at minSdk 24.) Expose it via a Capacitor plugin method or a native call the capture flow can invoke.
2. Wire it into the capture-stop path: when a recording stops, transcode the AAC to a 16 kHz mono Ogg-Opus "audio.opus" written to a deterministic, adb-pullable app location (e.g. the app files dir under a per-capture folder). The CapturePayload.audioUri the mobile SyncClient/mock receives should point to the audio.opus (not the raw AAC). Keep the existing recorder/foreground-service behaviour intact; do NOT touch the sync stub's contract beyond audioUri now being the opus.
3. Author ${REPO}/e2e/validate-transcode-on-step.sh (runs on the calling host; reaches the emulator via ssh step / the provisioned ~/minutist-emulator lane): build/assemble already done by the gate, so this script: scp the APK to step, boot the minutist-test AVD headless (source ~/minutist-emulator/env.sh; adb uninstall ai.minutist.companion || true; adb install -r), drive a Maestro flow that grants permissions, taps "Start recording", waits ~3s, taps "Stop recording" (reuse the accessibility names from e2e/flows/record.yaml), then pulls the produced audio.opus off the device (debug build → \`adb exec-out run-as ai.minutist.companion cat <path>\` or from external files), and VALIDATES it: non-empty; begins with the Ogg magic "OggS"; contains an "OpusHead" header; OpusHead channel-count byte == 1 (mono); OpusHead input-sample-rate (bytes 12..15 LE of the OpusHead payload) == 16000. Exit non-zero with a clear message if any check fails. Tear down the emulator (adb emu kill) on exit. (The emulator mic is silent, so the audio is silence — that's fine; we're validating the CONTAINER/CODEC/format, not audio content.)

Constraints: keep all gates green; reuse theme tokens; no thin-client violation. Do NOT git commit — leave the tree for the orchestrator. Return a short note of what changed + the chosen minSdk/API-29 handling.`

const GATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  pass: { type: 'boolean' },
  steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, ok: { type: 'boolean' }, log: { type: 'string' } }, required: ['name', 'ok'] } },
  summary: { type: 'string' } }, required: ['pass', 'steps', 'summary'] }
const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  approved: { type: 'boolean' },
  blocking: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } }, required: ['issue', 'fix'] } },
  nonblocking: { type: 'array', items: { type: 'string' } } }, required: ['approved', 'blocking'] }

phase('Build')
let attempt = 0, feedback = '', outcome = null
while (attempt < MAX_ATTEMPTS) {
  attempt++
  await agent(
    `${SHARED}\n\nROLE: Builder. Implement the transcoder + wiring + the validation script. Run needed commands; leave the gate green. Do NOT commit.${feedback ? `\n\nPrevious attempt FAILED — fix and do not regress:\n${feedback}` : ''}`,
    { model: 'sonnet', phase: 'Build', label: `build#${attempt}` },
  )
  const gate = await agent(
    `${SHARED}\n\nROLE: Test runner. Run this gate verbatim; report each step pass/fail with the tail of output for failures. Do not fix. The final step boots a real emulator on step, records, and validates the produced audio.opus is 16 kHz mono Ogg-Opus — allow several minutes; report the validation output (the OggS/OpusHead/channels/sample-rate checks) explicitly.\nGATE:\n${GATE}`,
    { model: 'haiku', phase: 'Build', label: `test#${attempt}`, schema: GATE_SCHEMA },
  )
  if (!gate.pass) {
    feedback = `Gate failed. ${gate.summary}\n` + gate.steps.filter((s) => !s.ok).map((s) => `[${s.name}] ${s.log || ''}`).join('\n')
    outcome = { attempt, pass: false, stage: 'test', detail: gate.summary }
    continue
  }
  const review = await agent(
    `${SHARED}\n\nROLE: Reviewer. Review the uncommitted diff (cd ${REPO} && git --no-pager diff + new files). BLOCKING if: the output isn't actually 16 kHz MONO Ogg-Opus (wrong sample rate, stereo, raw-Opus-not-Ogg), the resample/downmix is missing or wrong, the validation script's checks are fake/weak (must really parse OggS + OpusHead channels + sample rate, not just "file exists"), the transcode blocks the UI thread / leaks the codec, the API-29 guard is missing (build breaks at minSdk 24) or the pre-29 fallback is unstated, a thin-client violation, or types/gate break. Style nits non-blocking.`,
    { model: 'opus', phase: 'Build', label: `review#${attempt}`, agentType: 'principal-code-reviewer', schema: REVIEW_SCHEMA },
  )
  if (!review.approved && review.blocking.length) {
    feedback = 'Review blocking:\n' + review.blocking.map((b) => `- ${b.file || ''}: ${b.issue} -> ${b.fix}`).join('\n')
    outcome = { attempt, pass: false, stage: 'review', detail: review.blocking.map((b) => b.issue).join('; ') }
    continue
  }
  outcome = { attempt, pass: true, stage: 'done', nonblocking: review.nonblocking || [] }
  break
}
log(outcome.pass ? `Transcode landed (attempt ${outcome.attempt}).` : `Halted after ${MAX_ATTEMPTS}: ${outcome.detail}`)
return { outcome }
