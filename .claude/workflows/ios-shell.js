export const meta = {
  name: 'ios-shell',
  description: 'iOS shell scaffold: generate the ios/ Capacitor project on the Swift Package Manager path, bump secure-storage so all six plugins actually link, add the remote build/smoke harness for the macOS host, set the Info.plist keys, generate app icons and do the safe-area pass. Each unit of work lands as its own commit.',
  whenToUse: 'Executing the iOS shell-scaffold phase of docs/IOS_ROADMAP.md. Needs ssh access to the macOS host; simulator only, no signing.',
  phases: [
    { title: 'Recon', detail: 'Parallel read-only surveys: SPM plugin linkage, Info.plist requirements, asset pipeline, safe-area readiness, ios/ tree hygiene', model: 'sonnet' },
    { title: 'Plan', detail: 'Opus orders the work into commit-sized units and picks the gates each needs', model: 'opus' },
    { title: 'Build', detail: 'Per unit: Sonnet implements and commits -> gates run -> Opus reviews -> amend until green', model: 'sonnet/haiku/opus' },
    { title: 'Verify', detail: 'Linux and macOS gates, simulator screenshot judged, adversarial review of the whole branch', model: 'haiku/sonnet/opus' },
  ],
}

// Pass {repo, mac} via the Workflow tool's args to target a worktree or a
// different host; the defaults are the primary checkout and the Mac mini.
const REPO = (args && args.repo) || '/mnt/bulk/nas/projects/minutist-mobile'
const MAC = (args && args.mac) || 'mm'
const REMOTE = 'ios-gate'
const IMAGE = 'minutist/android-build:local'
const BASE = 'main'
const TASK_ATTEMPTS = 3
const FIX_ATTEMPTS = 3

const JS_GATE = `cd ${REPO}
set -o pipefail
npm run lint
npm run typecheck
npm test
npm run build`

const ANDROID_GATE = `cd ${REPO}
set -o pipefail
npx cap sync android
mkdir -p "$HOME/.gradle-mm"
docker run --rm -v "${REPO}:${REPO}" -w "${REPO}" \
  -v "$HOME/.gradle-mm:/gradle-home" -e GRADLE_USER_HOME=/gradle-home -e HOME=/tmp \
  --user "$(id -u):$(id -g)" \
  ${IMAGE} bash -lc 'cd android && ./gradlew --no-daemon testDebugUnitTest assembleDebug'`

// The iOS build cannot run on the Linux host, so the tree is pushed to the Mac
// and built there. This deliberately does not call
// scripts/ios-build-on-mac.sh: that script is one of this phase's deliverables,
// so the gate must not depend on it already existing.
const IOS_GATE = `set -o pipefail
cd ${REPO}
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude dist \
  --exclude 'ios/App/CapApp-SPM/.build' --exclude 'ios/App/build' \
  ./ ${MAC}:${REMOTE}/
ssh ${MAC} 'cd ${REMOTE} && npm ci && npm run build && npx cap sync ios'
ssh ${MAC} 'cd ${REMOTE}/ios/App && xcodebuild -project App.xcodeproj -scheme App -destination "generic/platform=iOS Simulator" -derivedDataPath /tmp/ddgate build 2>&1 | tail -5'
ssh ${MAC} 'ls -la /tmp/ddgate/Build/Products/Debug-iphonesimulator/App.app/App && lipo -info /tmp/ddgate/Build/Products/Debug-iphonesimulator/App.app/App'`

// Boot a simulator, install, launch, screenshot, pull the image back. The
// screenshot is judged by a separate agent: capturing a file is not the same as
// confirming what it shows.
const IOS_SMOKE = `set -o pipefail
DEV=$(ssh ${MAC} 'xcrun simctl list devices available | grep -m1 "iPhone" | sed -E "s/.*\\(([A-F0-9-]{36})\\).*/\\1/"')
echo "simulator=$DEV"
ssh ${MAC} "xcrun simctl boot $DEV" || true
ssh ${MAC} "xcrun simctl bootstatus $DEV -b"
ssh ${MAC} "xcrun simctl terminate $DEV ai.minutist.companion" || true
ssh ${MAC} "xcrun simctl install $DEV /tmp/ddgate/Build/Products/Debug-iphonesimulator/App.app"
ssh ${MAC} "xcrun simctl launch $DEV ai.minutist.companion"
sleep 15
ssh ${MAC} "xcrun simctl io $DEV screenshot /tmp/smoke.png"
scp ${MAC}:/tmp/smoke.png /tmp/ios-smoke.png
ssh ${MAC} "xcrun simctl spawn $DEV log show --last 1m --style compact --predicate 'process == \\"App\\"' | grep -iE 'error|exception|crash' | head -10" || true
ls -la /tmp/ios-smoke.png`

const COMMIT_RULES = `COMMIT MESSAGE RULES (this repo's convention — read \`git log -6\` in ${REPO} for live examples):
- Subject: a conventional-commit prefix with a scope, then what the commit makes true, imperative mood, under ~72 chars. Scopes in use: sync, capture, ios, docs, architecture, build, store, test.
- The subject describes THE WORK, never the process. It must NOT mention a phase number, a roadmap phase name, a task id, a workflow, an agent, an attempt, or a step.
- Body: factual bullets stating what changed and why, in the context of the current state. Conservative wording. Do not narrate the development journey; the diff shows the mechanics.
- No Co-Authored-By, no Generated-with, no AI attribution trailers of any kind. The repo has none.
- Commit ONLY the files belonging to this unit of work. Never \`git add -A\` blindly — check \`git status --short\` first and stage explicitly.`

const CONTEXT = `Repo: ${REPO} (branch feat/ios-port, based on ${BASE}). Capacitor 8 + React 19 + Vite + TypeScript in a native WebView, with native Kotlin under android/app/src/main/java/ai/minutist/companion/ and a Rust sync engine over UniFFI.

READ FIRST: docs/IOS_ROADMAP.md — in particular the Hosts section and "Phase 3 — iOS shell scaffold", which is the work in hand. Also docs/BUILD.md and architecture/components.md.

THE macOS HOST. ssh alias \`${MAC}\`: Mac mini, macOS 15.7.9 Sequoia via OpenCore Legacy Patcher, Xcode 16.4 (iOS 18.5 SDK, Swift 6.1.2), iOS 18.6 simulator runtime, Rust 1.91.0 with the three iOS targets, Node 22. No CocoaPods and none needed. Non-interactive ssh works; PATH and LANG come from its ~/.zshenv. It holds NO codesigning identity, so nothing in this phase may require signing or a physical device — simulator only.

ESTABLISHED FACTS, verified on ${MAC}. Do not re-litigate these:
- \`npx cap add ios\` works on Linux as well as macOS, and defaults to Swift Package Manager, writing ios/App/CapApp-SPM/Package.swift at swift-tools-version 5.9. There is NO .xcworkspace and no Podfile on this path, so xcodebuild takes \`-project ios/App/App.xcodeproj\`.
- The scaffold builds clean on ${MAC}, and the app installs, launches and renders the Capture view in the simulator against the mock sync client.
- The simulator binary is a fat x86_64 + arm64 Mach-O, minos 15.0, sdk 18.5.
- That host's simulator exposes no Metal device. WebKit renders correctly anyway. Do not chase it.
- \`@aparajita/capacitor-secure-storage\` at the pinned ^7.0.0 (7.1.6) ships NO Package.swift, so \`cap add ios\` silently drops it and only 5 of 6 plugins link. That plugin backs src/account/signin.ts (the account device credential), so the SPM build currently has no secure storage at all. Version 8.0.0 does ship a Package.swift.

HARD CONSTRAINTS:
- src/sync/plugin.ts does NOT change. It is the frozen contract for the later Swift port.
- No behaviour change on Android. The Android app stays shippable and its gate stays green.
- No Swift plugin code in this phase and no SyncPlugin.swift — a later phase owns that. The iOS app runs against the mock sync client through the existing seam in src/sync/client.ts, which already returns mockSyncClient for 'ios' and needs no change.
- Comment discipline (repo rule): comments describe the code AS IT CURRENTLY IS. Never "previously X, now Y", "changed from", "will become". A reader seeing only a snapshot must understand every comment.
- Do not weaken, delete, or make tautological any test.`

const SURVEY_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  findings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    topic: { type: 'string' }, what: { type: 'string' }, recommended_action: { type: 'string' }, evidence: { type: 'string' } },
    required: ['topic', 'what', 'recommended_action'] } },
  summary: { type: 'string' } }, required: ['findings', 'summary'] }

const PLAN_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string' }, title: { type: 'string' }, commit_subject: { type: 'string' },
    files: { type: 'string' }, detail: { type: 'string' }, acceptance: { type: 'string' },
    gates: { type: 'array', items: { type: 'string', enum: ['js', 'android', 'ios', 'smoke'] } } },
    required: ['id', 'title', 'commit_subject', 'files', 'detail', 'acceptance', 'gates'] } },
  out_of_scope: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } },
  required: ['tasks', 'out_of_scope', 'rationale'] }

const GATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  pass: { type: 'boolean' },
  steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    name: { type: 'string' }, ok: { type: 'boolean' }, log: { type: 'string' } }, required: ['name', 'ok'] } },
  summary: { type: 'string' } }, required: ['pass', 'steps', 'summary'] }

const SMOKE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  renders: { type: 'boolean' }, observed: { type: 'string' }, screenshot_mtime: { type: 'string' },
  problems: { type: 'array', items: { type: 'string' } } },
  required: ['renders', 'observed', 'screenshot_mtime', 'problems'] }

const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  approved: { type: 'boolean' },
  blocking: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } }, required: ['issue', 'fix'] } },
  nonblocking: { type: 'array', items: { type: 'string' } } }, required: ['approved', 'blocking'] }

const BUILD_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  committed: { type: 'boolean' }, subject: { type: 'string' },
  files_changed: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } },
  required: ['committed', 'subject', 'files_changed', 'notes'] }

// ---------------------------------------------------------------------------
phase('Recon')

const [linkage, plist, assets, safearea, hygiene] = await parallel([
  () => agent(
    `${CONTEXT}

ROLE: Plugin-linkage surveyor. READ-ONLY — write no files, make no commits.

Only 5 of this app's 6 Capacitor plugins link on the SPM path, because @aparajita/capacitor-secure-storage 7.1.6 ships no Package.swift. Version 8.0.0 does. Establish what bumping to 8.0.0 costs, and whether anything else is silently missing.

1. For EVERY Capacitor plugin in package.json dependencies, check whether the installed version ships a Package.swift (look in node_modules/<pkg>/) and whether it ships a podspec. Report any other plugin that would be dropped on the SPM path.
2. 7.1.6 -> 8.0.0 is a MAJOR bump. Determine the actual breaking changes: use \`npm view @aparajita/capacitor-secure-storage@8.0.0\` for metadata and peer deps, and compare the TypeScript surface the app uses. The app touches it only via src/account/signin.ts (SecureStorage.get / set / remove and CREDENTIAL_KEY) — read that file and any test that mocks it. Does 8.0.0 keep those signatures and behaviour, including get() returning the stored DataType and remove() on a missing key?
3. What is the Android impact? The plugin has an Android implementation (Keystore + EncryptedSharedPreferences). Check its Android minSdk/compileSdk and gradle expectations against android/app/build.gradle and android/variables.gradle. Anything that would break the Android build or change Android behaviour is critical — Android must not regress.
4. SPDX licence of 8.0.0 and compatibility with this repo's AGPL-3.0-only + REUSE-clean setup.
5. Its peerDependency on @capacitor/core: does 8.0.0 accept the installed Capacitor 8 line?

Report each finding with evidence (the command run or file read). If a breaking change cannot be determined from metadata alone, say so rather than guessing.`,
    { model: 'sonnet', phase: 'Recon', label: 'survey:linkage', schema: SURVEY_SCHEMA }),

  () => agent(
    `${CONTEXT}

ROLE: Info.plist surveyor. READ-ONLY — write no files.

Determine exactly what the iOS Info.plist needs, derived from what the app actually does rather than a generic checklist.

1. Read android/app/src/main/AndroidManifest.xml and enumerate every permission and service declared. For each, state the iOS equivalent Info.plist key or capability, or that iOS needs nothing.
2. The app records audio (src/capture/recorder.ts via @capgo/capacitor-audio-recorder) and must keep recording with the screen locked. Which keys does that require, and which are needed NOW versus in the later recording phase? Be precise about UIBackgroundModes: declaring a background mode the app does not yet exercise is an App Review risk, so say whether it belongs in this phase.
3. ITSAppUsesNonExemptEncryption: determine the correct value and the reasoning. The app uses TLS/QUIC via iroh and standard HTTPS. Read store/ for how the Android data-safety reasoning was recorded, and say where the iOS export-compliance reasoning should live and in what form.
4. Read capacitor.config.ts and android/app/build.gradle for display name, bundle id and version, so the iOS values match rather than being invented.
5. Read the Info.plist template @capacitor/ios generates (find it under node_modules/@capacitor/ios) so the plan only adds what is genuinely missing.

Report findings with the exact key, value and justification.`,
    { model: 'sonnet', phase: 'Recon', label: 'survey:plist', schema: SURVEY_SCHEMA }),

  () => agent(
    `${CONTEXT}

ROLE: Asset-pipeline surveyor. READ-ONLY — write no files.

Work out how iOS icons and splash screens should be generated, reusing whatever Android already does.

1. Inventory assets/ — every source file, its pixel dimensions and format (use \`file\` and/or \`identify\` if available).
2. @capacitor/assets is already a devDependency. Find how it is invoked for Android: package.json scripts, any config file, README/docs mentions, and git log for the commit that generated the Android assets. Report the exact command and config.
3. What does @capacitor/assets need to produce iOS output, and what does it emit into ios/? Which source files must exist at what minimum size — iOS icon requirements differ from Android's adaptive icons.
4. Check REUSE.toml: the brand mark is trademark-reserved. Generated iOS icons derive from it, so state which REUSE entry must cover the new ios/ asset paths, following exactly how the Android generated icons are covered.
5. Note whether generated iOS assets should be committed or gitignored, and what android/ does for the equivalent files — consistency matters more than either choice.

Report findings with evidence.`,
    { model: 'sonnet', phase: 'Recon', label: 'survey:assets', schema: SURVEY_SCHEMA }),

  () => agent(
    `${CONTEXT}

ROLE: Safe-area surveyor. READ-ONLY — write no files.

iOS needs a notch / home-indicator / status-bar pass that Android did not.

1. Read index.html and report the exact current viewport meta tag.
2. Read src/App.css and every view CSS file. Identify each place that assumes the viewport starts at y=0 or ends at the screen bottom — fixed headers, bottom tab bars, the record button row, scroll containers — and any 100vh usage, which behaves badly with iOS browser chrome.
3. The rendered layout has a top header ("Minutist"), a bottom tab bar (Capture / Meetings) and a Record button row above it. State for each whether it needs env(safe-area-inset-*) and which inset.
4. @capacitor/status-bar is already a dependency. Check whether anything configures it today and what iOS needs (overlay behaviour and style) versus Android.
5. Flag any change that would alter Android rendering. Android must look identical afterwards — say how to scope each change so it cannot regress Android.

Report findings with file, the current rule, and the concrete change.`,
    { model: 'sonnet', phase: 'Recon', label: 'survey:safearea', schema: SURVEY_SCHEMA }),

  () => agent(
    `${CONTEXT}

ROLE: Repository-hygiene surveyor. READ-ONLY — write no files.

Decide exactly what of the generated ios/ tree is committed and what is ignored, mirroring how android/ was handled.

1. Read .gitignore and any android/.gitignore. List every android/ ignore rule and its purpose.
2. Generate nothing, but determine from @capacitor/ios's template (node_modules/@capacitor/ios) what \`cap add ios\` produces. Classify each output as commit, ignore, or must-never-exist. Cover at minimum App.xcodeproj internals (project.pbxproj vs xcuserdata vs xcshareddata), CapApp-SPM/Package.swift and its .build directory and Package.resolved, ios/App/App/public (the copied web assets — note what android/ does with its equivalent), ios/App/App/capacitor.config.json, and DerivedData.
3. Package.resolved deserves a specific recommendation with reasoning: committing it pins transitive Swift package versions for reproducible CI builds; omitting it lets them float. Say which, and why, given the CI lane planned for the tests-and-CI phase.
4. Read .github/workflows/ci.yml and record what constraints an ios job would place on the committed tree — do not write the job. In particular a shared scheme, since a headless runner cannot open Xcode's GUI to autocreate one.
5. Check REUSE.toml and REUSE compliance: generated iOS source files need licence coverage. State exactly what entry is needed, following the android/ precedent. The \`reuse\` CI job must stay green.

Report findings with evidence.`,
    { model: 'sonnet', phase: 'Recon', label: 'survey:hygiene', schema: SURVEY_SCHEMA }),
])

const fmt = (s, name) => s
  ? s.findings.map((f) => `- [${f.topic}] ${f.what}\n  action: ${f.recommended_action}${f.evidence ? `\n  evidence: ${f.evidence}` : ''}`).join('\n')
  : `(${name} survey unavailable)`

log(`Recon: linkage ${linkage ? linkage.findings.length : 0}, plist ${plist ? plist.findings.length : 0}, assets ${assets ? assets.findings.length : 0}, safe-area ${safearea ? safearea.findings.length : 0}, hygiene ${hygiene ? hygiene.findings.length : 0}`)

// ---------------------------------------------------------------------------
phase('Plan')

const plan = await agent(
  `${CONTEXT}

ROLE: Planner. READ-ONLY — write no files. Produce the ordered task list the builders execute. EACH TASK BECOMES EXACTLY ONE GIT COMMIT, so a task must be a coherent, independently-reviewable unit — not a checklist line and not a grab-bag.

PLUGIN-LINKAGE SURVEY
${fmt(linkage, 'linkage')}

INFO.PLIST SURVEY
${fmt(plist, 'plist')}

ASSET-PIPELINE SURVEY
${fmt(assets, 'assets')}

SAFE-AREA SURVEY
${fmt(safearea, 'safe-area')}

HYGIENE SURVEY
${fmt(hygiene, 'hygiene')}

The work to cover:
1. The secure-storage bump, so all six plugins link on the SPM path. This changes an Android-shipping dependency, so it needs the Android gate and must not alter Android behaviour. If the linkage survey found the bump breaks the app's API or the Android build, plan the alternative instead of forcing it.
2. \`npm i @capacitor/ios && npx cap add ios\`, committing the generated tree with the ignore rules and REUSE coverage the hygiene survey specifies. Commit a shared scheme at ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme: xcodebuild synthesises an implicit scheme for a single-target project, so a local build can succeed without one, but a committed shared scheme is what makes the later CI lane and any multi-target work reliable.
3. \`scripts/ios-build-on-mac.sh\` — the iOS counterpart of e2e/run-on-step.sh, which you must read and mirror in structure, argument handling, env-var conventions (it uses STEP_HOST; use an equivalent for the Mac host defaulting to \`${MAC}\`), header-comment style, and \`set -euo pipefail\`. It rsyncs the repo to the Mac host, builds for the simulator with \`-project\`, and runs a headless install/launch/screenshot smoke. It must exit non-zero on build or launch failure, and depend on nothing beyond ssh, rsync and the remote toolchain. Document prerequisites the way run-on-step.sh documents its own.
4. Info.plist keys per the plist survey, plus the export-compliance reasoning recorded where that survey says it belongs.
5. App icons and splash per the asset survey, with REUSE coverage.
6. The safe-area pass per that survey, scoped so Android rendering is unchanged.
7. docs/BUILD.md: replace the "iOS (not yet buildable)" framing with what is now true — how to build and smoke-test iOS via the new script, the ${MAC} prerequisites, and what still cannot be done (device deployment, for want of a codesigning identity and iOS 15.8 DeviceSupport). State current fact; do not narrate the change.

For each task set \`gates\` to the subset actually needed:
- "js" — lint/typecheck/test/build. Nearly always.
- "android" — dockerised Robolectric + assembleDebug. Only for tasks touching android/, package.json dependencies, or shared web assets.
- "ios" — rsync to ${MAC} and xcodebuild. Every task changing ios/, package.json, capacitor.config.ts, or bundled web assets.
- "smoke" — boot the simulator, install, launch, screenshot, and have the screenshot judged. For tasks that could change what the app renders: the scaffold itself, assets, safe-area CSS.
Do not attach a gate that cannot yet pass — nothing can use "ios" before the ios/ tree exists.

For each task supply commit_subject following these rules:
${COMMIT_RULES}

Order tasks so each commit leaves the tree green on its own gates. List as out_of_scope anything a later phase owns.`,
  { model: 'opus', phase: 'Plan', label: 'plan', schema: PLAN_SCHEMA })

log(`Plan: ${plan.tasks.length} commits — ${plan.tasks.map((t) => `${t.id}[${t.gates.join('+')}]`).join(' ')}`)

// ---------------------------------------------------------------------------
phase('Build')

const gateFor = (name) => ({ js: JS_GATE, android: ANDROID_GATE, ios: IOS_GATE }[name])
const landed = []
const abandoned = []

for (const task of plan.tasks) {
  let attempt = 0, feedback = '', done = false

  while (attempt < TASK_ATTEMPTS) {
    attempt++

    const built = await agent(
      `${CONTEXT}

ROLE: Builder. Implement exactly ONE unit of work and commit it. Touch nothing outside its scope.

THE UNIT OF WORK
[${task.id}] ${task.title}
files: ${task.files}
${task.detail}
acceptance: ${task.acceptance}
gates that will run against it: ${task.gates.join(', ')}
suggested commit subject: ${task.commit_subject}

OUT OF SCOPE (do not touch): ${plan.out_of_scope.join('; ')}

PROCEDURE
1. If node_modules/ is absent, run \`npm ci\`.
2. Implement the change.
3. Run the JS gate yourself and get it green before committing:
${JS_GATE}
4. \`cd ${REPO} && git status --short\` — stage only this unit's files, then commit.
5. Refine the suggested subject to match what you actually changed.

${COMMIT_RULES}
${feedback ? `\nTHE PREVIOUS ATTEMPT ON THIS UNIT WAS REJECTED. Fix the following, then AMEND the existing commit (\`git commit --amend\`) rather than stacking a second commit — this unit lands as exactly one commit. Do not regress anything already correct:\n${feedback}` : ''}

Report committed: true only if \`git log -1\` shows your commit and \`git status --short\` is clean.`,
      { model: 'sonnet', phase: 'Build', label: `build:${task.id}#${attempt}`, schema: BUILD_SCHEMA })

    if (!built || !built.committed) {
      feedback = `The builder did not produce a clean commit. Notes: ${built ? built.notes : 'agent returned nothing'}`
      continue
    }

    // Running a command and reporting pass/fail is haiku's job. Judging the
    // screenshot is not, so that is a separate agent below.
    let gateFailure = null
    for (const g of task.gates.filter((x) => x !== 'smoke')) {
      const res = await agent(
        `${CONTEXT}

ROLE: Test runner. Run this gate verbatim, in order, and report each step's pass/fail with the tail of output for any failure. Fix NOTHING; change no files; make no commits. The remote npm ci and xcodebuild take several minutes — wait for them.

GATE (${g}):
${gateFor(g)}`,
        { model: 'haiku', phase: 'Build', label: `gate:${g}:${task.id}#${attempt}`, schema: GATE_SCHEMA })
      if (!res || !res.pass) {
        gateFailure = `Gate "${g}" failed. ${res ? res.summary : 'agent returned nothing'}\n` +
          ((res && res.steps) || []).filter((s) => !s.ok).map((s) => `[${s.name}] ${s.log || ''}`).join('\n')
        break
      }
    }
    if (gateFailure) { feedback = gateFailure; continue }

    if (task.gates.includes('smoke')) {
      const smoke = await agent(
        `${CONTEXT}

ROLE: Simulator validator. Run the smoke sequence below, then JUDGE the screenshot by opening it with the Read tool. You are confirming what the app actually renders — a captured file is not evidence on its own.

SMOKE:
${IOS_SMOKE}

Then Read /tmp/ios-smoke.png and describe what is actually on screen. Report renders: true only if the Capture view is genuinely visible — the "Minutist" header, a status line, a Title field, a Notes area, a Record button, and the Capture/Meetings tab bar. A blank or white screen is renders: false even though the process launched; so is a view missing its controls. Report the screenshot's mtime from the \`ls -la\` output so it is provable the image came from this run rather than a stale file, and list any error or exception lines the log query printed.`,
        { model: 'sonnet', phase: 'Build', label: `smoke:${task.id}#${attempt}`, schema: SMOKE_SCHEMA })
      if (!smoke || !smoke.renders) {
        feedback = `Simulator smoke failed. Observed: ${smoke ? smoke.observed : 'validator returned nothing'}\nProblems: ${((smoke && smoke.problems) || []).join('; ')}`
        continue
      }
    }

    const review = await agent(
      `${CONTEXT}

ROLE: Principal reviewer. Review the single commit at HEAD: \`cd ${REPO} && git --no-pager show HEAD\`. Read any new file in full.

THIS COMMIT'S UNIT OF WORK
[${task.id}] ${task.title}
${task.detail}
acceptance: ${task.acceptance}

BLOCKING if:
- the commit does not satisfy its stated acceptance criterion
- it contains changes outside its unit of work
- src/sync/plugin.ts changed (frozen contract), or Swift plugin code was added (a later phase owns that)
- Android behaviour or the Android build could change, beyond a dependency bump the plan explicitly sanctioned
- generated files that should be ignored are committed, or files the build needs are ignored — judge against the android/ precedent, not taste
- REUSE coverage is missing for new files, which breaks the \`reuse\` CI job
- a shell script omits \`set -euo pipefail\`, fails to exit non-zero when the build or launch it wraps fails, or diverges from e2e/run-on-step.sh's conventions without reason
- an Info.plist key is present that the app does not yet exercise (a background mode it does not use is an App Review risk), or a required one is absent
- a comment narrates the port ("previously", "now", "will become") instead of stating current fact
- docs claim an iOS capability that does not exist — device deployment is NOT possible (no codesigning identity, no iOS 15.8 DeviceSupport)
- a test was weakened, deleted, or made tautological
- the commit MESSAGE breaks the rules below

${COMMIT_RULES}

Style nits are non-blocking.`,
      { model: 'opus', phase: 'Build', label: `review:${task.id}#${attempt}`, agentType: 'principal-code-reviewer', schema: REVIEW_SCHEMA })

    if (review && review.blocking && review.blocking.length) {
      feedback = 'Review blocking findings:\n' + review.blocking.map((b) => `- ${b.file || ''}: ${b.issue}\n  fix: ${b.fix}`).join('\n')
      continue
    }

    landed.push({ id: task.id, subject: built.subject, files: built.files_changed })
    log(`Committed: ${built.subject}`)
    done = true
    break
  }

  if (!done) {
    abandoned.push({ id: task.id, title: task.title, reason: feedback.slice(0, 400) })
    log(`ABANDONED after ${TASK_ATTEMPTS} attempts: ${task.title}`)
  }
}

// ---------------------------------------------------------------------------
phase('Verify')

let fixAttempt = 0, verified = null

while (fixAttempt < FIX_ATTEMPTS) {
  fixAttempt++

  const [full, smoke, adversarial] = await parallel([
    () => agent(
      `${CONTEXT}

ROLE: Test runner. Run these three gates verbatim and in order, reporting each step. Fix NOTHING; change no files; make no commits.

JS GATE:
${JS_GATE}

ANDROID GATE:
${ANDROID_GATE}

iOS GATE:
${IOS_GATE}`,
      { model: 'haiku', phase: 'Verify', label: `full-gate#${fixAttempt}`, schema: GATE_SCHEMA }),

    () => agent(
      `${CONTEXT}

ROLE: Simulator validator for the finished branch. Run the smoke sequence, then judge the screenshot with the Read tool.

SMOKE:
${IOS_SMOKE}

Read /tmp/ios-smoke.png. renders: true only if the Capture view is genuinely on screen with its header, title field, notes area, record button and tab bar. Report the mtime from \`ls -la\` so the image is provably from this run, and any error lines from the log query. Also state whether the app icon and launch screen look correct rather than placeholder, since this branch sets those.`,
      { model: 'sonnet', phase: 'Verify', label: `smoke#${fixAttempt}`, schema: SMOKE_SCHEMA }),

    () => agent(
      `${CONTEXT}

ROLE: Adversarial reviewer. Break this branch; do not approve it. Review every commit: \`cd ${REPO} && git --no-pager log --oneline ${BASE}..HEAD\` and \`git --no-pager diff ${BASE}...HEAD\`.

Attack these axes and report only what you can substantiate from commands you actually ran:

1. PROVE THE iOS BUILD RAN rather than trusting a report. On ${MAC}: does /tmp/ddgate/Build/Products/Debug-iphonesimulator/App.app/App exist, is its mtime newer than the newest file rsynced there, and does \`lipo -info\` show x86_64 and arm64? Run the commands over ssh and state what you observed. Missing or stale artifacts are BLOCKING regardless of any report.
2. PROVE ALL SIX PLUGINS LINK. Read ios/App/CapApp-SPM/Package.swift on the branch and count the .package(name:) entries. Six Capacitor plugins are installed; if fewer link, identify which is dropped and whether that silently breaks a feature — secure storage backs the account credential in src/account/signin.ts. This is the specific defect this phase exists to fix, so verify it rather than assume.
3. Find a committed file that should be ignored (user-specific state, build output, a resolved dependency graph nobody intended to pin) or an ignored file the build needs. Check that a fresh clone plus \`npm ci\` plus the new script can build — in particular whether anything the build requires exists only because it was generated locally and never committed.
4. Run \`reuse lint\` (or the CI job's equivalent) and report the actual result. New files without licence coverage break CI.
5. Read scripts/ios-build-on-mac.sh adversarially. Make it fail: no arguments, a wrong host, a dirty remote directory, a build failure, a launch failure, an absent simulator. Does it exit non-zero in each case, or report success over a failure? Compare against e2e/run-on-step.sh.
6. Verify Android did not regress: does the diff touch anything Android-affecting beyond the sanctioned dependency bump, and did the Android gate genuinely run (a fresh APK on disk whose mtime is newer than the newest src file)?
7. Read every commit message (\`git --no-pager log ${BASE}..HEAD\`). BLOCKING if any subject names a phase, task id, workflow, agent or step instead of the work; if any body narrates the development process; or if any carries an AI-attribution trailer.

Do not manufacture findings: if an axis is clean, say so in nonblocking. Approve only if nothing on axes 1-7 is substantiated.`,
      { model: 'opus', phase: 'Verify', label: `adversarial#${fixAttempt}`, schema: REVIEW_SCHEMA }),
  ])

  const problems = [
    ...((full && full.pass) ? [] : [{ file: '', issue: `Full gate failed: ${full ? full.summary : 'no result'}`, fix: ((full && full.steps) || []).filter((s) => !s.ok).map((s) => `[${s.name}] ${s.log || ''}`).join('\n') }]),
    ...((smoke && smoke.renders) ? [] : [{ file: '', issue: `Simulator smoke failed: ${smoke ? smoke.observed : 'no result'}`, fix: ((smoke && smoke.problems) || []).join('; ') }]),
    ...((adversarial && adversarial.blocking) || []),
  ]

  if (!problems.length) {
    verified = { pass: true, attempt: fixAttempt, smoke: smoke.observed, nonblocking: (adversarial && adversarial.nonblocking) || [] }
    break
  }

  verified = { pass: false, attempt: fixAttempt, detail: problems.map((p) => p.issue).join('; ') }
  if (fixAttempt >= FIX_ATTEMPTS) break

  await agent(
    `${CONTEXT}

ROLE: Fixer. The branch failed verification. Fix every finding below and leave the branch green.

FINDINGS
${problems.map((p) => `- ${p.file || ''}: ${p.issue}\n  fix: ${p.fix}`).join('\n')}

COMMIT POLICY: if the defect is in the commit at HEAD, amend it. Otherwise add ONE new commit whose subject describes the correction as work in its own right. Never rewrite commits that are not at HEAD. Never leave the tree dirty.

${COMMIT_RULES}

Run the JS gate before committing:
${JS_GATE}`,
    { model: 'sonnet', phase: 'Verify', label: `fix#${fixAttempt}` })
}

log(verified && verified.pass
  ? `Branch verified on attempt ${verified.attempt}: ${landed.length} commits, all gates green, simulator renders.`
  : `Branch NOT verified after ${FIX_ATTEMPTS} attempts: ${(verified && verified.detail) || 'unknown'}`)

return { landed, abandoned, verified, out_of_scope: plan.out_of_scope }
