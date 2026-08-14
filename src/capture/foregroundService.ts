/**
 * ForegroundServiceController implementations and the POST_NOTIFICATIONS
 * runtime permission helper.
 *
 * On Android the real binding calls through to RecordingForegroundServicePlugin
 * (RecordingForegroundService.kt), which posts an ongoing notification and holds
 * a PARTIAL_WAKE_LOCK for the duration of the recording session.
 *
 * On web and in unit-test environments the no-op controller is used so the
 * recorder facade works without any native bridge.
 *
 * Usage — pass the platform-appropriate controller to start() / stop():
 *
 *   import { platformForegroundServiceController, requestNotificationPermission } from './foregroundService';
 *   await requestNotificationPermission();          // alongside RECORD_AUDIO prompt
 *   await start(opts, platformForegroundServiceController);
 *   await stop(platformForegroundServiceController);
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  noopForegroundServiceController,
  type ForegroundServiceController,
} from './recorder';

// ---------------------------------------------------------------------------
// Native plugin interface (Android only)
// ---------------------------------------------------------------------------

/** Minimal surface of RecordingForegroundServicePlugin exposed to the web layer. */
interface RecordingForegroundServicePlugin {
  /** Raise the foreground service. Call before starting audio capture. */
  start(): Promise<void>;
  /** Tear down the foreground service. Call after audio capture stops. */
  stop(): Promise<void>;
  /**
   * Request POST_NOTIFICATIONS permission on Android 13+ (API 33+).
   * Resolves with { granted: boolean }.  On older API levels resolves
   * immediately with granted = true (no prompt needed).
   */
  requestNotificationPermission(): Promise<{ granted: boolean }>;
}

/**
 * Lazy-registered handle to the native plugin.  Capacitor's registerPlugin
 * returns a proxy that routes calls to the native implementation on Android
 * and to the `web` fallback (the no-op object below) on the web platform and
 * in the jsdom test environment. On iOS there is no native
 * RecordingForegroundService and no `ios` implementation, so every call
 * rejects; the two call sites below catch that (requestNotificationPermission's
 * try/catch, and platformForegroundServiceController routing iOS to the
 * no-op controller so NativeForegroundService.start()/stop() are never called
 * there at all).
 */
const NativeForegroundService =
  registerPlugin<RecordingForegroundServicePlugin>(
    'RecordingForegroundService',
    {
      // Web fallback: no-op on the web platform and in the jsdom test
      // environment, the only cases Capacitor routes here. The plugin exists
      // only on Android; on web/test there is no service to raise and no
      // POST_NOTIFICATIONS permission to request, so no-op start/stop and
      // granted: true are the truthful answers, not a papered-over failure —
      // a caller could do nothing differently if told otherwise.
      web: {
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        requestNotificationPermission: () => Promise.resolve({ granted: true }),
      },
    },
  );

// ---------------------------------------------------------------------------
// POST_NOTIFICATIONS permission helper
// ---------------------------------------------------------------------------

/**
 * Request the POST_NOTIFICATIONS runtime permission (Android 13+ / API 33+).
 *
 * Call this alongside `recorder.requestPermission()` in the capture-start
 * flow so the ongoing recording notification is not silently suppressed on
 * Android 13+.  On older API levels and on iOS / web / test platforms this
 * resolves immediately without prompting.
 *
 * The result is informational; recording proceeds regardless because the
 * foreground service does not require the notification to be visible.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const result = await NativeForegroundService.requestNotificationPermission();
    return result.granted;
  } catch {
    // Rejects on iOS, where there is no native plugin and no `ios` fallback —
    // treat as granted, matching the informational nature of the result.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Platform-appropriate controller
// ---------------------------------------------------------------------------

/**
 * Real Android implementation of ForegroundServiceController.
 *
 * Calls the native RecordingForegroundServicePlugin bridge, which starts/stops
 * RecordingForegroundService with microphone foreground-service type and a
 * PARTIAL_WAKE_LOCK.
 *
 * Doze / 60-minute locked-screen acceptance is deferred to a manual device spike
 * and cannot be tested in CI.  See android/app/src/main/java/ai/minutist/
 * companion/RecordingForegroundService.kt for the service implementation.
 */
const androidForegroundServiceController: ForegroundServiceController = {
  onBeforeStart: () => NativeForegroundService.start(),
  onAfterStop: () => NativeForegroundService.stop(),
};

/**
 * The correct ForegroundServiceController for the current platform.
 *
 * - Android: calls the native plugin (raises foreground service + wake lock).
 * - iOS: no-op. There is no iOS foreground-service concept and no iOS target
 *   in this repo; nothing on the JS side is needed to select a controller.
 *   Whether the iOS arm must own `AVAudioSession` activation around
 *   start/stop is open — see docs/IOS_ROADMAP.md phases 0b and 6.
 * - Web / test: no-op (recorder facade works without a native bridge).
 *
 * Pass this to recorder.start() / recorder.stop() in the capture UI.
 */
function selectForegroundServiceController(): ForegroundServiceController {
  switch (Capacitor.getPlatform()) {
    case 'android':
      return androidForegroundServiceController;
    case 'ios':
      return noopForegroundServiceController;
    default:
      return noopForegroundServiceController;
  }
}

export const platformForegroundServiceController: ForegroundServiceController =
  selectForegroundServiceController();
