export const meta = {
  name: 'add-kvm-free-tests',
  description: 'Add the KVM-free automated test layer to minutist-mobile: Robolectric native-unit tests for the foreground service (JVM, no emulator), the recorder teardown + notification-permission robustness fixes, and vitest gap-fill — wired into the build gate',
  phases: [
    { title: 'Build', detail: 'per task: Sonnet builds -> Haiku runs the gate (now incl. testDebugUnitTest) -> Opus reviews -> commit' },
  ],
}

const REPO = '/mnt/bulk/nas/projects/minutist-mobile'
const IMAGE = 'minutist/android-build:local'
const MAX_ATTEMPTS = 3

// Gate now also runs the Android JVM unit tests (Robolectric) — testDebugUnitTest
// needs NO emulator/KVM, so it runs in the same headless docker gradle step.
const GATE = `cd ${REPO}
set -o pipefail
npm ci
npm run lint
npm run typecheck
npm test
npm run build
if [ -d android ]; then
  npx cap sync android
  mkdir -p "$HOME/.gradle-mm"
  docker run --rm -v "${REPO}:${REPO}" -w "${REPO}" \
    -v "$HOME/.gradle-mm:/gradle-home" \
    -e GRADLE_USER_HOME=/gradle-home -e HOME=/tmp \
    --user "$(id -u):$(id -g)" \
    ${IMAGE} bash -lc 'cd android && ./gradlew --no-daemon testDebugUnitTest assembleDebug'
fi`

const SHARED = `Repo: ${REPO} — the Minutist Android phone companion (thin capture+view client, NO on-device ML). The app shell is already built (capture UI, recorder facade src/capture/recorder.ts, Android foreground service android/app/src/main/java/ai/minutist/companion/RecordingForegroundService.kt + RecordingForegroundServicePlugin.kt, stubbed sync src/sync/, views in src/views/). Read architecture/components.md + the relevant existing files before editing.
This work adds the KVM-FREE automated test layer (this host has no KVM, so no emulator). Two test runners, both emulator-free:
- vitest (webview/TS, jsdom) — already present.
- Robolectric (Android-native unit, runs on the JVM via ./gradlew testDebugUnitTest) — to be added.
Constraints: keep the gate green (npm lint/typecheck/test/build + the docker gradle testDebugUnitTest+assembleDebug). Do NOT introduce any emulator/instrumented (connectedAndroidTest) tests — those need KVM and are out of scope. No thin-client violations (no ML/Opus-encode). Theme tokens only in any UI.
Your return value is a short markdown note of what changed; the orchestrator consumes it.`

const GATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { name: { type: 'string' }, ok: { type: 'boolean' }, log: { type: 'string' } }, required: ['name', 'ok'] } },
    summary: { type: 'string' },
  },
  required: ['pass', 'steps', 'summary'],
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    approved: { type: 'boolean' },
    blocking: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } }, required: ['issue', 'fix'] } },
    nonblocking: { type: 'array', items: { type: 'string' } },
  },
  required: ['approved', 'blocking'],
}

const TASKS = [
  {
    id: 'K1',
    title: 'Robolectric harness + RecordingForegroundService native-unit tests',
    intent: `Add Robolectric to the android/ Gradle project and write JVM unit tests (android/app/src/test/java/ai/minutist/companion/) for RecordingForegroundService and its plugin. Pick a Robolectric version compatible with the project's AGP/compileSdk (Robolectric >= 4.14 for SDK 35/36); add testImplementation deps (robolectric, androidx.test:core, junit) and testOptions { unitTests { isIncludeAndroidResources = true; isReturnDefaultValues = true } } in app/build.gradle. Tests must assert: the service goes to the foreground with foregroundServiceType microphone and an ongoing notification; the PARTIAL_WAKE_LOCK is acquired on start and released on stop; acquiring is idempotent (a redelivered start does not orphan a prior wake lock — add an "if (wakeLock == null)" guard or release-first if missing); the service stops cleanly. These run via ./gradlew testDebugUnitTest with NO emulator.`,
    acceptance: 'testDebugUnitTest runs Robolectric tests green in the docker gate; the wake-lock idempotency guard exists in RecordingForegroundService.kt.',
  },
  {
    id: 'K2',
    title: 'Recorder teardown-on-error + POST_NOTIFICATIONS runtime request, with vitest coverage',
    intent: `Fix the two robustness gaps the prior review flagged, with vitest tests: (1) src/capture/recorder.ts stop() must tear down the foreground service + wake lock even if the plugin stopRecording() throws (wrap so the controller teardown runs in a finally); symmetrically guard start() so a failed startRecording() does not leave the service up. Add a vitest test that makes stopRecording() reject and asserts the controller teardown still ran. (2) Request POST_NOTIFICATIONS at runtime on Android 13+ alongside the RECORD_AUDIO prompt (in the capture flow) so the ongoing notification is not silently suppressed. Also add the missing vitest coverage the review noted: the App sync-status pill rendering per SyncStatus.kind, and the recorder listener early-unsubscribe semantics.`,
    acceptance: 'vitest covers teardown-on-error and the status pill; recorder.ts has finally-based teardown; POST_NOTIFICATIONS requested at runtime; gate green.',
  },
  {
    id: 'K3',
    title: 'Wire testDebugUnitTest into CI + document the test layers',
    intent: `Add ./gradlew testDebugUnitTest to the android job in .github/workflows/ci.yml (before/with assembleDebug). Document the KVM-free test layers in docs/BUILD.md (vitest = webview unit; Robolectric testDebugUnitTest = native unit, no emulator) and note that the Maestro flow tests + Espresso/forced-Doze instrumented tests are a separate emulator lane that needs KVM (not on this host yet). Update README test bullet accordingly. No behaviour change.`,
    acceptance: 'CI android job runs testDebugUnitTest; docs/BUILD.md + README describe the KVM-free vs emulator lanes; gate green.',
  },
]

phase('Build')
const results = []
let halted = null
for (const task of TASKS) {
  let attempt = 0, feedback = '', outcome = null
  while (attempt < MAX_ATTEMPTS) {
    attempt++
    await agent(
      `${SHARED}

ROLE: Builder. Implement EXACTLY this one task in the working tree. Run needed npm/gradle commands yourself; leave the gate green. Do NOT git commit (a later step commits).
TASK ${task.id}: ${task.title}
INTENT: ${task.intent}
ACCEPTANCE: ${task.acceptance}
${feedback ? `\nPrevious attempt FAILED — fix and do not regress:\n${feedback}` : ''}`,
      { model: 'sonnet', phase: 'Build', label: `build:${task.id}#${attempt}` },
    )

    const gate = await agent(
      `${SHARED}

ROLE: Test runner. Run this gate verbatim and report each step's pass/fail with the tail of output for failures. Do not fix anything. First Robolectric run downloads its android-all jars — allow time.
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

ROLE: Reviewer. Review the uncommitted diff for task ${task.id} (run \`cd ${REPO} && git --no-pager diff\`). BLOCKING only for: a test that needs an emulator/connectedAndroidTest (out of scope — must be JVM/Robolectric or vitest), thin-client violations, the robustness fix not actually wired (e.g. teardown not in finally; wake lock still non-idempotent), acceptance unmet, or broken types. Style nits are non-blocking.`,
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
