import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StatusBar, Style } from '@capacitor/status-bar';

// Desktop design tokens (the "Editorial Ink" theme), imported once ahead of
// every component stylesheet — the single source of truth for colour, type,
// and geometry. Reused verbatim from the desktop app.
import './styles/theme.css';

import { App } from './App';
import { SyncFfi } from './sync/plugin';
import { seedCredential } from './account/signin';

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
    // Non-native environment or release build — no seed path available.
  }

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
})();
