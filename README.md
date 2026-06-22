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

Early scaffold. Nothing here records or syncs yet. What exists:

- repository skeleton, licensing, CI shape, and the headless Android build image;
- a build/test/review loop (`.claude/workflows/build-phone-shell.js`) that builds
  the app shell under separate model agents.

What is NOT here yet: the capture UI, the native recorder plugin and its Android
foreground service, the native sync plugin, and any real device build. The two
make-or-break unknowns — a 1-hour locked-screen background recording on a real
handset, and whether the `iroh-blobs` stack cross-compiles to Android — are
spikes, not settled facts. See the design history in the planning repo
(`Minutist/planning`, issue `0016-phone-companion-apps`).

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
src/                 webview app (React + Vite), lean capture surface
  styles/theme.css   desktop design tokens, reused verbatim
  capture/           recording + quick-notes surface
  sync/              JS side of the native sync plugin bridge
android/             generated Capacitor Android project (committed; build outputs ignored)
docker/android-build Headless Android build image (Dockerfile + notes)
architecture/        the phone container's C4 docs
docs/                build + signing runbook
.github/workflows/   CI (lint · typecheck · unit · web build · android assemble)
.claude/workflows/   the build/test/review loop
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
step — see `docs/BUILD.md`. Instrumented tests and the background-recording
acceptance need a real device and are not part of the automated loop.

## Licence

Code is AGPL-3.0-only. The name, logo, and app icons are trademark-reserved and
are NOT under the code licence — see `TRADEMARKS.md` and `REUSE.toml`.
