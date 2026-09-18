import type { BrowserWindow as BrowserWindowClass, Session } from 'electron';

/**
 * 021-pos-maintainability-rescue S3 — Electron/window bootstrap.
 *
 * Owns BrowserWindow construction and the renderer trust boundary: the
 * mandated `webPreferences` flags, the `will-navigate` allow-list, the
 * new-window denial, and the session-header CSP layer. Previously this was
 * `createWindow()` inline in `src/main/index.ts` (`:203–:262`).
 *
 * **Nothing here is new policy.** Every security value below is the verbatim
 * carry-forward of what `createWindow()` already did; S3 relocates it without
 * altering a single character (spec NFR-5, Constitution III). The CSP strings
 * are exported so tests can assert them literally rather than by shape — a
 * dropped directive is precisely the silent weakening this slice must not
 * introduce.
 *
 * **Why `resolveRendererOrigin` is INJECTED, not moved.** The resolver is the
 * single source of truth (#370) consumed by BOTH this navigation allow-list
 * and the IPC `createSenderGuardedIpcMain` wiring in `whenReady`. Moving it
 * here would drag S3 into IPC-guard territory it does not own; copying it
 * would recreate the drift #370 eliminated. Taking it as a dependency keeps
 * one definition with two consumers, so the navigation check and the IPC
 * sender check still cannot diverge.
 *
 * Electron itself is injected for the same reason the worker registry takes a
 * logger: it makes the trust boundary testable without launching a real
 * browser window.
 */

/**
 * Second CSP layer — Electron session headers (the first layer is the HTML
 * meta tag). Dev mode allows localhost:5173 so Vite assets and the HMR socket
 * are reachable; `'unsafe-inline'` for scripts is required by the
 * @vitejs/plugin-react preamble (an inline `<script type="module">` in
 * `<head>`) and is **dev only, never in production**.
 */
export const DEV_CSP = [
  "default-src 'self' http://localhost:5173;",
  "script-src 'self' 'unsafe-inline' http://localhost:5173;",
  "style-src 'self' 'unsafe-inline' http://localhost:5173;",
  "img-src 'self' data:;",
  "connect-src 'self' ws://localhost:5173 http://localhost:5173;",
].join(' ');

/** Production CSP — no inline script, no remote origins. */
export const PROD_CSP = [
  "default-src 'self';",
  "script-src 'self';",
  "style-src 'self' 'unsafe-inline';",
  "img-src 'self' data:;",
  "connect-src 'self';",
].join(' ');

export interface CreateWindowDeps {
  /** Dev vs packaged. Selects CSP, load strategy, and devtools. */
  isDev: boolean;
  /** Electron's `BrowserWindow` constructor. */
  BrowserWindow: typeof BrowserWindowClass;
  /** Electron's `session` module. */
  session: { defaultSession: Session };
  /**
   * The trusted renderer origin allow-list. MUST be the same resolver the IPC
   * sender guard uses (#370) — see the module docstring.
   */
  resolveRendererOrigin: () => string;
  /** Absolute path to the preload bundle. */
  preloadPath: string;
  /** Absolute path to the packaged renderer entry HTML. */
  rendererFilePath: string;
  /** Vite dev-server URL loaded when `isDev`. */
  devServerUrl: string;
}

/**
 * Build the `createWindow` routine bound to the supplied Electron surface.
 *
 * Returns a zero-argument function so the composition root's call sites
 * (`whenReady`, and the macOS `activate` re-open path) stay unchanged.
 */
export function createWindowFactory(deps: CreateWindowDeps): () => void {
  return function createWindow(): void {
    const win = new deps.BrowserWindow({
      width: 1280,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        preload: deps.preloadPath,
      },
    });

    // Renderer origin allow-list (single source of truth — see resolveRendererOrigin).
    const rendererOrigin = deps.resolveRendererOrigin();

    // Deny navigation to any URL outside the renderer origin (defense-in-depth against
    // injected redirects, drag-drop URLs, file:// traversal).
    win.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(rendererOrigin)) event.preventDefault();
    });

    // Deny all new-window requests. POS terminals have no pop-out windows.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const csp = deps.isDev ? DEV_CSP : PROD_CSP;

    deps.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
    });

    if (deps.isDev) {
      void win.loadURL(deps.devServerUrl);
      win.webContents.openDevTools();
    } else {
      void win.loadFile(deps.rendererFilePath);
    }
  };
}
