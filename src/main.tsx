import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StatusBar, Style } from '@capacitor/status-bar';

// Desktop design tokens (the "Editorial Ink" theme), imported once ahead of
// every component stylesheet — the single source of truth for colour, type,
// and geometry. Reused verbatim from the desktop app.
import './styles/theme.css';

import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { SyncFfi } from './sync/plugin';
import { seedCredential } from './account/signin';

// Theme the native status bar to match --bg so the warm-paper surface runs
// edge-to-edge behind the status icons, following the OS light/dark preference
// (index.html sets data-theme from the same media query before first paint).
// Style.Light = dark icons for the light background; Style.Dark = light icons
// for the dark background. Guarded: throws in web / test where the plugin is
// absent. Re-applied live when the system theme changes.
void (async () => {
  const applyStatusBar = async (dark: boolean) => {
    try {
      await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
      await StatusBar.setBackgroundColor({ color: dark ? '#16140f' : '#f4f0e7' });
    } catch {
      // Web or test environment — no native status bar.
    }
  };
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  await applyStatusBar(mq.matches);
  mq.addEventListener?.('change', (e) => void applyStatusBar(e.matches));
})();

// Resolve the mount point synchronously so a genuinely missing #root fails
// loudly at the top level rather than as a swallowed promise rejection.
const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// Bootstrap: seed the credential (DEBUG/e2e only) before mounting React so
// App's boot-time refreshAccountPeers() sees the written value. The seed
// round-trip (native getSeedCredential → SecureStorage.set) must complete
// before createRoot; a fire-and-forget IIFE would race with the useEffect.
void (async () => {
  try {
    const { seed } = await SyncFfi.getSeedCredential();
    if (seed) {
      await seedCredential(seed);
    }
  } catch {
    // No seed path available — web, a release build, or a platform with no
    // native SyncFfi implementation.
  }

  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
})();
