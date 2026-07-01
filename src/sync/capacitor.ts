/**
 * Real `SyncClient` over the native `SyncFfi` plugin (the Rust `FfiSyncEngine`).
 * Selected on-device by `getSyncClient()` (src/sync/client.ts); the in-memory
 * `MockSyncClient` is used on web / in tests. Views consume only the `SyncClient`
 * interface, so nothing view-side changes when this replaces the mock.
 */
import type { CapturePayload, SyncClient } from './index';
import type {
  CapturedUnprocessedMeeting,
  Meeting,
  PairingTicket,
  SyncedMeeting,
  SyncStatus,
  TranscriptSegment,
} from './types';
import { SyncFfi, type NativeMeeting } from './plugin';

// The connected-tier relay, matching the desktop `SyncConfig::DEFAULT_RELAY_URL`.
// The admission token (issued by the account service) is not wired yet — v1
// pairs against a relay that does not gate on a token.
const DEFAULT_RELAY_URL = 'https://sync.minutist.ai';

/** Decode base64 (the plugin's Yjs-bytes transport) into a Uint8Array. */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Map a native meeting JSON blob to the phone `Meeting` model. */
function toMeeting(n: NativeMeeting): Meeting {
  if (n.state === 'synced') {
    const synced: SyncedMeeting = {
      state: 'synced',
      id: n.id,
      title: n.title,
      startedAt: n.startedAtMs,
      transcript: n.transcript as TranscriptSegment[] | undefined,
      summary: n.summary,
      speakers: n.speakers,
      notes: n.notesB64 ? decodeBase64(n.notesB64) : undefined,
    };
    return synced;
  }
  const captured: CapturedUnprocessedMeeting = {
    state: 'captured-unprocessed',
    id: n.id,
    title: n.title,
    startedAt: n.startedAtMs,
    durationMs: n.durationMs ?? 0,
    audioUri: n.audioUri,
    hasNotes: n.hasNotes ?? false,
    processing: n.processing,
    claimedBy: n.claimedBy,
  };
  return captured;
}

export class CapacitorSyncClient implements SyncClient {
  private readonly statusSubs = new Set<(s: SyncStatus) => void>();
  private readonly meetingSubs = new Set<(m: Meeting[]) => void>();
  private started: Promise<void> | null = null;

  /** Start the engine once and wire the native `meetingsChanged` event. */
  private ensureStarted(): Promise<void> {
    if (!this.started) {
      this.started = (async () => {
        this.emitStatus({ kind: 'connecting' });
        await SyncFfi.start({ relayUrl: DEFAULT_RELAY_URL });
        await SyncFfi.addListener('meetingsChanged', () => {
          void this.refreshMeetings();
        });
        this.emitStatus({ kind: 'idle' });
      })();
    }
    return this.started;
  }

  /** Re-snapshot the meeting list and push it to `onMeetingsChanged` subscribers. */
  private async refreshMeetings(): Promise<void> {
    const { meetings } = await SyncFfi.listMeetings();
    const mapped = meetings.map(toMeeting);
    this.meetingSubs.forEach((cb) => cb(mapped));
  }

  async pair(ticket: PairingTicket): Promise<void> {
    await this.ensureStarted();
    const { peerId } = await SyncFfi.pair({ ticket });
    this.emitStatus({ kind: 'connected', peerId });
  }

  async myTicket(): Promise<PairingTicket> {
    await this.ensureStarted();
    const { ticket } = await SyncFfi.myTicket();
    return ticket as PairingTicket;
  }

  async listMeetings(): Promise<Meeting[]> {
    await this.ensureStarted();
    const { meetings } = await SyncFfi.listMeetings();
    return meetings.map(toMeeting);
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    await this.ensureStarted();
    const { meeting } = await SyncFfi.getMeeting({ id });
    return meeting ? toMeeting(meeting) : null;
  }

  async saveCaptured(payload: CapturePayload): Promise<string> {
    await this.ensureStarted();
    // `audioUri` is the Opus file the transcode plugin produced (a file:// path
    // on API 29+); strip the scheme for the Rust `fs::copy`. A content:// URI
    // (pre-29, un-transcoded) is not handled here — the desktop transcodes the
    // AAC it receives. TODO(0016): resolve content:// to a temp file first.
    const audioSrcPath = payload.audioUri?.replace(/^file:\/\//, '');
    const { id } = await SyncFfi.saveCaptured({
      title: payload.title,
      startedAtMs: payload.startedAt,
      durationMs: payload.durationMs,
      audioSrcPath,
      notesText: payload.notes,
    });
    await this.refreshMeetings();
    return id;
  }

  async syncMeeting(id: string): Promise<void> {
    await this.ensureStarted();
    const { peerIds } = await SyncFfi.peerIds();
    if (peerIds.length === 0) {
      this.emitStatus({ kind: 'error', message: 'No paired device to sync to' });
      return;
    }
    const peerId = peerIds[0];
    this.emitStatus({ kind: 'syncing', peerId, meetingId: id });
    // Push notes + media to the paired host; it adopts, processes, and syncs the
    // results back — arriving asynchronously via the `meetingsChanged` event.
    await SyncFfi.syncNotes({ peerId, meetingId: id });
    await SyncFfi.syncMedia({ peerId, meetingId: id });
    this.emitStatus({ kind: 'connected', peerId });
  }

  onStatus(cb: (status: SyncStatus) => void): () => void {
    this.statusSubs.add(cb);
    return () => {
      this.statusSubs.delete(cb);
    };
  }

  onMeetingsChanged(cb: (meetings: Meeting[]) => void): () => void {
    this.meetingSubs.add(cb);
    // Seed a late subscriber with current state once the engine is up.
    void this.ensureStarted().then(() => this.refreshMeetings());
    return () => {
      this.meetingSubs.delete(cb);
    };
  }

  private emitStatus(status: SyncStatus): void {
    this.statusSubs.forEach((cb) => cb(status));
  }
}
