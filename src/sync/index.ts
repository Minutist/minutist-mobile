/**
 * STUB — no real iroh/native sync.
 * Real implementation is gated on the iroh-blobs FFI spike + desktop
 * notes-crdt extraction; see planning issue 0016.
 * Do not implement the wire protocol here.
 */

import type { Meeting, PairingTicket, SyncStatus } from './types';

export type { Meeting, PairingTicket, SyncStatus };
export type { CapturedUnprocessedMeeting, SyncedMeeting, TranscriptSegment } from './types';

/**
 * Payload passed to `SyncClient.saveCaptured` after a recording stops.
 * `notes` is the raw text typed by the user during the meeting; the sync layer
 * serialises it before storage (real implementation) or stores it as-is (mock).
 */
export interface CapturePayload {
  /** Human-readable title; defaults to a timestamp string if the user typed nothing. */
  title: string;
  /** Unix epoch ms when recording started. */
  startedAt: number;
  /** Duration of the recording in milliseconds. */
  durationMs: number;
  /** Platform content-URI of the recorded AAC file, if any. */
  audioUri?: string;
  /** Raw notes text typed during the meeting. */
  notes: string;
}

/**
 * The sync boundary the UI crosses.  All views import from this interface;
 * the concrete implementation (mock or future native plugin bridge) is
 * provided via `SyncContext` / `useSync`.
 *
 * Method contracts:
 * - `pair`               — register a desktop by its pairing ticket; one-time setup.
 * - `myTicket`           — return this device's own ticket so a desktop can pair back.
 * - `listMeetings`       — snapshot read: return all meetings known to this device.
 *                          Use this once on mount to seed the list; subsequent changes
 *                          arrive through `onMeetingsChanged`.
 * - `getMeeting`         — return a single meeting by id, or null if not found.
 * - `saveCaptured`       — persist a newly-recorded meeting as captured-unprocessed;
 *                          returns the id assigned to it.
 * - `syncMeeting`        — begin pushing a captured-unprocessed meeting to the paired
 *                          desktop.  Resolution only means the push was initiated; the
 *                          captured→synced transition is delivered through
 *                          `onMeetingsChanged`, not by this promise's resolution.
 * - `onStatus`           — subscribe to status changes; returns an unsubscribe function.
 * - `onMeetingsChanged`  — subscribe to meeting-list changes; the callback receives a
 *                          fresh snapshot of all meetings whenever the list changes:
 *                          `saveCaptured`; the processing-lifecycle transitions a paired
 *                          desktop drives (captured-unprocessed `pending` → `claimed`
 *                          when a host adopts it → `synced` once its results arrive); or
 *                          any other unsolicited update from a paired desktop.  Returns
 *                          an unsubscribe function.  Callers must unsubscribe on unmount.
 */
export interface SyncClient {
  pair(ticket: PairingTicket): Promise<void>;
  myTicket(): Promise<PairingTicket>;
  listMeetings(): Promise<Meeting[]>;
  getMeeting(id: string): Promise<Meeting | null>;
  saveCaptured(payload: CapturePayload): Promise<string>;
  syncMeeting(id: string): Promise<void>;
  /**
   * Publish this device's iroh endpoint to the account directory and add every
   * other device on the account as an iroh peer, enabling account-mediated
   * auto-discovery. Best-effort: network failures are silent no-ops. Safe to
   * call repeatedly — `add_account_peer` on the Rust side de-dups by endpoint id.
   */
  refreshAccountPeers(): Promise<void>;
  onStatus(cb: (status: SyncStatus) => void): () => void;
  onMeetingsChanged(cb: (meetings: Meeting[]) => void): () => void;
}

