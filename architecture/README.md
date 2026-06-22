# Architecture — minutist-mobile

These docs describe the phone companion **as it is meant to be**, not the
journey to it. They are a deliberately light set: the phone is a single thin
client, not a multi-crate workspace, so it does not carry the app repo's
dependency table, per-crate domain ownership, or the architecture-drift commit
hook.

Read order:

1. `system-context.md` — where the phone sits: the trust boundary between the
   phone, the paired desktop(s), and the relay.
2. `components.md` — the phone's moving parts (webview UI, native recorder,
   native sync plugin) and the cross-repo contracts they depend on.

## Live-doc convention

A change that adds a component, changes how the phone talks to a desktop or the
relay, or alters a cross-repo contract (the sync wire protocol, the audio
format hand-off) updates the relevant file **in the same commit**. There is no
hook enforcing this here; review does.

## Binding boundaries (family-wide, non-negotiable)

- The phone runs **no machine learning**. Capture and view only.
- The sync channel is **end-to-end encrypted**; the relay stores only
  **ciphertext**. Never describe the relay as trusted with content.
- The connector channel (desktop → AI vendor) transits content **by design** and
  is never called "private". The phone does not touch that channel.

## Relationship to the family architecture

The authoritative, whole-system C4 model lives in the app repo
(`Minutist/minutist`, `architecture/`). The phone is a new container in that
model; when the phone's relationships change in a way the system-level diagrams
should show, that is an architecture-owner change in the app repo
(`workspace.dsl` + `containers.md` + `system-context.md`), tracked separately.
These docs are the phone's own slice.
