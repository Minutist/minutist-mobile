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
 * - `pair`          — register a desktop by its pairing ticket; one-time setup.
 * - `myTicket`      — return this device's own ticket so a desktop can pair back.
 * - `listMeetings`  — return all meetings known to this device, captured or synced.
 * - `getMeeting`    — return a single meeting by id, or null if not found.
 * - `saveCaptured`  — persist a newly-recorded meeting as captured-unprocessed;
 *                     returns the id assigned to it.
 * - `syncMeeting`   — push a captured-unprocessed meeting up to the paired desktop.
 * - `onStatus`      — subscribe to status changes; returns an unsubscribe function.
 */
export interface SyncClient {
  pair(ticket: PairingTicket): Promise<void>;
  myTicket(): Promise<PairingTicket>;
  listMeetings(): Promise<Meeting[]>;
  getMeeting(id: string): Promise<Meeting | null>;
  saveCaptured(payload: CapturePayload): Promise<string>;
  syncMeeting(id: string): Promise<void>;
  onStatus(cb: (status: SyncStatus) => void): () => void;
}

