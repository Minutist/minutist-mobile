# Components — minutist-mobile

Three moving parts plus the contracts they consume from the desktop.

## 1. Webview UI (`src/`)

A lean capture surface hosted in the Capacitor webview (React + Vite). Not the
full desktop editor — a record control, a quick-notes field, and a read-only
viewer for synced notes / transcripts / summaries. It reuses the desktop design
tokens (`src/styles/theme.css`) so it is visually the same product; it does not
reuse the desktop's full Tiptap editing surface.

Webview contenteditable quirks (iOS/Android caret/selection, keyboard accessory)
are a known cost of any webview editor and are handled with VisualViewport-based
keyboard sizing if/where editing is offered.

## 2. Native recorder plugin (`android/`, Capacitor plugin)

Captures meeting audio and survives screen-off, hour-long sessions. On Android
this means a **foreground service** with `microphone` service type and an
ongoing notification — the recorder library does not provide the service; we
own it. Output is **AAC** in an m4a container. On Android API 29+ this is
currently transcoded to Opus on-device before sync; API 24-28 hands the m4a
over unchanged. Nothing transcodes on adoption either way: as the phone
saves the capture, `sync-ffi` — the phone-side UniFFI wrapper — sniffs the
container magic and writes `audio.m4a` (`codec: "aac"`) or `audio.opus` to
match the real bytes, and on the desktop `persistence`'s `read_audio_pcm`
decodes whichever it finds by extension at read time. The settled decision
is to remove the on-phone transcode so the m4a is always what is handed
over — see `docs/IOS_ROADMAP.md`.

Highest-risk component: the foreground service surviving Doze on real OEM
handsets is the make-or-break behaviour and is validated on a device, not in CI
(see `docs/BUILD.md` and the background-recording spike).

## 3. Native sync plugin (`src/sync/` bridge + `android/` native lib)

The desktop `sync` crate (iroh endpoint, the custom notes ALPN, `iroh-blobs`
media transfer, the Yjs/yrs notes CRDT) compiled to an Android library via
UniFFI and called from the webview through a Capacitor plugin. The phone is just
another paired iroh endpoint speaking the **identical wire protocol** — nothing
on the wire changes.

This reuse landed via the `sync-ffi` UniFFI wrapper over the desktop
`sync::SyncEngine` (merged desktop-repo work: the `notes-crdt` leaf extraction —
plus the `update_metadata` lift into it — that keeps `libsql`/`audiopus`/`ogg`
out of the phone build, and the `crates/sync-ffi` crate itself). Wrapping our
OWN `SyncEngine` — not upstream `iroh-ffi` — keeps `iroh-blobs` entirely
internal: `sync_media` / `import_media` already encapsulate the media-blob
(captured-audio) transfer, so it never reaches the FFI boundary and no separate
`iroh-blobs` FFI surface is needed (the earlier "load-bearing spike" is moot).
The `.so` is cross-compiled to `aarch64-linux-android` (NDK r27 + cargo-ndk) by
`scripts/build-sync-ffi.sh`; the generated Kotlin bindings + the `SyncPlugin`
Capacitor bridge (src/sync/plugin.ts → src/sync/capacitor.ts, selected on-device
by src/sync/client.ts) surface it to the webview.

## iOS analogue (not yet built)

No `ios/` project exists in this repo yet; the sequencing that gets one built
is `docs/IOS_ROADMAP.md`. This section maps each Android-native piece above to
its iOS fate.

- `SyncPlugin.kt` -> `SyncPlugin.swift`: the same bridge surface, with
  `src/sync/plugin.ts` as the unchanging contract, calling Swift UniFFI
  bindings generated from a `SyncFfi.xcframework`. Two pieces of the Kotlin
  implementation are deliberately not ported: the wifi lock
  (`beginSyncHold`/`endSyncHold` resolve as no-ops so the JS contract keeps
  working) and the VPN-aware DNS resolution (`resolveRelayIps` returns empty,
  relying on the engine's DoH fallback) — both pending decision gate D4.
- `RecordingForegroundService.kt` (foreground service + `PARTIAL_WAKE_LOCK`)
  -> no foreground-service concept on iOS, and no iOS target exists in this
  repo yet, so `src/capture/foregroundService.ts`'s iOS arm is a no-op.
  Whether the iOS arm must instead own `AVAudioSession` activation
  (`.playAndRecord`, `UIBackgroundModes: audio`) around start/stop is open,
  decided by the roadmap's Phase 0b spike and Phase 6 — a physical iPhone is
  required to validate either answer, not the simulator.
- `SyncForegroundService.kt` -> **no analogue**. iOS has no way to hold the
  process open indefinitely for an in-flight transfer; only
  `beginBackgroundTask` (roughly 30 seconds of grace, enough to drain a small
  notes push) and opportunistic `BGProcessingTask` exist. This is what
  decision gate D1 turns on.
- `AacToOpusTranscoder.kt` / `OpusTranscodePlugin.kt` -> no analogue on either
  platform once the settled transcode decision lands: the phone hands the
  desktop its m4a and the desktop decodes it. See `docs/IOS_ROADMAP.md`.
- `MainActivity`'s DEBUG-only seed-credential injection (launch-intent extra
  -> `SyncPlugin.setPendingSeed`) -> an `AppDelegate` reading a DEBUG-only
  launch argument/environment variable with the same read-once-and-clear
  semantics. The injection mechanism differs; the purpose (skipping
  device-code sign-in in automated e2e runs) is identical.

None of these iOS-side items exist yet; building any of them needs a macOS
host.

## Cross-repo contracts the phone consumes

| Contract | Owner | Note |
|---|---|---|
| Sync wire protocol (ALPNs, frame format, lib0 v1/v2 boundary, StreamKind tags, pairing/auth) | app repo `crates/sync` | A non-Rust client now consumes it; it must be treated as a documented contract, not an internal detail. |
| Notes CRDT (Yjs v1 updates) | app repo `crates/persistence` ydoc | yrs ↔ yjs v1 wire-compat is already tested in-tree. |
| Audio hand-off (AAC on device, currently transcoded to Opus on Android API 29+; on save, phone-side `sync-ffi` sniffs the container and writes `audio.m4a` or `audio.opus` to match; desktop-side `persistence`'s `read_audio_pcm` decodes whichever it finds by extension) | app repo `crates/sync-ffi` + `crates/persistence` | Settled decision removes the on-phone transcode — see `docs/IOS_ROADMAP.md`. |
| Device pairing / identity | app repo + relay | Reuses the connected-tier device registry; auto-discovery pairing is deferred (manual ticket for now). |

## What the phone does NOT contain

No ASR, diarisation, summarisation, or any model. No direct connector
(AI-vendor) channel. If any of these appears here, the thin-client boundary
has been violated. (The on-device Opus encoder used by the current Android
transcode is being removed — see `docs/IOS_ROADMAP.md` — after which no
Opus encoder belongs on the phone either.)
