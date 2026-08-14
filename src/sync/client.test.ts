/**
 * Unit tests for getSyncClient (src/sync/client.ts) — the platform switch that
 * selects which SyncClient implementation the app uses.
 *
 * Verified behaviours:
 * - 'android' constructs and returns a CapacitorSyncClient instance.
 * - 'ios' returns the mock sentinel and never constructs CapacitorSyncClient.
 * - 'web' (and any other platform) returns the mock sentinel.
 * - Two calls on the same platform return the identical instance (memoised
 *   single-client contract).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getPlatformMock = vi.hoisted(() => vi.fn());
const capacitorSyncClientCtor = vi.hoisted(() => vi.fn());
const mockSentinel = vi.hoisted(() => ({ __mock: true }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: getPlatformMock },
}));

vi.mock('./capacitor', () => ({
  CapacitorSyncClient: capacitorSyncClientCtor,
}));

vi.mock('./mock', () => ({
  mockSyncClient: mockSentinel,
}));

beforeEach(() => {
  vi.resetModules();
  getPlatformMock.mockReset();
  capacitorSyncClientCtor.mockClear();
});

describe('getSyncClient', () => {
  it('constructs a CapacitorSyncClient on android', async () => {
    getPlatformMock.mockReturnValue('android');
    const { getSyncClient } = await import('./client');

    const client = getSyncClient();

    expect(capacitorSyncClientCtor).toHaveBeenCalledTimes(1);
    expect(client).toBeInstanceOf(capacitorSyncClientCtor);
  });

  it('returns the mock and never constructs CapacitorSyncClient on ios', async () => {
    getPlatformMock.mockReturnValue('ios');
    const { getSyncClient } = await import('./client');

    const client = getSyncClient();

    expect(client).toBe(mockSentinel);
    expect(capacitorSyncClientCtor).not.toHaveBeenCalled();
  });

  it('returns the mock on web', async () => {
    getPlatformMock.mockReturnValue('web');
    const { getSyncClient } = await import('./client');

    const client = getSyncClient();

    expect(client).toBe(mockSentinel);
    expect(capacitorSyncClientCtor).not.toHaveBeenCalled();
  });

  it('memoises: two calls on the same platform return the identical instance', async () => {
    getPlatformMock.mockReturnValue('android');
    const { getSyncClient } = await import('./client');

    const first = getSyncClient();
    const second = getSyncClient();

    expect(second).toBe(first);
    expect(capacitorSyncClientCtor).toHaveBeenCalledTimes(1);
  });
});
