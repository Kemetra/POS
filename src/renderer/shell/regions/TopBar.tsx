import type { JSX } from 'react';
import type { ConnectionState } from '../../ui/tokens/connection-state';
import { IdentityStrip } from './IdentityStrip';
import { OperatorSlot } from './OperatorSlot';
import { StatusBanner } from '../../ui/primitives/StatusBanner/StatusBanner';
import { CONNECTION_BANNER_MESSAGES } from '../../connection/connection-state';

interface TopBarProps {
  tenantId: string;
  branchId: string;
  terminalLabel: string;
  connectionState: ConnectionState;
}

/**
 * T045 (US4) — Non-online states surface a non-blocking StatusBanner.
 *
 * POS v3.5: the banner copy is Arabic-first (prototype copy — README §"App
 * shell & navigation" / "Connection states cycle"):
 *   degraded → "الاتصال بطيء"
 *   offline  → "غير متصل — البيع من قائمة الانتظار المحلية"
 *   syncing  → "جارٍ المزامنة…"
 *
 * All four states are covered; `online` is omitted from the rendered banner
 * via the `connectionState !== 'online'` guard, so it never reaches StatusBanner.
 * (RT-240: there is no connection pill; see the right cluster below.)
 */
const BANNER_MESSAGES = CONNECTION_BANNER_MESSAGES;

/**
 * T049 [S3] / POS v3.5 — TopBar restyle.
 *
 * Left cluster: POS Pulse wordmark · tenant · branch · terminal chip.
 * Right cluster: OperatorSlot (sign out
 * button is part of OperatorSlot when a session is active).
 * StatusBanner renders below the bar for non-online states.
 *
 * The terminal chip uses .top-bar__terminal-chip which maps to
 * --color-surface-sunken bg + --font-family-mono in CSS.
 * Device token is never rendered.
 */
export function TopBar({
  tenantId,
  branchId,
  terminalLabel,
  connectionState,
}: TopBarProps): JSX.Element {
  return (
    <>
      <header role="banner" className="top-bar">
        <div className="top-bar__left">
          <span className="top-bar__wordmark" aria-label="POS Pulse">
            POS Pulse
          </span>
          <IdentityStrip tenantId={tenantId} branchId={branchId} terminalLabel={terminalLabel} />
        </div>
        <div className="top-bar__right">
          {/* RT-240 (I-7): no connection pill. Nothing drives the connection state
              in production yet (only a dev toggle), so «Online» was a fabricated
              claim; non-online states still show the banner below. No theme
              toggle: the dark register is maintained but not offered (PRODUCT.md). */}
          <OperatorSlot />
        </div>
      </header>
      {connectionState !== 'online' && (
        <StatusBanner state={connectionState} message={BANNER_MESSAGES[connectionState]} />
      )}
    </>
  );
}
