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
import { getStoredCredential } from '../account/signin';
import { accountClient } from '../account/client';
import { App as CapacitorApp } from '@capacitor/app';

// The connected-tier relay, matching the desktop `SyncConfig::DEFAULT_RELAY_URL`.
const DEFAULT_RELAY_URL = 'https://sync.minutist.ai';

// The relay is admission-gated (paid-tier forward-auth), so start() must present
// a token. Dev/test builds inject it at BUILD time via VITE_RELAY_AUTH_TOKEN (see
// .env.example) — it is inlined into the bundle, so this path is for development
// against the gated relay only. Production will fetch a per-user admission token
// from the account service at runtime and pass it to start() instead. Undefined
// (unset) is left off the call, so an ungated relay still works.
const RELAY_AUTH_TOKEN = import.meta.env.VITE_RELAY_AUTH_TOKEN;

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
  private resumeListenerRegistered = false;
  // Meeting ids we've already attempted an artifact pull for this session, so a
  // repeatedly-missing meeting isn't re-pulled on every snapshot.
  private readonly pulledArtifacts = new Set<string>();
  // Account endpoint ids seen on the previous discovery pass, so the next pass can
  // reconcile-remove a peer that has since left the account (mirrors the Rust v2
  // refresh loop's `last` set). No persistence or account-list re-seed is needed
  // because this field is never reset while the native peer directory it reconciles
  // against survives: there is no in-place engine restart that reuses this client
  // instance — the engine and this object are created and torn down together — so
  // the Rust loop's `account_peer_ids()` re-seed (which guards a live disabled-window
  // restart) has no phone analogue.
  private lastAccountEndpoints = new Set<string>();

  /** Start the engine once, wire the native `meetingsChanged` event, and run the
   *  initial account-peer discovery pass. */
  private ensureStarted(): Promise<void> {
    if (!this.started) {
      this.started = (async () => {
        this.emitStatus({ kind: 'connecting' });
        // Prefer the stored per-device account credential; fall back to the
        // build-time static token for dev builds without an account.
        const accountCredential = await getStoredCredential();
        const relayAuthToken = accountCredential ?? RELAY_AUTH_TOKEN;
        await SyncFfi.start({
          relayUrl: DEFAULT_RELAY_URL,
          ...(relayAuthToken ? { relayAuthToken } : {}),
        });
        await SyncFfi.addListener('meetingsChanged', () => {
          void this.refreshMeetings();
        });
        // Wire the app-resume listener once so returning to foreground re-runs
        // peer discovery (picks up devices that came online while backgrounded).
        if (!this.resumeListenerRegistered) {
          this.resumeListenerRegistered = true;
          void CapacitorApp.addListener('resume', () => {
            void this.syncAccountPeers();
          });
        }
        // Initial peer discovery pass (publish self + add account peers).
        await this.syncAccountPeers();
        this.emitStatus({ kind: 'idle' });
      })();
    }
    return this.started;
  }

  /**
   * Publish this device's iroh endpoint to the account directory, then reconcile
   * the account's device list into the native peer directory: remove peers that
   * have left the account, and add every other device that has a registered
   * endpoint. Every step is best-effort: a network failure is a silent no-op, and
   * `add_account_peer` is an idempotent in-memory upsert on the Rust side (it does
   * not dial — dials happen on sync ops, gated by the engine's own failed-dial
   * backoff), so re-running the loop is cheap and safe.
   */
  private async syncAccountPeers(): Promise<void> {
    const credential = await getStoredCredential();
    if (!credential) return;

    const { endpointId: own } = await SyncFfi.endpointId();

    // Publish self — best-effort.
    try {
      await accountClient.registerEndpoint(credential, own, DEFAULT_RELAY_URL);
    } catch {
      // Best-effort; the sync engine still works without the directory entry.
    }

    // Fetch the full device list. If the account service is unreachable (e.g. not
    // yet deployed), treat it as a silent no-op and keep the last-seen set so a
    // transient outage isn't mistaken for every peer having left the account.
    let devices;
    try {
      devices = await accountClient.listDevices(credential);
    } catch {
      return;
    }

    // The account's current non-self peer endpoints.
    const current = new Set<string>();
    for (const d of devices) {
      if (d.endpoint_id && d.endpoint_id !== own) current.add(d.endpoint_id);
    }

    // Reconcile removals first: a peer seen last pass but absent now has left the
    // account — drop it from the directory (source-aware on the Rust side, so a
    // manually paired peer is never touched).
    for (const gone of this.lastAccountEndpoints) {
      if (current.has(gone)) continue;
      try {
        await SyncFfi.removeAccountPeer({ endpointId: gone });
      } catch {
        // Best-effort; a failed removal is dropped like the Rust loop does (the
        // id leaves the tracked set below), not retried.
      }
    }

    // Add each current peer. The upsert is unconditional: `add_account_peer` never
    // dials, so there is no suppressed-peer dial to skip, and keeping every account
    // peer present lets the engine's own backoff clear on a later successful dial —
    // skipping the upsert would strand a suppressed peer permanently out of the
    // directory.
    for (const d of devices) {
      if (!d.endpoint_id || d.endpoint_id === own) continue;
      try {
        await SyncFfi.addAccountPeer({
          endpointId: d.endpoint_id,
          relayUrl: d.relay_url ?? DEFAULT_RELAY_URL,
        });
      } catch {
        // Best-effort per peer.
      }
    }

    this.lastAccountEndpoints = current;
  }

  /** Re-run the full account-peer discovery loop (publish self + add peers). */
  async refreshAccountPeers(): Promise<void> {
    await this.ensureStarted();
    await this.syncAccountPeers();
  }

  /** Re-snapshot the meeting list and push it to `onMeetingsChanged` subscribers. */
  private async refreshMeetings(): Promise<void> {
    const { meetings } = await SyncFfi.listMeetings();
    const mapped = meetings.map(toMeeting);
    this.meetingSubs.forEach((cb) => cb(mapped));
    void this.pullMissingArtifacts(mapped);
  }

  /**
   * A meeting can be marked processed (synced) yet arrive without its
   * transcript/summary — e.g. the phone was offline when the host pushed them.
   * For each such meeting, pull the artifacts on demand from a paired peer rather
   * than depend on the host's push having reached us. Best-effort and idempotent:
   * each id is attempted at most once per session.
   */
  private async pullMissingArtifacts(meetings: Meeting[]): Promise<void> {
    const missing = meetings.filter(
      (m): m is SyncedMeeting =>
        m.state === 'synced' &&
        !this.pulledArtifacts.has(m.id) &&
        !(m.transcript && m.transcript.length > 0) &&
        !m.summary,
    );
    if (missing.length === 0) return;
    const { peerIds } = await SyncFfi.peerIds();
    if (peerIds.length === 0) return;
    for (const m of missing) {
      this.pulledArtifacts.add(m.id);
      try {
        // Reconcile artifacts with a paired peer; if it holds superseding
        // transcript/summary they are written to disk.
        await SyncFfi.syncArtifacts({ peerId: peerIds[0], meetingId: m.id });
      } catch {
        // A peer without the artifacts is a no-op; leave the meeting as-is.
      }
    }
    // Re-snapshot once so any pulled artifacts surface to subscribers (guarded
    // by pulledArtifacts, so this does not re-trigger a pull for the same ids).
    const { meetings: after } = await SyncFfi.listMeetings();
    this.meetingSubs.forEach((cb) => cb(after.map(toMeeting)));
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
    // Producer→host handoff, in this exact order: push notes (creates the meeting
    // folder on the host), then media (lands audio.opus), THEN advertise the
    // captured-unprocessed lifecycle via discovery. Discovery MUST be last: the
    // host's election loop only claims a meeting whose PendingProcessing state AND
    // audio.opus are already on its local disk, and a lifecycle that arrives before
    // the folder + audio is dropped with no retry. The host then adopts, processes,
    // and pushes transcript/summary back — arriving asynchronously via the
    // `meetingsChanged` event.
    await SyncFfi.syncNotes({ peerId, meetingId: id });
    await SyncFfi.syncMedia({ peerId, meetingId: id });
    await SyncFfi.discoverWith({ peerId });
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
