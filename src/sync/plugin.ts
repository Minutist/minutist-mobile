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
  myTicket(): Promise<{ ticket: string }>;
  endpointId(): Promise<{ endpointId: string }>;
  pair(opts: { ticket: string }): Promise<{ peerId: string }>;
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
  syncNotes(opts: { peerId: string; meetingId: string }): Promise<void>;
  syncMedia(opts: { peerId: string; meetingId: string }): Promise<void>;
  /** Pull derived artifacts (transcript/summary) for a meeting from a paired peer. */
  syncArtifacts(opts: { peerId: string; meetingId: string }): Promise<void>;
  discoverWith(opts: { peerId: string }): Promise<{ meetingIds: string[] }>;
  addAccountPeer(opts: { endpointId: string; relayUrl: string }): Promise<void>;
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

export const SyncFfi = registerPlugin<SyncFfiPlugin>('SyncFfi');
