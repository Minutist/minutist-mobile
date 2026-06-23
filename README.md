# minutist-mobile

The Minutist phone companion — a thin capture-and-view client. Android first.

The phone records meeting audio and lets you type notes; it runs no machine
learning. A paired desktop does all the work — transcription, diarisation,
summarisation — and syncs the results back. The relay only ever carries
ciphertext. The phone captures, a desktop computes.

This is a deliberately thin client: it wraps the desktop's React + Tiptap web
build in a native webview (Capacitor), captures audio through a native recorder
plugin, and reuses the desktop sync (iroh + Yjs + content-addressed blobs) by
compiling that Rust crate to a native library rather than reimplementing it.

The companion is a connected-tier feature. Without a paired desktop it has
nothing to sync to.

## Status

The app shell is implemented. What exists:

- repository skeleton, licensing, CI shape, and the headless Android build image;
- a build/test/review loop (`.claude/workflows/build-phone-shell.js`);
- **Capture UI** — record control, elapsed timer, VU meter, quick-notes textarea,
  permission handling, foreground-service wiring (`RecordingForegroundService.kt`
  with microphone service type and `PARTIAL_WAKE_LOCK`);
- **Recorder facade** (`src/capture/recorder.ts`) — the single import point for
  `@capgo/capacitor-audio-recorder`; provided at the app root via `RecorderContext`
  so all views share one instance and tests can inject a mock without module-level
  patching;
- **Stubbed sync** (`src/sync/`) — typed `SyncClient` interface, `MockSyncClient`
  in-memory implementation, and `SyncContext`/`useSync` hook; provided at the app
  root so both views share one client instance;
- **Meetings view** — lists captured-unprocessed and synced meetings, pairing panel
  (own ticket display and desktop ticket input), meeting detail read-only view
  (transcript + summary + speaker colours from `--speaker-N` palette tokens);
- **Shell integration** — after stop, the app navigates to Meetings so the user can
  see and sync the new item; the app-bar status pill tracks `SyncClient.onStatus`.

Real iroh/native sync is **not implemented** — it is gated on the iroh-blobs FFI
spike and desktop `notes-crdt` extraction tracked in planning issue `0016`. The
`SyncClient` interface and `MockSyncClient` are clearly marked as stubs.

The two make-or-break device unknowns — a 1-hour locked-screen background
recording on a real handset, and whether the `iroh-blobs` stack cross-compiles to
Android — remain spikes, not settled facts. See `Minutist/planning`, issue
`0016-phone-companion-apps`.

## Architecture

The phone is a new C4 container in the Minutist family. Its slice:

- **Webview UI** — a lean capture surface (record control, quick notes, a
  read-only viewer for synced notes/transcripts/summaries) that reuses the
  desktop design tokens (`src/styles/theme.css`, the "Editorial Ink" theme:
  Fraunces/Newsreader, the warm-paper palette).
- **Native recorder plugin** — captures audio in an Android foreground service
  (microphone service type) so a screen-off, hour-long meeting keeps recording.
  Output is AAC; the desktop transcodes to Opus when it adopts the meeting.
- **Native sync plugin** — the desktop `sync` crate (iroh endpoint, the custom
  notes ALPN, `iroh-blobs` media transfer, the Yjs/yrs notes CRDT) compiled to
  an Android library via UniFFI and called from the webview. The phone is just
  another paired iroh endpoint; the wire protocol does not change.

See `architecture/` for the container's docs. The binding cross-repo boundaries
hold here too: the sync channel is end-to-end encrypted and the relay stores
only ciphertext; the phone runs no ML.

## Repository layout

```
src/                       webview app (React + Vite), lean capture surface
  styles/theme.css         desktop design tokens, reused verbatim
  App.tsx                  app shell — SyncContext + RecorderContext providers,
                           tab routing, status pill, post-stop navigation
  capture/
    recorder.ts            recorder facade (sole @capgo/capacitor-audio-recorder import)
    RecorderContext.tsx    React context + useRecorder hook for the facade
    foregroundService.ts   platform-appropriate ForegroundServiceController
  sync/
    types.ts               domain types (Meeting, SyncStatus, PairingTicket)
    index.ts               SyncClient interface + CapturePayload (STUB)
    mock.ts                MockSyncClient — in-memory, used in dev + tests
    useSync.ts             SyncContext + useSync hook
  views/
    CaptureView.tsx        record control, VU meter, quick-notes, foreground wiring
    MeetingsView.tsx       meeting list, sync action, pairing panel, read-only detail
android/                   generated Capacitor Android project (committed; build outputs ignored)
  app/src/main/java/ai/minutist/companion/
    RecordingForegroundService.kt   foreground service (microphone type, wake lock)
    RecordingForegroundServicePlugin.kt  Capacitor plugin bridge
docker/android-build       headless Android build image (Dockerfile + notes)
architecture/              the phone container's C4 docs
docs/                      build + signing runbook
.github/workflows/         CI (lint · typecheck · vitest · web build · Robolectric unit · android assemble)
.claude/workflows/         the build/test/review loop
```

## Building

The web build is plain Vite. The Android assemble runs headless in the build
image — no Android SDK on the host required:

```sh
npm ci
npm run build                 # vite build -> dist/
npx cap sync android          # copy the web build + plugin wiring into android/

# Headless debug APK in the pinned build image (honours the host-uid convention):
docker run --rm -v "$(pwd):$(pwd)" -w "$(pwd)" --user "$(id -u):$(id -g)" \
  minutist/android-build:local bash -lc 'cd android && ./gradlew assembleDebug'
```

Release signing and Play upload are a separate, secret-bearing, human-gated
step — see `docs/BUILD.md`.

Two KVM-free test layers run in CI: `npm test` (vitest, webview unit) and
`./gradlew testDebugUnitTest` (Robolectric, Android-native unit on the JVM).
Instrumented tests (Espresso, Maestro flows, forced-Doze) and the
background-recording acceptance need an emulator (KVM) or a real device and
are a separate lane — see `docs/BUILD.md` for the boundary.

## Licence

Code is AGPL-3.0-only. The name, logo, and app icons are trademark-reserved and
are NOT under the code licence — see `TRADEMARKS.md` and `REUSE.toml`.
