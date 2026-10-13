/**
 * RT-438 (MA-1) — how long the terminal's manager PIN may approve, per action
 * kind (RT-114 C4 and its 2026-10-07 reconciliation: "expiry and offline
 * validity become per-action-kind policy values").
 *
 * One credential (`manager_pin_records`, RT-17), two kinds of window, both
 * computed from columns the record already has:
 *
 *   • `onlineValidityMs` — measured from `last_online_at`, the manager's last
 *     online manager / admin sign-in on this terminal. RT-114 C4 wants 24 h for
 *     an approval, so a manager whose access was removed centrally stops
 *     approving offline within a day. The RT-17 variance keeps its owner-
 *     approved 30 days (RT-17 comment 10943, review round 1 P2-1).
 *   • `maxAgeMs` — measured from `enrolled_at`, when the PIN was last set.
 *     RT-114 C4's 90-day rotation for approvals; none for the RT-17 variance.
 *
 * Main-only. The values are code constants, not tenant configuration: no
 * configuration contract exists for them yet (RT-114 reconciliation leaves the
 * capability model to the Policy & Permissions planning item).
 */
import type { ManagerActionKind } from '../../shared/operator/manager-action-kinds.js';

export interface ManagerCredentialPolicy {
  /** The record approves only this long after the manager's last online sign-in here. */
  readonly onlineValidityMs: number;
  /** The record approves only this long after its PIN was set; null for no limit. */
  readonly maxAgeMs: number | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** RT-17 shift variance — unchanged from 0044 / manager-pin-store (30 days, no age limit). */
export const SHIFT_VARIANCE_POLICY: ManagerCredentialPolicy = Object.freeze({
  onlineValidityMs: 30 * DAY_MS,
  maxAgeMs: null,
});

/** RT-114 C4 defaults for every other manager-approved action. */
export const DEFAULT_APPROVAL_POLICY: ManagerCredentialPolicy = Object.freeze({
  onlineValidityMs: 24 * HOUR_MS,
  maxAgeMs: 90 * DAY_MS,
});

/** The credential policy an approval of `kind` is checked against. */
export function credentialPolicyFor(kind: ManagerActionKind): ManagerCredentialPolicy {
  return kind === 'shift.variance_accept' ? SHIFT_VARIANCE_POLICY : DEFAULT_APPROVAL_POLICY;
}
