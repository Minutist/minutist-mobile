/**
 * Thin TypeScript binding for the native SyncForegroundService plugin
 * (SyncForegroundServicePlugin.kt).
 *
 * The service keeps the process alive so an in-flight sync push can finish
 * draining after the app is backgrounded mid-sync. It is bounded to that window:
 * the SyncClient starts it only when the app goes to the background while a sync
 * is in flight, and stops it the moment the queue drains or the app returns to
 * the foreground — so its notification is transient, and in the common
 * (foreground) case it is never started.
 *
 * start() resolves `{ started: boolean }`: false when the OS refused the
 * (background) foreground-service start — the caller then treats the push as
 * best-effort rather than guaranteed to survive backgrounding.
 *
 * The only registered implementation is `web`, which Capacitor selects on the
 * web platform and in the jsdom test environment; its `start()` resolves
 * `{ started: false }`. On iOS there is no native SyncForegroundService and
 * no `ios` implementation, so every call rejects — every call site in
 * src/sync/capacitor.ts swallows that with `.catch(() => undefined)`, landing
 * on the same best-effort outcome as an OS-refused start. iOS does not reach this binding at all today: getSyncClient()
 * selects the mock client on iOS.
 */
import { registerPlugin } from '@capacitor/core';

interface SyncForegroundServicePlugin {
  start(): Promise<{ started: boolean }>;
  stop(): Promise<void>;
}

export const SyncForegroundService = registerPlugin<SyncForegroundServicePlugin>(
  'SyncForegroundService',
  {
    web: {
      start: () => Promise.resolve({ started: false }),
      stop: () => Promise.resolve(),
    },
  },
);
