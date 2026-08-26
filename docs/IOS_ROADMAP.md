<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# iOS support — phased roadmap

Plan for porting the companion to iOS. Written to be executed as a sequence of
coding workflows (`.claude/workflows/`, one script per phase, in the style of
`build-phone-shell.js`): each phase has a concrete gate the orchestrator runs
itself, and phases are ordered so everything that can run on the current Linux
host runs first. Phases 3–7 run on the macOS host and the on-device legs need
the test iPhone (both described under Hosts); Phases 8 and 9 run on
GitHub-hosted macOS runners rather than a dev Mac (see D3).

Estimates assume the two Phase-0 spikes land clean. Total: roughly 5–8 weeks
of focused work to a TestFlight build at Android parity minus background sync.

## Hosts

- **`mm`** — Mac mini (`Macmini7,1`, i5-4278U, 4 threads, 8 GB RAM), macOS
  15.7.9 Sequoia via OpenCore Legacy Patcher, Xcode 16.4 with the iOS 18.5 SDK
  and Swift 6.1.2, iOS 18.6 simulator runtime. Reached over ssh, and the whole
  clone → build → install → launch loop runs headless, so nothing below needs a
  GUI session except device pairing and certificate setup. Toolchain: Rust
  1.91.0 (the pin in the desktop repo's `rust-toolchain.toml`) with the
  `aarch64-apple-ios`, `x86_64-apple-ios` and `aarch64-apple-ios-sim` targets,
  plus Node 22. Both are exported from `~/.zshenv`, which non-interactive ssh
  reads and `.zshrc` is not. CocoaPods is absent and unnecessary — Capacitor 8
  builds through Swift Package Manager.
  Two consequences of the patched OS: the simulator exposes no Metal device
  (WebKit renders correctly regardless), and a toolchain failure here needs care
  before it is blamed on the code. Device results are unaffected, because the
  phone rather than the Mac produces the evidence in Phases 0, 6 and 7.
- **Test iPhone** — running iOS 15.8.8. The app's floor is iOS 15.0: every
  first-party Capacitor plugin pins `ios.deployment_target = '15.0'`. The device
  clears that by one major version with no headroom, so any Capacitor bump that
  raises the floor to iOS 16 orphans it. Xcode 16.4 carries `DeviceSupport` for
  15.0–16.4 but not 15.8, which must be supplied before the device legs run.
- **Signing** — working headlessly. The Apple Developer Program membership is
  held; an App Store Connect API key authenticates against the API; and the
  bundle id `ai.minutist.companion`, an Apple Development certificate and the
  test iPhone are all registered under team `UQL2NA6679`. A signed
  `arm64-iphoneos` build has been produced over ssh (platform IOS, minos 15.0,
  sdk 18.5). Credentials and setup notes live off-repo beside the Android
  keystore.
  The certificate lives in a dedicated keychain on `mm` rather than the login
  keychain, because an ssh session runs in a different security session and
  cannot reach the login keychain at all — so a certificate created in Xcode's
  GUI cannot sign an ssh-driven build. Three things there fail silently and are
  settled: keychain unlock does not survive between separate ssh invocations,
  Apple's WWDR intermediate must sit in the same keychain or the chain will not
  validate, and `security set-key-partition-list` is required or `codesign`
  blocks on a prompt nobody can answer.
  `devicectl` is not a valid check for this device: CoreDevice handles iOS 17
  and later, so the iOS 15.8 test iPhone reports `unavailable`/`unpaired` there
  however it is configured. `xcrun xctrace list devices` shows its real state.
- **Device observability** — `libimobiledevice` is installed on `mm` via
  MacPorts, which supplies the two channels Apple's own tooling cannot reach on
  this hardware: `idevicescreenshot` captures the phone's screen, and
  `idevicesyslog` reads the device log (`log stream --device` was removed in
  macOS 15, and the `devicectl` route needs iOS 17). Both work unattended, so a
  device leg can be verified without anyone touching the phone.
  Launch method decides whether that screenshot is worth taking.
  `ios-deploy --justlaunch` issues `safequit`, which tears the app down moments
  after start — long enough for a plugin to write an artifact file, far too
  short to photograph. `idevicedebug -u <udid> run <bundle-id>` holds a
  debugserver session open and leaves the app on screen, and it relays the
  WebView's console to stdout as a side benefit.

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
  the only native-toolchain crate is `ring`, built by `cc`) or a pure-Rust
  encoder, and neither of the two candidates clears the bar: `opus-rs` has no
  published conformance evidence and four toy reverse dependencies;
  `unsafe-libopus` does test both its encoder and decoder against the
  IETF-published RFC 6716 test vectors for an exact match with reference
  libopus, but is 21 months past its last release, is essentially all-`unsafe`
  c2rust-transpiled output, runs roughly 20% slower for want of intrinsics,
  and has two reverse dependencies of its own — stale and unadopted rather
  than unproven. Either a CMake dependency or one of these becomes the sole
  producer of an on-disk, cross-device archival format the desktop must
  decode forever, which this decision avoids. The option reopens if a
  pure-Rust encoder acquires both conformance results and real adoption.
  Phase 1 (below) removes the Kotlin transcoder instead. What this reasoning
  does NOT establish is that ASR output is unaffected by the change; that is
  measured before the deletion lands, and Phase 1 says what happens if it
  regresses.
- **D3 — iOS CI hosting (settled).** GitHub-hosted `macos-latest`. The repo is
  public, so standard hosted runners carry no minute charge, and
  `Minutist/minutist` is public too, so a runner builds the Rust from source
  without credentials. Hosted macOS runners are arm64: the XCFramework needs
  `aarch64-apple-ios`, `aarch64-apple-ios-sim` and `x86_64-apple-ios` so the
  same artifact serves the runner and an Intel dev Mac. This also settles
  Phase 9's host — release archive and upload run in CI, not on a dev Mac,
  which matters because every Mac currently available is pre-2018 Intel and
  cannot produce an App Store-acceptable build (Apple has required Xcode 16 +
  the iOS 18 SDK for App Store Connect uploads since April 2025).
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
| 0 | Spikes: iroh-on-iOS, locked-screen recording | `mm` + iPhone | — | 3–5 d |
| 1 | Remove on-phone transcode, adopt raw AAC hand-off | Linux + Android device | ASR comparison\* | 1 d + measurement |
| 2 | Platform-seam prep in TS + docs | Linux | — | 1–2 d |
| 3 | iOS shell scaffold + assets | `mm` | 0 | 1–2 d |
| 4 | Rust → XCFramework + UniFFI Swift bindings | `mm` | 0 | 3–5 d |
| 5 | `SyncPlugin.swift` port | `mm` | 4 | 3–5 d |
| 6 | Recording: audio background mode + interruptions | `mm` + iPhone | 3 | 5 d |
| 7 | Background sync per D1 | `mm` + iPhone | 5, D1 | 2–5 d |
| 8 | Tests + CI (macOS lane) | CI (`macos-latest`) | 5, 6 | 5 d |
| 9 | TestFlight / App Store | CI (`macos-latest`) | all | 2–4 d + review latency |

Phase 1's deletion of the Kotlin transcoder is a real Android code-quality
improvement independent of the iOS outcome, and is ordered only by its own ASR
measurement. Phase 0 is a hard go/no-go gate: if iroh/quinn does not work on
iOS, phases 3–9 are moot. Phase 3 does not strictly depend on it — the scaffold
already builds and launches on `mm` — but nothing past Phase 3 is worth
building until Phase 0 passes.

\* Phase 1's 1 d estimate covers the deletion work, whose gate is pure Linux.
The ASR comparison that precedes it needs a recording made on a physical
Android device and a run of the desktop's ASR pipeline, so the phase as a
whole is not Linux-only. Nothing else in the roadmap depends on Phase 1, so
that measurement blocks only itself.

---

## Phase 0 — Spikes (go/no-go)

**Host:** `mm` + the test iPhone. **Repos:** desktop (`crates/sync-ffi`) +
this one. Signing and device registration are done (see Hosts), so neither
spike is blocked on those. Installing to the device still needs tooling that
handles pre-iOS-17 hardware, since `devicectl` covers iOS 17 and later only.

Two unknowns of the same class as the Android `iroh-blobs` spike and the
60-minute Doze spike (planning issue `0016`):

Relay admission uses the per-device account credential from device-code sign-in
(`src/account/signin.ts` -> `src/sync/capacitor.ts`), so the transport legs below
are exercised by signing in on the device, not by injecting a token.
`VITE_RELAY_AUTH_TOKEN` is a development fallback for builds that cannot complete
sign-in and tests the fallback rather than the real path.

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

**0a result — the engine runs on iOS, on the target device.** Recorded from
`/Documents/syncffi-probe.json` on the iPhone 6s (iOS 15.8.8): the engine
started, reported endpoint id
`a840a180818d72c69bd9fa62aa7ba596247e017c99d36a3f73875de8bef1b71f`, discovered
its own LAN address (`192.168.0.116:55384`), and left `sync-data/sync_node_key`
and `meetings/.blobs/blobs.db` on disk. So tokio, ed25519 key generation and
persistence, the iroh endpoint, local-address discovery through
SystemConfiguration, and the blob store all work on A9 hardware at the app's
stated floor. The endpoint id differs from the simulator's, confirming a
per-device key rather than a shared fixture.

**0a blocker found and resolved — a dependency cannot run below iOS 18.**
`netdev` 0.44/0.45, reached through `netwatch` <- `iroh`, declares and calls
`nw_path_is_ultra_constrained`: a Network.framework symbol exported in the SDK's
`.tbd` but absent from every public header, and missing on iOS below 18. dyld
aborts the app at launch, before any code runs.

`netdev` 0.46.1 dropped the call, and `netwatch` 0.19.3 requires `^0.46.1`
everywhere except Windows, so the fix is a plain version bump rather than a
patch: the desktop repo's lock carries netwatch 0.19.3, and nothing needs to be
re-applied on future updates. An earlier `[patch.crates-io]` rev pin against
`net-tools` did the same job and has been dropped — a pin that has to be
reapplied by hand ships a non-launching binary the first time someone forgets.

Two traps worth remembering from the pinned period. Cargo's `[patch]`
substitutes a SOURCE for a matching version and will not raise the resolved
version to reach the patch, so it silently reports "patch was not used" and
builds the old code until an explicit `cargo update --precise` makes the
versions meet — the failure is indistinguishable from success until a device
refuses to launch. And every Network.framework symbol the library imports should
be checked against the public headers, not only the one that failed; the other
19 were all public.

The check that settles it belongs on the built artifact, not the manifest:
`nm -u` over the iOS static library must report no
`nw_path_is_ultra_constrained`.

**The sync protocol is a hard cut at ALPN `/2`.** Every frame is sealed under an
account content key, and a device only holds that key once a user has confirmed
it. `minutist/sync/notes/1` and `/2` do not interoperate, so an un-upgraded
phone syncs nothing at all against a current desktop or hub — a state that looks
like a connectivity fault rather than a version mismatch. Two consequences for
this roadmap: the phase 0a transport legs are meaningless against a library
older than the cut, and the phone has to drive `noteAccountPeers` itself once
per successful account-directory poll, because it does not run the Rust
account-refresh loop that gives desktop and the hub the same signal for free.
Without that call the device never mints a key, never enrols, and every sync
fails as unauthenticated with no recovery path.

**Device diagnostics do not come from logs.** macOS 15 removed
`log stream --device`, and `devicectl` covers iOS 17+ only, so there is no CLI
route to this handset's unified log. On-device legs must write files and pull
them with `ios-deploy --download=/Documents --to <dir>`. Note that
`--download=<single-file>` and `--list=/Documents` both report nothing on a
directory that is in fact full; `--list=/` is the reliable form.

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
  `AacToOpusTranscoder.kt` and `opusTranscode.ts` carry doc comments that
  describe the desktop transcoding AAC on adoption; that premise is already
  corrected in `src/sync/capacitor.ts` and `src/capture/recorder.ts` (see D2)
  and does not need fixing in the files this phase deletes.
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
- Two measurements, both on a meeting recorded both ways on a physical device.
  Today's path is a double lossy transcode (AAC decode → resample → Opus
  encode, then Opus decode again wherever the audio is consumed); the
  raw-`.m4a` hand-off removes the middle step. That argument is about signal
  fidelity and is sound on its own terms, but ASR word-error-rate is not a
  monotone function of signal fidelity — the pipeline's acoustic model sees
  16 kHz Opus-decoded audio today, and changing what it is fed is an empirical
  question, not a deductive one.
  - **(b) is decisive and runs before the deletion lands.** Compare ASR output
    between the current on-phone Opus path and the raw-`.m4a` path against the
    desktop's own pipeline. If quality regresses, D2 is not thereby reversed —
    the likelier fix is to change what the phone records (16 kHz mono AAC,
    matching what the pipeline consumes) rather than to reinstate a transcoder
    on two platforms — but the shape of this phase changes, so the measurement
    precedes the deletion commit.
  - **(a) is tuning, and does not gate.** The wire-size cost of shipping
    `.m4a` instead of 32 kbps Opus is paid by lowering `AAC_DEFAULTS.bitRate`
    in `src/capture/recorder.ts` (currently 128 kbps at 44.1 kHz mono), sized
    by a file-size comparison. Sample rate is (b)'s to decide: keeping
    44.1 kHz lets the desktop's band-limited `rubato` resampler do the
    downsample rather than the phone's encoder, which is the better path only
    if (b) shows the pipeline is indifferent to it.

**Gate (orchestrator-run):** full existing gate (lint/typecheck/test/build +
`assembleDebug` in `minutist/android-build:local`) plus the adapted
`e2e/validate-transcode-on-step.sh`.

**Workflow shape:** standard coding tiering — sonnet implements, haiku runs
the gate, opus reviews (with the mandate to verify the on-device artifact is
an `.m4a`, not that a report says so); loop until green + no findings.

## Phase 2 — Platform-seam prep (Linux)

**Host:** Linux. Small, mechanical, keeps the Android app shippable
throughout.

- Every platform branch becomes an explicit `switch (Capacitor.getPlatform())`
  with a named `'ios'` case, in place of the old boolean `getPlatform() ===
  'android'` / `isNativePlatform()` checks: `selectForegroundServiceController()`
  in `src/capture/foregroundService.ts` (foreground-service controller →
  no-op on iOS in this phase; Phase 6 replaces it if session management needs
  a JS-visible seam) and `createSyncClient()` in `src/sync/client.ts`
  (`'ios'` → `mockSyncClient`).
- Comments that say "Android" but mean "native" get corrected; comments that
  genuinely mean Android stay (e.g. the wifi-lock notes).
- `docs/BUILD.md` gains an iOS section stub; `architecture/components.md`
  gains the iOS container notes (what maps to what, what has no analogue —
  the table from this roadmap's analysis).

**Gate:** `npm run lint && npm run typecheck && npm test && npm run build`,
Android assemble unchanged.

**Landed on this branch:** the `switch` seams in `foregroundService.ts` and
`client.ts`, the `docs/BUILD.md` iOS section, and the
`architecture/components.md` iOS analogue notes are all committed.

## Phase 3 — iOS shell scaffold

**Host:** `mm`. Xcode 16.4; Swift Package Manager, not CocoaPods.

- `npm i @capacitor/ios && npx cap add ios`; commit the generated `ios/`
  project with the same hygiene the `android/` tree got — gitignore
  `DerivedData`, SPM build products under `ios/App/CapApp-SPM/.build`, and
  `xcuserdata`. `cap add ios` defaults to SPM and writes
  `ios/App/CapApp-SPM/Package.swift` at `swift-tools-version: 5.9`; leaving the
  default is deliberate, since it is the path Capacitor maintains.
- `Info.plist`: `NSMicrophoneUsageDescription`, `UIBackgroundModes: [audio]`,
  `ITSAppUsesNonExemptEncryption` (expected `false` — standard TLS/QUIC is
  exempt, but record the reasoning in `store/`), display name "Minutist",
  bundle id `ai.minutist.companion`.
- Icons/splash via `@capacitor/assets` from the existing `assets/` sources.
- Safe-area pass on the web UI: `viewport-fit=cover` in `index.html`,
  `env(safe-area-inset-*)` in `App.css`/view CSS (notch, home indicator,
  keyboard accessory). Status-bar styling via the already-present
  `@capacitor/status-bar`.
- App boots to the Capture view in the simulator with the mock sync client —
  the Phase 2 seam's `case 'ios'` in `createSyncClient()` (src/sync/client.ts)
  already returns `mockSyncClient`, so this phase needs no client.ts change.

**Landed on this branch:** the SPM scaffold (`ios/` committed, with a shared
scheme and `Package.resolved`), all six Capacitor plugins linked, the
`Info.plist` keys, generated app icon and splash, the safe-area CSS, and
`scripts/ios-build-on-mac.sh` — which builds on `mm`, installs, launches,
confirms the process survives a settle, and fetches a screenshot.

The gate below is only partly exercised. The build and launch legs run; the
"record button reaches the permission prompt" leg does not, because the smoke
harness performs no UI interaction. Nothing here has run on a physical device
or on an iOS 15 runtime, and only the Debug configuration has ever been built.

**Gate:** `xcodebuild -project ios/App/App.xcodeproj -scheme App -destination
'generic/platform=iOS Simulator' build` clean — note `-project`, as the SPM
layout has no `.xcworkspace`. Then a headless simulator smoke via `xcrun
simctl install` + `launch` + `io screenshot`: the Capture view renders and the
record button reaches the permission prompt.

## Phase 4 — Rust → XCFramework + Swift bindings

**Host:** Mac. **Repos:** desktop (build tooling) + this one (consumption).

- `scripts/build-sync-ffi-ios.sh`, sibling of `build-sync-ffi.sh`: cargo
  build for `aarch64-apple-ios`, `aarch64-apple-ios-sim` and
  `x86_64-apple-ios` — all three, because simulator architecture follows the
  host and the app already links a fat `x86_64 arm64` simulator binary on `mm`
  while the CI runners are arm64. Then `uniffi-bindgen` Swift output
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
- Change `case 'ios'` in `createSyncClient()` (src/sync/client.ts) from
  `mockSyncClient` to `new CapacitorSyncClient()`, and flip the `ios`
  expectation in src/sync/client.test.ts to assert `CapacitorSyncClient` is
  constructed.

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

**Host:** GitHub-hosted `macos-latest` (per D3).

- XCTest for `SyncPlugin.swift` (projection, coercion, engine-not-started
  rejection paths — the Robolectric suite is the checklist).
- Maestro iOS lane: port `e2e/flows/*.yaml` (Maestro flows are largely
  cross-platform; the `run-on-step.sh` harness needs an iOS-simulator
  sibling).
- CI: a `macos-latest` job mirroring the `android` job's scope. Unlike that
  job it can produce a functional binary: `Minutist/minutist` is public, so
  the runner checks the crate out and builds the XCFramework itself, and the
  iOS toolchain is host-Xcode rather than a locally-built Docker image. Decide
  whether to build the framework per-run or consume a published artifact —
  the same choice `store/CI_PUBLISH.md` records for the Android `.so`, and
  worth answering once for both.

**Gate:** CI green on a PR that touches `ios/`, Maestro smoke flow passes on
a simulator.

## Phase 9 — TestFlight / App Store

**Host:** GitHub-hosted `macos-latest` (per D3) — the archive and upload run
in CI. No dev Mac currently available can do this leg: every one is pre-2018
Intel, capped below the Xcode 16 / iOS 18 SDK that App Store Connect has
required since April 2025. Prereqs: Apple Developer Program membership
($99/yr) under the same entity as the Play listing.

- Signing in CI: an App Store Connect API key (`.p8` + key id + issuer id)
  rather than an Apple ID, so upload needs no interactive 2FA, plus the
  distribution certificate and provisioning profile — `fastlane match` against
  a private cert repo, or base64 secrets. Secrets live off-repo alongside the
  Android keystore under `minutist-secrets/`.
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

## Web-platform floors outside this repo

Sign-in leaves the app for the identity provider's own pages, so their browser
floor matters as much as ours, and a break there is just as fatal to the flow.
The app's own stylesheets use no `hsl()` at all, so everything below concerns
Rauthy's frontend only.

**Unitless `hsl()` components are dropped below Safari 18 / Chrome 121 /
Firefox 122.** Measured at both ends with a probe page reporting `CSS.supports`
and `getComputedStyle`:

| declaration | iOS 15.8.8 (device) | iOS 18.6 (simulator) |
| --- | --- | --- |
| `hsl(0 45 33)` | false → `rgba(0, 0, 0, 0)` | true → `rgb(122, 46, 46)` |
| `hsl(0 45% 33%)` | true → `rgb(122, 46, 46)` | true → `rgb(122, 46, 46)` |
| `hsla(0 45 33 / .93)` | false → `rgba(0, 0, 0, 0)` | true → `rgba(122, 46, 46, 0.93)` |
| `hsla(0 45% 33% / .93)` | true → `rgba(122, 46, 46, 0.93)` | true → `rgba(122, 46, 46, 0.93)` |

This is what makes Rauthy's buttons invisible. Its theme CSS stores each colour
as a unitless triple (`--action: 0 45 33`) and wraps it at the point of use
(`background: hsla(var(--action) / .93)`). Below the floor that whole
declaration is discarded, so the button keeps its transparent initial
background, while `--btn-text: white` is a plain keyword and survives — white
text on the white page, which is why there is nothing to press.

Note the floor is *not* an iOS 15 artefact, unlike the other compatibility
limits recorded here. Per MDN's compat data the feature landed in Chrome 121
and Firefox 122 (both 2024-01-23) and Safari 18 (2024-09-16), so **every iOS
below 18 is affected** — 15, 16 and 17 alike — and on iOS there is no way out,
because every browser there is WebKit. Android and desktop browsers are
updatable and mostly past the floor, but any client older than early 2024 sees
the same blank buttons.

The fix is in Rauthy's `ThemeCss::append_css`
(`src/data/src/entity/theme.rs`): emit `{} {}% {}%` rather than `{} {} {}` for
the seven colour variables. Percentage form is accepted by every engine that
accepts the unitless form — including all of the above — so it costs nothing on
newer browsers and is strictly wider support. There is no configuration route,
as the format string is compiled in, so the deployment runs a patched build.

Two general lessons for the remaining device legs. A probe page reporting
`CSS.supports` plus `getComputedStyle`, loaded on the device and screenshotted,
settles a compatibility question in minutes and does not depend on caniuse
having an entry; run it against a supported OS too, or the floor gets
attributed to whichever old device happened to find it. And the failure mode to
expect from this class of bug is a *partial* render — half the cascade applies —
rather than a blank page, so it reads as a styling oddity rather than the hard
incompatibility it is.

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
- The Mac host is provisioned, so the build and simulator phases (3–5) are
  schedulable on it. Phases 0a/0b, 6 and 7 additionally need the test iPhone
  plus a codesigning identity on `mm` and a device registered in the account;
  8 and 9 need CI.
