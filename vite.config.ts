import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'src/renderer',
  // Relative base so built asset URLs are `./assets/...` not `/assets/...`.
  // The packaged app loads the renderer via `file://` (win.loadFile); an
  // absolute `/assets/` path resolves to the FILESYSTEM ROOT under file://
  // (e.g. C:\assets\), 404s, and the window renders blank white. Relative
  // base resolves correctly against index.html. Dev is unaffected — it loads
  // from the Vite server (loadURL http://localhost:5173), not the built files.
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    // Keep `/*! … @license */` comments through minification, which strips
    // them by default: the vendored Fluent icon data (RT-692, MIT) and other
    // third-party code carry their notice in the bundle.
    rolldownOptions: {
      output: { comments: { legal: true } },
    },
  },
  plugins: [react()],
  server: {
    port: 5173,
    // Fail loudly if port 5173 is occupied instead of silently using 5174+.
    // dev-electron.cjs waits on exactly port 5173; a port mismatch would
    // attach Electron to a stale server from a previous dev session.
    strictPort: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
