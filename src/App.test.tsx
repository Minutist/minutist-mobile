import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { App } from './App';
import { MockSyncClient } from './sync/mock';
import type { SyncStatus } from './sync/index';

describe('App', () => {
  it('renders the product name', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Minutist' })).toBeInTheDocument();
  });

  it('renders both tabs', () => {
    render(<App />);
    expect(screen.getByRole('tab', { name: 'Capture' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Meetings' })).toBeInTheDocument();
  });

  it('shows the Capture view by default', () => {
    render(<App />);
    expect(screen.getByLabelText('Capture view')).toBeInTheDocument();
    expect(screen.queryByLabelText('Meetings view')).not.toBeInTheDocument();
  });

  it('switches to the Meetings view when the Meetings tab is clicked', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: 'Meetings' }));
    expect(screen.getByLabelText('Meetings view')).toBeInTheDocument();
    expect(screen.queryByLabelText('Capture view')).not.toBeInTheDocument();
  });

  it('switches back to the Capture view when the Capture tab is clicked', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: 'Meetings' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Capture' }));
    expect(screen.getByLabelText('Capture view')).toBeInTheDocument();
    expect(screen.queryByLabelText('Meetings view')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sync status pill — rendering per SyncStatus.kind
// ---------------------------------------------------------------------------

describe('App sync status pill', () => {
  let syncClient: MockSyncClient;

  // Helper: emit a status change on the sync client and let React flush.
  async function emitStatus(status: SyncStatus) {
    act(() => {
      // Access the private emitStatus helper indirectly via pair/syncMeeting,
      // or cast to any to drive the test directly.
      (syncClient as unknown as { emitStatus: (s: SyncStatus) => void }).emitStatus(status);
    });
  }

  beforeEach(() => {
    syncClient = new MockSyncClient({ noFixtures: true });
  });

  it('shows no pill when status is idle', () => {
    render(<App syncClient={syncClient} />);
    // idle — label is empty string so the pill is not rendered at all.
    expect(screen.queryByTestId('status-pill')).not.toBeInTheDocument();
  });

  it('shows "Connecting…" pill when status is connecting', async () => {
    render(<App syncClient={syncClient} />);
    await emitStatus({ kind: 'connecting' });
    const pill = screen.getByTestId('status-pill');
    expect(pill).toHaveTextContent('Connecting…');
    expect(pill).toHaveClass('app-bar__status-pill--connecting');
  });

  it('shows "Connected" pill when status is connected', async () => {
    render(<App syncClient={syncClient} />);
    await emitStatus({ kind: 'connected', peerId: 'peer-xyz' });
    const pill = screen.getByTestId('status-pill');
    expect(pill).toHaveTextContent('Connected');
    expect(pill).toHaveClass('app-bar__status-pill--connected');
  });

  it('shows "Syncing…" pill when status is syncing', async () => {
    render(<App syncClient={syncClient} />);
    await emitStatus({ kind: 'syncing', peerId: 'peer-xyz', meetingId: 'meet-001' });
    const pill = screen.getByTestId('status-pill');
    expect(pill).toHaveTextContent('Syncing…');
    expect(pill).toHaveClass('app-bar__status-pill--syncing');
  });

  it('shows "Sync error" pill when status is error', async () => {
    render(<App syncClient={syncClient} />);
    await emitStatus({ kind: 'error', message: 'timeout' });
    const pill = screen.getByTestId('status-pill');
    expect(pill).toHaveTextContent('Sync error');
    expect(pill).toHaveClass('app-bar__status-pill--error');
  });

  it('pill has an aria-label describing the sync state', async () => {
    render(<App syncClient={syncClient} />);
    await emitStatus({ kind: 'connected', peerId: 'peer-xyz' });
    const pill = screen.getByTestId('status-pill');
    expect(pill).toHaveAttribute('aria-label', 'Sync status: Connected');
  });

  it('pill transitions from syncing back to idle when status becomes idle', async () => {
    render(<App syncClient={syncClient} />);
    await emitStatus({ kind: 'syncing', peerId: 'peer-xyz', meetingId: 'meet-001' });
    expect(screen.getByTestId('status-pill')).toBeInTheDocument();

    await emitStatus({ kind: 'idle' });
    expect(screen.queryByTestId('status-pill')).not.toBeInTheDocument();
  });
});
