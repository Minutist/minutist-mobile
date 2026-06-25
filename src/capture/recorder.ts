/**
 * Recorder facade — the only module in this codebase that imports
 * @capgo/capacitor-audio-recorder.  The capture UI calls this module
 * exclusively; it never touches the plugin directly.
 *
 * Audio format note: on Android the plugin writes AAC/m4a.  On API 29+
 * the phone transcodes this to 16 kHz mono Ogg-Opus before handing the
 * URI to the sync layer (see OpusTranscodePlugin / opusTranscode.ts).
 * On pre-29 devices the raw AAC URI is passed to sync; the desktop is
 * responsible for the AAC → Ogg-Opus conversion on adoption.
 */

import {
  CapacitorAudioRecorder,
  RecordingStatus as PluginRecordingStatus,
} from '@capgo/capacitor-audio-recorder';
import type {
  RecordingErrorEvent,
  RecordingStoppedEvent,
} from '@capgo/capacitor-audio-recorder';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Mapped permission state used by this module. */
export type MicPermission = 'granted' | 'denied' | 'prompt';

/** Recording lifecycle state exposed to the capture UI. */
export type RecorderStatus = 'inactive' | 'recording' | 'paused';

/** Returned by stop(). */
export interface StopResult {
  /** Platform content-URI of the recorded AAC file. */
  uri: string;
  /** Duration of the recording in milliseconds. */
  durationMs: number;
}

/** Options forwarded to the plugin on start(). Callers may omit to accept defaults. */
export interface StartOptions {
  /** Encoding bit rate in bits per second. Default: 128 000 (128 kbps). */
  bitRate?: number;
  /** Sample rate in Hz. Default: 44 100. */
  sampleRate?: number;
}

// ---------------------------------------------------------------------------
// Foreground-service seam
// ---------------------------------------------------------------------------

/**
 * Contract the recorder facade calls around start/stop so the capture flow
 * can manage a foreground service without this module owning that concern.
 *
 * T7 provides the real Android implementation in src/capture/foregroundService.ts:
 * `platformForegroundServiceController` calls the native Capacitor plugin which
 * posts the required ongoing notification with `microphone` service type and
 * holds a PARTIAL_WAKE_LOCK. The no-op default is used on web and in tests.
 */
export interface ForegroundServiceController {
  /** Called immediately before the plugin starts recording. */
  onBeforeStart(): Promise<void>;
  /** Called immediately after the plugin stops recording. */
  onAfterStop(): Promise<void>;
}

/**
 * No-op implementation — used on web and in unit tests.
 * The real Android implementation is in src/capture/foregroundService.ts
 * (platformForegroundServiceController), wired in by T7.
 */
export const noopForegroundServiceController: ForegroundServiceController = {
  onBeforeStart: () => Promise.resolve(),
  onAfterStop: () => Promise.resolve(),
};

// ---------------------------------------------------------------------------
// Default AAC recording options
// ---------------------------------------------------------------------------

/**
 * AAC-appropriate defaults for Android.
 * 128 kbps / 44.1 kHz gives acceptable quality for speech at a modest file size.
 */
const AAC_DEFAULTS: Required<StartOptions> = {
  bitRate: 128_000,
  sampleRate: 44_100,
};

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

/** Map the plugin's PermissionStatus.recordAudio value to our MicPermission type. */
function mapPermissionState(state: string): MicPermission {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'prompt';
}

/**
 * Return the current microphone permission state without prompting the user.
 */
export async function checkPermission(): Promise<MicPermission> {
  const result = await CapacitorAudioRecorder.checkPermissions();
  return mapPermissionState(result.recordAudio);
}

/**
 * Request microphone permission, prompting the user if necessary.
 * Returns the resulting state after the prompt.
 */
export async function requestPermission(): Promise<MicPermission> {
  const result = await CapacitorAudioRecorder.requestPermissions();
  return mapPermissionState(result.recordAudio);
}

// ---------------------------------------------------------------------------
// Recording lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a new recording session.
 *
 * Raises the foreground service via `controller.onBeforeStart()` before
 * instructing the plugin.  If `startRecording()` throws, `controller.onAfterStop()`
 * is called to tear down the service so a failed start never leaves the
 * foreground service running without an active recording.
 *
 * Output format is AAC on Android.  The phone never encodes Opus.
 */
export async function start(
  opts?: StartOptions,
  controller: ForegroundServiceController = noopForegroundServiceController,
): Promise<void> {
  const { bitRate, sampleRate } = { ...AAC_DEFAULTS, ...opts };
  await controller.onBeforeStart();
  try {
    await CapacitorAudioRecorder.startRecording({ bitRate, sampleRate });
  } catch (err) {
    await controller.onAfterStop();
    throw err;
  }
}

/** Pause the current recording session. */
export async function pause(): Promise<void> {
  await CapacitorAudioRecorder.pauseRecording();
}

/** Resume a paused recording session. */
export async function resume(): Promise<void> {
  await CapacitorAudioRecorder.resumeRecording();
}

/**
 * Stop the recording and return the saved file location and duration.
 *
 * `controller.onAfterStop()` runs in a `finally` block so the foreground
 * service and wake lock are torn down even when `stopRecording()` rejects.
 *
 * @throws if the plugin rejects or returns no URI (unexpected on Android).
 */
export async function stop(
  controller: ForegroundServiceController = noopForegroundServiceController,
): Promise<StopResult> {
  try {
    const result = await CapacitorAudioRecorder.stopRecording();

    if (!result.uri) {
      throw new Error('Recorder stop returned no URI — unexpected on Android');
    }

    return {
      uri: result.uri,
      durationMs: result.duration ?? 0,
    };
  } finally {
    await controller.onAfterStop();
  }
}

// ---------------------------------------------------------------------------
// Status and amplitude
// ---------------------------------------------------------------------------

/** Map the plugin's RecordingStatus enum to our RecorderStatus union. */
function mapRecordingStatus(status: PluginRecordingStatus): RecorderStatus {
  switch (status) {
    case PluginRecordingStatus.Recording:
      return 'recording';
    case PluginRecordingStatus.Paused:
      return 'paused';
    case PluginRecordingStatus.Inactive:
    default:
      return 'inactive';
  }
}

/** Return the current recording lifecycle state. */
export async function getStatus(): Promise<RecorderStatus> {
  const result = await CapacitorAudioRecorder.getRecordingStatus();
  return mapRecordingStatus(result.status);
}

/**
 * Return the current input amplitude as a normalised [0, 1] value.
 * Intended for driving a VU meter at UI-rate polling (60–100 ms intervals).
 * Returns 0 when no recording is active.
 */
export async function getAmplitude(): Promise<number> {
  const result = await CapacitorAudioRecorder.getCurrentAmplitude();
  return result.value;
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

/** Payload type carried by each plugin recording event. */
interface RecordingEventMap {
  recordingError: RecordingErrorEvent;
  recordingStopped: RecordingStoppedEvent;
  recordingPaused: void;
}

/**
 * Register `handler` for a plugin recording `event` and return an unsubscribe
 * function.
 *
 * `addListener` resolves asynchronously, so the handle may not exist yet when
 * the caller unsubscribes.  A `cancelled` flag closes that race in both
 * directions: an unsubscribe that runs before the promise resolves still
 * removes the late-arriving handle (the `.then` checks the flag), and an
 * unsubscribe that runs after resolution removes it directly.  Either way
 * `remove()` runs at most once.
 */
function subscribe<E extends keyof RecordingEventMap>(
  event: E,
  handler: (payload: RecordingEventMap[E]) => void,
): () => void {
  let handle: { remove: () => Promise<void> } | null = null;
  let cancelled = false;

  // The plugin's addListener is overloaded per event name; the indexed handler
  // type is wider than any single overload, so narrow at the call site.
  CapacitorAudioRecorder.addListener(
    event as 'recordingError',
    handler as (e: RecordingErrorEvent) => void,
  ).then((h) => {
    if (cancelled) {
      // Unsubscribed before the handle arrived — remove the late handle now.
      void h.remove();
    } else {
      handle = h;
    }
  });

  return () => {
    cancelled = true;
    if (handle) {
      void handle.remove();
      handle = null;
    }
  };
}

/**
 * Register a listener for recording errors.
 * Returns an unsubscribe function — call it to remove the listener.
 */
export function onRecordingError(
  handler: (event: RecordingErrorEvent) => void,
): () => void {
  return subscribe('recordingError', handler);
}

/**
 * Register a listener for recording-stopped events (file saved).
 * Returns an unsubscribe function — call it to remove the listener.
 */
export function onRecordingStopped(
  handler: (event: RecordingStoppedEvent) => void,
): () => void {
  return subscribe('recordingStopped', handler);
}

/**
 * Register a listener for recording-paused events.
 * Returns an unsubscribe function — call it to remove the listener.
 */
export function onRecordingPaused(handler: () => void): () => void {
  return subscribe('recordingPaused', handler);
}
