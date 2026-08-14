/**
 * Selects the active `SyncClient` by `Capacitor.getPlatform()`: Android gets
 * the real native bridge ([CapacitorSyncClient]); every other platform gets
 * the in-memory [MockSyncClient]. iOS has no native `SyncFfi` implementation,
 * so the bridge would reject on the first call — the mock stands in for it.
 * Web and the jsdom test environment fall through the same `default` arm.
 * Memoised so the whole app shares one client instance.
 *
 * `CapacitorSyncClient` is import-safe everywhere (Capacitor's `registerPlugin`
 * returns a proxy and is never called unless the platform switch selects it),
 * so no dynamic import is needed.
 */
import { Capacitor } from '@capacitor/core';
import type { SyncClient } from './index';
import { mockSyncClient } from './mock';
import { CapacitorSyncClient } from './capacitor';

function createSyncClient(): SyncClient {
  switch (Capacitor.getPlatform()) {
    case 'android':
      return new CapacitorSyncClient();
    case 'ios':
      return mockSyncClient;
    default:
      return mockSyncClient;
  }
}

let singleton: SyncClient | null = null;

export function getSyncClient(): SyncClient {
  if (!singleton) {
    singleton = createSyncClient();
  }
  return singleton;
}
