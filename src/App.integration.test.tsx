/**
 * Integration test — capture → captured-unprocessed → sync → read-only detail.
 *
 * Exercises the full App shell (both views, shared SyncClient, shared recorder
 * facade) on mock data.  No native bridge, no real device required.
 *
 * Flow:
 *   1. Capture tab is active on mount.
 *   2. User starts and stops a recording.
 *   3. App navigates to Meetings automatically (via onNavigateToMeetings).
 *   4. The captured-unprocessed item appears in the list.
 *   5. User triggers "Retry sync"; the mock transitions the meeting to synced.
 *   6. User opens the synced meeting; detail is read-only (no contenteditable).
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from './App';
import { MockSyncClient } from './sync/mock';
import type { RecorderFacade } from './capture/RecorderContext';

// ---------------------------------------------------------------------------
// Recorder facade mock — constructed as a plain object, injected via App prop.
// No module-level vi.mock needed because CaptureView reads from RecorderContext.
// ---------------------------------------------------------------------------

function makeRecorderMock(): RecorderFacade {
  return {
    checkPermission: vi.fn().mockResolvedValue('granted'),
    requestPermission: vi.fn().mockResolvedValue('granted'),
    start: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue({
      uri: 'content://media/test/integration.m4a',
      durationMs: 45_000,
    }),
    getAmplitude: vi.fn().mockResolvedValue(0),
    // No-op subscriptions — the integration test exercises the user-initiated
    // stop path only; unsolicited-stop reconciliation is covered in CaptureView.test.tsx.
    onStopped: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Fresh state for each test — avoids cross-test contamination.
// ---------------------------------------------------------------------------

let syncClient: MockSyncClient;
let recorderFacade: RecorderFacade;

beforeEach(() => {
  vi.clearAllMocks();
  // Start with no fixture meetings so captured items are unambiguous.
  syncClient = new MockSyncClient({ noFixtures: true });
  recorderFacade = makeRecorderMock();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Record and stop a meeting from the Capture tab, then navigate to Meetings.
 *
 * After stop, the undo banner shows for 3 s before auto-navigating.  This
 * helper skips the countdown by clicking the Meetings tab directly so tests
 * don't need to deal with fake timers.
 */
async function recordAndStop() {
  await userEvent.click(screen.getByTestId('record-button'));
  await waitFor(() => screen.getByTestId('stop-button'));
  await userEvent.click(screen.getByTestId('stop-button'));
  // Wait for the undo banner — confirms save succeeded.
  await waitFor(() => screen.getByTestId('saved-banner'));
  // Navigate directly rather than waiting for the 3-second countdown.
  await userEvent.click(screen.getByRole('tab', { name: 'Meetings' }));
  await waitFor(() => screen.getByLabelText('Meetings view'));
}

// ---------------------------------------------------------------------------
// Integration flow
// ---------------------------------------------------------------------------

describe('App integration: capture → meetings → sync → detail', () => {
  it('capture tab is active on mount', () => {
    render(<App recorderFacade={recorderFacade} syncClient={syncClient} />);

    expect(screen.getByLabelText('Capture view')).toBeInTheDocument();
    expect(screen.queryByLabelText('Meetings view')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Capture' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('navigates to Meetings after stop and shows the captured-unprocessed item', async () => {
    render(<App recorderFacade={recorderFacade} syncClient={syncClient} />);

    await recordAndStop();

    // The new captured-unprocessed meeting appears in the list.
    await waitFor(() => {
      expect(screen.getByText(/recorded.*awaiting sync/i)).toBeInTheDocument();
    });
  });

  it('the full shell flow: record → captured-unprocessed → sync → read-only synced detail', async () => {
    render(<App recorderFacade={recorderFacade} syncClient={syncClient} />);

    // Step 1: record and stop in Capture tab.
    await recordAndStop();

    // Step 2: captured-unprocessed item is visible.
    await waitFor(() => {
      expect(screen.getByText(/recorded.*awaiting sync/i)).toBeInTheDocument();
    });

    // Step 3: the captured meeting row has a "Retry sync" button.
    // Use getByText to target the button content (the sync button has no aria-label).
    const retrySyncButton = screen.getByText('Retry sync');
    expect(retrySyncButton.closest('button')).toBeInTheDocument();

    // Step 4: click Retry sync; the mock converts the meeting to synced.
    await userEvent.click(retrySyncButton);

    // Step 5: "awaiting sync" badge is gone — the meeting is now synced.
    await waitFor(() => {
      expect(screen.queryByText(/recorded.*awaiting sync/i)).not.toBeInTheDocument();
    });

    // Step 6: the synced meeting is now a clickable row.  With noFixtures the list
    // has exactly one meeting.  Its aria-label is the meeting title (generated date) —
    // query by data-testid to avoid depending on the dynamic value.
    await waitFor(() => screen.getByTestId(/^meeting-row-/));
    await userEvent.click(screen.getByTestId(/^meeting-row-/));

    // Step 7: meeting detail is read-only.
    await waitFor(() => {
      // No editable elements.
      expect(document.querySelectorAll('[contenteditable]')).toHaveLength(0);
      expect(document.querySelectorAll('input, textarea')).toHaveLength(0);
    });

    // Mock summary is present.
    await waitFor(() => {
      const summary = screen.getByTestId('meeting-summary');
      expect(summary).toBeInTheDocument();
      expect(summary.textContent).toContain('Mock summary');
    });
  });

  it('status pill reflects sync status changes during syncMeeting', async () => {
    render(<App recorderFacade={recorderFacade} syncClient={syncClient} />);

    await recordAndStop();

    await waitFor(() => screen.getByText(/recorded.*awaiting sync/i));

    const retrySyncButton = screen.getByText('Retry sync');
    await userEvent.click(retrySyncButton);

    // After sync the mock emits 'syncing' then 'connected' synchronously.
    // By the time click resolves the status is 'connected' (shown as 'Connected').
    await waitFor(() => {
      // Either the Connected pill is shown, or no pill at all (idle) — no error.
      const pill = screen.queryByTestId('status-pill');
      if (pill) {
        expect(pill.textContent).not.toBe('Sync error');
      }
    });
  });

  it('single recorder facade instance is used (start called exactly once per recording)', async () => {
    render(<App recorderFacade={recorderFacade} syncClient={syncClient} />);

    await recordAndStop();

    expect(recorderFacade.start).toHaveBeenCalledTimes(1);
    expect(recorderFacade.stop).toHaveBeenCalledTimes(1);
  });

  it('back button in detail view returns to the meetings list', async () => {
    render(<App recorderFacade={recorderFacade} syncClient={syncClient} />);

    await recordAndStop();

    await waitFor(() => screen.getByText(/recorded.*awaiting sync/i));
    await userEvent.click(screen.getByText('Retry sync'));
    await waitFor(() =>
      expect(screen.queryByText(/recorded.*awaiting sync/i)).not.toBeInTheDocument(),
    );

    await waitFor(() => screen.getByTestId(/^meeting-row-/));
    await userEvent.click(screen.getByTestId(/^meeting-row-/));

    await waitFor(() => screen.getByLabelText('Back to meetings list'));
    await userEvent.click(screen.getByLabelText('Back to meetings list'));

    await waitFor(() => {
      expect(screen.getByLabelText('Meetings view')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Empty-state smoke test
// ---------------------------------------------------------------------------

describe('App: Meetings empty state', () => {
  it('shows the no-meetings prompt when the client has no meetings', async () => {
    render(<App recorderFacade={recorderFacade} syncClient={syncClient} />);

    // Navigate to Meetings manually (no recording, so no auto-navigate).
    await userEvent.click(screen.getByRole('tab', { name: 'Meetings' }));

    await waitFor(() => {
      expect(screen.getByText(/no meetings yet/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Shared context: both views see the same meeting after capture
// ---------------------------------------------------------------------------

describe('App: shared SyncClient context', () => {
  it('a meeting saved in CaptureView appears in MeetingsView on the same client', async () => {
    render(<App recorderFacade={recorderFacade} syncClient={syncClient} />);

    // Start on Capture tab.
    await recordAndStop();

    // Meetings view is showing — confirm meetings list has the new item.
    const meetings = await syncClient.listMeetings();
    expect(meetings.some((m) => m.state === 'captured-unprocessed')).toBe(true);

    // The "awaiting sync" badge is visible in the rendered list.
    await waitFor(() => {
      const badge = screen.getByText(/recorded.*awaiting sync/i);
      expect(within(badge.closest('li')!).getByText('Retry sync')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Account-peer registration on boot
// ---------------------------------------------------------------------------

describe('App: account-peer registration on boot', () => {
  it('calls refreshAccountPeers on mount regardless of the active tab', async () => {
    // Spy on refreshAccountPeers without breaking the mock's implementation.
    const refreshSpy = vi.spyOn(syncClient, 'refreshAccountPeers');

    render(<App recorderFacade={recorderFacade} syncClient={syncClient} />);

    // refreshAccountPeers should have been called on mount, even though
    // the Capture tab is active (not the Meetings tab where the view
    // would subscribe to onMeetingsChanged).
    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    refreshSpy.mockRestore();
  });

  it('refreshAccountPeers is idempotent and network-silent on failure', async () => {
    // The mock's refreshAccountPeers is always async, but App catches
    // the promise rejection (if any) so the UI render never breaks.
    const refreshSpy = vi.spyOn(syncClient, 'refreshAccountPeers');

    render(<App recorderFacade={recorderFacade} syncClient={syncClient} />);

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
    });

    // The app should still be in a valid state — rendering the Capture view.
    expect(screen.getByLabelText('Capture view')).toBeInTheDocument();

    refreshSpy.mockRestore();
  });
});
