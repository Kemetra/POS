import type { Database as SqlJsDatabase } from 'sql.js';
import type { Logger } from 'pino';

import { ForcedCloseHandler } from '../../../../../src/main/operator/forced-close-handler.js';
import type { AuditEmitter } from '../../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../../src/shared/audit/event-shape.js';
import type { OperatorSessionRecord } from '../../../../../src/main/operator/session-manager.js';
import type { PairingStatus } from '../../../../../src/shared/pairing-types.js';
import type { ForceCloseShiftRequest } from '../../../../../src/shared/bridge-api.js';
import {
  freshSalesSyncDb,
  handleFor,
} from '../../../../../src/main/sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  managerSession,
  MANAGER,
  serviceHarness,
  type ServiceHarness,
} from '../../../../../src/main/shift-cashup/__tests__/__helpers__/shift-cashup-service-fixture.js';
import { SCOPE } from '../../../../../src/main/shift-cashup/__tests__/__helpers__/shift-sync-fixture.js';

/**
 * Shared fixture of the forced-close handler tests (T085, T086; RT-554 (b)):
 * the real cash-up service over the full migration stack (sql.js), a cashier's
 * open shift on the terminal, a manager signed in at the close instant, and an
 * audit emitter that writes the real `audit_events` table (so the close and its
 * audit share one rollback, as in production). The caller closes `db`.
 */

export const FLOAT = 50_000;
export const CLOSE_AT = '2026-10-05T16:00:00.000Z';

export const PAIRED: PairingStatus = {
  kind: 'paired',
  tenant_id: SCOPE.tenantId,
  branch_id: SCOPE.branchId,
  terminal_id: SCOPE.terminalId,
  terminal_label: 'Terminal 1',
  paired_at: 0,
};

export interface HandlerOptions {
  session?: OperatorSessionRecord | null;
  auditFails?: boolean;
  deliverNow?: () => Promise<boolean>;
  logger?: Logger;
}

export interface ForcedCloseFixture {
  db: SqlJsDatabase;
  harness: ServiceHarness;
  /** The cashier's open shift on the terminal. */
  shiftId: string;
  /** Every audit event the handler emitted, in order. */
  captured: AuditEvent[];
  makeSession: (overrides?: Partial<OperatorSessionRecord>) => OperatorSessionRecord;
  makeHandler: (options?: HandlerOptions) => ForcedCloseHandler;
  request: (over?: Partial<ForceCloseShiftRequest>) => ForceCloseShiftRequest;
}

function auditEmitterOver(input: {
  db: SqlJsDatabase;
  captured: AuditEvent[];
  fails: boolean;
}): AuditEmitter {
  const { db, captured } = input;
  return {
    emit(event: AuditEvent): void {
      if (input.fails) throw new Error('audit store unavailable');
      captured.push(event);
      db.run(
        `INSERT INTO audit_events
           (event_id, tenant_id, branch_id, originating_terminal_id,
            acting_operator_id, session_id, shift_id, action_category,
            created_at, approving_supervisor_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.event_id,
          event.tenant_id,
          event.branch_id,
          event.originating_terminal_id,
          event.acting_operator_id,
          event.session_id ?? null,
          event.shift_id ?? null,
          event.action_category,
          event.created_at,
          event.approving_supervisor_id ?? null,
          JSON.stringify(event.payload),
        ],
      );
    },
  } as unknown as AuditEmitter;
}

/** The manager's session record (`manager_user_id` = the fixture manager's users.id). */
function sessionRecord(overrides: Partial<OperatorSessionRecord> = {}): OperatorSessionRecord {
  return {
    id: managerSession().operator_session_id,
    operator_id: 'op-manager-1',
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    backend_session_id: 'bsess-1',
    started_at: '2026-10-05T15:00:00.000Z',
    last_activity_at: '2026-10-05T15:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
    manager_user_id: MANAGER,
    ...overrides,
  };
}

/** A fresh db with the cashier's shift open and the manager signed in at `CLOSE_AT`. */
export function setupForcedClose(): ForcedCloseFixture {
  const db = freshSalesSyncDb();
  const harness = serviceHarness(db, { varianceApprovalThresholdMinor: null });
  const shiftId = harness.service.openShift({ openingFloatMinor: FLOAT }).shiftId;
  harness.state.session = managerSession();
  harness.state.clock = CLOSE_AT;
  const captured: AuditEvent[] = [];
  let eventCounter = 0;
  return {
    db,
    harness,
    shiftId,
    captured,
    makeSession: sessionRecord,
    makeHandler(options = {}) {
      const session = options.session === undefined ? sessionRecord() : options.session;
      return new ForcedCloseHandler({
        db: handleFor(db),
        sessionManager: { getCurrent: () => session },
        pairingStore: { getStatus: () => Promise.resolve(PAIRED) },
        auditEmitter: auditEmitterOver({ db, captured, fails: options.auditFails === true }),
        shiftCashup: harness.service,
        ...(options.deliverNow === undefined ? {} : { deliverNow: options.deliverNow }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
    },
    request(over = {}) {
      eventCounter += 1;
      return {
        event_id: `evt-${String(eventCounter)}`,
        shift_id: shiftId,
        reason: 'takeover_supersession',
        counted_cash_minor: FLOAT,
        ...over,
      };
    },
  };
}
