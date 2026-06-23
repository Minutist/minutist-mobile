export const meta = {
  name: 'recorder-events-and-design',
  description: 'Wire the recorder plugin events (onStopped/onError) into the capture UI so state reconciles from the source of truth, plus the surfaced phone↔desktop design tweaks; verify unit + Robolectric + the 5 step emulator flows',
  phases: [{ title: 'Build', detail: 'Sonnet builds -> Haiku runs unit+Robolectric+emulator flows -> Opus reviews -> loop until green+approved' }],
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

const SHARED = `Repo: ${REPO} — the Minutist Android phone companion (Capacitor 8 + React/Vite thin client, NO ML). Desktop reference for design values: /mnt/bulk/nas/projects/minutist/ui/src (read shell/MainWindow.css, MeetingList.css, MeetingMasthead.css, SummaryView.css, SyncSettingsPane.tsx, shell/RecordingStatus.tsx, transcript/TranscriptPane.css, styles/theme.css). Read the phone files first: src/App.tsx, src/App.css, src/capture/{recorder.ts, RecorderContext.tsx}, src/views/{CaptureView.tsx, CaptureView.css, MeetingsView.tsx, MeetingsView.css}, and the tests alongside them.

Implement BOTH of the following. Keep every gate green. Behaviour must stay correct (these are improvements, not rewrites). Do NOT git commit — leave the tree for the orchestrator. Reuse theme tokens only — no hard-coded colours/fonts.

=== A. Wire recorder plugin events into the UI (the structural fix) ===
Today CaptureView tracks recording lifecycle purely in its own React state and never observes the plugin's events (recorder.ts exports onRecordingStopped/onRecordingError/onRecordingPaused but nothing consumes them). If the OS or plugin stops/errors recording on its own (interruption, process pressure), the UI stays stuck showing "Recording" — a desync.
- Add onStopped(cb) and onError(cb) to the RecorderFacade (src/capture/RecorderContext.tsx interface + realRecorderFacade) delegating to recorder.ts's onRecordingStopped/onRecordingError. (Inspect the plugin event payload types in recorder.ts / the @capgo plugin to see what each event carries.)
- In CaptureView, subscribe to onStopped + onError (cleanup on unmount). Use a stoppingRef (set true at the start of the user-initiated handleStop, cleared when it completes) so the event handlers DISTINGUISH:
  - USER-initiated stop: handleStop already drives save+teardown+navigate — the onStopped handler must NOT double-handle (no double save).
  - UNSOLICITED stop (stoppingRef is false): reconcile the UI from the event — set status back to inactive, stop the elapsed timer + amplitude poller, run the foreground-service teardown, and surface a brief notice that recording ended unexpectedly (and, if the event carries a usable file + duration, save the captured meeting the same way handleStop would, then navigate).
  - onError (either case): set the error message, reconcile status to inactive, tear down.
- This makes UI state derived from the recorder's source of truth, not a parallel guess. Do not remove the existing handleStop path; the event seam complements it for the unsolicited case.

=== B. Design tweaks (align to the desktop conventions cited) ===
1. (C4) MeetingsView.css .meeting-detail__section-heading: drop the uppercase chrome idiom — make "Summary"/"Transcript" sentence-case Fraunces in --ink (with font-variation-settings), matching desktop SummaryView.css content headings. (Keep uppercase ONLY for genuine micro-labels, not content headings.)
2. (C6) App.css .app-bar__wordmark: colour --accent → --ink, matching desktop .main-window__wordmark (oxblood is reserved for active/rec state, not the resting wordmark).
3. (C7) MeetingsView synced list rows: give the row title --font-display (Fraunces, with font-variation-settings) and render the summary snippet as italic --ink-soft via CSS line-clamp (2 lines) instead of the JS summary.slice(0,100)+'…'. Match the editorial register of desktop MeetingList.css rows. Remove the JS slice.
4. (E1) App.css/App.tsx tab bar: the column layout reserves an icon slot that is never filled (dangling gap, half-finished look). Add a small inline SVG glyph above each label — a filled record dot for "Capture", a short stacked-lines/list glyph for "Meetings" — aria-hidden, currentColor, ~20px, so the accessible name stays exactly "Capture"/"Meetings" (flows + tests depend on those names). Conservative line/solid glyphs in the Editorial-Ink register; no brand logos.
5. (E4+E10) Capture stop feedback: during handleStop's async save window, surface a transient "Saving…" status (the busy flag already exists) before navigating to Meetings, so the tab switch isn't abrupt and unexplained — mirroring desktop's "Finalising…" feedback (RecordingStatus.tsx). Navigate after the save resolves.
6. (E5+E7) Pairing panel dismissal: collapse to ONE affordance — the toolbar toggle ("Pair"/"Done") is the single open/close control; remove the inline ✕ close button (or vice-versa, but only one). On successful pair, auto-close the panel (and reset the toggle to "Pair").
7. (E6) Pairing panel: add a Copy button next to "This device's ticket" (the ticket is currently unselectable mono text), mirroring desktop SyncSettingsPane.tsx's Copy affordance (navigator.clipboard.writeText with a brief "Copied" confirmation).
8. (E8) App.tsx status pill vocabulary: stop saying "Paired" (it collides with the "Pair"/"Done" pairing control). Use desktop's vocabulary — map connected → "Connected" (keep "Connecting…"/"Syncing…"/"Sync error"); see desktop SyncSettingsPane.tsx statusLabel.
9. (E9) CaptureView notes textarea: on focus, scrollIntoView so the on-screen keyboard doesn't occlude it (a behaviour-safe mitigation; true device verification is still a manual follow-up). Use a ref + onFocus handler.

=== VERIFY (all must pass) ===
- npm run lint && typecheck && test && build green. Update tests that assert changed copy/markup to the new form (e.g. the status-pill label "Paired"→"Connected", any pairing-panel close assertion, the snippet rendering) — adapt, don't weaken. Add a unit test for the unsolicited-stop reconcile (fire the onStopped/onError facade callback and assert CaptureView returns to inactive).
- Docker Robolectric testDebugUnitTest + assembleDebug green.
- STEP_HOST=step bash e2e/run-on-step.sh — 5/5 flows. The flows assert tab names "Capture"/"Meetings", "Recording"/"Start recording"/"Stop recording", "Recorded — awaiting a desktop", "Sync now", "Open Product roadmap review", "Summary"/"Transcript"/"Andrew", and typed notes — keep all those strings intact. If a flow breaks from a change you made, fix the FLOW to match the app (do not regress the app).
Report what landed, the unsolicited-stop wiring approach, tests added/updated, and the unit/Robolectric/flow results.`

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
    `${SHARED}\n\nROLE: Builder. Implement A and B. Run needed commands; leave the gate green. Do NOT commit.${feedback ? `\n\nPrevious attempt FAILED — fix and do not regress:\n${feedback}` : ''}`,
    { model: 'sonnet', phase: 'Build', label: `build#${attempt}` },
  )
  const gate = await agent(
    `${SHARED}\n\nROLE: Test runner. Run this gate verbatim; report each step pass/fail with the tail of output for failures. Do not fix. The e2e step boots a real emulator on step and runs 5 Maestro flows — allow several minutes.\nGATE:\n${GATE}`,
    { model: 'haiku', phase: 'Build', label: `test#${attempt}`, schema: GATE_SCHEMA },
  )
  if (!gate.pass) {
    feedback = `Gate failed. ${gate.summary}\n` + gate.steps.filter((s) => !s.ok).map((s) => `[${s.name}] ${s.log || ''}`).join('\n')
    outcome = { attempt, pass: false, stage: 'test', detail: gate.summary }
    continue
  }
  const review = await agent(
    `${SHARED}\n\nROLE: Reviewer. Review the uncommitted diff (cd ${REPO} && git --no-pager diff + new files). BLOCKING if: the recorder-event wiring can DOUBLE-handle a user stop (double save) or doesn't actually reconcile the unsolicited case; the onStopped/onError subscriptions aren't cleaned up on unmount; a flow-asserted string was changed without updating the flow; a test was weakened; thin-client boundary violated; theme tokens bypassed with hard-coded values; or types/gate break. Design tweaks: confirm they match the cited desktop convention and didn't change tab accessible names. Style nits non-blocking.`,
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
log(outcome.pass ? `Landed (attempt ${outcome.attempt}).` : `Halted after ${MAX_ATTEMPTS}: ${outcome.detail}`)
return { outcome }
