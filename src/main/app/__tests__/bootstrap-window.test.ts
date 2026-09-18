import { describe, it, expect, vi } from 'vitest';

import { DEV_CSP, PROD_CSP, createWindowFactory } from '../bootstrap-window.js';

/**
 * 021-pos-maintainability-rescue S3 (T030–T033) — Electron/window bootstrap.
 *
 * These tests characterise the BrowserWindow construction and trust-boundary
 * policy that previously lived inline in `src/main/index.ts` as `createWindow()`
 * (`:203–:262`). They are authored BEFORE the extraction (Constitution
 * Principle VI) and assert the CURRENT values, so they must hold both before
 * and after the move.
 *
 * NFR-5 / Constitution III are the point of this suite: S3 relocates security
 * policy, so every security-relevant value is asserted LITERALLY rather than
 * by shape. A refactor that silently widened `will-navigate`, admitted a
 * pop-out window, or loosened a CSP directive must red this file.
 *
 * The `resolveRendererOrigin` seam (plan AD-4 follow-on): the resolver is the
 * SINGLE SOURCE OF TRUTH (#370) shared by BOTH the `will-navigate` allow-list
 * and the IPC `createSenderGuardedIpcMain` wiring. S3 therefore INJECTS it
 * rather than moving it — the composition root keeps one definition feeding
 * both consumers, so the navigation check and the IPC sender check can never
 * drift apart.
 */

interface FakeWebContents {
  on: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  openDevTools: ReturnType<typeof vi.fn>;
}

interface FakeWindow {
  webContents: FakeWebContents;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
}

function createFakeWindow(): FakeWindow {
  return {
    webContents: {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
    },
    loadURL: vi.fn(),
    loadFile: vi.fn(),
  };
}

const RENDERER_ORIGIN = 'http://localhost:5173';

interface BrowserWindowOptions {
  width: number;
  height: number;
  webPreferences: Record<string, unknown>;
}

type HeadersListener = (
  details: { responseHeaders: Record<string, string[]> },
  callback: (r: { responseHeaders: Record<string, string[]> }) => void,
) => void;

function setup(options: { isDev?: boolean } = {}) {
  const win = createFakeWindow();
  // `new` requires a [[Construct]] slot — an arrow function has none, so the
  // fake constructor must be a `function`.
  const browserWindowCtor = vi.fn(function fakeBrowserWindow(opts: BrowserWindowOptions) {
    void opts;
    return win;
  });
  const onHeadersReceived = vi.fn();

  const createWindow = createWindowFactory({
    isDev: options.isDev ?? false,
    BrowserWindow: browserWindowCtor as never,
    session: {
      defaultSession: { webRequest: { onHeadersReceived } },
    } as never,
    resolveRendererOrigin: () => RENDERER_ORIGIN,
    preloadPath: '/app/preload/index.js',
    rendererFilePath: '/app/renderer/index.html',
    devServerUrl: RENDERER_ORIGIN,
  });

  createWindow();

  return { win, browserWindowCtor, onHeadersReceived };
}

/** Pull the handler registered for a given webContents event. */
function handlerFor(win: FakeWindow, event: string): (...args: never[]) => void {
  const entry = win.webContents.on.mock.calls.find((call) => call[0] === event);
  if (entry === undefined) throw new Error(`no handler registered for "${event}"`);
  return entry[1] as (...args: never[]) => void;
}

/**
 * Read the first recorded call's first argument, failing loudly if the mock was
 * never invoked. The repo forbids non-null assertions, and a silent `undefined`
 * here would make a security assertion vacuously pass — the one failure mode
 * this suite must not have.
 */
function firstArgOf(mock: { mock: { calls: unknown[][] } }, what: string): unknown {
  const call = mock.mock.calls[0];
  if (call === undefined) throw new Error(`${what} was never called`);
  return call[0];
}

describe('021 S3 — window bootstrap: webPreferences trust boundary (T030)', () => {
  it('constructs the BrowserWindow with the mandated security flags', () => {
    const { browserWindowCtor } = setup();

    expect(browserWindowCtor).toHaveBeenCalledTimes(1);
    const opts = firstArgOf(browserWindowCtor, 'BrowserWindow') as BrowserWindowOptions;

    // Constitution III / CLAUDE.md hard rule — these three are non-negotiable
    // on EVERY BrowserWindow.
    expect(opts.webPreferences.contextIsolation).toBe(true);
    expect(opts.webPreferences.nodeIntegration).toBe(false);
    expect(opts.webPreferences.sandbox).toBe(true);
    expect(opts.webPreferences.webSecurity).toBe(true);
    expect(opts.webPreferences.preload).toBe('/app/preload/index.js');

    // Window geometry is behaviour too — a silent change here is a UX regression.
    expect(opts.width).toBe(1280);
    expect(opts.height).toBe(800);
  });
});

describe('021 S3 — window bootstrap: navigation allow-list (T031)', () => {
  it('denies navigation to any URL outside the resolved renderer origin', () => {
    const { win } = setup();
    const willNavigate = handlerFor(win, 'will-navigate');

    for (const hostile of [
      'https://evil.example.com/',
      'file:///C:/Windows/System32/',
      'http://localhost:5174/',
      'about:blank',
      'javascript:alert(1)',
    ]) {
      const event = { preventDefault: vi.fn() };
      willNavigate(event as never, hostile as never);
      expect(event.preventDefault, `expected "${hostile}" to be denied`).toHaveBeenCalledTimes(1);
    }
  });

  it('permits navigation within the resolved renderer origin', () => {
    const { win } = setup();
    const willNavigate = handlerFor(win, 'will-navigate');

    for (const url of [`${RENDERER_ORIGIN}/`, `${RENDERER_ORIGIN}/index.html`]) {
      const event = { preventDefault: vi.fn() };
      willNavigate(event as never, url as never);
      expect(event.preventDefault, `expected "${url}" to be allowed`).not.toHaveBeenCalled();
    }
  });

  it('uses the INJECTED resolver, so it cannot drift from the IPC sender guard', () => {
    // #370: one resolver, two consumers. If S3 had copied the resolution logic
    // instead of taking it as a dependency, this test would still pass with a
    // duplicated implementation — so we assert the injected value is honoured.
    const win = createFakeWindow();
    const createWindow = createWindowFactory({
      isDev: false,
      BrowserWindow: vi.fn(function fakeBrowserWindow(opts: BrowserWindowOptions) {
        void opts;
        return win;
      }) as never,
      session: {
        defaultSession: { webRequest: { onHeadersReceived: vi.fn() } },
      } as never,
      resolveRendererOrigin: () => 'file:///D:/packaged/renderer/',
      preloadPath: '/p',
      rendererFilePath: '/r',
      devServerUrl: RENDERER_ORIGIN,
    });
    createWindow();

    const willNavigate = handlerFor(win, 'will-navigate');
    const denied = { preventDefault: vi.fn() };
    willNavigate(denied as never, `${RENDERER_ORIGIN}/` as never);
    expect(denied.preventDefault).toHaveBeenCalledTimes(1);

    const allowed = { preventDefault: vi.fn() };
    willNavigate(allowed as never, 'file:///D:/packaged/renderer/index.html' as never);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
  });
});

describe('021 S3 — window bootstrap: new-window policy (T032)', () => {
  it('denies all new-window requests', () => {
    const { win } = setup();

    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const handler = firstArgOf(
      win.webContents.setWindowOpenHandler,
      'setWindowOpenHandler',
    ) as () => {
      action: string;
    };
    expect(handler()).toEqual({ action: 'deny' });
  });
});

describe('021 S3 — window bootstrap: CSP (T033)', () => {
  /**
   * These two literals are the character-identical carry-forward of the CSP
   * strings that lived in `createWindow()`. They are asserted whole — not by
   * `toContain` — because a dropped directive is exactly the silent
   * weakening NFR-5 forbids.
   */
  it('emits the production CSP verbatim', () => {
    expect(PROD_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';",
    );
  });

  it('emits the dev CSP verbatim', () => {
    expect(DEV_CSP).toBe(
      "default-src 'self' http://localhost:5173; script-src 'self' 'unsafe-inline' http://localhost:5173; style-src 'self' 'unsafe-inline' http://localhost:5173; img-src 'self' data:; connect-src 'self' ws://localhost:5173 http://localhost:5173;",
    );
  });

  it('never allows unsafe-inline script in production', () => {
    // The dev CSP needs 'unsafe-inline' for the @vitejs/plugin-react preamble.
    // Production must never inherit it — this is the single most consequential
    // difference between the two strings.
    expect(PROD_CSP).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(DEV_CSP).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('installs the production CSP on the session response headers', () => {
    const { onHeadersReceived } = setup({ isDev: false });

    expect(onHeadersReceived).toHaveBeenCalledTimes(1);
    const listener = firstArgOf(onHeadersReceived, 'onHeadersReceived') as HeadersListener;

    const callback = vi.fn();
    listener({ responseHeaders: { 'X-Existing': ['kept'] } }, callback);

    const applied = firstArgOf(callback, 'headers callback') as {
      responseHeaders: Record<string, string[]>;
    };
    expect(applied.responseHeaders['Content-Security-Policy']).toEqual([PROD_CSP]);
    // Pre-existing headers must survive — the handler spreads, never replaces.
    expect(applied.responseHeaders['X-Existing']).toEqual(['kept']);
  });

  it('installs the dev CSP when running in dev', () => {
    const { onHeadersReceived } = setup({ isDev: true });

    const listener = firstArgOf(onHeadersReceived, 'onHeadersReceived') as HeadersListener;
    const callback = vi.fn();
    listener({ responseHeaders: {} }, callback);

    const applied = firstArgOf(callback, 'headers callback') as {
      responseHeaders: Record<string, string[]>;
    };
    expect(applied.responseHeaders['Content-Security-Policy']).toEqual([DEV_CSP]);
  });
});

describe('021 S3 — window bootstrap: content loading', () => {
  it('loads the dev server URL and opens devtools in dev', () => {
    const { win } = setup({ isDev: true });

    expect(win.loadURL).toHaveBeenCalledWith(RENDERER_ORIGIN);
    expect(win.loadFile).not.toHaveBeenCalled();
    expect(win.webContents.openDevTools).toHaveBeenCalledTimes(1);
  });

  it('loads the packaged renderer file and does NOT open devtools in production', () => {
    const { win } = setup({ isDev: false });

    expect(win.loadFile).toHaveBeenCalledWith('/app/renderer/index.html');
    expect(win.loadURL).not.toHaveBeenCalled();
    // Devtools in a packaged POS terminal would expose the renderer to a cashier.
    expect(win.webContents.openDevTools).not.toHaveBeenCalled();
  });
});
