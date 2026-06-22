export const meta = {
  name: 'build-phone-shell',
  description: 'Build the Minutist Android companion shell via a plan -> (build -> test -> review) loop with heterogeneous models, plus the iroh-blobs FFI cross-compile spike and the device-spike evidence request',
  phases: [
    { title: 'Plan', detail: 'Opus decomposes the shell into an ordered task list', model: 'opus' },
    { title: 'Spike', detail: 'attempt the iroh-blobs aarch64-linux-android cross-compile; emit the device-recording spike as a manual evidence request' },
    { title: 'Build', detail: 'per task: Sonnet builds -> Haiku runs the headless gate -> Opus reviews -> commit on green+approved' },
  ],
}

const REPO = '/mnt/bulk/nas/projects/minutist-mobile'
const IMAGE = 'minutist/android-build:local'
const MAX_ATTEMPTS = 3

// The headless gate the Test role runs. JS legs always; the Android assemble
// only once the Capacitor android/ project exists. No device, no emulator.
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
    ${IMAGE} bash -lc 'cd android && ./gradlew --no-daemon assembleDebug'
fi`

const SHARED = `Repo: ${REPO} (the Minutist Android phone companion — a THIN capture+view client; the phone runs NO machine learning).
Read architecture/README.md, architecture/system-context.md, architecture/components.md, and README.md first — they are binding.
Hard constraints for this build:
- LEAN capture surface, NOT the full desktop Tiptap editor. Reuse the desktop design tokens in src/styles/theme.css (the "Editorial Ink" theme: Fraunces/Newsreader, warm-paper palette, oxblood accent) — reference the CSS variables only, never hard-code colours/fonts.
- Audio capture goes through the native recorder plugin (@capgo/capacitor-audio-recorder, MPL-2.0). Output is AAC; the phone NEVER encodes Opus. Android needs a foreground service (microphone service type) + manifest permissions (RECORD_AUDIO, FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE, WAKE_LOCK) for screen-off long recording. The plugin does NOT create the service — it is our code.
- Sync is STUBBED for now: define the typed TS interface the UI calls (pair, myTicket, syncMeeting, captured-but-unprocessed state, read-only synced data) with a mock/no-op implementation. Do NOT implement real iroh/native sync — that is gated on the FFI spike + desktop-Rust work tracked in the planning issue 0016. Mark the stub clearly.
- Capacitor 8, React + Vite + TS. Keep the gate green: npm run lint, npm run typecheck, npm test, npm run build (and the Android assemble once android/ exists) must all pass.`

const TASKS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          intent: { type: 'string', description: 'what to build and why, concrete' },
          files: { type: 'array', items: { type: 'string' }, description: 'expected files touched' },
          acceptance: { type: 'string', description: 'how Test/Review confirm it is done' },
        },
        required: ['id', 'title', 'intent', 'acceptance'],
      },
    },
  },
  required: ['tasks'],
}

const GATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    steps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' },
          ok: { type: 'boolean' },
          log: { type: 'string', description: 'tail of output for a failing step; empty if ok' },
        },
        required: ['name', 'ok'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['pass', 'steps', 'summary'],
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    approved: { type: 'boolean' },
    blocking: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } },
        required: ['issue', 'fix'],
      },
    },
    nonblocking: { type: 'array', items: { type: 'string' } },
  },
  required: ['approved', 'blocking'],
}

const SPIKE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['go', 'no-go', 'blocked'] },
    detail: { type: 'string' },
    evidence: { type: 'string', description: 'commands run + their relevant output' },
    next: { type: 'string', description: 'the concrete next step to fully de-risk' },
  },
  required: ['verdict', 'detail', 'next'],
}

// ---- Plan -----------------------------------------------------------------
phase('Plan')
const plan = await agent(
  `${SHARED}

ROLE: Planner. Decompose ONLY the phone SHELL into an ordered, dependency-respecting task list a build agent can execute one at a time. Scope: a buildable Capacitor 8 app with the android/ project generated, a lean capture surface (record control + timer/status, quick-notes, a read-only synced-meeting viewer using mock data), the native recorder plugin + Android foreground service wired (compiles; device-validated later), and a STUBBED sync interface. Each task must leave the gate green. Keep it to roughly 6-9 tasks. Do not include real iroh/native sync, release signing, or device tests — those are out of scope here.`,
  { model: 'opus', phase: 'Plan', schema: TASKS_SCHEMA },
)
log(`Planned ${plan.tasks.length} tasks: ${plan.tasks.map((t) => t.id).join(', ')}`)

// ---- Spike ----------------------------------------------------------------
phase('Spike')
const ffiSpike = await agent(
  `${SHARED}

ROLE: De-risking spike (the load-bearing sync unknown). The phone reuses the desktop Rust sync by compiling it to an Android native lib. Upstream iroh-ffi exposes core iroh on Android but NOT iroh-blobs — and the media-blob path (crates/sync/src/blobs.rs in the app repo at /mnt/bulk/nas/projects/minutist) is what carries the captured audio. Determine whether the iroh-blobs stack can cross-compile to aarch64-linux-android via a custom UniFFI crate.
Attempt a minimal proof on THIS host: install the rust target (rustup target add aarch64-linux-android), create a throwaway crate that depends on iroh-blobs 0.103 (+ its redb-backed FsStore), and try to cargo build --target aarch64-linux-android. You will likely hit a missing Android NDK / linker — report exactly what blocks, whether the pure-Rust deps (redb) compile, and the concrete toolchain needed (NDK version, linker config, cargo-ndk). Do NOT modify the app repo or this repo. Report a go/no-go/blocked verdict with the commands you ran and their output, and the next step to fully prove it.`,
  { model: 'opus', phase: 'Spike', schema: SPIKE_SCHEMA },
)
log(`iroh-blobs Android FFI spike: ${ffiSpike.verdict} — ${ffiSpike.detail.slice(0, 160)}`)
log('DEVICE SPIKE (manual, cannot be automated): run a real 60-min locked-screen + Doze recording on a low-end Android and a current iPhone, including an incoming call mid-session, before the recorder plugin choice is locked. This is the make-or-break acceptance the loop cannot self-run.')

// ---- Build / Test / Review loop -------------------------------------------
phase('Build')
const results = []
let halted = null
for (const task of plan.tasks) {
  let attempt = 0
  let feedback = ''
  let outcome = null
  while (attempt < MAX_ATTEMPTS) {
    attempt++
    await agent(
      `${SHARED}

ROLE: Builder. Implement EXACTLY this one task in the working tree (do not start later tasks). Run any needed npm installs / npx cap commands yourself. Leave the gate green.
TASK ${task.id}: ${task.title}
INTENT: ${task.intent}
ACCEPTANCE: ${task.acceptance}
${feedback ? `\nThe previous attempt FAILED. Fix this and do not regress:\n${feedback}` : ''}
Do NOT git commit — a separate step commits after review. Return a short note of what you changed.`,
      { model: 'sonnet', phase: 'Build', label: `build:${task.id}#${attempt}` },
    )

    const gate = await agent(
      `${SHARED}

ROLE: Test runner. Run the headless gate below verbatim in a bash shell and report each step's pass/fail with the tail of output for any failure. Do not fix anything; just run and report. First run may download Gradle/SDK deps — allow it time.
GATE:
${GATE}`,
      { model: 'haiku', phase: 'Build', label: `test:${task.id}#${attempt}`, schema: GATE_SCHEMA },
    )

    if (!gate.pass) {
      feedback = `Gate failed. ${gate.summary}\n` + gate.steps.filter((s) => !s.ok).map((s) => `[${s.name}] ${s.log || ''}`).join('\n')
      outcome = { task: task.id, attempt, stage: 'test', pass: false, detail: gate.summary }
      continue
    }

    const review = await agent(
      `${SHARED}

ROLE: Reviewer. Review the uncommitted working-tree diff for task ${task.id} (${task.title}). Run \`cd ${REPO} && git --no-pager diff\` and inspect the changed files. Judge against the architecture docs and the task acceptance. Flag as BLOCKING only real defects: thin-client boundary violations (any ML/Opus-encode on the phone; a real-sync implementation slipping in where a stub was required), hard-coded colours/fonts instead of theme tokens, a missing/incorrect Android foreground-service config for the recorder, broken types, or acceptance not met. Style nits are non-blocking.`,
      { model: 'opus', phase: 'Build', label: `review:${task.id}#${attempt}`, agentType: 'principal-code-reviewer', schema: REVIEW_SCHEMA },
    )

    if (!review.approved && review.blocking.length) {
      feedback = `Review blocking findings:\n` + review.blocking.map((b) => `- ${b.file || ''}: ${b.issue} -> ${b.fix}`).join('\n')
      outcome = { task: task.id, attempt, stage: 'review', pass: false, detail: review.blocking.map((b) => b.issue).join('; ') }
      continue
    }

    await agent(
      `Commit the current working-tree changes in ${REPO} for this completed task. Run: cd ${REPO} && git add -A && git commit -m "$MSG" where MSG is a factual, conservative subject describing what the task added (no journey narration, no Claude/AI attribution). Task: ${task.title} (${task.id}). Return the commit hash.`,
      { model: 'haiku', phase: 'Build', label: `commit:${task.id}` },
    )
    outcome = { task: task.id, attempt, stage: 'done', pass: true, nonblocking: review.nonblocking || [] }
    break
  }
  results.push(outcome)
  if (!outcome.pass) { halted = task.id; log(`Task ${task.id} exhausted ${MAX_ATTEMPTS} attempts — halting the loop for human inspection.`); break }
  log(`Task ${task.id} done (attempt ${outcome.attempt}).`)
}

return {
  planned: plan.tasks.map((t) => ({ id: t.id, title: t.title })),
  ffiSpike,
  results,
  halted,
  deviceSpike: 'MANUAL: 60-min locked-screen + Doze recording on a real low-end Android + current iPhone, incl. mid-session call. Blocks locking the recorder/Capacitor choice.',
}
