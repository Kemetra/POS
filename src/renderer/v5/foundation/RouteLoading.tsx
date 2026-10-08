import type { JSX } from 'react';
import './route-states.css';

/**
 * RT-241 (VNext W1-A, VN-S2) — the boot loading surface. Never blank: the
 * screen says what it is doing while `pairing.getStatus()` decides the start
 * route. It renders before any frame exists, so it sets its own direction and
 * language. Routing semantics are unchanged; this is presentation only.
 */
export function RouteLoading(): JSX.Element {
  return (
    <main
      className="v5-route-state"
      data-testid="route-loading"
      aria-busy="true"
      dir="rtl"
      lang="ar"
    >
      <p className="v5-route-state__status" role="status">
        <span className="v5-route-state__spinner" aria-hidden="true" />
        جارٍ التحميل…
      </p>
    </main>
  );
}
