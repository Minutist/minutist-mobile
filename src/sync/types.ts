/**
 * Domain types for the sync boundary.
 *
 * These types define what the rest of the app consumes — they are the
 * phone-side model of meetings, pairing, and sync status.  They deliberately
 * contain no iroh/yjs-wire/native imports; the Yjs notes payload is carried as
 * an opaque Uint8Array (a serialised Yjs v1 update) so this file is safe to
 * import in any context.
 */

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * An opaque string that encodes an iroh node ticket (NodeId + derp-url).
 * The phone and desktop exchange these once to learn each other's addresses;
 * the format is owned by the desktop `sync` crate and is intentionally opaque
 * here.
 */
export type PairingTicket = string & { readonly __brand: 'PairingTicket' };

// ---------------------------------------------------------------------------
// Meeting model — two mutually-exclusive states
// ---------------------------------------------------------------------------

/**
 * A meeting that exists only on this device: recorded audio, possibly some
 * typed notes, but no desktop has adopted and processed it yet.
 *
 * `audioUri` is the platform content-URI of the AAC file written by the
 * recorder plugin; it may be absent if the capture was notes-only.
 */
export interface CapturedUnprocessedMeeting {
  readonly state: 'captured-unprocessed';
  readonly id: string;
  readonly title: string;
  readonly startedAt: number; // Unix epoch ms
  readonly durationMs: number;
  readonly audioUri?: string;
  readonly hasNotes: boolean;
}

/**
 * A meeting that has been adopted by a desktop, processed (ASR + diarisation +
 * summarisation), and synced back to this device.  The data is read-only on the
 * phone; edits happen on the desktop.
 *
 * `speakers` is an ordered list of display labels (e.g. "Speaker 1",
 * "Andrew") indexed from 1 to match the `--speaker-N` CSS palette tokens in
 * theme.css.
 *
 * `notes` is an opaque Yjs v1 update payload (the notes CRDT state vector),
 * carried as raw bytes so this type does not depend on the yjs library.
 */
export interface SyncedMeeting {
  readonly state: 'synced';
  readonly id: string;
  readonly title: string;
  readonly startedAt: number; // Unix epoch ms
  readonly transcript?: TranscriptSegment[];
  readonly summary?: string;
  readonly speakers?: string[];
  /** Opaque Yjs v1 update bytes — do not interpret, only display via a Yjs doc. */
  readonly notes?: Uint8Array;
}

/** A single diarised transcript segment. */
export interface TranscriptSegment {
  /** 1-based index into the speaker palette / `SyncedMeeting.speakers` array. */
  readonly speakerIndex: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** Either state a meeting can be in on this device. */
export type Meeting = CapturedUnprocessedMeeting | SyncedMeeting;

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

export type SyncStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly peerId: string }
  | { readonly kind: 'syncing'; readonly peerId: string; readonly meetingId: string }
  | { readonly kind: 'error'; readonly message: string };
