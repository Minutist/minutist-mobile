/**
 * Domain types for the sync boundary.
 *
 * These types define what the rest of the app consumes — they are the
 * phone-side model of meetings, enrolment, and sync status.  They deliberately
 * contain no iroh/yjs-wire/native imports; the Yjs notes payload is carried as
 * an opaque Uint8Array (a serialised Yjs v1 update) so this file is safe to
 * import in any context.
 */

/**
 * Whether this device holds the account content key, which every frame on the
 * sync wire is sealed under. A device without it can sync nothing.
 *
 * Deliberately four states rather than a boolean, because `isEnrolledSelf()`
 * returning false conflates cases that need different things said to the user —
 * and only one of them is a call to action. Local capture, processing and notes
 * are untouched by the content key, so none of these states should gate or nag
 * the capture path; they annotate sync only.
 *
 * - `unknown` — the account directory has not been polled successfully yet, so
 *   nothing is known. Transient and self-healing: say nothing at all.
 * - `enrolled` — holds the key and can sync.
 * - `awaitingConfirmation` — the account has other devices and this one holds no
 *   key, so a user must confirm it on one of the others. The only call to action.
 * - `fault` — minting or reading the key failed, or the account has no other
 *   device yet this one still has no key (it should have minted). Show a
 *   diagnostic; do not tell the user to confirm on a device that may not exist.
 */
export type EnrolmentState = 'unknown' | 'enrolled' | 'awaitingConfirmation' | 'fault';

// ---------------------------------------------------------------------------
// Meeting model — two mutually-exclusive states
// ---------------------------------------------------------------------------

/**
 * A meeting that exists on this device without its derived outputs yet:
 * recorded audio + optional notes, captured here and delegated for processing
 * (the phone runs no ML). Mirrors the desktop `ProcessingLifecycle` (the
 * `crates/common` enum the sync engine surfaces) for the two states the phone
 * can hold before results arrive:
 *
 * - `processing: 'pending'` — `PendingProcessing`: captured here and offered for
 *   a host (a desktop / the hub) to adopt. The default at capture; the phone
 *   authors this when it saves a recording.
 * - `processing: 'claimed'` — `Claimed`: a host has adopted it and is producing
 *   the derived outputs. The phone learns this from a paired desktop via
 *   `onMeetingsChanged`; `claimedBy` is a resolved human-readable host label
 *   when the sync layer can provide one, else absent (see the field doc).
 *
 * (The desktop-only `Local` variant — recorded AND processed on one device —
 * never occurs here. Once processing finishes the meeting arrives as a
 * [`SyncedMeeting`] = `Processed`.)
 *
 * `processing` is optional for back-compat with callers that predate the field;
 * absent is read as `'pending'`.
 *
 * `audioUri` is the platform URI of the recording (the transcoded `audio.opus`
 * on API 29+, else the original AAC); absent if the capture was notes-only.
 */
export interface CapturedUnprocessedMeeting {
  readonly state: 'captured-unprocessed';
  readonly id: string;
  readonly title: string;
  readonly startedAt: number; // Unix epoch ms
  readonly durationMs: number;
  readonly audioUri?: string;
  readonly hasNotes: boolean;
  /** Lifecycle sub-state before results exist; absent ⇒ `'pending'`. */
  readonly processing?: 'pending' | 'claimed';
  /**
   * When `'claimed'`, a human-readable label for the processing host IF the sync
   * layer can resolve one (e.g. from a device registry). Absent when only the
   * opaque host id (the desktop `ProcessingClaim.host` / `HostRef`) is known —
   * the UI then shows a plain "Processing…". This is NOT the raw `HostRef`; a
   * real client populates it only once a name resolution exists.
   */
  readonly claimedBy?: string;
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
