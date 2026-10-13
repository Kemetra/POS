/**
 * RT-114 §3 — the closed catalogue of manager-approved action kinds. It grows
 * by contract only. MA-1 (RT-438) keys the credential policy on it; MA-2
 * (RT-443) binds each approval to one kind.
 *
 * `shift.variance_accept` is the RT-17 shift variance, the first consumer of
 * the manager PIN; it keeps its RT-17 behaviour (manager-approval-policy.ts).
 * `drawer.no_sale` and `price.override` are reserved by RT-114 and not listed
 * until their contracts exist.
 */
export const MANAGER_ACTION_KINDS = [
  'cart.cancel_post_handoff',
  'cart.discount.manual',
  'shift.pay_in',
  'shift.pay_out',
  'shift.variance_accept',
  'cashier.pin.unlock_lockout',
  'recovery.unlock_other',
  'recovery.complete_attempt',
  'recovery.cancel_attempt',
  'recovery.cancel_held_cart',
  'session.self_unlock',
] as const;

export type ManagerActionKind = (typeof MANAGER_ACTION_KINDS)[number];

export function isManagerActionKind(value: unknown): value is ManagerActionKind {
  return typeof value === 'string' && (MANAGER_ACTION_KINDS as readonly string[]).includes(value);
}
