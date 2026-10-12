import type { Logger } from 'pino';

import type {
  CashierPinStatus,
  CashierPinStatusRefusalCategory,
  ListCashierPinStatusResponse,
} from '../../shared/bridge-api.js';
import { OperatorRefusalError } from '../../shared/audit/event-shape.js';
import type { DatabaseHandle } from '../db/client.js';
import type { PairingStore } from '../pairing/store.js';

import type { CashierAdmissionClient, CashierRosterEntry } from './cashier-admission-client.js';
import { snapshotOf, type SessionSnapshot } from './operator-identity-call.js';
import { requireRole } from './role-enforcement.js';
import type { OperatorSessionRecord, SessionManager } from './session-manager.js';

/**
 * RT-424 (D-M1, docs/design/vnext/19-d-m1-cashier-pin-status.md §2) — the
 * manager-only read behind the Cashiers screen: the device roster, each entry
 * with its PIN state on THIS terminal.
 *
 *   • `requireRole(['manager','admin'])` is the first call (AD-1).
 *   • Scope comes from the paired terminal, never the renderer.
 *   • The roster is the device roster (no manager JWT), the one the screen
 *     already lists, so the list keeps loading after the JWT expires.
 *   • State per entry, matched as sign-in matches (`cashier_clerk_user_id =
 *     id`): `locked` when `lockout_until > now`, else `ready`; `no_pin` when
 *     no row. A lockout ends on its own, so an expired one reads `ready`.
 *   • The session is re-checked after every await. A session that signed
 *     out, locked, latched or was replaced meanwhile gets `not_signed_in`, so
 *     a lock never shows rows to the next person.
 *
 * Read-only: no write, no audit event. Nothing secret crosses the bridge —
 * no PIN hash or salt, failure count, `user_id`, or tenant / branch /
 * terminal id. Only the count is logged (FR-032).
 */

export interface CashierPinStatusHandlerDeps {
  db: DatabaseHandle;
  sessionManager: Pick<SessionManager, 'getCurrent'>;
  pairingStore: Pick<PairingStore, 'getStatus'>;
  cashierAdmissions: Pick<CashierAdmissionClient, 'listRoster'>;
  /** Wall clock (ms) for the lockout comparison. Tests inject. */
  nowMs?: () => number;
  logger?: Pick<Logger, 'info'>;
}

interface PinScope {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
}

interface PinStatusRow {
  lockout_until: string | null;
}

type PrepareGet = { get(...p: unknown[]): PinStatusRow | undefined };

function refuse(category: CashierPinStatusRefusalCategory): ListCashierPinStatusResponse {
  return { kind: 'refused', category };
}

export class CashierPinStatusHandler {
  constructor(private readonly deps: CashierPinStatusHandlerDeps) {}

  async listCashierPinStatus(): Promise<ListCashierPinStatusResponse> {
    const session = this.deps.sessionManager.getCurrent();
    try {
      requireRole(['manager', 'admin'], session);
    } catch (err) {
      return err instanceof OperatorRefusalError && err.category === 'role_mismatch'
        ? refuse('role_mismatch')
        : refuse('not_signed_in');
    }
    const snapshot = snapshotOf(session as OperatorSessionRecord);
    if (!this.stillActive(snapshot)) return refuse('not_signed_in');

    const pairing = await this.deps.pairingStore.getStatus();
    if (!this.stillActive(snapshot)) return refuse('not_signed_in');
    if (pairing.kind !== 'paired') return refuse('invalid_input');
    const scope: PinScope = {
      tenant_id: pairing.tenant_id,
      branch_id: pairing.branch_id,
      terminal_id: pairing.terminal_id,
    };

    const roster = await this.deps.cashierAdmissions.listRoster();
    if (!this.stillActive(snapshot)) return refuse('not_signed_in');
    if (roster.kind === 'no_connection' || roster.kind === 'unavailable') {
      return refuse('no_connection');
    }
    if (roster.kind !== 'roster') return refuse('invalid_input');

    const now = this.deps.nowMs?.() ?? Date.now();
    const cashiers = roster.cashiers.map((entry) => this.statusOf(entry, scope, now));
    this.deps.logger?.info(
      { event: 'operator.cashier_pin_status.listed', count: cashiers.length },
      'cashier pin status listed',
    );
    return { kind: 'cashiers', cashiers };
  }

  /** Same session as at entry, unlocked and not latched. */
  private stillActive(snapshot: SessionSnapshot): boolean {
    const current = this.deps.sessionManager.getCurrent();
    return (
      current?.id === snapshot.id &&
      current.backend_session_id === snapshot.backend_session_id &&
      current.lock_state !== 'locked' &&
      current.authority_latch === undefined
    );
  }

  private statusOf(entry: CashierRosterEntry, scope: PinScope, now: number): CashierPinStatus {
    const base = { id: entry.operator_id, display_name: entry.display_name };
    const row = (
      this.deps.db.prepare(
        `SELECT lockout_until
           FROM cashier_pin_records
          WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND cashier_clerk_user_id = ?`,
      ) as PrepareGet
    ).get(scope.tenant_id, scope.branch_id, scope.terminal_id, entry.operator_id);

    if (row === undefined) return { ...base, pin: 'no_pin' };
    const lockoutEnd = row.lockout_until === null ? Number.NaN : Date.parse(row.lockout_until);
    if (lockoutEnd > now) {
      return { ...base, pin: 'locked', locked_until: new Date(lockoutEnd).toISOString() };
    }
    return { ...base, pin: 'ready' };
  }
}
