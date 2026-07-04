/**
 * MeetingsView tests.
 *
 * Covers:
 * - List renders both synced and captured-unprocessed meetings from the mock.
 * - Captured-unprocessed item shows a "Sync now" action.
 * - Clicking "Sync now" calls syncMeeting with the correct id.
 * - Selecting a synced meeting opens read-only detail (transcript + summary).
 * - Detail has no contenteditable or edit controls.
 * - Transcript speaker colours reference var(--speaker-N), not hard-coded values.
 * - Pairing affordance renders own ticket and calls pair() on submit.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockSyncClient } from '../sync/mock';
import { SyncContext } from '../sync/useSync';
import type { PairingTicket } from '../sync/index';
import { MeetingsView } from './MeetingsView';

// Mock the native Share plugin so we can assert it is called with the meeting
// text (jsdom has no navigator.share bridge).
interface ShareOpts { title?: string; text?: string; dialogTitle?: string }
const shareMock = vi.fn<(opts: ShareOpts) => Promise<void>>();
vi.mock('@capacitor/share', () => ({
  Share: { share: (opts: ShareOpts) => shareMock(opts) },
}));

// Mock the App plugin so the backButton listener binds without a native bridge.
const backButtonHandlers: Array<(e: { canGoBack: boolean }) => void> = [];
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: (event: string, handler: (e: { canGoBack: boolean }) => void) => {
      if (event === 'backButton') backButtonHandlers.push(handler);
      return Promise.resolve({ remove: async () => {} });
    },
    exitApp: vi.fn(async () => {}),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render MeetingsView with a fresh MockSyncClient injected via context.
 * Returns the client so tests can inspect / stub it.
 */
function renderWithMock(client: MockSyncClient) {
  return render(
    <SyncContext.Provider value={client}>
      <MeetingsView />
    </SyncContext.Provider>,
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let client: MockSyncClient;

beforeEach(() => {
  client = new MockSyncClient();
  shareMock.mockReset();
  shareMock.mockResolvedValue(undefined);
  backButtonHandlers.length = 0;
});

// ---------------------------------------------------------------------------
// List — both meeting states render
// ---------------------------------------------------------------------------

describe('MeetingsView list', () => {
  it('renders the two fixture synced meetings', async () => {
    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-meet-001')).toBeInTheDocument();
      expect(screen.getByTestId('meeting-row-meet-002')).toBeInTheDocument();
    });
  });

  it('renders a captured-unprocessed meeting when one is registered', async () => {
    client.registerCaptured({
      id: 'local-001',
      title: 'Morning standup',
      startedAt: new Date('2026-06-23T08:00:00').getTime(),
      durationMs: 900_000,
      hasNotes: false,
    });

    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-local-001')).toBeInTheDocument();
    });
  });

  it('shows the "recorded, awaiting sync" affordance for captured meetings', async () => {
    client.registerCaptured({
      id: 'local-002',
      title: 'Design review',
      startedAt: Date.now(),
      durationMs: 1_800_000,
      hasNotes: true,
    });

    renderWithMock(client);

    await waitFor(() => {
      expect(
        screen.getByText(/recorded.*awaiting sync/i),
      ).toBeInTheDocument();
    });
  });

  it('does NOT show the awaiting badge for synced meetings', async () => {
    renderWithMock(client);

    await waitFor(() => {
      // Both fixture meetings are synced — no badge should appear.
      expect(screen.queryByText(/awaiting sync/i)).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Sync action
// ---------------------------------------------------------------------------

describe('MeetingsView sync action', () => {
  it('shows a Sync now button for captured-unprocessed meetings', async () => {
    client.registerCaptured({
      id: 'local-sync',
      title: 'Quarterly planning',
      startedAt: Date.now(),
      durationMs: 3_600_000,
      hasNotes: false,
    });

    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('sync-button-local-sync')).toBeInTheDocument();
    });
  });

  it('does NOT show a Sync now button for synced meetings', async () => {
    renderWithMock(client);

    await waitFor(() => {
      // Fixture meetings are synced — no sync buttons.
      expect(screen.queryByTestId('sync-button-meet-001')).not.toBeInTheDocument();
      expect(screen.queryByTestId('sync-button-meet-002')).not.toBeInTheDocument();
    });
  });

  it('shows a Processing affordance and no Sync button for a claimed meeting', async () => {
    // 'claimed' = a host has adopted it and is processing (no results yet);
    // it must not offer a Sync action.
    client.registerCaptured({
      id: 'local-claimed',
      title: 'Board sync',
      startedAt: Date.now(),
      durationMs: 1_200_000,
      hasNotes: true,
      processing: 'claimed',
      claimedBy: 'Studio desktop',
    });

    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-local-claimed')).toBeInTheDocument();
    });
    expect(screen.getByText('Processing on Studio desktop…')).toBeInTheDocument();
    expect(screen.getByTestId('processing-local-claimed')).toBeInTheDocument();
    expect(
      screen.queryByTestId('sync-button-local-claimed'),
    ).not.toBeInTheDocument();
  });

  it('calls syncMeeting with the correct id when Sync now is clicked', async () => {
    const syncMeetingSpy = vi.spyOn(client, 'syncMeeting');

    client.registerCaptured({
      id: 'local-click',
      title: 'Sprint retro',
      startedAt: Date.now(),
      durationMs: 2_400_000,
      hasNotes: false,
    });

    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('sync-button-local-click')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('sync-button-local-click'));

    expect(syncMeetingSpy).toHaveBeenCalledWith('local-click');
    expect(syncMeetingSpy).toHaveBeenCalledTimes(1);
  });

  it('list updates reactively via subscription — no manual refresh needed', async () => {
    // The mock echoes syncMeeting synchronously through onMeetingsChanged.
    // Confirm that after clicking Sync now the row transitions from
    // captured-unprocessed to synced without any explicit refreshMeetings call.
    client.registerCaptured({
      id: 'local-reactive',
      title: 'Reactive sync test',
      startedAt: Date.now(),
      durationMs: 1_200_000,
      hasNotes: false,
    });

    renderWithMock(client);

    // Captured badge is visible before sync.
    await waitFor(() => {
      expect(screen.getByTestId('sync-button-local-reactive')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('sync-button-local-reactive'));

    // After sync the captured badge is gone — transition arrived via subscription.
    await waitFor(() => {
      expect(screen.queryByTestId('sync-button-local-reactive')).not.toBeInTheDocument();
    });

    // The row still exists but is now a synced (clickable) row.
    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-local-reactive')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Meeting detail — read-only
// ---------------------------------------------------------------------------

describe('MeetingsView meeting detail', () => {
  it('opens the detail view when a synced meeting is clicked', async () => {
    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-meet-001')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('Open Product roadmap review'));

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Meeting detail: Product roadmap review/),
      ).toBeInTheDocument();
      expect(screen.getByText('Product roadmap review')).toBeInTheDocument();
    });
  });

  it('shows the meeting summary in the detail view', async () => {
    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-meet-001')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('Open Product roadmap review'));

    await waitFor(() => {
      expect(screen.getByTestId('meeting-summary')).toBeInTheDocument();
      expect(screen.getByTestId('meeting-summary').textContent).toContain(
        'Relay is deployed',
      );
    });
  });

  it('shows transcript segments in the detail view', async () => {
    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-meet-001')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('Open Product roadmap review'));

    await waitFor(() => {
      const rows = screen.getAllByTestId('transcript-row');
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it('has no contenteditable in the detail view', async () => {
    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-meet-001')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('Open Product roadmap review'));

    await waitFor(() => {
      // No contenteditable attributes anywhere in the document.
      const editables = document.querySelectorAll('[contenteditable]');
      expect(editables).toHaveLength(0);
    });
  });

  it('has no text inputs or textareas in the detail view', async () => {
    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-meet-001')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('Open Product roadmap review'));

    await waitFor(() => {
      // The detail view should have no editable fields.
      const inputs = document.querySelectorAll('input, textarea');
      expect(inputs).toHaveLength(0);
    });
  });

  it('navigates back to the list when the back button is pressed', async () => {
    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-meet-001')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('Open Product roadmap review'));

    await waitFor(() => {
      expect(screen.getByLabelText('Back to meetings list')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('Back to meetings list'));

    await waitFor(() => {
      expect(screen.getByLabelText('Meetings view')).toBeInTheDocument();
      expect(screen.queryByLabelText(/Meeting detail/)).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// A10: Android system back button
// ---------------------------------------------------------------------------

describe('MeetingsView Android back button', () => {
  it('registers a backButton listener on mount', async () => {
    renderWithMock(client);
    await waitFor(() => {
      expect(backButtonHandlers.length).toBeGreaterThan(0);
    });
  });

  it('pops the detail view back to the list on system back', async () => {
    renderWithMock(client);

    await waitFor(() => screen.getByTestId('meeting-row-meet-001'));
    await userEvent.click(screen.getByLabelText('Open Product roadmap review'));
    await waitFor(() => screen.getByLabelText('Back to meetings list'));

    // Fire the registered Android back-button handler.
    act(() => {
      backButtonHandlers.forEach((h) => h({ canGoBack: true }));
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Meetings view')).toBeInTheDocument();
      expect(screen.queryByLabelText(/Meeting detail/)).not.toBeInTheDocument();
    });
  });

  it('closes the pairing panel on system back', async () => {
    renderWithMock(client);

    await waitFor(() => screen.getByLabelText('Toggle pairing panel'));
    await userEvent.click(screen.getByLabelText('Toggle pairing panel'));
    await waitFor(() => screen.getByLabelText('Pairing panel'));

    act(() => {
      backButtonHandlers.forEach((h) => h({ canGoBack: true }));
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('Pairing panel')).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// A12: refresh + share
// ---------------------------------------------------------------------------

describe('MeetingsView refresh + share', () => {
  it('refresh button re-reads listMeetings', async () => {
    const listSpy = vi.spyOn(client, 'listMeetings');
    renderWithMock(client);

    await waitFor(() => screen.getByTestId('refresh-button'));
    const callsBefore = listSpy.mock.calls.length;

    await userEvent.click(screen.getByTestId('refresh-button'));

    await waitFor(() => {
      expect(listSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('share button calls Share.share with the meeting title and body', async () => {
    renderWithMock(client);

    await waitFor(() => screen.getByTestId('meeting-row-meet-001'));
    await userEvent.click(screen.getByLabelText('Open Product roadmap review'));
    await waitFor(() => screen.getByTestId('share-button'));

    await userEvent.click(screen.getByTestId('share-button'));

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledTimes(1);
    });
    const arg = shareMock.mock.calls[0][0];
    expect(arg.title).toBe('Product roadmap review');
    // The share body carries both the summary and the labelled transcript.
    expect(arg.text ?? '').toContain('Reviewed WS4 milestones');
    expect(arg.text ?? '').toContain('Andrew: Alright, let us walk through');
  });
});

// ---------------------------------------------------------------------------
// Transcript speaker colours
// ---------------------------------------------------------------------------

describe('Transcript speaker colours', () => {
  it('applies var(--speaker-N) inline styles to speaker chips', async () => {
    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-meet-001')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('Open Product roadmap review'));

    await waitFor(() => {
      const rows = screen.getAllByTestId('transcript-row');
      expect(rows.length).toBeGreaterThan(0);
    });

    // Speaker chip elements carry a colour via var(--speaker-N).
    const speakerEls = document.querySelectorAll('.transcript-row__chip');
    speakerEls.forEach((el) => {
      const style = (el as HTMLElement).style.color;
      expect(style).toMatch(/var\(--speaker-\d+\)/);
    });
  });

  it('applies var(--speaker-N) tinted background to speaker chips', async () => {
    renderWithMock(client);

    await waitFor(() => {
      expect(screen.getByTestId('meeting-row-meet-001')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('Open Product roadmap review'));

    await waitFor(() => {
      const chips = document.querySelectorAll('.transcript-row__chip');
      expect(chips.length).toBeGreaterThan(0);
      chips.forEach((chip) => {
        const bg = (chip as HTMLElement).style.background;
        expect(bg).toMatch(/color-mix\(in srgb, var\(--speaker-\d+\)/);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Pairing affordance
// ---------------------------------------------------------------------------

describe('MeetingsView pairing', () => {
  it('shows own ticket when pairing panel is opened', async () => {
    renderWithMock(client);

    await userEvent.click(screen.getByLabelText('Toggle pairing panel'));

    await waitFor(() => {
      expect(screen.getByTestId('own-ticket')).toBeInTheDocument();
      expect(screen.getByTestId('own-ticket').textContent).toBe(
        'mock-ticket-abcdef1234567890',
      );
    });
  });

  it('calls pair() with the submitted ticket', async () => {
    const pairSpy = vi.spyOn(client, 'pair');

    renderWithMock(client);

    await userEvent.click(screen.getByLabelText('Toggle pairing panel'));

    const input = await screen.findByLabelText('Desktop pairing ticket');
    await userEvent.type(input, 'desktop-ticket-xyz');

    await userEvent.click(screen.getByLabelText('Pair with desktop'));

    expect(pairSpy).toHaveBeenCalledWith('desktop-ticket-xyz' as PairingTicket);
  });
});
