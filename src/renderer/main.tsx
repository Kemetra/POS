import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/electron/renderer';
import type { BrowserOptions } from '@sentry/electron/renderer';
import App from './App';
import { initSentryRenderer } from './observability/sentry-renderer';
import './styles/tailwind.css';
import type { PreloadBridgeAPI } from '../shared/bridge-api';
import { useFeatureFlagsStore } from './stores/feature-flags-store';
import { installCartStoreSignOutHook } from './stores/cart-signout-hook';
import { initTheme } from './stores/theme-store';

/**
 * T068 — initialise renderer-side Sentry BEFORE React mounts.
 *
 * Fire-and-forget: the bridge call is async, but we don't block React
 * mounting on it. With no DSN configured, init is a no-op; with an
 * invalid DSN, the throw is swallowed and a single console.warn fires.
 * Either way, the app launches normally (AS-8).
 *
 * The renderer SDK marks `dsn`/`release` as "should only be set in
 * main", but we pass them anyway because AS-8 reasons about the
 * renderer's init posture independently. We cast the `init` reference
 * — not the argument — so the call site is type-safe.
 */
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found in DOM');
const root = ReactDOM.createRoot(rootElement);

// 023: the static Sale proof is a renderer-only development preview. It takes
// this branch before application bootstrap, so it reads no bridge, store,
// pairing state, or feature flag. Vite removes this DEV branch from builds.
if (
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash === '#/dev/sale-proof'
) {
  void import('./v5/sale/SaleScreen').then(({ SaleScreen }) => {
    root.render(
      <React.StrictMode>
        <SaleScreen />
      </React.StrictMode>,
    );
  });
} else {
  // POS v3.5 Phase 1 (ADR-0004) — reconcile the persisted theme before mount.
  initTheme();

  const sentryInit = Sentry.init as unknown as (opts: BrowserOptions) => void;
  const bridge = (window as unknown as { api: PreloadBridgeAPI }).api;

  void initSentryRenderer({
    sentryInit,
    fetchConfig: () => bridge.appConfig(),
    console: window.console,
    appVersion: '0.1.0',
  });

  // Existing production boot: hydrate flags and install sign-out cleanup.
  void bridge
    .appConfig()
    .then((cfg) => {
      useFeatureFlagsStore.getState().hydrate(cfg.features ?? {});
    })
    .catch(() => undefined);
  installCartStoreSignOutHook();

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
