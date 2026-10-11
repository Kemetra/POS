/**
 * 004-operator-session T090 — stuck-shifts handler.
 *
 * Lists stuck cashier shifts for manager/admin operators. Enforces the
 * role gate (AD-1), delegates to BackendClient.getStuckShifts, and
 * applies an allowlist redaction so only display-safe fields reach the
 * renderer (FR-013 / FR-032).
 *
 * RT-358 (RT-247 D-A1) — the route is `operator-identity`, so the request goes
 * through `OperatorIdentityCall`: never an empty bearer, an expired JWT →
 * `reauth_required` without sending, a 401 → `reauth_required` (or, on the
 * marked retry, the session ends), and a locked / latched / replaced session
 * is refused before and after the request.
 */

import type { Logger } from 'pino';
import type { OperatorRefusal } from '../../shared/audit/event-shape.js';
import type { SessionManager } from './session-manager.js';
import type { BackendClient, BackendStuckShiftRow } from './backend-client.js';
import type { JwtHolder } from './jwt-holder.js';
import { OperatorIdentityCall, snapshotOf } from './operator-identity-call.js';
import type { ListStuckShiftsResponse, StuckShiftSummary } from '../../shared/bridge-api.js';

export interface StuckShiftsHandlerDeps {
  sessionManager: Pick<SessionManager, 'getCurrent' | 'endIfCurrent'>;
  backendClient: Pick<BackendClient, 'getStuckShifts'>;
  jwtHolder: Pick<JwtHolder, 'get' | 'consumeMark' | 'clear'>;
  /** RT-358 — clears the envelope of a session ended by the fail-closed path. */
  clearEnvelope?: (backendSessionId: string) => void;
  /** RT-358 — wall clock (ms) for the JWT `exp` check. Tests inject. */
  nowMs?: () => number;
  /** RT-358 — monotonic clock (ms) for the re-auth mark. Tests inject. */
  monoNowMs?: () => number;
  /** Optional logger. Tests omit it. */
  logger?: Logger;
}

const REFUSE_INVALID: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };

function toSummary(row: BackendStuckShiftRow): StuckShiftSummary {
  return {
    shift_id: row.shift_id,
    cashier_display_name: row.cashier_display_name,
    terminal_label: row.terminal_label,
    opened_at: row.opened_at,
    duration_minutes: row.duration_minutes,
  };
}

export class StuckShiftsHandler {
  private readonly identityCall: OperatorIdentityCall;

  constructor(private readonly deps: StuckShiftsHandlerDeps) {
    this.identityCall = new OperatorIdentityCall({
      sessionManager: deps.sessionManager,
      jwtHolder: deps.jwtHolder,
      ...(deps.clearEnvelope === undefined ? {} : { clearEnvelope: deps.clearEnvelope }),
      ...(deps.nowMs === undefined ? {} : { nowMs: deps.nowMs }),
      ...(deps.monoNowMs === undefined ? {} : { monoNowMs: deps.monoNowMs }),
    });
  }

  async listStuckShifts(): Promise<ListStuckShiftsResponse> {
    const session = this.deps.sessionManager.getCurrent();
    if (session === null) {
      return { kind: 'refused', category: 'not_signed_in' };
    }
    if (session.role === 'cashier') {
      return { kind: 'refused', category: 'role_mismatch' };
    }

    const snapshot = snapshotOf(session);
    const prepared = this.identityCall.prepare(snapshot);
    if (prepared.kind === 'refused') return prepared;

    const result = await this.deps.backendClient.getStuckShifts(session.branch_id, prepared.jwt);

    if (result.kind === 'unauthenticated') {
      return this.identityCall.onUnauthenticated(snapshot, prepared.marked);
    }
    const inactive = this.identityCall.stillActive(snapshot);
    if (inactive !== null) return inactive;
    if (result.kind === 'no_connection') {
      return { kind: 'refused', category: 'no_connection' };
    }
    if (result.kind !== 'ok') return REFUSE_INVALID;

    const shifts = result.shifts.map(toSummary);
    this.deps.logger?.info(
      { event: 'operator.stuck_shifts.listed', count: shifts.length },
      'stuck shifts listed',
    );
    return { kind: 'stuck_shifts', shifts };
  }
}
