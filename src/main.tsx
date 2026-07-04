import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StatusBar, Style } from '@capacitor/status-bar';

// Desktop design tokens (the "Editorial Ink" theme), imported once ahead of
// every component stylesheet — the single source of truth for colour, type,
// and geometry. Reused verbatim from the desktop app.
import './styles/theme.css';

import { App } from './App';

// Theme the native status bar to match --bg (#f4f0e7) so the warm-paper
// surface runs edge-to-edge behind the status icons. Guarded: throws in
// web / test environments where the plugin is absent.
void (async () => {
  try {
    await StatusBar.setStyle({ style: Style.Light });
    await StatusBar.setBackgroundColor({ color: '#f4f0e7' });
  } catch {
    // Web or test environment — no native status bar.
  }
})();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
