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
own it. Output is **AAC**; the phone does not encode Opus. The desktop
transcodes AAC → Opus when it adopts the meeting (the pipeline ingests
`audio.opus`).

Highest-risk component: the foreground service surviving Doze on real OEM
handsets is the make-or-break behaviour and is validated on a device, not in CI
(see `docs/BUILD.md` and the background-recording spike).

## 3. Native sync plugin (`src/sync/` bridge + `android/` native lib)

The desktop `sync` crate (iroh endpoint, the custom notes ALPN, `iroh-blobs`
media transfer, the Yjs/yrs notes CRDT) compiled to an Android library via
UniFFI and called from the webview through a Capacitor plugin. The phone is just
another paired iroh endpoint speaking the **identical wire protocol** — nothing
on the wire changes.

This reuse is not free; it requires desktop-repo work tracked in the app repo
and the planning issue:

- decoupling the `sync` crate from the heavy `persistence` crate (extracting a
  `notes-crdt` leaf so the phone build does not drag in `libsql`/`audiopus`/`ogg`
  C deps);
- a hand-rolled `iroh-blobs` FFI surface (upstream `iroh-ffi` exposes core iroh
  but **not** `iroh-blobs`) — this is the load-bearing spike; the media-blob half
  carries the captured audio.

## Cross-repo contracts the phone consumes

| Contract | Owner | Note |
|---|---|---|
| Sync wire protocol (ALPNs, frame format, lib0 v1/v2 boundary, StreamKind tags, pairing/auth) | app repo `crates/sync` | A non-Rust client now consumes it; it must be treated as a documented contract, not an internal detail. |
| Notes CRDT (Yjs v1 updates) | app repo `crates/persistence` ydoc | yrs ↔ yjs v1 wire-compat is already tested in-tree. |
| Audio hand-off (AAC on device → desktop transcodes to Opus) | app repo pipeline | The phone never produces Opus. |
| Device pairing / identity | app repo + relay | Reuses the connected-tier device registry; auto-discovery pairing is deferred (manual ticket for now). |

## What the phone does NOT contain

No ASR, diarisation, summarisation, or any model. No Opus encoder. No direct
connector (AI-vendor) channel. If any of these appears here, the thin-client
boundary has been violated.
