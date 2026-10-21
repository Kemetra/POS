import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installErrorReporter } from './observability/error-reporter';
import './styles/tailwind.css';
// The shared V5 button system. Global, not per-frame: the pairing and sign-in
// entry routes render outside V5Frame, so foundation.css alone does not reach them.
import './v5/foundation/buttons.css';
import type { PreloadBridgeAPI } from '../shared/bridge-api';
import { useFeatureFlagsStore } from './stores/feature-flags-store';
import { installCartStoreSignOutHook } from './stores/cart-signout-hook';
import { installDrawerNoticeSignOutHook } from './ui/receipts/drawer-notice-store';
import { initTheme } from './stores/theme-store';
import { installActivityReporter } from './session/activity-reporter';

/**
 * T068 / RT-634 (OBS-5) — renderer crash reporting is installed BEFORE React
 * mounts (production boot below). The renderer runs no Sentry SDK and never
 * sees the DSN: uncaught errors and unhandled rejections are forwarded over
 * the typed bridge (`reportError`) and main validates, scrubs and sends them,
 * or drops them when Sentry is not configured. Fire-and-forget (AS-8).
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
} else if (
  // RT-243 W1-C: the Checkout harness, same DEV-only contract as the Sale proof
  // (no bridge, no pairing, no flags from main; an in-memory payment stand-in).
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash.startsWith('#/dev/checkout-proof')
) {
  void import('./v5/checkout/dev/CheckoutProof').then(({ CheckoutProof }) => {
    root.render(
      <React.StrictMode>
        <CheckoutProof />
      </React.StrictMode>,
    );
  });
} else if (
  // RT-244 W1-D: the sign-in harness, same DEV-only contract as the Checkout
  // harness (the real SignInRoute against an in-memory operator bridge).
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash.startsWith('#/dev/sign-in-proof')
) {
  void import('./v5/entry/dev/SignInProof').then(({ SignInProof }) => {
    root.render(
      <React.StrictMode>
        <SignInProof />
      </React.StrictMode>,
    );
  });
} else if (
  // RT-424: the Manager → Cashiers harness, same DEV-only contract (the real
  // CashiersScreen in the real V5Frame against an in-memory operator bridge).
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash.startsWith('#/dev/cashiers-proof')
) {
  void import('./v5/cashiers/dev/CashiersProof').then(({ CashiersProof }) => {
    root.render(
      <React.StrictMode>
        <CashiersProof />
      </React.StrictMode>,
    );
  });
} else if (
  // RT-441: the Manager → المبيعات المعلقة harness, same DEV-only contract (the
  // real RecoveryScreen in the real V5Frame against in-memory bridges).
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash.startsWith('#/dev/recovery-proof')
) {
  void import('./v5/recovery/dev/RecoveryProof').then(({ RecoveryProof }) => {
    root.render(
      <React.StrictMode>
        <RecoveryProof />
      </React.StrictMode>,
    );
  });
} else if (
  // RT-498 (VN-S10 S10-1): the one-frame harness, same DEV-only contract (the
  // real AppRouter at any /app path against in-memory bridges).
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash.startsWith('#/dev/one-frame-proof')
) {
  void import('./v5/frame/dev/OneFrameProof').then(({ OneFrameProof }) => {
    root.render(
      <React.StrictMode>
        <OneFrameProof />
      </React.StrictMode>,
    );
  });
} else if (
  // RT-445 (PK-3): the park / resume harness, same DEV-only contract (the real
  // AppRouter — Sale, parked list, review, shift close — against in-memory bridges).
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash.startsWith('#/dev/park-proof')
) {
  void import('./v5/park/dev/ParkProof').then(({ ParkProof }) => {
    root.render(
      <React.StrictMode>
        <ParkProof />
      </React.StrictMode>,
    );
  });
} else if (
  // RT-660: the Returns harness, same DEV-only contract (the real AppRouter at
  // /app/returns — the RT-15 screen — against an in-memory returns bridge).
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash.startsWith('#/dev/returns-proof')
) {
  void import('./returns/dev/ReturnsProof').then(({ ReturnsProof }) => {
    root.render(
      <React.StrictMode>
        <ReturnsProof />
      </React.StrictMode>,
    );
  });
} else if (
  // RT-604 (VN-S6 S6-3): the status indicator harness, same DEV-only contract
  // (the real frame and indicator against an in-memory terminalStatus bridge).
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash.startsWith('#/dev/status-proof')
) {
  void import('./v5/frame/dev/StatusIndicatorProof').then(({ StatusIndicatorProof }) => {
    root.render(
      <React.StrictMode>
        <StatusIndicatorProof />
      </React.StrictMode>,
    );
  });
} else if (
  // RT-654: the void screen harness, same DEV-only contract (the real AppRouter
  // at /app/void against in-memory saleVoid / approval bridges).
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash.startsWith('#/dev/void-proof')
) {
  void import('./v5/void/dev/VoidProof').then(({ VoidProof }) => {
    root.render(
      <React.StrictMode>
        <VoidProof />
      </React.StrictMode>,
    );
  });
} else if (
  // RT-658 (G-2): the shift harness, same DEV-only contract (the real AppRouter —
  // the cashier's /app/shift and the manager's /app/shift/manager — against an
  // in-memory shiftCashup bridge).
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV &&
  window.location.hash.startsWith('#/dev/shift-proof')
) {
  void import('./v5/shift/dev/ShiftProof').then(({ ShiftProof }) => {
    root.render(
      <React.StrictMode>
        <ShiftProof />
      </React.StrictMode>,
    );
  });
} else {
  // POS v3.5 Phase 1 (ADR-0004) — reconcile the persisted theme before mount.
  initTheme();

  const bridge = (window as unknown as { api: PreloadBridgeAPI }).api;

  installErrorReporter(window, (report) => bridge.reportError(report));

  // Existing production boot: hydrate flags and install sign-out cleanup.
  void bridge
    .appConfig()
    .then((cfg) => {
      useFeatureFlagsStore.getState().hydrate(cfg.features ?? {});
    })
    .catch(() => undefined);
  installCartStoreSignOutHook();
  // RT-241 (D-B1) — the drawer notice never outlives the session.
  installDrawerNoticeSignOutHook();
  // RT-117 — report genuine operator input so main measures INACTIVITY, not
  // session age (RT-112 RC-1). Notify-only; main ignores it while locked.
  installActivityReporter(window, () => {
    bridge.operator._reportActivity();
  });

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
