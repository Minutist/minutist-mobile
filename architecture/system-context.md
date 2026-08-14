# System context — the phone's slice

The phone is a capture-and-view endpoint. It never processes audio.

```
   ┌─────────────┐   AAC audio + notes (Yjs)      ┌──────────────────┐
   │   Phone     │ ───────────────────────────▶   │  Paired desktop  │
   │ (companion) │   E2E, P2P when co-present       │  (does all ML)   │
   │             │ ◀───────────────────────────    │                  │
   │ • mic       │   notes + transcript + summary   │ • ASR/diarize    │
   │ • notes     │                                  │ • summarise      │
   │ • viewer    │                                  │ • decode AAC/    │
   └──────┬──────┘                                  │   Opus at read   │
          │                                         └────────┬─────────┘
          │  relay store-and-forward (ciphertext only)       │
          └──────────────────▶  ┌───────────────┐  ◀─────────┘
                                │  sync.minutist │
                                │  .ai (relay)   │
                                └───────────────┘
```

## Trust boundary

- The phone captures audio (OS microphone) and the user's typed notes. It holds
  the device key and ciphertext only.
- A **desktop** is the only place audio is transcribed, diarised, and
  summarised. The phone shows results the desktop syncs back.
- The **relay** brokers connections and, where a desktop is offline, holds an
  encrypted store-and-forward payload. It can read none of it.

## Flows

1. **Capture** — the phone records a meeting (foreground service, screen may be
   off) and the user types notes. The meeting is "captured but unprocessed".
2. **Sync up** — audio (AAC blob) + notes (Yjs CRDT) move to a desktop: directly
   when a desktop is co-present and online, otherwise via the relay's encrypted
   inbox.
3. **Adopt + process** — exactly one desktop claims the pending meeting,
   decodes the AAC (or Opus) audio by container/extension, and runs the
   normal pipeline.
4. **Sync down** — the resulting transcript and summary sync back to the phone,
   read-only, alongside the notes CRDT.

Flows 2–4 depend on substrate that is partly built (direct P2P notes + media
blob sync is on the desktop `main`) and partly deferred (the encrypted offline
inbox, account-service auto-discovery pairing) — see the planning repo issue
`0016-phone-companion-apps` for the dependency state.
