/**
 * 004-operator-session — IPC channel constants for the `operator.*`
 * preload namespace. Lives in `src/shared/` so both the preload bundle
 * (NodeNext, narrow includes) and the main-process bundle can import
 * the same string constants. Renaming any value here is a breaking
 * change to the bridge surface.
 */

export const OPERATOR_IPC_CHANNELS = {
  SIGN_IN: 'operator:sign-in',
  SIGN_OUT: 'operator:sign-out',
  GET_CURRENT_SESSION: 'operator:get-current-session',
  REPORT_ACTIVITY: 'operator:_report-activity',
  EMIT_AUDIT_EVENT: 'operator:emit-audit-event',
  /** T051 — debug bridge smoke; never reachable in production builds. */
  EMIT_AUDIT_EVENT_SMOKE: 'operator:_emit-audit-event-smoke',
  /** T070b — list cashiers on the terminal's paired branch. */
  LIST_BRANCH_ROSTER: 'operator:list-branch-roster',
  /** T070 — confirm a pending takeover via capability token. */
  TAKEOVER_CONFIRM: 'operator:takeover-confirm',
  /** T071 — cancel a pending takeover; pure local discard. */
  TAKEOVER_CANCEL: 'operator:takeover-cancel',
  /** T072 — manager/admin PIN reset for a cashier on this terminal. */
  RESET_CASHIER_PIN: 'operator:reset-cashier-pin',
  /** 019 — manager/admin FIRST-PIN provisioning (create) for a cashier on this terminal. */
  PROVISION_CASHIER_PIN: 'operator:provision-cashier-pin',
  /** T073 — manager/admin unlock of a locked-out cashier on this terminal. */
  UNLOCK_CASHIER: 'operator:unlock-cashier',
  /** T089 — manager/admin forced-close of a stuck cashier shift. */
  FORCE_CLOSE_SHIFT: 'operator:force-close-shift',
  /** T090 — list stuck cashier shifts on this terminal's branch. */
  LIST_STUCK_SHIFTS: 'operator:list-stuck-shifts',
  /** T091 — cashier dismisses the forced-close return banner. Zero renderer args. */
  DISMISS_SHIFT_CLOSED_NOTICE: 'operator:dismiss-shift-closed-notice',
} as const;

/**
 * RT-117 (RT-116 §2.4, §7.2) — inactivity-lock channels. Kept apart from
 * `OPERATOR_IPC_CHANNELS` because they have their own registrar
 * (`ipc/session-lock.ts`) and SESSION_STATE is a main → renderer push, not an
 * invoke handler.
 */
export const SESSION_LOCK_IPC_CHANNELS = {
  /** Same-operator unlock of the CURRENT locked session. */
  UNLOCK_SESSION: 'operator:unlock-session',
  /** The only operator read served while locked: state + totals summary. */
  GET_LOCK_STATE: 'operator:get-lock-state',
  /** Main → renderer push of session state changes. */
  SESSION_STATE: 'operator:session-state',
} as const;

/**
 * RT-352 (RT-116 §7.2) — held-cart resume. Its own registrar
 * (`ipc/resume-state.ts`), so it is kept apart from `OPERATOR_IPC_CHANNELS`.
 */
export const RESUME_STATE_IPC_CHANNELS = {
  /** The draft cart re-attached at sign-in (ids + a count only). */
  GET_RESUME_STATE: 'operator:get-resume-state',
} as const;

export type OperatorIpcChannel = (typeof OPERATOR_IPC_CHANNELS)[keyof typeof OPERATOR_IPC_CHANNELS];
