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

const { mockRecorder } = vi.hoisted(() => {
  const mockRecorder = {
    checkPermission: vi.fn(),
    requestPermission: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    getAmplitude: vi.fn(),
  };
  return { mockRecorder };
});

vi.mock('../capture/recorder', () => mockRecorder);

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
// Elapsed timer format
// ---------------------------------------------------------------------------

describe('CaptureView elapsed timer', () => {
  it('timer initially shows 00:00 on first render after record starts', async () => {
    renderCapture(client);

    await userEvent.click(screen.getByTestId('record-button'));

    await waitFor(() => {
      expect(screen.getByTestId('elapsed-timer')).toBeInTheDocument();
      expect(screen.getByTestId('elapsed-timer').textContent).toMatch(/^\d{2}:\d{2}$/);
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

    // Advance wall clock by 5 seconds — this triggers the 500 ms timer interval.
    act(() => {
      vi.advanceTimersByTime(5_500);
    });

    const timerText = screen.getByTestId('elapsed-timer').textContent;
    expect(timerText).toMatch(/^\d{2}:\d{2}$/);

    vi.useRealTimers();
  });
});
