import type { CapacitorConfig } from '@capacitor/cli';

// Reverse-DNS app id, aligned with the desktop `ai.minutist`. `webDir` is the
// Vite build output that gets copied into the native webview by `cap sync`.
const config: CapacitorConfig = {
  appId: 'ai.minutist.companion',
  appName: 'Minutist',
  webDir: 'dist',
  android: {
    // Debug builds use the auto-generated debug keystore; release signing is
    // configured out-of-band (see docs/BUILD.md) and never committed.
  },
};

export default config;
