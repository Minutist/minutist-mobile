/**
 * App shell — routing scaffold, layout chrome, and bottom tab switcher.
 *
 * The active view is a typed union; no router library is needed at this scale.
 * CSS lives in App.css and references only theme.css variables + env() insets —
 * no hard-coded colours, fonts, or radii.
 *
 * A single MockSyncClient instance is provided at the root via SyncContext so all
 * views share one store.  A single RecorderFacade instance is provided via
 * RecorderContext so tests can inject a mock without module-level patching.
 *
 * A sync status pill is rendered in the app-bar to surface connection state
 * without intruding on any view's content area.
 */
import { useState, useEffect, useCallback } from 'react';
import './App.css';
import { CaptureView } from './views/CaptureView';
import { MeetingsView } from './views/MeetingsView';
import { SyncContext } from './sync/useSync';
import { mockSyncClient } from './sync/mock';
import { RecorderContext, realRecorderFacade } from './capture/RecorderContext';
import type { RecorderFacade } from './capture/RecorderContext';
import type { SyncStatus } from './sync/index';

type View = 'capture' | 'meetings';

/** Small inline SVG glyph for the Capture tab — a filled record dot. */
function CaptureIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="10" cy="10" r="6" />
    </svg>
  );
}

/** Small inline SVG glyph for the Meetings tab — three stacked horizontal lines. */
function MeetingsIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      <line x1="3" y1="6" x2="17" y2="6" />
      <line x1="3" y1="10" x2="17" y2="10" />
      <line x1="3" y1="14" x2="17" y2="14" />
    </svg>
  );
}

const TABS: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: 'capture', label: 'Capture', icon: <CaptureIcon /> },
  { id: 'meetings', label: 'Meetings', icon: <MeetingsIcon /> },
];

function syncStatusLabel(status: SyncStatus): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'syncing':
      return 'Syncing…';
    case 'error':
      return 'Sync error';
  }
}

interface AppProps {
  /**
   * Override the recorder facade — used in integration tests to inject a mock
   * without module-level patching.
   */
  recorderFacade?: RecorderFacade;
  /**
   * Override the sync client — used in integration tests to provide a fresh
   * MockSyncClient instance with known state.  Defaults to the module-level
   * singleton so the production app always shares one client.
   */
  syncClient?: import('./sync/index').SyncClient;
}

export function App({
  recorderFacade = realRecorderFacade,
  syncClient = mockSyncClient,
}: AppProps = {}) {
  const [activeView, setActiveView] = useState<View>('capture');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ kind: 'idle' });

  useEffect(() => {
    return syncClient.onStatus(setSyncStatus);
  }, [syncClient]);

  const statusLabel = syncStatusLabel(syncStatus);

  const handleNavigateToMeetings = useCallback(() => {
    setActiveView('meetings');
  }, []);

  return (
    <SyncContext.Provider value={syncClient}>
      <RecorderContext.Provider value={recorderFacade}>
        <div className="app-shell">
          <header className="app-bar">
            <h1 className="app-bar__wordmark">Minutist</h1>
            {statusLabel && (
              <span
                className={`app-bar__status-pill app-bar__status-pill--${syncStatus.kind}`}
                data-testid="status-pill"
                aria-label={`Sync status: ${statusLabel}`}
              >
                {statusLabel}
              </span>
            )}
          </header>

          {activeView === 'capture' ? (
            <CaptureView onNavigateToMeetings={handleNavigateToMeetings} />
          ) : (
            <MeetingsView />
          )}

          <nav className="tab-bar" role="tablist" aria-label="Main navigation">
            {TABS.map(({ id, label, icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={activeView === id}
                className="tab-bar__button"
                onClick={() => setActiveView(id)}
              >
                {icon}
                {label}
              </button>
            ))}
          </nav>
        </div>
      </RecorderContext.Provider>
    </SyncContext.Provider>
  );
}
