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
- **D2 — Transcode home (settled).** The phone does not transcode. Both
  platforms hand their recorder's native AAC-in-`.m4a` to sync as-is; the
  desktop decodes it at read time. `crates/persistence/src/reader.rs`
  `read_audio_pcm` already dispatches on file extension — `.opus` through
  `decode_opus_ogg`, `.m4a` through `decode_aac_m4a` (`symphonia` isomp4+aac
  decode, `rubato` band-limited resample to 16 kHz) — and `OggOpusEncoder`
  (`crates/persistence/src/opus_encoder.rs`) has exactly one caller, the
  desktop's own live-microphone capture writer; there is no adoption-time
  transcode to match. The sync fabric already carries the honest filename:
  `crates/sync-ffi/src/lib.rs` `sniff_captured_audio` reads container magic
  and stores `audio.m4a` with `codec: "aac"` when given AAC, and
  `crates/sync/src/blobs.rs` resolves the real filename into the manifest
  instead of a fixed `audio.opus`. Desktop planning issue `0047` weighed this
  choice explicitly ("normalize audio at the consumer, not the producer") and
  `0048` (status `done`) shipped it across `common`, `sync`, and `sync-ffi`.
  Adding an Opus encoder to `sync-ffi` would mean either a new C dependency
  (`audiopus_sys` needs CMake per ABI; the android-build image has neither
  CMake nor Ninja, and `cargo tree -p sync-ffi --edges normal,build` shows
  the only native-toolchain crate is `ring`, built by `cc`) or an immature
  pure-Rust encoder with no published RFC 6716 conformance evidence — either
  way it becomes the sole producer of an on-disk, cross-device archival
  format the desktop must decode forever. Phase 1 (below) removes the
  Kotlin transcoder instead; see it for the follow-up measurements this
  still owes.
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
| 1 | Remove on-phone transcode, adopt raw AAC hand-off | Linux | — | 1 d |
| 2 | Platform-seam prep in TS + docs | Linux | — | 1–2 d |
| 3 | iOS shell scaffold + assets | Mac | 0 | 1–2 d |
| 4 | Rust → XCFramework + UniFFI Swift bindings | Mac | 0 | 3–5 d |
| 5 | `SyncPlugin.swift` port | Mac | 4 | 3–5 d |
| 6 | Recording: audio background mode + interruptions | Mac + iPhone | 3 | 5 d |
| 7 | Background sync per D1 | Mac + iPhone | 5, D1 | 2–5 d |
| 8 | Tests + CI (macOS lane) | Mac (runner) | 5, 6, D3 | 5 d |
| 9 | TestFlight / App Store | Mac | all | 2–4 d + review latency |

Phases 1 and 2 can start now, before any Mac exists, and Phase 1's deletion of
the Kotlin transcoder is a real Android code-quality improvement independent
of the iOS outcome. Phase 0 is the first Mac task and is a hard go/no-go gate:
if iroh/quinn does not work on iOS, phases 3–9 are moot.

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

## Phase 1 — Remove on-phone transcode

**Host:** Linux (current setup). **Repos:** this one only; the desktop repo
needs no change — it already decodes `.m4a` at read time (see D2, above).

- Delete `android/app/src/main/java/ai/minutist/companion/AacToOpusTranscoder.kt`,
  `OpusTranscodePlugin.kt`, `android/app/src/test/java/ai/minutist/companion/OpusTranscodePluginTest.kt`,
  and `src/capture/opusTranscode.ts`. Remove the two `transcodeAacToOpus` call
  sites in `src/views/CaptureView.tsx` and the `captureIdRef` machinery that
  exists only to name the transcode output directory; `saveCaptured` receives
  the recorder's `.m4a` URI directly. `src/sync/plugin.ts` is untouched —
  `OpusTranscode` is a separate registered plugin, not part of that contract.
- Fix `android/app/src/main/java/ai/minutist/companion/SyncPlugin.kt:593`,
  which builds `audioUri` as a hardcoded `.../audio.opus` — already wrong for
  pre-API-29 devices that sync an `.m4a` — to resolve the actual stored
  filename.
- Correct the format comments in `src/capture/recorder.ts` that describe a
  transcode step; the "output format is AAC on Android, the phone never
  encodes Opus" statement stays, the transcode sentences go.
- Repoint `e2e/validate-transcode-on-step.sh` from asserting `OggS`/`OpusHead`/
  mono/16000 to asserting the saved meeting folder contains `audio.m4a`, that
  `ftyp` sits at bytes 4..8, and that the desktop's `decode_aac_m4a` accepts
  it — the harness gets stronger assertions, not fewer, and is not deleted.
- Two follow-ups this phase owes before it lands: (a) the wire-size cost of
  shipping `.m4a` instead of 32 kbps Opus is paid by lowering
  `AAC_DEFAULTS.bitRate` in `src/capture/recorder.ts` (currently 128 kbps at
  44.1 kHz mono), gated on a measured file-size comparison of the same
  meeting recorded both ways, keeping 44.1 kHz so the desktop's band-limited
  `rubato` resampler does the downsample rather than the phone's own encoder;
  (b) an ASR quality comparison between the current on-phone Opus path and
  the raw-`.m4a` path has not been run and is the measurement most likely to
  overturn this decision.

**Gate (orchestrator-run):** full existing gate (lint/typecheck/test/build +
`assembleDebug` in `minutist/android-build:local`) plus the adapted
`e2e/validate-transcode-on-step.sh`.

**Workflow shape:** standard coding tiering — sonnet implements, haiku runs
the gate, opus reviews (with the mandate to verify the on-device artifact is
an `.m4a`, not that a report says so); loop until green + no findings.

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
  through the real app UI (not the spike harness), file hands off as
  `.m4a` per the Phase 1 decision, meeting saved via `saveCaptured`.

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
