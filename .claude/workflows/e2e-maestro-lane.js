export const meta = {
  name: 'e2e-maestro-lane',
  description: 'Add a portable Maestro E2E lane to minutist-mobile (flows + an env-parameterised runner that builds the APK on Telie and executes flows on the step emulator), author a real flow set, and clean up the flagged nits — each flow verified by actually running on the step AVD',
  phases: [
    { title: 'Build', detail: 'per task: Sonnet builds -> Haiku runs the gate (unit gate, or the e2e gate that executes flows on step) -> Opus reviews -> commit' },
  ],
}

const REPO = '/mnt/bulk/nas/projects/minutist-mobile'
const IMAGE = 'minutist/android-build:local'
const MAX_ATTEMPTS = 3

// Build the debug APK headless in the docker image (host has no Android SDK).
const BUILD_APK = `cd ${REPO}
npm ci
npm run build
npx cap sync android
mkdir -p "$HOME/.gradle-mm"
docker run --rm -v "${REPO}:${REPO}" -w "${REPO}" \
  -v "$HOME/.gradle-mm:/gradle-home" -e GRADLE_USER_HOME=/gradle-home -e HOME=/tmp \
  --user "$(id -u):$(id -g)" \
  ${IMAGE} bash -lc 'cd android && ./gradlew --no-daemon assembleDebug'`

// Unit gate: JS + Robolectric, no emulator.
const UNIT_GATE = `cd ${REPO}
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
  ${IMAGE} bash -lc 'cd android && ./gradlew --no-daemon testDebugUnitTest assembleDebug'`

// E2E gate: JS gate green, build the APK, then run the repo's portable runner,
// which scps the APK + flows to the step host and executes them on the AVD.
const E2E_GATE = `cd ${REPO}
set -o pipefail
npm run lint
npm run typecheck
npm test
${BUILD_APK}
STEP_HOST=step APK="${REPO}/android/app/build/outputs/apk/debug/app-debug.apk" bash ${REPO}/e2e/run-on-step.sh`

const STEP_FACTS = `The emulator host is the ssh host \`step\` (WSL2 on Win11). It already has a provisioned lane: ~/minutist-emulator/run-emulator-tests.sh <apk> <flows-dir> boots a headless KVM AVD (minutist-test), installs the APK, runs every Maestro flow in the dir, and tears the emulator down (exit code = Maestro's). env on step is in ~/minutist-emulator/env.sh (JDK21 + SDK + maestro on PATH). \`ssh step\` lands in WSL2 bash; key auth is non-interactive. Only ONE emulator can run at a time — never run flows concurrently.`

const SHARED = `Repo: ${REPO} — the Minutist Android phone companion (thin capture+view client, NO on-device ML). The app shell exists: src/views/CaptureView.tsx (record control, timer, VU, quick-notes <textarea>), src/views/MeetingsView.tsx (meeting list, Sync action, pairing panel, read-only detail), src/App.tsx (Capture/Meetings tab bar, navigates to Meetings after stop, sync-status pill), src/sync/mock.ts (MockSyncClient: registerCaptured/saveCaptured -> captured-unprocessed, sync -> synced), src/capture/recorder.ts (facade over @capgo/capacitor-audio-recorder). appId is ai.minutist.companion, main activity ai.minutist.companion.MainActivity.
${STEP_FACTS}
Maestro notes: the UI is a webview — Maestro assertVisible/tapOn match the VISIBLE webview text (native uiautomator hierarchy is opaque), so target visible text labels. Handle the RECORD_AUDIO runtime permission dialog (use launchApp { permissions } to pre-grant where the flow is not about the grant itself, and a dedicated flow that taps Record and accepts the system dialog for the grant path). The emulator's mic is virtual (silent) — the record flow should assert UI STATE transitions (status/label/timer change on start, return to a stopped/handed-off state on stop), not audio content; if recording genuinely cannot start on the emulator, report it as a finding rather than masking it.
Constraints: keep all gates green; no thin-client violations; theme tokens only. Return a short markdown note of what changed.`

const GATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  pass: { type: 'boolean' },
  steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, ok: { type: 'boolean' }, log: { type: 'string' } }, required: ['name', 'ok'] } },
  summary: { type: 'string' } }, required: ['pass', 'steps', 'summary'] }
const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  approved: { type: 'boolean' },
  blocking: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } }, required: ['issue', 'fix'] } },
  nonblocking: { type: 'array', items: { type: 'string' } } }, required: ['approved', 'blocking'] }

const TASKS = [
  {
    id: 'E0', kind: 'unit',
    title: 'Cleanup: drop dead scaffold tests, align the BUILD.md docker snippet, tidy recorder.ts',
    intent: `Remove the dead Capacitor scaffold tests so the "no instrumented tests in CI" boundary is unambiguous: delete android/app/src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java and android/app/src/androidTest/**/ExampleInstrumentedTest.java (if present). In docs/BUILD.md, change the "Android native unit tests" docker snippet to use the SAME gradle-home mount the gate and CI use: -v "$HOME/.gradle-mm:/gradle-home" -e GRADLE_USER_HOME=/gradle-home -e HOME=/tmp, and run only the gradle step in docker (npm/build/cap-sync on host) to match. Tidy src/capture/recorder.ts stop() to drop the result! non-null assertions (assign and return inside the try after the URI check, keep onAfterStop() in finally). Add the missing trailing newline to android/variables.gradle. No behaviour change.`,
    acceptance: 'Dead Example tests gone; BUILD.md snippet matches the gate mount; recorder.ts has no result! assertions; unit gate green.',
  },
  {
    id: 'E1', kind: 'e2e',
    title: 'Portable Maestro lane: env-parameterised runner + a real flow set, executed on step',
    intent: `Create e2e/run-on-step.sh (runs on Telie, env-parameterised, NO machine-specific absolute paths): reads STEP_HOST (default "step") and APK (default ${REPO}/android/app/build/outputs/apk/debug/app-debug.apk; if absent, build it via the docker image incantation in this repo's docs); scps the APK to step:~/minutist-app-debug.apk; syncs this repo's e2e/flows/ to step (e.g. rsync/scp into ~/minutist-emulator/flows-repo, clearing it first); then runs ssh "$STEP_HOST" '~/minutist-emulator/run-emulator-tests.sh ~/minutist-app-debug.apk ~/minutist-emulator/flows-repo' and propagates its exit code. Keep it set -euo pipefail and CI-friendly.
Author e2e/flows/ as Maestro YAML, reading the actual UI labels/state from src/views/*.tsx + src/sync/mock.ts + src/App.tsx so assertions match reality:
  - smoke.yaml: launchApp + assertVisible "Minutist".
  - navigation.yaml: tap "Meetings" tab -> assert the Meetings view (its empty-state/list text) -> tap "Capture" -> assertVisible "Record".
  - notes.yaml: tap the quick-notes field, inputText some text, assertVisible that text.
  - record.yaml: pre-grant or accept RECORD_AUDIO, tap "Record", assert the UI enters a recording state (status/label/timer), then stop, assert it returns to a stopped/handed-off state (per App.tsx this navigates to Meetings and a captured-unprocessed item appears).
  - synced-viewer.yaml: from a captured-unprocessed meeting in Meetings, trigger the mock Sync action, assert it becomes synced, open its detail, assert the read-only transcript/summary text is visible.
Add e2e/README.md documenting the lane (how to run from Telie, that it needs the step host provisioned, the one-liner). The flows MUST actually pass on the step AVD — the gate runs them there.`,
    acceptance: 'e2e/run-on-step.sh + e2e/flows/{smoke,navigation,notes,record,synced-viewer}.yaml + e2e/README.md exist; all flows PASS on the step emulator via the e2e gate; the runner has no machine-specific hardcoded paths.',
  },
]

phase('Build')
const results = []
let halted = null
for (const task of TASKS) {
  const GATE = task.kind === 'e2e' ? E2E_GATE : UNIT_GATE
  let attempt = 0, feedback = '', outcome = null
  while (attempt < MAX_ATTEMPTS) {
    attempt++
    await agent(
      `${SHARED}

ROLE: Builder. Implement EXACTLY this task in the working tree. Run needed npm/gradle/ssh commands yourself; leave the gate green. Do NOT git commit.
TASK ${task.id}: ${task.title}
INTENT: ${task.intent}
ACCEPTANCE: ${task.acceptance}
${feedback ? `\nPrevious attempt FAILED — fix and do not regress:\n${feedback}` : ''}`,
      { model: 'sonnet', phase: 'Build', label: `build:${task.id}#${attempt}` },
    )
    const gate = await agent(
      `${SHARED}

ROLE: Test runner. Run this gate verbatim and report each step's pass/fail with the tail of output for failures. Do not fix anything. ${task.kind === 'e2e' ? 'The e2e gate boots a real emulator on the step host and runs Maestro flows — allow several minutes; report the Maestro flow results (which flows passed/failed and why).' : 'First Robolectric run may download its android-all jar — allow time.'}
GATE:
${GATE}`,
      { model: 'haiku', phase: 'Build', label: `test:${task.id}#${attempt}`, schema: GATE_SCHEMA },
    )
    if (!gate.pass) {
      feedback = `Gate failed. ${gate.summary}\n` + gate.steps.filter((s) => !s.ok).map((s) => `[${s.name}] ${s.log || ''}`).join('\n')
      outcome = { task: task.id, attempt, pass: false, stage: 'test', detail: gate.summary }
      continue
    }
    const review = await agent(
      `${SHARED}

ROLE: Reviewer. Review the uncommitted diff for task ${task.id} (run \`cd ${REPO} && git --no-pager diff\` and inspect new files). BLOCKING only for: machine-specific hardcoded paths in the runner (must be env-parameterised), flows that assert nothing meaningful or were not actually executed, thin-client violations, broken types, or acceptance unmet. Style nits are non-blocking.`,
      { model: 'opus', phase: 'Build', label: `review:${task.id}#${attempt}`, agentType: 'principal-code-reviewer', schema: REVIEW_SCHEMA },
    )
    if (!review.approved && review.blocking.length) {
      feedback = 'Review blocking:\n' + review.blocking.map((b) => `- ${b.file || ''}: ${b.issue} -> ${b.fix}`).join('\n')
      outcome = { task: task.id, attempt, pass: false, stage: 'review', detail: review.blocking.map((b) => b.issue).join('; ') }
      continue
    }
    await agent(
      `Commit the working-tree changes in ${REPO} for this task: cd ${REPO} && git add -A && git commit -m "$MSG" with a factual subject (no journey narration, no AI attribution). Task: ${task.title} (${task.id}). Return the commit hash.`,
      { model: 'haiku', phase: 'Build', label: `commit:${task.id}` },
    )
    outcome = { task: task.id, attempt, pass: true, stage: 'done', nonblocking: review.nonblocking || [] }
    break
  }
  results.push(outcome)
  if (!outcome.pass) { halted = task.id; log(`Task ${task.id} exhausted ${MAX_ATTEMPTS} attempts — halting.`); break }
  log(`Task ${task.id} done (attempt ${outcome.attempt}).`)
}
return { results, halted }
