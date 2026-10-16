/**
 * RT-546 (RT-534 F3) — the main-process role gate for every `sales.*` and
 * `receipts.*` bridge handler. The renderer route guard and navigation are
 * secondary; this is the trust boundary (AD-1).
 *
 * Owner decisions (RT-534 comment 12048, Confluence 40468506):
 *   • OD-534-1 = A — a cashier sees ONLY their own sales; a manager or admin
 *     sees every sale in their authorized scope.
 *   • OD-534-2 = A — a cashier reprints ONLY their own sales; a manager or admin
 *     may reprint any sale they may view. This reverses 008 AD-10 ("any signed-in
 *     operator may reprint").
 *
 * The local SQLite holds only THIS terminal's sales, so the existing
 * tenant/branch/terminal scope stays in force. Store-wide reads (RT-541/542)
 * reuse this module for the role and ownership rules.
 *
 * Gate order in every handler: forbidden-key scan → `admitSession` (session
 * present, not locked, role in the closed allowlist) → row fetch → scope →
 * `admitSale` (a cashier must own the sale).
 *
 * Refusals on the wire stay inside the closed `SalesRefusalReason` set:
 *   • no session, or a locked session         → `no_session`
 *   • a role outside the allowlist            → `role_denied` (audited)
 *   • a cashier asking for another's sale     → `sale_not_found` (audited)
 * The ownership miss is deliberately non-disclosing: sale numbers are
 * sequential, so `role_denied` there would tell a cashier which numbers exist
 * (Confluence 40468506: "fail closed and non-disclosing"). The audit event
 * records the true reason.
 *
 * Not audited: `no_session` (no operator or scope to attribute it to) and a
 * locked session (the banner poll would write a row every few seconds).
 *
 * Identity: `sales.selling_operator_id` is the `operator_id` of the session that
 * started the settled payment attempt (`finalize-dispatch.ts`), the same value
 * this gate compares with `session.operator_id` — never a renderer-supplied id.
 */

import type { Role } from '../../shared/operator/role.js';
import type { SaleAuditEmitter } from './audit-emitter.js';
import type { OperatorSessionForSales } from './sales-bridge.js';

/** The roles that may use the sales/receipts surface at all. */
export const SALE_ACCESS_ROLES: readonly Role[] = ['cashier', 'manager', 'admin'];

/** The handler a gate decision is for (closed; audit payload only). */
export type SaleAccessAction =
  | 'sales.read'
  | 'sales.findByNumber'
  | 'sales.subscribe'
  | 'sales.list'
  | 'receipts.preview'
  | 'receipts.retryPrint'
  | 'receipts.reprint'
  | 'receipts.manualOverride'
  // RT-542 — the store-wide history through Backend-Core.
  | 'saleHistory.list'
  | 'saleHistory.read'
  | 'saleHistory.reprint';

/** Why access was refused, as recorded in the `sale.access.refused` audit event. */
export type SaleAccessAuditReason = 'role_denied' | 'not_owner';

/** The minimum of a sale row the ownership check reads. */
export interface SaleOwnership {
  readonly sale_id: string;
  readonly selling_operator_id: string;
}

export type AdmitSessionResult =
  | { ok: true; session: OperatorSessionForSales }
  | { ok: false; reason: 'no_session' | 'role_denied' };

export interface SaleAccessPolicy {
  /** Session present, not locked, role allowed. Audits a role refusal. */
  admitSession(action: SaleAccessAction): AdmitSessionResult;
  /** A cashier must own the sale; manager/admin pass. Audits a refusal. */
  admitSale(
    action: SaleAccessAction,
    session: OperatorSessionForSales,
    sale: SaleOwnership,
  ): boolean;
  /** The operator a read must be limited to, or null for full scope. */
  ownerFilter(session: OperatorSessionForSales): string | null;
}

export interface SaleAccessPolicyDeps {
  getCurrentSession: () => OperatorSessionForSales | null;
  /** True while the operator session is locked. Absent → never locked. */
  isSessionLocked?: () => boolean;
  /** Records `sale.access.refused`. Absent → refusals are not audited. */
  auditEmitter?: Pick<SaleAuditEmitter, 'emitRaw'>;
  now?: () => string;
}

/**
 * True when the session names its operator. An own-sales filter built from a
 * missing id would read as "no filter", so such a session is refused rather
 * than given the whole scope (RT-541 hardening; fail closed).
 */
function hasOperatorId(session: OperatorSessionForSales): boolean {
  return typeof session.operator_id === 'string' && session.operator_id.length > 0;
}

/** True iff this session may see only its own sales (OD-534-1/2). */
function isOwnSalesOnly(session: OperatorSessionForSales): boolean {
  // A closed allowlist upstream means this is exactly 'cashier'; anything not
  // manager/admin is treated as own-only, so a future role fails closed.
  return session.role !== 'manager' && session.role !== 'admin';
}

export function createSaleAccessPolicy(deps: SaleAccessPolicyDeps): SaleAccessPolicy {
  const now = deps.now ?? ((): string => new Date().toISOString());

  function audit(
    action: SaleAccessAction,
    session: OperatorSessionForSales,
    reason: SaleAccessAuditReason,
    saleId: string | null,
  ): void {
    try {
      deps.auditEmitter?.emitRaw({
        action_category: 'sale.access.refused',
        attribution_operator_id: session.operator_id,
        tenant_id: session.tenant_id,
        branch_id: session.branch_id,
        originating_terminal_id: session.terminal_id,
        session_id: session.operator_session_id,
        created_at: now(),
        payload: saleId === null ? { action, reason } : { action, reason, sale_id: saleId },
      });
    } catch {
      // Best-effort: the refusal itself is what protects the data. An audit
      // sink fault must not turn a refusal into an IPC rejection.
    }
  }

  return {
    admitSession(action) {
      const session = deps.getCurrentSession();
      if (session === null) return { ok: false, reason: 'no_session' };
      if (deps.isSessionLocked?.() === true) return { ok: false, reason: 'no_session' };
      if (!hasOperatorId(session)) return { ok: false, reason: 'no_session' };
      if (!SALE_ACCESS_ROLES.includes(session.role)) {
        audit(action, session, 'role_denied', null);
        return { ok: false, reason: 'role_denied' };
      }
      return { ok: true, session };
    },

    admitSale(action, session, sale) {
      if (!isOwnSalesOnly(session)) return true;
      if (sale.selling_operator_id === session.operator_id) return true;
      audit(action, session, 'not_owner', sale.sale_id);
      return false;
    },

    ownerFilter(session) {
      return isOwnSalesOnly(session) ? session.operator_id : null;
    },
  };
}
