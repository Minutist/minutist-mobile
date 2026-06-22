/**
 * App shell — routing scaffold, layout chrome, and bottom tab switcher.
 *
 * The active view is a typed union; no router library is needed at this scale.
 * CSS lives in App.css and references only theme.css variables + env() insets —
 * no hard-coded colours, fonts, or radii.
 */
import { useState } from 'react';
import './App.css';
import { CaptureView } from './views/CaptureView';
import { MeetingsView } from './views/MeetingsView';

type View = 'capture' | 'meetings';

const TABS: { id: View; label: string }[] = [
  { id: 'capture', label: 'Capture' },
  { id: 'meetings', label: 'Meetings' },
];

export function App() {
  const [activeView, setActiveView] = useState<View>('capture');

  return (
    <div className="app-shell">
      <header className="app-bar">
        <h1 className="app-bar__wordmark">Minutist</h1>
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
