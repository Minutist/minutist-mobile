/**
 * STUB — no real iroh/native sync.
 * Real implementation is gated on the iroh-blobs FFI spike + desktop
 * notes-crdt extraction; see planning issue 0016.
 * Do not implement the wire protocol here.
 */

import type { CapturePayload, SyncClient } from './index';
import type {
  CapturedUnprocessedMeeting,
  Meeting,
  PairingTicket,
  SyncStatus,
} from './types';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_MEETINGS: Meeting[] = [
  {
    state: 'synced',
    id: 'meet-001',
    title: 'Product roadmap review',
    startedAt: new Date('2026-06-20T09:00:00+10:00').getTime(),
    transcript: [
      {
        speakerIndex: 1, // --speaker-1 (oxblood == --accent)
        startMs: 0,
        endMs: 4800,
        text: 'Alright, let us walk through the WS4 milestones before we jump into the backlog.',
      },
      {
        speakerIndex: 2, // --speaker-2 (teal-slate)
        startMs: 5100,
        endMs: 9200,
        text: 'The relay is live; the iroh blobs spike is next. Main blocker is the FFI surface for blobs.',
      },
      {
        speakerIndex: 1,
        startMs: 9500,
        endMs: 14000,
        text: 'Right. Until that lands the phone has no way to transfer the audio file. So the stub is the correct call for now.',
      },
      {
        speakerIndex: 3, // --speaker-3 (ochre)
        startMs: 14300,
        endMs: 18800,
        text: 'Agreed. We can unblock UI work behind the mock and do the FFI in parallel.',
      },
    ],
    summary:
      'Reviewed WS4 milestones. Relay is deployed. iroh-blobs FFI spike is the next critical path item; phone audio transfer is blocked on it. Decision: stub the sync interface and continue UI work in parallel.',
    speakers: ['Andrew', 'Ben', 'Camille'],
  },
  {
    state: 'synced',
    id: 'meet-002',
    title: 'Design token sync check',
    startedAt: new Date('2026-06-21T14:30:00+10:00').getTime(),
    transcript: [
      {
        speakerIndex: 1,
        startMs: 0,
        endMs: 5500,
        text: 'The Editorial Ink tokens look correct in the phone shell — Fraunces renders cleanly in the webview.',
      },
      {
        speakerIndex: 2,
        startMs: 5800,
        endMs: 10200,
        text: 'Stone colour passes 4.5:1 on the sheet background in both light and dark modes.',
      },
    ],
    summary:
      'Confirmed design token parity between desktop and phone webview. No token overrides required.',
    speakers: ['Andrew', 'Ben'],
  },
];

// ---------------------------------------------------------------------------
// MockSyncClient
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of `SyncClient` for development and unit tests.
 *
 * Starts with two synced fixture meetings.  Call `registerCaptured` to add a
 * locally-captured meeting (the UI wrapper does this after the recorder saves a
 * file — or in tests, directly).
 *
 * All async methods resolve immediately; `onStatus` callbacks are invoked
 * synchronously within the method that triggers a status change.
 */
export class MockSyncClient implements SyncClient {
  private meetings: Meeting[] = [...FIXTURE_MEETINGS];
  private status: SyncStatus = { kind: 'idle' };
  private subscribers: Set<(s: SyncStatus) => void> = new Set();
  private pairedTicket: PairingTicket | null = null;
  private readonly ownTicket: PairingTicket =
    'mock-ticket-abcdef1234567890' as PairingTicket;

  // -------------------------------------------------------------------------
  // SyncClient implementation
  // -------------------------------------------------------------------------

  async pair(ticket: PairingTicket): Promise<void> {
    this.pairedTicket = ticket;
    this.emitStatus({ kind: 'connected', peerId: `mock-peer-${ticket.slice(0, 8)}` });
  }

  async myTicket(): Promise<PairingTicket> {
    return this.ownTicket;
  }

  async listMeetings(): Promise<Meeting[]> {
    return [...this.meetings];
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    return this.meetings.find((m) => m.id === id) ?? null;
  }

  async saveCaptured(payload: CapturePayload): Promise<string> {
    const id = `captured-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const meeting: CapturedUnprocessedMeeting = {
      state: 'captured-unprocessed',
      id,
      title: payload.title,
      startedAt: payload.startedAt,
      durationMs: payload.durationMs,
      audioUri: payload.audioUri,
      hasNotes: payload.notes.trim().length > 0,
    };
    this.meetings = [...this.meetings, meeting];
    return id;
  }

  async syncMeeting(id: string): Promise<void> {
    const meeting = this.meetings.find((m) => m.id === id);
    if (!meeting) {
      throw new Error(`MockSyncClient.syncMeeting: meeting ${id} not found`);
    }
    if (meeting.state !== 'captured-unprocessed') {
      // Already synced — no-op.
      return;
    }
    const peerId = this.pairedTicket
      ? `mock-peer-${this.pairedTicket.slice(0, 8)}`
      : 'mock-peer-unpaired';
    this.emitStatus({ kind: 'syncing', peerId, meetingId: id });
    // In the mock, "syncing" resolves immediately.
    this.emitStatus({ kind: 'connected', peerId });
  }

  onStatus(cb: (status: SyncStatus) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  // -------------------------------------------------------------------------
  // Test / setup helpers (not part of SyncClient interface)
  // -------------------------------------------------------------------------

  /**
   * Register a locally-captured meeting so it appears in `listMeetings`.
   * Accepts a partial record; `id` and `startedAt` default to generated values.
   */
  registerCaptured(partial: Omit<CapturedUnprocessedMeeting, 'state'>): void {
    const meeting: CapturedUnprocessedMeeting = {
      ...partial,
      state: 'captured-unprocessed',
    };
    this.meetings = [...this.meetings, meeting];
  }

  /** Current status snapshot — useful in tests. */
  currentStatus(): SyncStatus {
    return this.status;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private emitStatus(next: SyncStatus): void {
    this.status = next;
    this.subscribers.forEach((cb) => cb(next));
  }
}

/** Singleton mock instance used as the default via `SyncContext`. */
export const mockSyncClient = new MockSyncClient();
