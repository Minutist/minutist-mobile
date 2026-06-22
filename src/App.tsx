/**
 * App shell — routing scaffold, layout chrome, and bottom tab switcher.
 *
 * The active view is a typed union; no router library is needed at this scale.
 * CSS lives in App.css and references only theme.css variables + env() insets —
 * no hard-coded colours, fonts, or radii.
 *
 * A sync status pill is rendered in the app-bar to surface connection state
 * without intruding on any view's content area.
 */
import { useState, useEffect } from 'react';
import './App.css';
import { CaptureView } from './views/CaptureView';
import { MeetingsView } from './views/MeetingsView';
import { useSync } from './sync/useSync';
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

export function App() {
  const [activeView, setActiveView] = useState<View>('capture');
  const sync = useSync();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ kind: 'idle' });

  useEffect(() => {
    return sync.onStatus(setSyncStatus);
  }, [sync]);

  const statusLabel = syncStatusLabel(syncStatus);

  return (
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

      {activeView === 'capture' ? <CaptureView /> : <MeetingsView />}

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
  );
}
