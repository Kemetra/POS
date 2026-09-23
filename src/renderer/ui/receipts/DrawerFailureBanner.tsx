import { useId, type JSX } from 'react';

import { formatRelativeTime } from '../../../shared/formatters/time-formatters.js';

/**
 * T360 — `<DrawerFailureBanner>` (008 Slice 4, /impeccable craft against §A1 §(g)).
 *
 * A persistent, non-modal banner that surfaces a cash drawer that did NOT open
 * on a cash-inclusive sale. Like `<PrinterFailureBanner>`, it embodies
 * PRODUCT.md Principle 3 ("Failure is loud, never silent"): the sale is already
 * durably finalized and the receipt printed, so this is a *workflow-degrading*,
 * recoverable condition — amber (Caution), not red (DESIGN.md Status-Color
 * Containment). It never auto-dismisses and has no close-X.
 *
 * **Visually distinct from `<PrinterFailureBanner>` (NFR-008).** A cashier under
 * counter pressure must never confuse the two: this banner uses an open-drawer
 * icon (not a printer), its own `drawer-failure-banner` class, and surfaces the
 * relative "last opened" time. The two banners can be on screen at the same time
 * (the coexistence `BannerState` record; stacked in AppShell, printer on top).
 *
 * Affordance (T331 / quickstart §Path D): the ONLY action is Manual receipt.
 * There is deliberately NO retry-kick — a re-kick would violate FR-053 (the
 * UNIQUE(sale_id) constraint rejects a second drawer_events row) or lack an
 * audit anchor. Manual override is an entry-point for the Slice-6
 * `receipts.manualOverride` handler (T512); here it is a required prop the host
 * wires (the `enabled⟹wired` invariant — no affordance without a result).
 *
 * Presentational: fed by an injected `drawerFailure` prop. The live feed is the
 * `useDrawerBannerState` hook (polls `sales.subscribe(banner_state)` →
 * `.drawer_failure` slice); this component performs no bridge calls itself.
 */

/** The projected drawer-banner state: which sale's drawer failed + last-open time. */
export interface DrawerFailureState {
  sale_id: string;
  /** UTC ISO-8601 of the terminal's last successful drawer open, or null. */
  last_successful_open_at: string | null;
}

export interface DrawerFailureBannerProps {
  /** Null → the banner is unmounted (not hidden). Non-null → a drawer failed. */
  drawerFailure: DrawerFailureState | null;
  /**
   * Entry-point for the Slice-6 manual-override surface (T512); receives the
   * sale id. REQUIRED (not optional) to preserve the enabled⟹wired invariant —
   * the affordance is always actionable, so it must always have a real handler
   * (PRODUCT.md Principle 1). Symmetric with `<PrinterFailureBanner>`.
   */
  onManualOverride: (saleId: string) => void;
  /** Reference "now" (ISO-8601) for the relative timestamp; injected for purity. */
  now: string;
}

export function DrawerFailureBanner({
  drawerFailure,
  onManualOverride,
  now,
}: DrawerFailureBannerProps): JSX.Element | null {
  const messageId = useId();
  if (drawerFailure === null) return null;

  const lastOpened = formatRelativeTime(drawerFailure.last_successful_open_at, now);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-describedby={messageId}
      className="v4-row drawer-failure-banner"
      data-testid="drawer-failure-banner"
      dir="rtl"
    >
      <DrawerWarningIcon />
      <p id={messageId} className="drawer-failure-banner__message">
        <span lang="ar">لم يفتح درج النقود</span>
        <span aria-hidden="true" className="drawer-failure-banner__sep">
          {' — '}
        </span>
        <span lang="en">Cash drawer did not open</span>
        <span className="drawer-failure-banner__hint">
          {' · '}
          <span lang="ar">افتح الدرج يدويًا، أو حوّل للإيصال اليدوي</span>
          <span aria-hidden="true">{' — '}</span>
          <span lang="en">Open the drawer manually, or switch to a manual receipt</span>
        </span>
        <span className="drawer-failure-banner__last-open">
          {' · '}
          <span lang="ar">آخر فتح: </span>
          <span aria-hidden="true">{' — '}</span>
          <span lang="en">last opened: </span>
          <span className="drawer-failure-banner__last-open-value">{lastOpened}</span>
        </span>
      </p>
      <div className="v4-row drawer-failure-banner__actions">
        <button
          type="button"
          className="btn btn--md btn--ghost"
          onClick={() => {
            onManualOverride(drawerFailure.sale_id);
          }}
          aria-label="إيصال يدوي — Manual receipt"
        >
          <span lang="ar">إيصال يدوي</span>
          <span aria-hidden="true">{' / '}</span>
          <span lang="en">Manual receipt</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Open-cash-drawer composite with a warning mark — NOT the printer glyph and NOT
 * a generic alert triangle (per §A1 brief + NFR-008: the iconography must make
 * the source instantly recognizable so the drawer banner is never confused with
 * the printer-failure banner). Decorative; the message text carries the meaning
 * (color is never the sole signal — FR-068).
 */
function DrawerWarningIcon(): JSX.Element {
  return (
    <svg
      className="drawer-failure-banner__icon"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* drawer body + face */}
      <path
        d="M3 10.5 5 6h14l2 4.5M3 10.5V18a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-7.5M3 10.5h18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* drawer pull handle */}
      <path d="M10 14h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {/* warning mark above the drawer */}
      <path
        d="M12 2.6v1.2M12 5.4v.05"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
