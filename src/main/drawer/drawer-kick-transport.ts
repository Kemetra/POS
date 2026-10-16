/**
 * T350 — drawer-kick transport port (008 Slice 4).
 *
 * The injected hardware seam for the AD-8 separate-command drawer kick. The
 * dispatcher calls `kick()` AFTER a successful first-print ack; the transport
 * issues the ESC/POS DK1/DK2 pulse (`CD_KICK_2` + `CD_KICK_5`) as its OWN write
 * — a buffer distinct from the receipt byte stream (AD-8: embedded-in-receipt
 * kick is PROHIBITED in 008 v1). Injecting the port keeps the dispatcher
 * unit-testable without hardware (same DI posture as `EscposTransport` and the
 * `DatabaseHandle` → sql.js test adapter).
 *
 * `no_drawer_configured` is how a terminal with NO drawer answers (RT-531: the
 * cash drawer is optional): the sale dispatcher records it as a suppressed
 * drawer event and a return payout completes as `no_drawer`; neither warns.
 * Every other failure reason is a configured drawer that failed, and still warns.
 *
 * The real implementation (constructed only at the main entry point) wraps
 * `node-thermal-printer`'s `openCashDrawer()` in an isolated
 * `clear() → openCashDrawer() → execute()` sequence so the pulse cannot ride
 * the receipt flush. Until the T200 hardware bring-up swaps it in, the
 * composition root injects an honest STUB that returns
 * `{ ok:false, failure_reason:'no_drawer_configured' }` — never a faked
 * `opened` (PRODUCT.md Principle 3: failure is loud, never silent).
 */

import type { DrawerEventFailureReason } from '../sales/repositories/drawer-events.repository.js';

/**
 * Typed kick outcome. Success carries nothing; failure carries the closed
 * `DrawerEventFailureReason` enum (mirrors the `print_events` adapter-result
 * posture). `kick()` MUST always resolve — a hardware/USB fault degrades to
 * `{ ok:false }`, never a rejected promise (the Sale is already durable; a
 * drawer fault must surface as a banner, not crash the finalize seam).
 */
export type DrawerKickResult =
  | { ok: true }
  | { ok: false; failure_reason: DrawerEventFailureReason };

export interface DrawerKickTransport {
  /** Issue the DK1/DK2 pulse as a separate write; resolve a typed outcome. */
  kick(): Promise<DrawerKickResult>;
}
