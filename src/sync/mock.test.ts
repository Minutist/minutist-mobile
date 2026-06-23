import { describe, it, expect, beforeEach } from 'vitest';
import { MockSyncClient } from './mock';
import type { Meeting, PairingTicket, SyncStatus } from './types';

// Fresh client for each test — avoid shared state between cases.
let client: MockSyncClient;
beforeEach(() => {
  client = new MockSyncClient();
});

// ---------------------------------------------------------------------------
// Fixture list
// ---------------------------------------------------------------------------

describe('MockSyncClient.listMeetings', () => {
  it('returns the two built-in fixture meetings', async () => {
    const meetings = await client.listMeetings();
    expect(meetings).toHaveLength(2);
    expect(meetings.map((m) => m.id)).toEqual(['meet-001', 'meet-002']);
  });

  it('fixture meetings are in the synced state', async () => {
    const meetings = await client.listMeetings();
    expect(meetings.every((m) => m.state === 'synced')).toBe(true);
  });

  it('does not return a mutable reference to internal state', async () => {
    const a = await client.listMeetings();
    const b = await client.listMeetings();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// registerCaptured then listMeetings
// ---------------------------------------------------------------------------

describe('MockSyncClient.registerCaptured + listMeetings', () => {
  it('includes a registered captured meeting in the list', async () => {
    client.registerCaptured({
      id: 'local-001',
      title: 'Morning standup',
      startedAt: Date.now(),
      durationMs: 900_000,
      audioUri: 'content://media/external/local-001.aac',
      hasNotes: false,
    });

    const meetings = await client.listMeetings();
    expect(meetings).toHaveLength(3);
    const local = meetings.find((m) => m.id === 'local-001');
    expect(local).toBeDefined();
    expect(local?.state).toBe('captured-unprocessed');
  });

  it('preserves existing fixtures when a captured meeting is registered', async () => {
    client.registerCaptured({
      id: 'local-002',
      title: 'Afternoon review',
      startedAt: Date.now(),
      durationMs: 1_800_000,
      hasNotes: true,
    });

    const meetings = await client.listMeetings();
    expect(meetings.map((m) => m.id)).toContain('meet-001');
    expect(meetings.map((m) => m.id)).toContain('meet-002');
  });

  it('allows multiple captured meetings to be registered', async () => {
    client.registerCaptured({
      id: 'local-a',
      title: 'First',
      startedAt: Date.now() - 3_600_000,
      durationMs: 600_000,
      hasNotes: false,
    });
    client.registerCaptured({
      id: 'local-b',
      title: 'Second',
      startedAt: Date.now(),
      durationMs: 300_000,
      hasNotes: true,
    });

    const meetings = await client.listMeetings();
    expect(meetings).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// getMeeting round-trip
// ---------------------------------------------------------------------------

describe('MockSyncClient.getMeeting', () => {
  it('returns the correct meeting by id', async () => {
    const meeting = await client.getMeeting('meet-001');
    expect(meeting).not.toBeNull();
    expect(meeting?.id).toBe('meet-001');
    expect(meeting?.state).toBe('synced');
  });

  it('returns null for an unknown id', async () => {
    const meeting = await client.getMeeting('does-not-exist');
    expect(meeting).toBeNull();
  });

  it('round-trips a registered captured meeting', async () => {
    client.registerCaptured({
      id: 'local-rt',
      title: 'Round-trip test',
      startedAt: 1_700_000_000_000,
      durationMs: 60_000,
      hasNotes: false,
    });

    const meeting = await client.getMeeting('local-rt');
    expect(meeting).not.toBeNull();
    expect(meeting?.state).toBe('captured-unprocessed');
    if (meeting?.state === 'captured-unprocessed') {
      expect(meeting.title).toBe('Round-trip test');
      expect(meeting.startedAt).toBe(1_700_000_000_000);
      expect(meeting.durationMs).toBe(60_000);
      expect(meeting.hasNotes).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// pair and myTicket
// ---------------------------------------------------------------------------

describe('MockSyncClient.pair', () => {
  it('resolves without throwing', async () => {
    await expect(
      client.pair('some-iroh-ticket-xyz' as PairingTicket),
    ).resolves.toBeUndefined();
  });

  it('emits a connected status after pairing', async () => {
    const statuses: SyncStatus[] = [];
    client.onStatus((s) => statuses.push(s));
    await client.pair('ticket-abc123' as PairingTicket);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.kind).toBe('connected');
  });
});

describe('MockSyncClient.myTicket', () => {
  it('resolves without throwing', async () => {
    await expect(client.myTicket()).resolves.toBeDefined();
  });

  it('returns a non-empty string', async () => {
    const ticket = await client.myTicket();
    expect(typeof ticket).toBe('string');
    expect(ticket.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// syncMeeting
// ---------------------------------------------------------------------------

describe('MockSyncClient.syncMeeting', () => {
  it('resolves without throwing for a captured-unprocessed meeting', async () => {
    client.registerCaptured({
      id: 'sync-me',
      title: 'To be synced',
      startedAt: Date.now(),
      durationMs: 1_200_000,
      hasNotes: false,
    });
    await expect(client.syncMeeting('sync-me')).resolves.toBeUndefined();
  });

  it('emits syncing then connected status', async () => {
    client.registerCaptured({
      id: 'sync-status-test',
      title: 'Status test',
      startedAt: Date.now(),
      durationMs: 600_000,
      hasNotes: false,
    });
    const statuses: SyncStatus[] = [];
    client.onStatus((s) => statuses.push(s));
    await client.syncMeeting('sync-status-test');
    expect(statuses[0]?.kind).toBe('syncing');
    expect(statuses[1]?.kind).toBe('connected');
  });

  it('throws for an unknown meeting id', async () => {
    await expect(client.syncMeeting('unknown-id')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onStatus subscription lifecycle
// ---------------------------------------------------------------------------

describe('MockSyncClient.onStatus', () => {
  it('unsubscribe prevents further callbacks', async () => {
    const statuses: SyncStatus[] = [];
    const unsub = client.onStatus((s) => statuses.push(s));
    await client.pair('ticket-1' as PairingTicket);
    unsub();
    await client.pair('ticket-2' as PairingTicket);
    // Only the first pair call should have been received.
    expect(statuses).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// onMeetingsChanged subscription
// ---------------------------------------------------------------------------

describe('MockSyncClient.onMeetingsChanged', () => {
  it('fires when saveCaptured is called', async () => {
    const snapshots: Meeting[][] = [];
    client.onMeetingsChanged((list) => snapshots.push(list));

    await client.saveCaptured({
      title: 'New recording',
      startedAt: Date.now(),
      durationMs: 60_000,
      notes: '',
    });

    expect(snapshots).toHaveLength(1);
    // Snapshot includes the two fixtures plus the new captured meeting.
    expect(snapshots[0]).toHaveLength(3);
    expect(snapshots[0]?.at(-1)?.state).toBe('captured-unprocessed');
  });

  it('fires when registerCaptured is called', () => {
    const snapshots: Meeting[][] = [];
    client.onMeetingsChanged((list) => snapshots.push(list));

    client.registerCaptured({
      id: 'local-obs',
      title: 'Observed',
      startedAt: Date.now(),
      durationMs: 30_000,
      hasNotes: false,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toHaveLength(3);
  });

  it('fires when syncMeeting transitions a meeting to synced', async () => {
    client.registerCaptured({
      id: 'sync-obs',
      title: 'To sync',
      startedAt: Date.now(),
      durationMs: 30_000,
      hasNotes: false,
    });

    const snapshots: Meeting[][] = [];
    client.onMeetingsChanged((list) => snapshots.push(list));

    await client.syncMeeting('sync-obs');

    expect(snapshots).toHaveLength(1);
    const synced = snapshots[0]?.find((m) => m.id === 'sync-obs');
    expect(synced?.state).toBe('synced');
  });

  it('delivers a fresh array on each call (no shared reference)', async () => {
    const snapshots: Meeting[][] = [];
    client.onMeetingsChanged((list) => snapshots.push(list));

    await client.saveCaptured({
      title: 'First',
      startedAt: Date.now(),
      durationMs: 10_000,
      notes: '',
    });
    await client.saveCaptured({
      title: 'Second',
      startedAt: Date.now(),
      durationMs: 10_000,
      notes: '',
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).not.toBe(snapshots[1]);
    expect(snapshots[1]).toHaveLength(4);
  });

  it('unsubscribe stops further callbacks', async () => {
    const snapshots: Meeting[][] = [];
    const unsub = client.onMeetingsChanged((list) => snapshots.push(list));

    client.registerCaptured({
      id: 'before-unsub',
      title: 'Before',
      startedAt: Date.now(),
      durationMs: 10_000,
      hasNotes: false,
    });
    expect(snapshots).toHaveLength(1);

    unsub();

    client.registerCaptured({
      id: 'after-unsub',
      title: 'After',
      startedAt: Date.now(),
      durationMs: 10_000,
      hasNotes: false,
    });
    // No new callbacks after unsubscribe.
    expect(snapshots).toHaveLength(1);
  });
});
