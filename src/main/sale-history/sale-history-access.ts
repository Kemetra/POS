/**
 * RT-542 — the main-process gate of every `saleHistory.*` handler. It REUSES
 * the RT-546 policy (`createSaleAccessPolicy`): the same session/lock/role
 * allowlist, the same own-sales rule and the same `sale.access.refused` audit.
 * There is no second role gate.
 *
 * Order in every handler: request shape (forbidden keys, then a closed key
 * allowlist) → `admit` (RT-546 `admitSession`) → credential → server call →
 * `stillCurrent` after every await → `owns` on every sale shown.
 *
 * OD-534-1 in main, not only on the server:
 *   • the credential follows the role: the envelope for a manager/admin, the
 *     device token + the session's own cashier admission for a cashier;
 *   • a cashier is shown a sale only when its recorded operator is the
 *     cashier's own backend user id. A missing or different id is the
 *     non-disclosing `sale_not_found`, audited as `not_owner`.
 *
 * The credential is resolved once per request and bound to the admitted
 * session: `stillCurrent` refuses an answer that lands after the session
 * changed, so one operator's data is never handed to another.
 */

import { findForbiddenKey } from '../audit/find-forbidden-key.js';
import type { TenantScope } from '../sales/repositories/sales.repository.js';
import {
  createSaleAccessPolicy,
  type SaleAccessAction,
  type SaleAccessPolicyDeps,
} from '../sales/sale-access-policy.js';
import type { OperatorSessionForSales } from '../sales/sales-bridge.js';
import type { SaleHistoryRefusalReason } from '../../shared/sale-history/types.js';
import type { SaleHistoryCredential } from './sale-history-client.js';

/** The credential of the admitted session, and the cashier it proves (null: manager/admin). */
export interface ResolvedCredential {
  readonly credential: SaleHistoryCredential;
  readonly cashierUserId: string | null;
}

export interface SaleHistoryAccessDeps extends SaleAccessPolicyDeps {
  /**
   * The credential for this session, or null when it holds none (a PIN-only
   * or offline cashier, a signed-out envelope). Never logged or bridged.
   */
  resolveCredential: (session: OperatorSessionForSales) => Promise<ResolvedCredential | null>;
}

/** An admitted request: who, where, and the RT-546 own-sales filter. */
export interface Admitted {
  readonly action: SaleAccessAction;
  readonly session: OperatorSessionForSales;
  readonly scope: TenantScope;
  /** The local operator a cashier's local reads are limited to; null for full scope. */
  readonly owner: string | null;
}

export type AdmitResult =
  | { readonly ok: true; readonly admitted: Admitted }
  | { readonly ok: false; readonly reason: SaleHistoryRefusalReason };

export interface SaleHistoryAccess {
  admit(action: SaleAccessAction, req: unknown, keys: ReadonlySet<string>): AdmitResult;
  credential(admitted: Admitted): Promise<ResolvedCredential | null>;
  stillCurrent(admitted: Admitted): boolean;
  owns(
    admitted: Admitted,
    resolved: ResolvedCredential,
    sale: { readonly saleRef: string; readonly operatorRef: string | null },
  ): boolean;
}

/** Stand-in owner id that never equals a session's operator id. */
const NOT_OWNER = '';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shapeRefusal(req: unknown, keys: ReadonlySet<string>): SaleHistoryRefusalReason | null {
  if (!isPlainObject(req)) return 'invalid_request';
  if (findForbiddenKey(req) !== null) return 'forbidden_field_in_request';
  return Object.keys(req).every((key) => keys.has(key)) ? null : 'invalid_request';
}

function isSameSession(a: OperatorSessionForSales, b: OperatorSessionForSales): boolean {
  return (
    a.operator_session_id === b.operator_session_id &&
    a.operator_id === b.operator_id &&
    a.role === b.role &&
    a.tenant_id === b.tenant_id &&
    a.branch_id === b.branch_id &&
    a.terminal_id === b.terminal_id
  );
}

export function createSaleHistoryAccess(deps: SaleHistoryAccessDeps): SaleHistoryAccess {
  const policy = createSaleAccessPolicy(deps);

  return {
    admit(action, req, keys) {
      const shape = shapeRefusal(req, keys);
      if (shape !== null) return { ok: false, reason: shape };
      const admitted = policy.admitSession(action);
      if (!admitted.ok) return admitted;
      const { session } = admitted;
      const scope: TenantScope = {
        tenant_id: session.tenant_id,
        branch_id: session.branch_id,
        terminal_id: session.terminal_id,
      };
      return { ok: true, admitted: { action, session, scope, owner: policy.ownerFilter(session) } };
    },

    async credential(admitted) {
      const resolved = await deps.resolveCredential(admitted.session);
      if (resolved === null) return null;
      // A cashier credential must prove which cashier it is, or nothing is shown.
      if (admitted.owner !== null && resolved.cashierUserId === null) return null;
      return resolved;
    },

    stillCurrent(admitted) {
      const live = deps.getCurrentSession();
      if (live === null || deps.isSessionLocked?.() === true) return false;
      return isSameSession(live, admitted.session);
    },

    owns(admitted, resolved, sale) {
      const isOwn =
        resolved.cashierUserId === null ||
        (sale.operatorRef !== null && sale.operatorRef === resolved.cashierUserId);
      return policy.admitSale(admitted.action, admitted.session, {
        sale_id: sale.saleRef,
        selling_operator_id: isOwn ? admitted.session.operator_id : NOT_OWNER,
      });
    },
  };
}
