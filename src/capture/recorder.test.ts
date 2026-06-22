/**
 * Unit tests for the recorder facade.
 *
 * The plugin is mocked via vi.mock so no native bridge or real device is
 * needed.  Every call through the facade is verified against the mock, and
 * all public behaviours (status mapping, permission mapping, amplitude
 * pass-through, listener unsubscribe, foreground-service seam) are covered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Plugin mock — vi.hoisted ensures these objects are available inside the
// vi.mock factory, which vitest hoists to the top of the compiled module.
// ---------------------------------------------------------------------------

const { mockHandle, mockPlugin } = vi.hoisted(() => {
  const mockHandle = { remove: vi.fn().mockResolvedValue(undefined) };
  const mockPlugin = {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    startRecording: vi.fn().mockResolvedValue(undefined),
    pauseRecording: vi.fn().mockResolvedValue(undefined),
    resumeRecording: vi.fn().mockResolvedValue(undefined),
    stopRecording: vi.fn(),
    getRecordingStatus: vi.fn(),
    getCurrentAmplitude: vi.fn(),
    addListener: vi.fn().mockResolvedValue(mockHandle),
    removeAllListeners: vi.fn().mockResolvedValue(undefined),
  };
  return { mockHandle, mockPlugin };
});

vi.mock('@capgo/capacitor-audio-recorder', () => ({
  CapacitorAudioRecorder: mockPlugin,
  RecordingStatus: {
    Inactive: 'INACTIVE',
    Recording: 'RECORDING',
    Paused: 'PAUSED',
  },
}));

// ---------------------------------------------------------------------------
// Facade imports (after mock registration)
// ---------------------------------------------------------------------------

import {
  checkPermission,
  requestPermission,
  start,
  pause,
  resume,
  stop,
  getStatus,
  getAmplitude,
  onRecordingError,
  onRecordingStopped,
  onRecordingPaused,
  noopForegroundServiceController,
  type ForegroundServiceController,
} from './recorder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockPlugin.addListener.mockResolvedValue(mockHandle);
  mockHandle.remove.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('checkPermission', () => {
  it('returns "granted" when the plugin reports granted', async () => {
    mockPlugin.checkPermissions.mockResolvedValue({ recordAudio: 'granted' });
    expect(await checkPermission()).toBe('granted');
  });

  it('returns "denied" when the plugin reports denied', async () => {
    mockPlugin.checkPermissions.mockResolvedValue({ recordAudio: 'denied' });
    expect(await checkPermission()).toBe('denied');
  });

  it('returns "prompt" for prompt and prompt-with-rationale', async () => {
    mockPlugin.checkPermissions.mockResolvedValue({ recordAudio: 'prompt' });
    expect(await checkPermission()).toBe('prompt');

    mockPlugin.checkPermissions.mockResolvedValue({
      recordAudio: 'prompt-with-rationale',
    });
    expect(await checkPermission()).toBe('prompt');
  });
});

describe('requestPermission', () => {
  it('calls requestPermissions on the plugin and maps the result', async () => {
    mockPlugin.requestPermissions.mockResolvedValue({ recordAudio: 'granted' });
    expect(await requestPermission()).toBe('granted');
    expect(mockPlugin.requestPermissions).toHaveBeenCalledOnce();
  });

  it('returns "denied" when the user denies', async () => {
    mockPlugin.requestPermissions.mockResolvedValue({ recordAudio: 'denied' });
    expect(await requestPermission()).toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// Recording lifecycle — start / pause / resume / stop
// ---------------------------------------------------------------------------

describe('start', () => {
  it('calls startRecording with AAC defaults when no opts given', async () => {
    await start();
    expect(mockPlugin.startRecording).toHaveBeenCalledWith({
      bitRate: 128_000,
      sampleRate: 44_100,
    });
  });

  it('merges caller opts over the defaults', async () => {
    await start({ bitRate: 64_000 });
    expect(mockPlugin.startRecording).toHaveBeenCalledWith({
      bitRate: 64_000,
      sampleRate: 44_100,
    });
  });

  it('calls controller.onBeforeStart before startRecording', async () => {
    const order: string[] = [];
    const ctrl: ForegroundServiceController = {
      onBeforeStart: vi.fn().mockImplementation(async () => {
        order.push('onBeforeStart');
      }),
      onAfterStop: vi.fn(),
    };
    mockPlugin.startRecording.mockImplementation(async () => {
      order.push('startRecording');
    });

    await start(undefined, ctrl);

    expect(order).toEqual(['onBeforeStart', 'startRecording']);
    expect(ctrl.onBeforeStart).toHaveBeenCalledOnce();
  });

  it('uses the noop controller by default', async () => {
    // noopForegroundServiceController should not throw
    await expect(start()).resolves.toBeUndefined();
  });
});

describe('pause', () => {
  it('delegates to pauseRecording', async () => {
    await pause();
    expect(mockPlugin.pauseRecording).toHaveBeenCalledOnce();
  });
});

describe('resume', () => {
  it('delegates to resumeRecording', async () => {
    await resume();
    expect(mockPlugin.resumeRecording).toHaveBeenCalledOnce();
  });
});

describe('stop', () => {
  it('returns uri and durationMs from the plugin', async () => {
    mockPlugin.stopRecording.mockResolvedValue({
      uri: 'content://media/recording.m4a',
      duration: 62_000,
    });

    const result = await stop();

    expect(result).toEqual({
      uri: 'content://media/recording.m4a',
      durationMs: 62_000,
    });
    expect(mockPlugin.stopRecording).toHaveBeenCalledOnce();
  });

  it('defaults durationMs to 0 when the plugin omits duration', async () => {
    mockPlugin.stopRecording.mockResolvedValue({
      uri: 'content://media/recording.m4a',
    });
    const result = await stop();
    expect(result.durationMs).toBe(0);
  });

  it('throws when no URI is returned', async () => {
    mockPlugin.stopRecording.mockResolvedValue({ duration: 1_000 });
    await expect(stop()).rejects.toThrow(/no URI/i);
  });

  it('calls controller.onAfterStop after stopRecording', async () => {
    mockPlugin.stopRecording.mockResolvedValue({
      uri: 'content://media/recording.m4a',
      duration: 10_000,
    });
    const order: string[] = [];
    const ctrl: ForegroundServiceController = {
      onBeforeStart: vi.fn(),
      onAfterStop: vi.fn().mockImplementation(async () => {
        order.push('onAfterStop');
      }),
    };
    (mockPlugin.stopRecording as Mock).mockImplementation(async () => {
      order.push('stopRecording');
      return { uri: 'content://media/recording.m4a', duration: 10_000 };
    });

    await stop(ctrl);

    expect(order).toEqual(['stopRecording', 'onAfterStop']);
    expect(ctrl.onAfterStop).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Status mapping — all three RecordingStatus values
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('maps INACTIVE to "inactive"', async () => {
    mockPlugin.getRecordingStatus.mockResolvedValue({ status: 'INACTIVE' });
    expect(await getStatus()).toBe('inactive');
  });

  it('maps RECORDING to "recording"', async () => {
    mockPlugin.getRecordingStatus.mockResolvedValue({ status: 'RECORDING' });
    expect(await getStatus()).toBe('recording');
  });

  it('maps PAUSED to "paused"', async () => {
    mockPlugin.getRecordingStatus.mockResolvedValue({ status: 'PAUSED' });
    expect(await getStatus()).toBe('paused');
  });
});

// ---------------------------------------------------------------------------
// Amplitude pass-through
// ---------------------------------------------------------------------------

describe('getAmplitude', () => {
  it('passes through the amplitude value from the plugin', async () => {
    mockPlugin.getCurrentAmplitude.mockResolvedValue({ value: 0.42 });
    expect(await getAmplitude()).toBe(0.42);
  });

  it('returns 0 when the plugin reports silence', async () => {
    mockPlugin.getCurrentAmplitude.mockResolvedValue({ value: 0 });
    expect(await getAmplitude()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Listener registration and unsubscribe
// ---------------------------------------------------------------------------

describe('onRecordingError', () => {
  it('registers a recordingError listener and returns an unsubscribe fn', async () => {
    const handler = vi.fn();
    const unsubscribe = onRecordingError(handler);

    // Give the internal Promise a tick to resolve
    await Promise.resolve();

    expect(mockPlugin.addListener).toHaveBeenCalledWith(
      'recordingError',
      handler,
    );

    unsubscribe();
    expect(mockHandle.remove).toHaveBeenCalledOnce();
  });

  it('calling unsubscribe before the Promise resolves does not throw', () => {
    // addListener not yet resolved — handle is still null
    mockPlugin.addListener.mockReturnValue(new Promise(() => {})); // never resolves
    const unsubscribe = onRecordingError(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('onRecordingStopped', () => {
  it('registers a recordingStopped listener and the unsubscribe works', async () => {
    const handler = vi.fn();
    const unsubscribe = onRecordingStopped(handler);
    await Promise.resolve();

    expect(mockPlugin.addListener).toHaveBeenCalledWith(
      'recordingStopped',
      handler,
    );

    unsubscribe();
    expect(mockHandle.remove).toHaveBeenCalledOnce();
  });
});

describe('onRecordingPaused', () => {
  it('registers a recordingPaused listener and the unsubscribe works', async () => {
    const handler = vi.fn();
    const unsubscribe = onRecordingPaused(handler);
    await Promise.resolve();

    expect(mockPlugin.addListener).toHaveBeenCalledWith(
      'recordingPaused',
      handler,
    );

    unsubscribe();
    expect(mockHandle.remove).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// noopForegroundServiceController — exported default
// ---------------------------------------------------------------------------

describe('noopForegroundServiceController', () => {
  it('resolves without error for onBeforeStart', async () => {
    await expect(
      noopForegroundServiceController.onBeforeStart(),
    ).resolves.toBeUndefined();
  });

  it('resolves without error for onAfterStop', async () => {
    await expect(
      noopForegroundServiceController.onAfterStop(),
    ).resolves.toBeUndefined();
  });
});
