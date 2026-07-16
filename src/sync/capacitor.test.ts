/**
 * Unit tests for CapacitorSyncClient.syncAccountPeers (the B2 account-peer
 * discovery loop). All external I/O is mocked; no native plugin or live
 * account-service is required.
 *
 * Verified behaviours:
 * - Own endpoint is filtered out from the peer-add loop.
 * - Every other device with a registered endpoint_id is added via addAccountPeer
 *   with the correct endpointId + relayUrl.
 * - DEFAULT_RELAY_URL is used as the fallback when a device has no relay_url.
 * - A listDevices rejection is a silent no-op (no throw, no addAccountPeer calls).
 * - No credential → no calls to any service.
 * - A second invocation (resume) completes without throwing (idempotent).
 * - addAccountPeer failures are per-peer silent no-ops (other peers still added).
 * - A peer that left the account is reconcile-removed on the next pass; a failed
 *   removal is a silent no-op.
 * - The own endpoint is never reconcile-removed (it is filtered from the tracked set).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — set up BEFORE CapacitorSyncClient is imported so the mocked
// modules are in place when its module-level `SyncFfi` registration runs.
// vi.hoisted() is required because vi.mock() factory calls are hoisted to the
// top of the file by the vitest transform; any variable the factory closes over
// must also be hoisted so it is initialised before the factory runs.
// ---------------------------------------------------------------------------

const syncFfiMock = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  myTicket: vi.fn().mockResolvedValue({ ticket: 'mock-ticket' }),
  endpointId: vi.fn().mockResolvedValue({ endpointId: 'own-ep-123' }),
  pair: vi.fn().mockResolvedValue({ peerId: 'mock-peer' }),
  peerIds: vi.fn().mockResolvedValue({ peerIds: [] }),
  localMeetings: vi.fn().mockResolvedValue({ meetingIds: [] }),
  saveCaptured: vi.fn().mockResolvedValue({ id: 'new-id' }),
  listMeetings: vi.fn().mockResolvedValue({ meetings: [] }),
  getMeeting: vi.fn().mockResolvedValue({ meeting: null }),
  syncNotes: vi.fn().mockResolvedValue(undefined),
  syncMedia: vi.fn().mockResolvedValue(undefined),
  syncArtifacts: vi.fn().mockResolvedValue(undefined),
  discoverWith: vi.fn().mockResolvedValue({ meetingIds: [] }),
  addAccountPeer: vi.fn().mockResolvedValue(undefined),
  removeAccountPeer: vi.fn().mockResolvedValue({ removed: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
  addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => syncFfiMock),
}));

// Mock @capacitor/app — App.addListener is used for the resume listener.
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

// Mock secure-storage — returns the credential from the in-memory store.
const secureStore = new Map<string, string>();
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    set: vi.fn((key: string, value: string) => {
      secureStore.set(key, value);
      return Promise.resolve();
    }),
    get: vi.fn((key: string) => Promise.resolve(secureStore.get(key) ?? null)),
    remove: vi.fn((key: string) => {
      secureStore.delete(key);
      return Promise.resolve(true);
    }),
  },
}));

// Mock fetch so AccountClient.listDevices + registerEndpoint can be controlled.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

// ---------------------------------------------------------------------------
// Now import the module under test (after mocks are registered).
// ---------------------------------------------------------------------------
import { CapacitorSyncClient } from './capacitor';
import { CREDENTIAL_KEY } from '../account/signin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_RELAY_URL = 'https://sync.minutist.ai';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stub fetch for the start sequence: registerEndpoint PUT + listDevices GET. */
function stubFetch(
  registerStatus: number,
  devices: { device_id: string; endpoint_id?: string; relay_url?: string }[],
): void {
  fetchMock
    // registerEndpoint PUT
    .mockResolvedValueOnce(new Response('', { status: registerStatus }))
    // listDevices GET
    .mockResolvedValueOnce(jsonResponse(devices));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  secureStore.clear();
  fetchMock.mockReset();
  syncFfiMock.addAccountPeer.mockReset().mockResolvedValue(undefined);
  syncFfiMock.removeAccountPeer.mockReset().mockResolvedValue({ removed: true });
  syncFfiMock.endpointId.mockReset().mockResolvedValue({ endpointId: 'own-ep-123' });
  syncFfiMock.start.mockReset().mockResolvedValue(undefined);
  syncFfiMock.addListener.mockReset().mockResolvedValue({ remove: vi.fn() });
  syncFfiMock.listMeetings.mockReset().mockResolvedValue({ meetings: [] });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CapacitorSyncClient.refreshAccountPeers — no credential', () => {
  it('makes no calls to the account service or addAccountPeer', async () => {
    // No credential stored.
    const client = new CapacitorSyncClient();
    // ensureStarted needs start + addListener to not fail.
    stubFetch(200, []);

    await client.refreshAccountPeers();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(syncFfiMock.addAccountPeer).not.toHaveBeenCalled();
  });
});

describe('CapacitorSyncClient.refreshAccountPeers — with credential', () => {
  beforeEach(() => {
    secureStore.set(CREDENTIAL_KEY, 'mdc_test.secret');
  });

  it('filters own endpoint_id out and adds only other devices', async () => {
    stubFetch(200, [
      { device_id: 'self', endpoint_id: 'own-ep-123', relay_url: DEFAULT_RELAY_URL },
      { device_id: 'peer1', endpoint_id: 'peer-ep-456', relay_url: DEFAULT_RELAY_URL },
    ]);

    const client = new CapacitorSyncClient();
    await client.refreshAccountPeers();

    expect(syncFfiMock.addAccountPeer).toHaveBeenCalledTimes(1);
    expect(syncFfiMock.addAccountPeer).toHaveBeenCalledWith({
      endpointId: 'peer-ep-456',
      relayUrl: DEFAULT_RELAY_URL,
    });
  });

  it('uses DEFAULT_RELAY_URL when device relay_url is absent', async () => {
    stubFetch(200, [
      { device_id: 'peer-no-relay', endpoint_id: 'peer-ep-789' },
    ]);

    const client = new CapacitorSyncClient();
    await client.refreshAccountPeers();

    expect(syncFfiMock.addAccountPeer).toHaveBeenCalledWith({
      endpointId: 'peer-ep-789',
      relayUrl: DEFAULT_RELAY_URL,
    });
  });

  it('adds multiple other devices', async () => {
    stubFetch(200, [
      { device_id: 'peer-a', endpoint_id: 'ep-aaa', relay_url: DEFAULT_RELAY_URL },
      { device_id: 'peer-b', endpoint_id: 'ep-bbb' },
      { device_id: 'self', endpoint_id: 'own-ep-123' },
    ]);

    const client = new CapacitorSyncClient();
    await client.refreshAccountPeers();

    expect(syncFfiMock.addAccountPeer).toHaveBeenCalledTimes(2);
    const calls = (syncFfiMock.addAccountPeer.mock.calls as [{ endpointId: string; relayUrl: string }][]).map(
      (c) => c[0].endpointId,
    );
    expect(calls).toContain('ep-aaa');
    expect(calls).toContain('ep-bbb');
    expect(calls).not.toContain('own-ep-123');
  });

  it('skips devices that have no endpoint_id', async () => {
    stubFetch(200, [
      { device_id: 'no-endpoint' },
      { device_id: 'has-endpoint', endpoint_id: 'ep-xyz', relay_url: DEFAULT_RELAY_URL },
    ]);

    const client = new CapacitorSyncClient();
    await client.refreshAccountPeers();

    expect(syncFfiMock.addAccountPeer).toHaveBeenCalledTimes(1);
    expect(syncFfiMock.addAccountPeer).toHaveBeenCalledWith({
      endpointId: 'ep-xyz',
      relayUrl: DEFAULT_RELAY_URL,
    });
  });

  it('is a silent no-op when listDevices throws (account service unreachable)', async () => {
    // registerEndpoint succeeds, then listDevices fails.
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockRejectedValueOnce(new Error('network error'));

    const client = new CapacitorSyncClient();
    await expect(client.refreshAccountPeers()).resolves.toBeUndefined();
    expect(syncFfiMock.addAccountPeer).not.toHaveBeenCalled();
  });

  it('continues adding other peers when one addAccountPeer call fails', async () => {
    stubFetch(200, [
      { device_id: 'peer-fail', endpoint_id: 'ep-fail', relay_url: DEFAULT_RELAY_URL },
      { device_id: 'peer-ok', endpoint_id: 'ep-ok', relay_url: DEFAULT_RELAY_URL },
    ]);

    syncFfiMock.addAccountPeer
      .mockRejectedValueOnce(new Error('peer unreachable'))
      .mockResolvedValueOnce(undefined);

    const client = new CapacitorSyncClient();
    await expect(client.refreshAccountPeers()).resolves.toBeUndefined();
    expect(syncFfiMock.addAccountPeer).toHaveBeenCalledTimes(2);
  });

  it('a second call (resume) completes without throwing (idempotent)', async () => {
    // Two full round-trips: first call on start, second simulates resume.
    fetchMock
      // First call: registerEndpoint + listDevices
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse([
        { device_id: 'peer1', endpoint_id: 'ep-aaa', relay_url: DEFAULT_RELAY_URL },
      ]))
      // Second call: registerEndpoint + listDevices (re-run is safe)
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse([
        { device_id: 'peer1', endpoint_id: 'ep-aaa', relay_url: DEFAULT_RELAY_URL },
      ]));

    const client = new CapacitorSyncClient();
    await client.refreshAccountPeers();
    await expect(client.refreshAccountPeers()).resolves.toBeUndefined();
    // addAccountPeer called once per run (idempotent on the Rust side).
    expect(syncFfiMock.addAccountPeer).toHaveBeenCalledTimes(2);
  });

  it('never reconcile-removes the own endpoint across passes', async () => {
    // own-ep-123 is present in both passes' device lists; it must be filtered from
    // the tracked set and never handed to removeAccountPeer.
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse([
        { device_id: 'self', endpoint_id: 'own-ep-123', relay_url: DEFAULT_RELAY_URL },
        { device_id: 'a', endpoint_id: 'ep-a', relay_url: DEFAULT_RELAY_URL },
      ]))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse([
        { device_id: 'self', endpoint_id: 'own-ep-123', relay_url: DEFAULT_RELAY_URL },
        { device_id: 'a', endpoint_id: 'ep-a', relay_url: DEFAULT_RELAY_URL },
      ]));

    const client = new CapacitorSyncClient();
    await client.refreshAccountPeers();

    const removed = (
      syncFfiMock.removeAccountPeer.mock.calls as [{ endpointId: string }][]
    ).map((c) => c[0].endpointId);
    expect(removed).not.toContain('own-ep-123');
  });

  it('reconcile-removes a peer that left the account between passes', async () => {
    // The first refreshAccountPeers() runs two passes: ensureStarted's initial pass
    // then the explicit refresh. Pass A sees {a,b} (populating the last-seen set),
    // pass B sees {a} — so b left and must be removed.
    fetchMock
      // Pass A: register + list [a, b]
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse([
        { device_id: 'a', endpoint_id: 'ep-a', relay_url: DEFAULT_RELAY_URL },
        { device_id: 'b', endpoint_id: 'ep-b', relay_url: DEFAULT_RELAY_URL },
      ]))
      // Pass B: register + list [a]  (b has left)
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse([
        { device_id: 'a', endpoint_id: 'ep-a', relay_url: DEFAULT_RELAY_URL },
      ]));

    const client = new CapacitorSyncClient();
    await client.refreshAccountPeers();

    // ep-b departed between the passes → removed exactly once; ep-a is untouched.
    expect(syncFfiMock.removeAccountPeer).toHaveBeenCalledTimes(1);
    expect(syncFfiMock.removeAccountPeer).toHaveBeenCalledWith({ endpointId: 'ep-b' });
  });

  it('is a silent no-op when removeAccountPeer fails for a departed peer', async () => {
    // Pass A sees {b}, pass B sees {} — b left, and its removal is made to fail.
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse([
        { device_id: 'b', endpoint_id: 'ep-b', relay_url: DEFAULT_RELAY_URL },
      ]))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse([])); // b left

    syncFfiMock.removeAccountPeer.mockRejectedValueOnce(new Error('remove failed'));

    const client = new CapacitorSyncClient();
    await expect(client.refreshAccountPeers()).resolves.toBeUndefined();
    expect(syncFfiMock.removeAccountPeer).toHaveBeenCalledWith({ endpointId: 'ep-b' });
  });
});
