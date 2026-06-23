/**
 * React context that provides the recorder facade to the capture UI.
 *
 * The facade is a plain object matching the recorder module's function set.
 * Providing it through context allows tests to inject a mock without module-level
 * vi.mock, and ensures the app root wires exactly one instance.
 *
 * Default value delegates to the real recorder module so components work
 * without a provider (web, Storybook).  Tests and the integration test
 * substitute a mock object via RecorderContext.Provider.
 */

import { createContext, useContext } from 'react';
import * as RealRecorder from './recorder';
import type {
  MicPermission,
  RecorderStatus,
  StartOptions,
  StopResult,
  ForegroundServiceController,
} from './recorder';
import type {
  RecordingErrorEvent,
  RecordingStoppedEvent,
} from '@capgo/capacitor-audio-recorder';

export type { MicPermission, RecorderStatus, StartOptions, StopResult };
export type { RecordingErrorEvent, RecordingStoppedEvent };

/**
 * The subset of recorder operations consumed by the capture UI.
 * Mirrors the module-level function signatures in recorder.ts.
 */
export interface RecorderFacade {
  checkPermission(): Promise<MicPermission>;
  requestPermission(): Promise<MicPermission>;
  start(opts?: StartOptions, controller?: ForegroundServiceController): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(controller?: ForegroundServiceController): Promise<StopResult>;
  getAmplitude(): Promise<number>;
  /** Subscribe to plugin-level recording-stopped events. Returns an unsubscribe function. */
  onStopped(cb: (event: RecordingStoppedEvent) => void): () => void;
  /** Subscribe to plugin-level recording-error events. Returns an unsubscribe function. */
  onError(cb: (event: RecordingErrorEvent) => void): () => void;
}

/**
 * Default facade delegates to the real recorder module — the single source of
 * truth for the production wiring (the context default AND the App prop
 * default both use this instance).
 */
export const realRecorderFacade: RecorderFacade = {
  checkPermission: RealRecorder.checkPermission,
  requestPermission: RealRecorder.requestPermission,
  start: RealRecorder.start,
  pause: RealRecorder.pause,
  resume: RealRecorder.resume,
  stop: RealRecorder.stop,
  getAmplitude: RealRecorder.getAmplitude,
  onStopped: RealRecorder.onRecordingStopped,
  onError: RealRecorder.onRecordingError,
};

export const RecorderContext = createContext<RecorderFacade>(realRecorderFacade);

/** Return the active recorder facade. Defaults to the real module if no provider is present. */
export function useRecorder(): RecorderFacade {
  return useContext(RecorderContext);
}
