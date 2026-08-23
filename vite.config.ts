import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Capacitor loads assets from the bundled webview over a file/`capacitor://`
  // origin, so emitted asset URLs must be relative, not root-absolute.
  base: '',
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The app's floor is iOS 15.0 (every first-party Capacitor plugin pins
    // ios.deployment_target 15.0), and Vite's default target is Safari 14 for
    // syntax it can transform — but it cannot transform regex features, so
    // without naming the floor explicitly, syntax that iOS 15's JavaScriptCore
    // rejects ships silently and fails at runtime. Naming safari15 makes esbuild
    // refuse to emit it. Android's WebView is far newer, so this is the binding
    // constraint for both platforms.
    target: ['es2020', 'safari15'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
