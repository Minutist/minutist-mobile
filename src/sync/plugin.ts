/**
 * TypeScript facade for the native `SyncFfi` Capacitor plugin
 * (android/app/src/main/java/ai/minutist/companion/SyncPlugin.kt), the thin
 * bridge to the Rust `FfiSyncEngine`. All shapes here are plain JSON; the
 * `SyncClient` implementation in capacitor.ts maps them to the Meeting model in
 * types.ts. Do not use this directly from views — go through `SyncClient`.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** The JSON meeting shape emitted by `SyncPlugin.meetingToJs`. */
export interface NativeMeeting {
  state: 'captured-unprocessed' | 'synced';
  id: string;
  title: string;
  startedAtMs: number;
  // Captured only:
  durationMs?: number;
  hasNotes?: boolean;
  processing?: 'pending' | 'claimed';
  claimedBy?: string;
  audioUri?: string;
  // Synced only:
  transcript?: { speakerIndex: number; startMs: number; endMs: number; text: string }[];
  summary?: string;
  speakers?: string[];
  /** Opaque Yjs v1 update bytes, base64-encoded across the bridge. */
  notesB64?: string;
}

export interface SyncFfiPlugin {
  start(opts: { relayUrl: string; relayAuthToken?: string }): Promise<void>;
  endpointId(): Promise<{ endpointId: string }>;
  peerIds(): Promise<{ peerIds: string[] }>;
  localMeetings(): Promise<{ meetingIds: string[] }>;
  saveCaptured(opts: {
    title: string;
    startedAtMs: number;
    durationMs: number;
    audioSrcPath?: string;
    notesText: string;
  }): Promise<{ id: string }>;
  listMeetings(): Promise<{ meetings: NativeMeeting[] }>;
  getMeeting(opts: { id: string }): Promise<{ meeting: NativeMeeting | null }>;
  /**
   * Change a meeting's title. Writes both the local `metadata.json` and the
   * `notes.ydoc` authored-metadata CRDT (the latter is what makes the new title
   * converge to the account's other devices once the notes doc is next pushed).
   * Rejects an empty/whitespace title.
   */
  renameMeeting(opts: { meetingId: string; title: string }): Promise<void>;
  syncNotes(opts: { peerId: string; meetingId: string }): Promise<void>;
  syncMedia(opts: { peerId: string; meetingId: string }): Promise<void>;
  /** Pull derived artifacts (transcript/summary) for a meeting from a paired peer. */
  syncArtifacts(opts: { peerId: string; meetingId: string }): Promise<void>;
  discoverWith(opts: { peerId: string }): Promise<{ meetingIds: string[] }>;
  addAccountPeer(opts: {
    endpointId: string;
    relayUrl: string;
    /** The peer's direct addresses ("ip:port") from the account directory, so a
     *  same-tailnet/LAN peer is dialled directly instead of via the relay. Empty
     *  falls back to relay. */
    directAddrs: string[];
  }): Promise<void>;
  /**
   * Tell the engine whether the account directory holds any device besides this
   * one, which is what gates minting the account content key.
   *
   * `false` means this device is alone and mints, becoming the founder; `true`
   * means others exist and it waits to be enrolled by one of them. Once a key is
   * held this is a no-op, so it only matters on a keyless device. Passing `false`
   * when others do exist is the harmful direction — it mints a key no peer holds
   * and every exchange fails until enrolment overwrites it — so a caller that
   * cannot tell must pass `true`, where the device waits and recovers. Rejects if
   * the mint itself fails, which is a fault to surface rather than a prompt.
   */
  noteAccountPeers(opts: { hasOtherDevices: boolean }): Promise<void>;
  /** Whether this device holds the account content key. False means it can sync
   *  nothing yet — distinct from signed-out and from cannot-reach-relay. */
  isEnrolledSelf(): Promise<{ enrolled: boolean }>;
  /** This device's own filtered direct addresses ("ip:port"), for publishing to
   *  the account directory alongside the endpoint id. */
  ownDirectAddrs(): Promise<{ directAddrs: string[] }>;
  /**
   * Remove an account-sourced peer that has left the account. Source-aware on the
   * Rust side: only `Account`-tagged peers are removed, never a manually paired
   * one. Returns whether a peer was actually removed.
   */
  removeAccountPeer(opts: { endpointId: string }): Promise<{ removed: boolean }>;
  /**
   * Return the once-only DEBUG credential seed injected via the launch-intent
   * extra `minutist_seed_credential`, then clear it from native memory.
   * Returns `{ seed: string }` or `{ seed: null }` when none was injected
   * (or in release builds where the path is compiled out).
   */
  getSeedCredential(): Promise<{ seed: string | null }>;
  /**
   * Acquire/release the wifi hold for a sync window (a high-perf WifiLock so the
   * radio doesn't idle-drop the relay socket mid-transfer). Scoped by the client
   * around a push, NOT the engine lifetime. Both are idempotent.
   */
  beginSyncHold(): Promise<void>;
  endSyncHold(): Promise<void>;
  shutdown(): Promise<void>;
  /** Fired when an inbound lifecycle event lands; the client re-snapshots. */
  addListener(
    eventName: 'meetingsChanged',
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
}

// No fallback object is registered here: this is the real sync bridge, and on
// a platform with no native SyncFfi implementation every call must reject
// rather than resolve with invented data, so callers learn immediately.
// Keeping a platform off this binding entirely (e.g. selecting a mock client
// instead of calling through here) is getSyncClient()'s job (src/sync/client.ts),
// not this file's.
export const SyncFfi = registerPlugin<SyncFfiPlugin>('SyncFfi');
