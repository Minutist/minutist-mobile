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
import { RecorderContext } from './capture/RecorderContext';
import * as RealRecorder from './capture/recorder';
import type { RecorderFacade } from './capture/RecorderContext';
import type { SyncStatus } from './sync/index';

type View = 'capture' | 'meetings';

const TABS: { id: View; label: string }[] = [
  { id: 'capture', label: 'Capture' },
  { id: 'meetings', label: 'Meetings' },
];

function syncStatusLabel(status: SyncStatus): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Paired';
    case 'syncing':
      return 'Syncing…';
    case 'error':
      return 'Sync error';
  }
}

/**
 * Default recorder facade delegates to the real recorder module.
 * Tests substitute this via RecorderContext.Provider.
 */
const defaultRecorderFacade: RecorderFacade = {
  checkPermission: RealRecorder.checkPermission,
  requestPermission: RealRecorder.requestPermission,
  start: RealRecorder.start,
  pause: RealRecorder.pause,
  resume: RealRecorder.resume,
  stop: RealRecorder.stop,
  getAmplitude: RealRecorder.getAmplitude,
};

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
  recorderFacade = defaultRecorderFacade,
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
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                aria-selected={activeView === id}
                className="tab-bar__button"
                onClick={() => setActiveView(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </RecorderContext.Provider>
    </SyncContext.Provider>
  );
}
