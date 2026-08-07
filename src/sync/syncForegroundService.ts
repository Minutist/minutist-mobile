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
 * On web / non-Android the registered fallback is a no-op so the module is safe
 * to import everywhere.
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
