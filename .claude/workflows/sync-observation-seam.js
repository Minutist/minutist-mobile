export const meta = {
  name: 'sync-observation-seam',
  description: 'Add an onMeetingsChanged observation seam to SyncClient so the meeting list updates reactively (not via manual refresh) — shaping the contract for the real device-to-device case while the mock is the only implementer; verify unit + Robolectric + the 5 step emulator flows',
  phases: [{ title: 'Build', detail: 'Sonnet builds -> Haiku runs unit+Robolectric+emulator flows -> Opus reviews the contract shape -> loop until green+approved' }],
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
STEP_HOST=step APK="${REPO}/android/app/build/outputs/apk/debug/app-debug.apk" bash ${REPO}/e2e/run-on-step.sh`

const SHARED = `Repo: ${REPO} — the Minutist Android phone companion (thin capture+view client, NO ML). Sync is a typed STUB (src/sync/{index.ts,types.ts,mock.ts,useSync.ts}); the real client is a future native plugin gated on desktop-Rust work. Read those files + src/views/MeetingsView.tsx + its tests first.

THE CHANGE — add an observation seam to the SyncClient contract so the meeting list updates reactively, mirroring the existing onStatus subscription. This is the right shape for the eventual DEVICE-TO-DEVICE case: a real sync receives meeting updates the phone did not initiate (the desktop finishes processing meeting A while you record meeting B; the captured→synced transition arrives later, unsolicited, over the wire). The current contract is shaped around the mock's synchronous echo (syncMeeting mutates the local list to synced and resolves, and MeetingsView does \`await syncMeeting; refreshMeetings()\`), which the real client cannot honour.

Implement:
1. src/sync/index.ts (+ types.ts as needed): add to the SyncClient interface
   \`onMeetingsChanged(cb: (meetings: Meeting[]) => void): () => void\`
   — a subscription returning an unsubscribe, exactly like onStatus. listMeetings() stays as the initial-snapshot read. Document that syncMeeting() now means only "begin pushing"; the captured→synced transition is delivered through onMeetingsChanged, not by syncMeeting's resolution.
2. src/sync/mock.ts: maintain a Set of meeting-change subscribers; add a private emitMeetings() that notifies them with a fresh snapshot ([...this.meetings]); call it after every mutation (saveCaptured, syncMeeting's local echo-to-synced, registerCaptured). Implement onMeetingsChanged. Keep the existing behaviour observable (the mock may still echo synchronously) but route the list update through the subscription so the contract — not the mock's timing — is what the UI depends on.
3. src/views/MeetingsView.tsx: on mount, seed from listMeetings() AND subscribe via onMeetingsChanged (unsubscribe on unmount); drop the manual refreshMeetings() choreography — handleSyncNow just calls syncMeeting() and lets the subscription update the list. Keep the loading state sensible.
4. Update tests: src/sync/mock.test.ts (assert onMeetingsChanged fires on saveCaptured + syncMeeting and that unsubscribe stops it), and src/views/MeetingsView.test.tsx / src/App.integration.test.tsx (the sync-now path now reflects via the subscription rather than an awaited refresh). Do not weaken assertions to pass — adapt them to the reactive model.

Do NOT change anything else (no recorder/UI/CSS changes; do not touch the dead recorder event surface — that is a separate decision). Keep the gate green. Do NOT git commit — leave the tree for the orchestrator.`

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
    `${SHARED}\n\nROLE: Builder. Implement the change. Run needed commands yourself; leave the gate green. Do NOT commit.${feedback ? `\n\nPrevious attempt FAILED — fix and do not regress:\n${feedback}` : ''}`,
    { model: 'sonnet', phase: 'Build', label: `build#${attempt}` },
  )
  const gate = await agent(
    `${SHARED}\n\nROLE: Test runner. Run this gate verbatim and report each step's pass/fail with the tail of output for failures. Do not fix anything. The e2e step boots a real emulator on the step host and runs 5 Maestro flows — allow several minutes.\nGATE:\n${GATE}`,
    { model: 'haiku', phase: 'Build', label: `test#${attempt}`, schema: GATE_SCHEMA },
  )
  if (!gate.pass) {
    feedback = `Gate failed. ${gate.summary}\n` + gate.steps.filter((s) => !s.ok).map((s) => `[${s.name}] ${s.log || ''}`).join('\n')
    outcome = { attempt, pass: false, stage: 'test', detail: gate.summary }
    continue
  }
  const review = await agent(
    `${SHARED}\n\nROLE: Reviewer. Review the uncommitted diff (run \`cd ${REPO} && git --no-pager diff\` + inspect new code). The point of this change is contract SHAPE. BLOCKING if: the contract still forces the UI to depend on syncMeeting's resolution for the list update (the seam isn't actually used), onMeetingsChanged leaks mock-only timing semantics into the interface contract/docs, the subscription isn't unsubscribed on unmount (leak), MeetingsView still does manual refresh after sync, a test was weakened rather than adapted, or types/gate break. Confirm the interface reads as something a real device-to-device client can implement (updates arrive unsolicited). Style nits are non-blocking.`,
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
log(outcome.pass ? `Seam landed (attempt ${outcome.attempt}).` : `Halted after ${MAX_ATTEMPTS} attempts: ${outcome.detail}`)
return { outcome }
