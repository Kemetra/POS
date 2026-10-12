import type { Logger } from 'pino';

import type {
  CashierPinStatus,
  ListCashierPinStatusRefusalCategory,
  ListCashierPinStatusResponse,
} from '../../shared/bridge-api.js';
import { OperatorRefusalError } from '../../shared/audit/event-shape.js';
import type { DatabaseHandle } from '../db/client.js';
import type { PairingStore } from '../pairing/store.js';

import type {
  CashierAdmissionClient,
  CashierRosterEntry,
  CashierRosterResult,
} from './cashier-admission-client.js';
import { snapshotOf, type SessionSnapshot } from './operator-identity-call.js';
import { requireRole } from './role-enforcement.js';
import type { SessionManager } from './session-manager.js';

/**
 * RT-424 (RT-251 doc 19 §2) — the manager-only cashier PIN-status read for
 * Manager → Cashiers.
 *
 * Rules, in order:
 *   1. `requireRole(['manager','admin'])` is the first call (AD-1).
 *   2. Scope comes from the pairing, never the renderer; unpaired →
 *      `invalid_input`.
 *   3. The roster is the device roster (no manager JWT): the list keeps loading
 *      after the manager's JWT expires. Unreachable → `no_connection`.
 *   4. After every await, the session the read started under must still be the
 *      current one, unlocked and not latched (as provision does, RT-358);
 *      otherwise `not_signed_in`, so a lock never shows rows to the next person.
 *   5. Each entry: `locked` when a row matches `cashier_clerk_user_id = id` in
 *      scope and `lockout_until > now`; `ready` when that row exists otherwise;
 *      `no_pin` when none does. This is the sign-in match (`pin-credential.ts`),
 *      so a row keyed by `user_id` alone reads `no_pin`, exactly as sign-in
 *      sees it.
 *
 * Read-only: no write, no audit event. The hash, salt, failure count,
 * `user_id` and scope ids never leave this module; the response is fixed enums
 * plus the roster `display_name`. Names and ids never reach pino; only the
 * count is logged (FR-032).
 */

export interface CashierPinStatusHandlerDeps {
  db: DatabaseHandle;
  sessionManager: Pick<SessionManager, 'getCurrent'>;
  pairingStore: Pick<PairingStore, 'getStatus'>;
  cashierAdmissions: Pick<CashierAdmissionClient, 'listRoster'>;
  /** Wall clock for the lockout comparison. Tests inject. */
  now?: () => Date;
  logger?: Pick<Logger, 'info'>;
}

/** This terminal's PIN-record scope, from the pairing (never the renderer). */
interface TerminalScope {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
}

interface PinRowState {
  cashier_clerk_user_id: string;
  lockout_until: string | null;
}

type PrepareAll = { all(...params: unknown[]): unknown[] };

const SELECT_SCOPE_ROWS = `SELECT cashier_clerk_user_id, lockout_until
   FROM cashier_pin_records
  WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?
    AND cashier_clerk_user_id IS NOT NULL`;

function refuse(category: ListCashierPinStatusRefusalCategory): ListCashierPinStatusResponse {
  return { kind: 'refused', category };
}

/** An unreachable backend is `no_connection`; any other non-roster answer is `invalid_input`. */
function rosterRefusal(
  kind: Exclude<CashierRosterResult['kind'], 'roster'>,
): ListCashierPinStatusRefusalCategory {
  return kind === 'no_connection' || kind === 'unavailable' ? 'no_connection' : 'invalid_input';
}

/** The role gate's two outcomes, narrowed to this method's refusal set. */
function gateCategory(err: unknown): ListCashierPinStatusRefusalCategory {
  if (err instanceof OperatorRefusalError && err.category === 'role_mismatch') {
    return 'role_mismatch';
  }
  return 'not_signed_in';
}

export class CashierPinStatusHandler {
  constructor(private readonly deps: CashierPinStatusHandlerDeps) {}

  async listCashierPinStatus(): Promise<ListCashierPinStatusResponse> {
    const snapshot = this.gate();
    if ('kind' in snapshot) return snapshot;

    const read = await this.readRoster(snapshot);
    if ('kind' in read) return read;

    const rows = this.scopeRows(read.scope);
    const now = (this.deps.now?.() ?? new Date()).getTime();
    const cashiers = read.cashiers.map((entry) =>
      statusOf(entry, rows.get(entry.operator_id), now),
    );

    this.deps.logger?.info(
      { event: 'operator.cashier_pin_status.read', count: cashiers.length },
      'cashier pin status read',
    );
    return { kind: 'cashiers', cashiers };
  }

  /** AD-1: the role gate first, then the session must be unlocked and not latched. */
  private gate(): SessionSnapshot | ListCashierPinStatusResponse {
    const session = this.deps.sessionManager.getCurrent();
    try {
      requireRole(['manager', 'admin'], session);
    } catch (err) {
      return refuse(gateCategory(err));
    }
    // requireRole throws on a null session, so `session` is set here.
    const snapshot = snapshotOf(session as NonNullable<typeof session>);
    return this.stillActive(snapshot) ? snapshot : refuse('not_signed_in');
  }

  /** The pairing scope and the device roster, re-checking the session after each await. */
  private async readRoster(
    snapshot: SessionSnapshot,
  ): Promise<
    { scope: TerminalScope; cashiers: CashierRosterEntry[] } | ListCashierPinStatusResponse
  > {
    const pairing = await this.deps.pairingStore.getStatus();
    if (!this.stillActive(snapshot)) return refuse('not_signed_in');
    if (pairing.kind !== 'paired') return refuse('invalid_input');

    const roster = await this.deps.cashierAdmissions.listRoster();
    if (!this.stillActive(snapshot)) return refuse('not_signed_in');
    if (roster.kind !== 'roster') return refuse(rosterRefusal(roster.kind));

    const { tenant_id, branch_id, terminal_id } = pairing;
    return { scope: { tenant_id, branch_id, terminal_id }, cashiers: roster.cashiers };
  }

  /** Same session, unlocked and not latched (the RT-358 rule for every await). */
  private stillActive(snapshot: SessionSnapshot): boolean {
    const current = this.deps.sessionManager.getCurrent();
    return (
      current?.id === snapshot.id &&
      current.backend_session_id === snapshot.backend_session_id &&
      current.lock_state !== 'locked' &&
      current.authority_latch === undefined
    );
  }

  /** This terminal's PIN rows, keyed by the roster id they sign in with. */
  private scopeRows(scope: TerminalScope): Map<string, PinRowState> {
    const found = (this.deps.db.prepare(SELECT_SCOPE_ROWS) as PrepareAll).all(
      scope.tenant_id,
      scope.branch_id,
      scope.terminal_id,
    ) as PinRowState[];
    return new Map(found.map((row) => [row.cashier_clerk_user_id, row]));
  }
}

/** The sign-in rule: locked iff `lockout_until` is set and later than now. */
function statusOf(
  entry: CashierRosterEntry,
  row: PinRowState | undefined,
  now: number,
): CashierPinStatus {
  const base = { id: entry.operator_id, display_name: entry.display_name };
  if (row === undefined) return { ...base, pin: 'no_pin' };
  const until = row.lockout_until === null ? Number.NaN : new Date(row.lockout_until).getTime();
  if (until > now) {
    return { ...base, pin: 'locked', locked_until: new Date(until).toISOString() };
  }
  return { ...base, pin: 'ready' };
}
