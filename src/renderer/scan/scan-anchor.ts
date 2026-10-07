/**
 * RT-239 (VNext A2, rule 6) — the scan owner's focus anchor on the Sale screen.
 *
 * Lane A keeps the existing scan-capture field as the focus anchor: a burst is
 * routed to the scan owner wherever focus is (the guard), but returning focus
 * to one predictable place after an add, Back from Checkout, «بيع جديد» or a
 * pointer click keeps keyboard users oriented. The non-focusable owner of
 * freeze package 15 §3.2 belongs to W1-B.
 */
export const SCAN_ANCHOR_ID = 'v5-live-scan';

/** Move focus to the scan anchor. A no-op when the Sale catalogue region is not mounted. */
export function focusScanOwner(): void {
  document.getElementById(SCAN_ANCHOR_ID)?.focus();
}
