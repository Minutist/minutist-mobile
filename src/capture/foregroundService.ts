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
 * and to the web fallback (the no-op object below) on other platforms.
 */
const NativeForegroundService =
  registerPlugin<RecordingForegroundServicePlugin>(
    'RecordingForegroundService',
    {
      // Web fallback: no-op so the proxy never rejects on non-Android.
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
 * Android 13+.  On older API levels and non-Android platforms this resolves
 * immediately without prompting.
 *
 * The result is informational; recording proceeds regardless because the
 * foreground service does not require the notification to be visible.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const result = await NativeForegroundService.requestNotificationPermission();
    return result.granted;
  } catch {
    // Plugin unavailable (web / test without a real bridge) — treat as granted.
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
 * - Web / test: no-op (recorder facade works without a native bridge).
 *
 * Pass this to recorder.start() / recorder.stop() in the capture UI.
 */
export const platformForegroundServiceController: ForegroundServiceController =
  Capacitor.getPlatform() === 'android'
    ? androidForegroundServiceController
    : noopForegroundServiceController;
