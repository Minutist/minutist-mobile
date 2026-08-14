<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# iOS support — phased roadmap

Plan for porting the companion to iOS. Written to be executed as a sequence of
coding workflows (`.claude/workflows/`, one script per phase, in the style of
`build-phone-shell.js`): each phase has a concrete gate the orchestrator runs
itself, and phases are ordered so everything that can run on the current Linux
host runs first. A macOS host is required from Phase 3 onward and is available
on request — nothing before Phase 3 needs it.

Estimates assume the two Phase-0 spikes land clean. Total: roughly 5–8 weeks
of focused work to a TestFlight build at Android parity minus background sync.

## Decisions to settle before Phase 3 (D-gates)

These change what gets built; they are inputs, not tasks.

- **D1 — Background sync stance.** iOS has no analogue of
  `SyncForegroundService` ("keep this transfer alive now"). Options:
  (a) foreground-only sync for v1, `BGProcessingTask` best-effort later
  (recommended — it unblocks everything else); (b) block iOS on a
  push-triggered-wake design. Phase 7 implements whatever D1 picks; every
  other phase is unaffected.
- **D2 — Transcode home.** Move AAC→Opus into the Rust `sync-ffi` crate
  (Phase 1, recommended: one implementation, deletes 449 lines of Kotlin,
  no Swift transcoder needed) vs. ship iOS with raw-AAC handoff and let the
  desktop transcode on adoption (the existing pre-API-29 Android path; zero
  new work but a permanent format asymmetry).
- **D3 — iOS CI hosting.** Paid GitHub macOS minutes vs. a self-hosted Mac
  runner. Current CI is deliberately ubuntu-only. Decides Phase 8's shape
  only.
- **D4 — Relay DNS on iOS.** Android carries ~150 lines of VPN-aware
  per-network resolution in `SyncPlugin.kt` (`DnsResolver` +
  `Network.getAllByName` ordering). iOS has no per-link resolve API of that
  shape. Default: rely on the engine's DoH fallback for v1 and revisit if
  the Tailscale-style capture problem reproduces on iOS (`NWPathMonitor` +
  `getaddrinfo` binding is the escalation path). Decide during the Phase 0
  spike, which should test resolution under a DNS-capturing VPN.

## Phase map

| # | Phase | Host | Blocks on | Est. |
|---|-------|------|-----------|------|
| 0 | Spikes: iroh-on-iOS, locked-screen recording | Mac + iPhone | — | 3–5 d |
| 1 | Transcode → Rust (`sync-ffi`), Android adopts | Linux | D2 | 3–5 d |
| 2 | Platform-seam prep in TS + docs | Linux | — | 1–2 d |
| 3 | iOS shell scaffold + assets | Mac | 0 | 1–2 d |
| 4 | Rust → XCFramework + UniFFI Swift bindings | Mac | 0, 1 | 3–5 d |
| 5 | `SyncPlugin.swift` port | Mac | 4 | 3–5 d |
| 6 | Recording: audio background mode + interruptions | Mac + iPhone | 3 | 5 d |
| 7 | Background sync per D1 | Mac + iPhone | 5, D1 | 2–5 d |
| 8 | Tests + CI (macOS lane) | Mac (runner) | 5, 6, D3 | 5 d |
| 9 | TestFlight / App Store | Mac | all | 2–4 d + review latency |

Phases 1 and 2 can start now, before any Mac exists, and Phase 1 pays back on
Android regardless of the iOS outcome. Phase 0 is the first Mac task and is a
hard go/no-go gate: if iroh/quinn does not work on iOS, phases 3–9 are moot.

---

## Phase 0 — Spikes (go/no-go)

**Host:** Mac + a physical iPhone. **Repos:** desktop (`crates/sync-ffi`) +
this one.

Two unknowns of the same class as the Android `iroh-blobs` spike and the
60-minute Doze spike (planning issue `0016`):

- **0a — iroh endpoint on iOS.** Cross-compile `sync-ffi` for
  `aarch64-apple-ios` (+ `-sim`), link into a throwaway Xcode app, and prove
  on-device: relay connect, pair with a desktop, one notes sync, one blob
  transfer. Then the failure modes that matter: wifi→cellular transition
  mid-connection (quinn rebinding), app suspend → resume (sockets die on
  suspend; the engine must survive re-entry), and resolution/connect under a
  DNS-capturing VPN (feeds D4). Known risk to check early: any
  `ring`/`aws-lc-rs` build friction on the iOS targets, and tokio runtime
  behaviour across suspend.
- **0b — 60-minute locked-screen recording.** `UIBackgroundModes: audio` +
  `AVAudioSession .playAndRecord`, screen locked, 60 min on a real handset.
  Verify: no truncation, duration correct, file playable, interruption
  (incoming call) pauses and resumes per the plugin's existing
  interruption-observer code. This validates `@capgo/capacitor-audio-recorder`
  under our exact usage, not in general.

**Evidence, not assertion:** artifacts on disk (the transferred blob's hash
matching the desktop's, the 60-min `.m4a` and its `afinfo` output), committed
to a spike log. A workflow can drive 0a's build legs, but both spikes end in a
manual on-device evidence request, exactly as `build-phone-shell.js` handles
the Android device spike.

**Gate:** both spikes pass → proceed. 0a fails → stop; the port is off until
the upstream problem is fixed. 0b fails → recording architecture rethink
before Phase 6.

## Phase 1 — Transcode into Rust (D2 = move)

**Host:** Linux (current setup). **Repos:** desktop first, then this one.
Independent of everything else; can run today.

- Add AAC→16 kHz-mono-Ogg-Opus decode/resample/encode to a crate the desktop
  repo owns, exposed through `sync-ffi` (e.g. `transcode_to_opus(src, dst)`;
  candidate crates: `symphonia` for AAC decode, `opus`/`audiopus` +
  `ogg` for encode/mux — licence-check each, REUSE-clean).
- Regenerate Kotlin bindings via `scripts/build-sync-ffi.sh`; route
  `src/capture/opusTranscode.ts` through the FFI method; delete
  `AacToOpusTranscoder.kt`, `OpusTranscodePlugin.kt`, and their tests; the
  pre-API-29 fallback branch dies too (the Rust path has no API floor).
- Acceptance is byte-level: transcode a fixture AAC on-device (emulator leg is
  fine), assert 16 kHz mono Ogg-Opus that the desktop pipeline accepts.
  `e2e/validate-transcode-on-step.sh` is the existing harness to adapt.

**Gate (orchestrator-run):** full existing gate (lint/typecheck/test/build +
`assembleDebug` in `minutist/android-build:local`) plus the adapted transcode
validation. Cross-repo note: the desktop change lands and is reviewed in the
desktop repo before this repo's adoption commit.

**Workflow shape:** standard coding tiering — sonnet implements, haiku runs
the gate, opus reviews (with the mandate to verify the transcode artifact
exists on disk, not that a report says so); loop until green + no findings.
Two sequenced workflows (desktop repo, then here), not one.

## Phase 2 — Platform-seam prep (Linux)

**Host:** Linux. Small, mechanical, keeps the Android app shippable
throughout.

- Audit every platform branch: `src/capture/foregroundService.ts:116`
  (`getPlatform() === 'android'`) and `src/sync/client.ts:19`
  (`isNativePlatform()`). Introduce an explicit iOS arm where behaviour will
  differ (foreground-service controller → no-op on iOS in this phase; Phase 6
  replaces it if session management needs a JS-visible seam).
- Comments that say "Android" but mean "native" get corrected; comments that
  genuinely mean Android stay (e.g. the wifi-lock notes).
- `docs/BUILD.md` gains an iOS section stub; `architecture/components.md`
  gains the iOS container notes (what maps to what, what has no analogue —
  the table from this roadmap's analysis).

**Gate:** `npm run lint && npm run typecheck && npm test && npm run build`,
Android assemble unchanged.

## Phase 3 — iOS shell scaffold

**Host:** Mac (first non-spike Mac phase). Xcode + CocoaPods.

- `npm i @capacitor/ios && npx cap add ios`; commit the generated `ios/`
  project with the same hygiene the `android/` tree got (gitignore for Pods
  and DerivedData, no user-specific xcuserdata).
- `Info.plist`: `NSMicrophoneUsageDescription`, `UIBackgroundModes: [audio]`,
  `ITSAppUsesNonExemptEncryption` (expected `false` — standard TLS/QUIC is
  exempt, but record the reasoning in `store/`), display name "Minutist",
  bundle id `ai.minutist.companion`.
- Icons/splash via `@capacitor/assets` from the existing `assets/` sources.
- Safe-area pass on the web UI: `viewport-fit=cover` in `index.html`,
  `env(safe-area-inset-*)` in `App.css`/view CSS (notch, home indicator,
  keyboard accessory). Status-bar styling via the already-present
  `@capacitor/status-bar`.
- App boots to the Capture view in the simulator with the mock sync client
  (the `isNativePlatform()` branch will pick `CapacitorSyncClient` — until
  Phase 5, force the mock on iOS behind the Phase 2 seam).

**Gate:** `xcodebuild -workspace ios/App/App.xcworkspace -scheme App
-destination 'generic/platform=iOS Simulator' build` clean; simulator
smoke: app launches, record button reaches the permission prompt.

## Phase 4 — Rust → XCFramework + Swift bindings

**Host:** Mac. **Repos:** desktop (build tooling) + this one (consumption).

- `scripts/build-sync-ffi-ios.sh`, sibling of `build-sync-ffi.sh`: cargo
  build for `aarch64-apple-ios` + `aarch64-apple-ios-sim` (x86_64-sim only if
  an Intel Mac is actually in play), `uniffi-bindgen` Swift output
  (`sync_ffi.swift` + modulemap/headers), assemble
  `SyncFfi.xcframework` via `xcodebuild -create-xcframework`. Static lib
  preferred (matches UniFFI's default Swift story).
- Same commit/ignore split as Android: generated Swift bindings committed,
  binary framework gitignored (CI compile-gate implications mirror the
  existing "CI doesn't have the .so" note in `ci.yml`).
- No Docker leg here — the toolchain is host-Xcode; document the pinned Rust
  and Xcode versions in `docs/BUILD.md` instead of an image.

**Gate:** a headless Swift test target (or a `swift test` harness) that
starts `FfiSyncEngine` against a local relay stub — or at minimum
instantiates the bindings — on the simulator. Orchestrator verifies the
`.xcframework` exists and `lipo -info`/`vtool` shows the expected slices.

## Phase 5 — `SyncPlugin.swift`

**Host:** Mac. The core port: 618 lines of Kotlin → Swift against the same
21-method bridge surface (`src/sync/plugin.ts` is the contract and does not
change — that is the acceptance criterion).

- Mechanical: `withEngine` → a serial `DispatchQueue`/actor equivalent of the
  `Dispatchers.IO` pattern (FFI calls are blocking `block_on`s — never the
  main thread), `meetingToJs` projection, lifecycle listener →
  `notifyListeners("meetingsChanged")`, `saveCaptured`'s Long-coercion note
  becomes a Double/Int64 note (Capacitor iOS bridges JS numbers as `NSNumber`
  — same class of trap, verify `startedAtMs > 2^31` explicitly in a test).
- Deliberately dropped relative to Kotlin (record each in the class doc
  comment as current-state contract, not history): wifi lock
  (`beginSyncHold`/`endSyncHold` become no-ops that still resolve — the JS
  contract keeps working), the VPN-aware DNS block per D4 (engine DoH
  fallback; `resolveRelayIps` returns empty).
- `MainActivity`'s debug seed-credential injection: iOS equivalent via a
  launch argument/environment read in `AppDelegate`, DEBUG-only, same
  read-once-and-clear semantics.
- Remove the Phase 3 force-mock: `isNativePlatform()` now correctly selects
  `CapacitorSyncClient` on iOS.

**Gate:** simulator run against a real desktop peer on the LAN: pair via
ticket, `saveCaptured` a meeting, sync notes + artifacts, meeting renders in
the Meetings view. Plus the Phase 8 unit tests retro-fitted here if Phase 8
hasn't landed (at minimum: projection + argument-coercion tests).

**Workflow shape:** sonnet ports method-by-method against the Kotlin source;
opus reviews with `SyncPlugin.kt` and `plugin.ts` side-by-side (contract
drift is the main review target); haiku runs the build/test gate.

## Phase 6 — Recording on iOS

**Host:** Mac + physical iPhone (simulator microphone behaviour is not
evidence).

- Wire the recorder facade's foreground-service seam for iOS: no service to
  start — the seam's iOS arm manages nothing, or (if the plugin's session
  handling proves insufficient in 0b) owns `AVAudioSession` activation
  around start/stop.
- Interruption handling end-to-end: incoming call mid-recording → plugin's
  interruption observer → facade's existing event surface → Capture UI shows
  paused state and resumes. Route audio-route-change (headphones unplugged)
  the same way.
- Repeat the 0b acceptance as a regression: 60-minute locked-screen capture
  through the real app UI (not the spike harness), file lands in the
  Phase 1/D2 transcode path, meeting saved via `saveCaptured`.

**Gate:** manual evidence request (device video/log + `afinfo` + the saved
meeting visible after sync), same pattern as the Android device spike.

## Phase 7 — Background sync per D1

**Host:** Mac + iPhone. Only what D1 chose; sized here for option (a).

- Foreground-only baseline: on `appStateChange` → background with unsynced
  outbound data, request `beginBackgroundTask` (~30 s of grace to drain a
  small notes push), then let the engine suspend. On foreground, re-drain.
- `BGProcessingTask` registration + scheduling for opportunistic catch-up
  sync (engine start → drain → shutdown inside the task budget). Treat as
  best-effort; UI must never promise it.
- The `SyncForegroundService` JS call sites (`src/sync/syncForegroundService.ts`)
  route through a platform seam: Android arm unchanged, iOS arm implements
  the above.

**Gate:** instrumented device run: background the app mid-push, verify the
30-s grace drains it; force a `BGProcessingTask` via the debugger
(`_simulateLaunchForTaskWithIdentifier`) and verify a drain occurs.

## Phase 8 — Tests + CI

**Host:** Mac runner (per D3).

- XCTest for `SyncPlugin.swift` (projection, coercion, engine-not-started
  rejection paths — the Robolectric suite is the checklist).
- Maestro iOS lane: port `e2e/flows/*.yaml` (Maestro flows are largely
  cross-platform; the `run-on-step.sh` harness needs an iOS-simulator
  sibling).
- CI: a `macos-latest` (or self-hosted) job mirroring the `android` job's
  scope — compile gate + unit tests, no functional binary (the
  `.xcframework` is not reachable from a hosted runner for the same
  cross-repo reason as the `.so`; keep the same honest comment).

**Gate:** CI green on a PR that touches `ios/`, Maestro smoke flow passes on
a simulator.

## Phase 9 — TestFlight / App Store

**Host:** Mac. Prereqs: Apple Developer Program membership ($99/yr) under
the same entity as the Play listing.

- Signing: Xcode-managed or `fastlane match` (decide with D3 — match wants a
  cert repo; secrets live off-repo alongside the Android keystore under
  `minutist-secrets/`).
- `fastlane` iOS lane (`deliver`/`pilot`) beside the existing Android
  `supply` lanes; shared metadata source where fastlane allows it.
- Store metadata: privacy nutrition labels mapped from
  `store/data-safety-answers.md` (the Android answers are the source of
  truth for what the app actually collects), screenshots (iPhone sizes),
  export-compliance declaration recorded in `store/`.
- Internal TestFlight first — the analogue of the Play internal track — then
  App Review.

**Gate:** a build on TestFlight installable on the test device; review
submission is a manual step with known latency (days), planned around, not
gated on.

---

## Workflow conventions for these phases

- One workflow script per phase under `.claude/workflows/` (e.g.
  `ios-shell.js`, `ios-sync-plugin.js`), following `build-phone-shell.js`:
  plan (opus) → per-task build (sonnet) → gate run (haiku) → review (opus) →
  commit on green+approved; loop on findings.
- Haiku only ever executes gates and reports pass/fail. Anything that judges
  whether the port works — device evidence, artifact checks, before/after —
  is sonnet-or-above, and the decisive command (hash, `lipo -info`,
  `afinfo`, mtime checks) is run by the orchestrator, not delegated.
- On-device legs (0a/0b, 6, 7) end in a manual evidence request, never a
  simulated result.
- Mac-phase workflows run on the Mac host once provisioned; until then only
  Phases 1–2 are schedulable.
