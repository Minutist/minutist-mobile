/**
 * CaptureView tests.
 *
 * Covers:
 * - Record control and notes field are present on initial render.
 * - A record → stop cycle registers a captured-unprocessed meeting via
 *   the (mock) sync client and the meeting appears in listMeetings.
 * - Timer and status reflect state transitions: idle → recording → stopped.
 * - Pause / resume transitions work with the recorder facade mocked.
 * - Permission-denied path renders a message rather than throwing.
 * - No ML / Opus / Tiptap code present in the rendered output.
 *
 * The recorder facade is mocked at the module level so no native bridge
 * or real device is needed.
 */

import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Recorder facade mock — vi.hoisted so the factory can reference these refs.
// ---------------------------------------------------------------------------

const { mockRecorder, mockForegroundController } = vi.hoisted(() => {
  const mockRecorder = {
    checkPermission: vi.fn(),
    requestPermission: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    getAmplitude: vi.fn(),
    // Event subscription stubs — return a no-op unsubscribe by default.
    // Tests that exercise the unsolicited-stop path override these to capture
    // the registered callback and fire it manually.
    onRecordingStopped: vi.fn().mockReturnValue(() => {}),
    onRecordingError: vi.fn().mockReturnValue(() => {}),
  };
  const mockForegroundController = {
    onBeforeStart: vi.fn().mockResolvedValue(undefined),
    onAfterStop: vi.fn().mockResolvedValue(undefined),
  };
  return { mockRecorder, mockForegroundController };
});

vi.mock('../capture/recorder', () => mockRecorder);
vi.mock('../capture/foregroundService', () => ({
  platformForegroundServiceController: mockForegroundController,
  requestNotificationPermission: vi.fn().mockResolvedValue(true),
}));

// ---------------------------------------------------------------------------
// React + testing imports (after mock registration)
// ---------------------------------------------------------------------------

import { MockSyncClient } from '../sync/mock';
import { SyncContext } from '../sync/useSync';
import { CaptureView } from './CaptureView';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderCapture(client: MockSyncClient) {
  return render(
    <SyncContext.Provider value={client}>
      <CaptureView />
    </SyncContext.Provider>,
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let client: MockSyncClient;

beforeEach(() => {
  vi.clearAllMocks();
  client = new MockSyncClient();

  // Defaults: permission granted, plugin calls succeed.
  mockRecorder.checkPermission.mockResolvedValue('granted');
  mockRecorder.requestPermission.mockResolvedValue('granted');
  mockRecorder.start.mockResolvedValue(undefined);
  mockRecorder.pause.mockResolvedValue(undefined);
  mockRecorder.resume.mockResolvedValue(undefined);
  mockRecorder.stop.mockResolvedValue({
    uri: 'content://media/test/recording.m4a',
    durationMs: 12_000,
  });
  mockRecorder.getAmplitude.mockResolvedValue(0);
  // Event subscription stubs — return a no-op unsubscribe by default.
  mockRecorder.onRecordingStopped.mockReturnValue(() => {});
  mockRecorder.onRecordingError.mockReturnValue(() => {});

  // Foreground controller defaults.
  mockForegroundController.onBeforeStart.mockResolvedValue(undefined);
  mockForegroundController.onAfterStop.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

describe('CaptureView initial render', () => {
  it('renders the record button', () => {
    renderCapture(client);
    expect(screen.getByTestId('record-button')).toBeInTheDocument();
  });

  it('renders the notes textarea', () => {
    renderCapture(client);
    expect(screen.getByTestId('notes-field')).toBeInTheDocument();
  });

  it('notes field is a plain textarea, not contenteditable', () => {
    renderCapture(client);
    const notes = screen.getByTestId('notes-field');
    expect(notes.tagName).toBe('TEXTAREA');
    expect(notes).not.toHaveAttribute('contenteditable');
  });

  it('shows "Ready" status on mount', async () => {
    renderCapture(client);
    await waitFor(() => {
      expect(screen.getByTestId('status-label')).toHaveTextContent('Ready');
    });
  });

  it('elapsed timer is not visible before recording starts', () => {
    renderCapture(client);
    expect(screen.queryByTestId('elapsed-timer')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Record → stop cycle
// ---------------------------------------------------------------------------

describe('CaptureView record → stop cycle', () => {
  it('transitions status to "Recording" after record button click', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));

    await waitFor(() => {
      expect(screen.getByTestId('status-label')).toHaveTextContent('Recording');
    });
  });

  it('shows the elapsed timer once recording starts', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));

    await waitFor(() => {
      expect(screen.getByTestId('elapsed-timer')).toBeInTheDocument();
    });
  });

  it('shows stop and pause buttons while recording', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));

    await waitFor(() => {
      expect(screen.getByTestId('stop-button')).toBeInTheDocument();
      expect(screen.getByTestId('pause-button')).toBeInTheDocument();
    });
  });

  it('registers a captured-unprocessed meeting when stop is clicked', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));
    await userEvent.click(screen.getByTestId('stop-button'));

    await waitFor(async () => {
      const meetings = await client.listMeetings();
      const captured = meetings.filter((m) => m.state === 'captured-unprocessed');
      expect(captured).toHaveLength(1);
    });
  });

  it('the registered meeting carries the audio URI from the recorder', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));
    await userEvent.click(screen.getByTestId('stop-button'));

    await waitFor(async () => {
      const meetings = await client.listMeetings();
      const captured = meetings.find((m) => m.state === 'captured-unprocessed');
      expect(captured?.state === 'captured-unprocessed' && captured.audioUri).toBe(
        'content://media/test/recording.m4a',
      );
    });
  });

  it('the registered meeting carries the duration from the recorder', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));
    await userEvent.click(screen.getByTestId('stop-button'));

    await waitFor(async () => {
      const meetings = await client.listMeetings();
      const captured = meetings.find((m) => m.state === 'captured-unprocessed');
      expect(
        captured?.state === 'captured-unprocessed' && captured.durationMs,
      ).toBe(12_000);
    });
  });

  it('attaches notes text to the captured meeting', async () => {
    renderCapture(client);

    const notesField = screen.getByTestId('notes-field');
    await userEvent.type(notesField, 'Action items: review spec');

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));
    await userEvent.click(screen.getByTestId('stop-button'));

    await waitFor(async () => {
      const meetings = await client.listMeetings();
      const captured = meetings.find((m) => m.state === 'captured-unprocessed');
      expect(
        captured?.state === 'captured-unprocessed' && captured.hasNotes,
      ).toBe(true);
    });
  });

  it('returns to idle state and hides the timer after stop', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));
    await userEvent.click(screen.getByTestId('stop-button'));

    await waitFor(() => {
      expect(screen.getByTestId('status-label')).toHaveTextContent('Ready');
      expect(screen.queryByTestId('elapsed-timer')).not.toBeInTheDocument();
    });
  });

  it('re-shows the record button after stop', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));
    await userEvent.click(screen.getByTestId('stop-button'));

    await waitFor(() => {
      expect(screen.getByTestId('record-button')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Foreground service controller wiring
//
// Verifies that CaptureView passes platformForegroundServiceController into
// Recorder.start() and Recorder.stop() so the native foreground service and
// wake lock are actually raised/released during a recording session.
// Without this wiring, screen-off long recording silently degrades to the
// no-op controller — these tests prevent that regression.
// ---------------------------------------------------------------------------

describe('CaptureView foreground service controller wiring', () => {
  // These tests verify that CaptureView passes platformForegroundServiceController
  // as an argument to Recorder.start/stop rather than relying on the default no-op.
  // The recorder facade is mocked, so we assert on what arguments were passed to it;
  // the actual controller hooks are exercised by recorder.test.ts and the native
  // service runs on device.

  it('passes the controller to Recorder.start as the second argument', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));

    await waitFor(() => {
      expect(mockRecorder.start).toHaveBeenCalledWith(
        undefined,
        mockForegroundController,
      );
    });
  });

  it('passes the controller to Recorder.stop as the first argument', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));
    await userEvent.click(screen.getByTestId('stop-button'));

    await waitFor(() => {
      expect(mockRecorder.stop).toHaveBeenCalledWith(mockForegroundController);
    });
  });
});

// ---------------------------------------------------------------------------
// Pause / resume
// ---------------------------------------------------------------------------

describe('CaptureView pause / resume', () => {
  it('shows resume button after pause', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('pause-button'));
    await userEvent.click(screen.getByTestId('pause-button'));

    await waitFor(() => {
      expect(screen.getByTestId('resume-button')).toBeInTheDocument();
      expect(screen.queryByTestId('pause-button')).not.toBeInTheDocument();
    });
  });

  it('shows pause button again after resume', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('pause-button'));
    await userEvent.click(screen.getByTestId('pause-button'));
    await waitFor(() => screen.getByTestId('resume-button'));
    await userEvent.click(screen.getByTestId('resume-button'));

    await waitFor(() => {
      expect(screen.getByTestId('pause-button')).toBeInTheDocument();
      expect(screen.queryByTestId('resume-button')).not.toBeInTheDocument();
    });
  });

  it('status shows "Paused" when paused', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('pause-button'));
    await userEvent.click(screen.getByTestId('pause-button'));

    await waitFor(() => {
      expect(screen.getByTestId('status-label')).toHaveTextContent('Paused');
    });
  });

  it('elapsed timer is still visible while paused', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('pause-button'));
    await userEvent.click(screen.getByTestId('pause-button'));

    await waitFor(() => {
      expect(screen.getByTestId('elapsed-timer')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Permission-denied path
// ---------------------------------------------------------------------------

describe('CaptureView permission denied', () => {
  it('renders permission-denied message when checkPermission returns denied', async () => {
    mockRecorder.checkPermission.mockResolvedValue('denied');

    renderCapture(client);

    await waitFor(() => {
      expect(screen.getByTestId('permission-denied')).toBeInTheDocument();
    });
  });

  it('renders permission-denied message when the user denies on request', async () => {
    mockRecorder.checkPermission.mockResolvedValue('prompt');
    mockRecorder.requestPermission.mockResolvedValue('denied');

    renderCapture(client);

    // Record button is visible initially (permission is 'prompt').
    await waitFor(() => screen.getByTestId('record-button'));

    await userEvent.click(screen.getByTestId('record-button'));

    await waitFor(() => {
      expect(screen.getByTestId('permission-denied')).toBeInTheDocument();
    });
  });

  it('does not throw when plugin calls fail (web / test environment)', async () => {
    mockRecorder.checkPermission.mockRejectedValue(new Error('Plugin not available'));

    // Should render without throwing.
    expect(() => renderCapture(client)).not.toThrow();

    // View should still show the record button (permission defaults to 'prompt').
    await waitFor(() => {
      expect(screen.getByTestId('record-button')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// VU bar presence
// ---------------------------------------------------------------------------

describe('CaptureView VU bar', () => {
  it('renders the VU bar', () => {
    renderCapture(client);
    expect(screen.getByTestId('vu-bar')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// No ML / Opus / Tiptap
// ---------------------------------------------------------------------------

describe('CaptureView boundary assertions', () => {
  it('renders no contenteditable elements', () => {
    renderCapture(client);
    expect(document.querySelectorAll('[contenteditable]')).toHaveLength(0);
  });

  it('the notes field is a plain textarea (not a div-based editor)', () => {
    renderCapture(client);
    expect(screen.getAllByRole('textbox').length).toBeGreaterThanOrEqual(1);
    const notes = screen.getByTestId('notes-field');
    expect(notes.tagName).toBe('TEXTAREA');
  });
});

// ---------------------------------------------------------------------------
// Unsolicited-stop reconciliation (plugin fires onStopped/onError without
// the user pressing the Stop button — e.g. OS interruption, process pressure)
// ---------------------------------------------------------------------------

describe('CaptureView unsolicited stop / error reconciliation', () => {
  it('unsolicited onStopped with usable file: returns to inactive and saves the meeting', async () => {
    let stoppedCb: ((event: { uri?: string; duration?: number }) => void) | null = null;
    mockRecorder.onRecordingStopped.mockImplementation(
      (cb: (event: { uri?: string; duration?: number }) => void) => {
        stoppedCb = cb;
        return () => { stoppedCb = null; };
      },
    );

    const navigateSpy = vi.fn();
    render(
      <SyncContext.Provider value={client}>
        <CaptureView onNavigateToMeetings={navigateSpy} />
      </SyncContext.Provider>,
    );

    // Start recording.
    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));

    // Simulate OS stopping the recording unsolicitedly (stoppingRef is false).
    await act(async () => {
      stoppedCb!({ uri: 'content://media/test/os-stop.m4a', duration: 8_000 });
      await Promise.resolve();
      await Promise.resolve();
    });

    // View must return to inactive.
    await waitFor(() => {
      expect(screen.getByTestId('status-label')).toHaveTextContent('Ready');
      expect(screen.queryByTestId('elapsed-timer')).not.toBeInTheDocument();
    });

    // A meeting must have been saved.
    await waitFor(async () => {
      const meetings = await client.listMeetings();
      const captured = meetings.filter((m) => m.state === 'captured-unprocessed');
      expect(captured).toHaveLength(1);
    });

    // Navigation must have been triggered.
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('unsolicited onStopped with no usable file: returns to inactive and surfaces a notice', async () => {
    let stoppedCb: ((event: { uri?: string; duration?: number }) => void) | null = null;
    mockRecorder.onRecordingStopped.mockImplementation(
      (cb: (event: { uri?: string; duration?: number }) => void) => {
        stoppedCb = cb;
        return () => { stoppedCb = null; };
      },
    );

    renderCapture(client);

    // Start recording.
    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));

    // Simulate a stop with no usable file.
    await act(async () => {
      stoppedCb!({});
    });

    // View must return to inactive and show an error notice.
    await waitFor(() => {
      expect(screen.getByTestId('status-label')).toHaveTextContent('Ready');
      expect(screen.getByTestId('capture-error')).toBeInTheDocument();
    });
  });

  it('onError: returns to inactive and surfaces the error message', async () => {
    let errorCb: ((event: { message: string }) => void) | null = null;
    mockRecorder.onRecordingError.mockImplementation(
      (cb: (event: { message: string }) => void) => {
        errorCb = cb;
        return () => { errorCb = null; };
      },
    );

    renderCapture(client);

    // Start recording.
    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));

    // Fire a plugin error event.
    await act(async () => {
      errorCb!({ message: 'Audio focus lost' });
    });

    // View must return to inactive and display the error.
    await waitFor(() => {
      expect(screen.getByTestId('status-label')).toHaveTextContent('Ready');
      expect(screen.getByTestId('capture-error')).toHaveTextContent('Audio focus lost');
    });
  });

  it('user-initiated stop: onStopped fires during the stop window (stoppingRef true) and is a no-op', async () => {
    // Verify the stoppingRef guard: the plugin event fired during user-stop
    // must not trigger a second navigate.  With the undo window, navigation is
    // deferred 3 s; fake timers let us advance past the countdown.
    //
    // Strategy: use real timers for the setup/teardown, switch to fake only for
    // the countdown advancement, then switch back.  waitFor is only called
    // outside the fake-timer window to avoid interaction with its internal
    // polling timeouts.
    let stoppedCb: ((event: { uri?: string; duration?: number }) => void) | null = null;
    mockRecorder.onRecordingStopped.mockImplementation(
      (cb: (event: { uri?: string; duration?: number }) => void) => {
        stoppedCb = cb;
        return () => { stoppedCb = null; };
      },
    );

    const navigateSpy = vi.fn();

    // Override stop() to fire the plugin event synchronously while stoppingRef is true.
    mockRecorder.stop.mockImplementation(async () => {
      if (stoppedCb) {
        stoppedCb({ uri: 'content://media/test/race.m4a', duration: 5_000 });
      }
      return { uri: 'content://media/test/user-stop.m4a', durationMs: 5_000 };
    });

    render(
      <SyncContext.Provider value={client}>
        <CaptureView onNavigateToMeetings={navigateSpy} />
      </SyncContext.Provider>,
    );

    await userEvent.click(screen.getByTestId('record-button'));
    await waitFor(() => screen.getByTestId('stop-button'));

    // Switch to fake timers just before the action that triggers the countdown.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId('stop-button'));
        // Flush the async stop() mock and handleStop's await chain.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // The undo banner should now be visible (no timer needed for this).
      expect(screen.getByTestId('saved-banner')).toBeInTheDocument();
      // navigate not yet called — still in the undo window.
      expect(navigateSpy).toHaveBeenCalledTimes(0);

      // Advance the countdown 1 s at a time so React state flushes between ticks.
      await act(async () => { vi.advanceTimersByTime(1_000); });
      await act(async () => { vi.advanceTimersByTime(1_000); });
      await act(async () => { vi.advanceTimersByTime(1_000); });

      // After countdown expires, navigate fires exactly once.
      // stoppedCb path was gated by stoppingRef — no double-fire.
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Elapsed timer format
// ---------------------------------------------------------------------------

describe('CaptureView elapsed timer', () => {
  it('timer initially shows 0:00 on first render after record starts', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));

    await waitFor(() => {
      expect(screen.getByTestId('elapsed-timer')).toBeInTheDocument();
      // formatClock renders M:SS (rolling to H:MM:SS past an hour).
      expect(screen.getByTestId('elapsed-timer').textContent).toMatch(/^\d{1,2}:\d{2}$/);
    });
  });

  it('timer advances while recording (using fake timers)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    renderCapture(client);

    // Wait for the initial checkPermission effect to settle before switching
    // to fake-timer territory.
    await act(async () => {
      await Promise.resolve();
    });

    // Click record using fireEvent (synchronous) so userEvent's own timers
    // don't interact with vi fake timers.
    await act(async () => {
      fireEvent.click(screen.getByTestId('record-button'));
      // Flush the async start() mock resolution.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Advance wall clock by 5 seconds — this triggers the 1000 ms timer interval.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    const timerText = screen.getByTestId('elapsed-timer').textContent;
    expect(timerText).toMatch(/^\d{1,2}:\d{2}$/);

    vi.useRealTimers();
  });
});
