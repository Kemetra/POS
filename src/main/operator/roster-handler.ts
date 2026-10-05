import type { Logger } from 'pino';

import type { ListBranchRosterResponse } from '../../shared/bridge-api.js';
import type { OperatorRefusal } from '../../shared/audit/event-shape.js';

import type { CashierAdmissionClient } from './cashier-admission-client.js';

/**
 * 004-operator-session T070b — main-side handler for operator.listBranchRoster.
 *
 * RT-113 P2 (10763 D11, owner decision 10844; fixes RT-182): the roster comes
 * from the device-authenticated `GET /api/pos/v1/cashier-admissions/roster`,
 * not the Clerk-gated `/operators/roster` (which 401s without a manager JWT).
 * The store is the paired device's; there is no branch parameter.
 *
 * Mapping: `{user_id, operator_id, display_name}` → `{id: operator_id,
 * display_name, role: 'cashier'}`. `id` stays the provider subject, the
 * session `operator_id` (RT-116 seam 1); `user_id` never crosses the bridge
 * (Constitution VII). Explicit allowlist: no other field crosses (FR-006 /
 * FR-031). A live roster carries `source: 'online'` (10763 §3).
 *
 * FR-032 — opaque references only: names and ids never reach pino; only the
 * count is logged.
 */

export interface RosterHandlerDeps {
  cashierAdmissions: Pick<CashierAdmissionClient, 'listRoster'>;
  logger?: Pick<Logger, 'info'>;
}

const REFUSE_INVALID: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };
const REFUSE_NO_CONN: OperatorRefusal = { kind: 'refused', category: 'no_connection' };

export class RosterHandler {
  constructor(private readonly deps: RosterHandlerDeps) {}

  async listRoster(): Promise<ListBranchRosterResponse> {
    const result = await this.deps.cashierAdmissions.listRoster();

    if (result.kind === 'no_connection' || result.kind === 'unavailable') {
      return this.offlineRoster();
    }
    if (result.kind !== 'roster') {
      return REFUSE_INVALID;
    }

    const cashiers = result.cashiers.map(({ operator_id, display_name }) => ({
      id: operator_id,
      display_name,
      role: 'cashier' as const,
    }));

    this.deps.logger?.info(
      { event: 'operator.roster.fetched', count: cashiers.length, source: 'online' },
      'roster fetched',
    );

    return { kind: 'roster', source: 'online', cashiers };
  }

  /**
   * P1 SEAM — offline roster fallback (10763 D11). RT113-P1/P3 will answer
   * here with the cashiers holding a currently valid offline grant on this
   * terminal, `source: 'offline'`. Until then an unreachable Backend-Core is
   * the `no_connection` refusal, as before.
   */
  private offlineRoster(): ListBranchRosterResponse {
    return REFUSE_NO_CONN;
  }
}
