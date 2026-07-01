/**
 * Selects the active `SyncClient`: the real native bridge
 * ([CapacitorSyncClient]) on-device, the in-memory [MockSyncClient] on web / in
 * tests. Memoised so the whole app shares one client instance.
 *
 * `CapacitorSyncClient` is import-safe on web (Capacitor's `registerPlugin`
 * returns a proxy and is never called there), so no dynamic import is needed —
 * `isNativePlatform()` gates which one is constructed.
 */
import { Capacitor } from '@capacitor/core';
import type { SyncClient } from './index';
import { mockSyncClient } from './mock';
import { CapacitorSyncClient } from './capacitor';

let singleton: SyncClient | null = null;

export function getSyncClient(): SyncClient {
  if (!singleton) {
    singleton = Capacitor.isNativePlatform() ? new CapacitorSyncClient() : mockSyncClient;
  }
  return singleton;
}
