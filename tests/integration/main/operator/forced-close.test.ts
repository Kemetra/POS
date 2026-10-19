import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { Logger } from 'pino';

import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { ForceCloseShiftRequest } from '../../../../src/shared/bridge-api.js';
import {
  handleFor,
  initSalesSyncSql,
} from '../../../../src/main/sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createShiftCashupRepo } from '../../../../src/main/shift-cashup/shift-cashup-repo.js';
import {
  cashLine,
  factCounts,
  MANAGER,
  seedSettlement,
  seedShiftSale,
  storedBody,
  type ServiceHarness,
} from '../../../../src/main/shift-cashup/__tests__/__helpers__/shift-cashup-service-fixture.js';
import {
  SCOPE,
  USER,
} from '../../../../src/main/shift-cashup/__tests__/__helpers__/shift-sync-fixture.js';
import {
  CLOSE_AT,
  FLOAT,
  setupForcedClose,
  type ForcedCloseFixture,
  type HandlerOptions,
} from './__helpers__/forced-close-fixture.js';

/**
 * T085 (rewritten by RT-554 (b)) — the manager's forced close of a stuck shift
 * of THIS terminal. The shift is the terminal's open shift in the cash-up
 * tables (`shift_cashup_opens`); the cash-up is computed from local truth and
 * the manager's count; the close row, its manager-envelope outbox row and the
 * `shift.forced_close` audit event are ONE atomic write. The legacy `shifts`
 * table (0007, never written in production) is not used.
 *
 * Verifies: manager/admin can force-close; the audit event shape (FR-025); the
 * count is a blind input; idempotency by `event_id`; the audit and the close
 * stand or fall together; a cashier, a signed-out caller and a manager with no
 * `users.id` are refused; a shift this terminal does not hold is
 * `not_closable_here`; an already-closed shift is `state_invalid`; in-flight
 * drawer cash is `close_blocked`; nothing sensitive reaches a log.
 */

const OTHER_SHIFT = '0192f5a2-3b4c-7d8e-9f01-eeeeeeeeeeee';
/** The close is the second outbox row: the open is seq 1. */
const CLOSE_SEQ = 2;

let db: SqlJsDatabase;
let harness: ServiceHarness;
let shiftId: string;
let captured: AuditEvent[];
let makeSession: ForcedCloseFixture['makeSession'];
let makeHandler: ForcedCloseFixture['makeHandler'];
let request: ForcedCloseFixture['request'];

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  ({ db, harness, shiftId, captured, makeSession, makeHandler, request } = setupForcedClose());
});

afterEach(() => {
  db.close();
});

function closeRows(): unknown[][] {
  return (
    db.exec(
      `SELECT close_kind, forced_reason, closing_user_id, counted_cash_minor, variance_minor
         FROM shift_cashup_closes`,
    )[0]?.values ?? []
  );
}

// ─── the forced close ─────────────────────────────────────────────────────────

describe('T085 — a manager force-closes the terminal’s own stuck shift', () => {
  it.each(['manager', 'admin'] as const)(
    'a %s receives forced_closed, queued for sending',
    async (role) => {
      const handler = makeHandler({ session: makeSession({ role }) });
      const req = request();

      const result = await handler.forceCloseShift(req);

      expect(result).toEqual({
        kind: 'forced_closed',
        audit_event_id: req.event_id,
        delivery: 'queued',
      });
    },
  );

  it('records the forced close and ONE manager-envelope outbox row with the manager as closer', async () => {
    await makeHandler().forceCloseShift(request({ reason: 'cashier_no_show' }));

    expect(closeRows()).toEqual([['forced', 'cashier_no_show', MANAGER, FLOAT, 0]]);
    expect(
      db.exec(`SELECT auth_path, sync_status FROM shift_sync_outbox o
               JOIN shift_sync_state s ON s.seq = o.seq WHERE o.fact_kind = 'close'`)[0]?.values,
    ).toEqual([['envelope', 'pending']]);
    const body = storedBody(db, 2);
    expect(body).toMatchObject({ closeKind: 'forced', forcedReason: 'cashier_no_show' });
    expect(body).not.toHaveProperty('operatorUserId');
  });

  it('computes the cash-up from local truth and the manager’s count', async () => {
    seedShiftSale(db, {
      saleId: 'sale-1',
      finalizedAt: '2026-10-05T10:00:00.000Z',
      lines: [cashLine(10_000)],
    });

    await makeHandler().forceCloseShift(request({ counted_cash_minor: 59_500 }));

    expect(storedBody(db, 2)).toMatchObject({
      openingFloat: '500.00',
      cashSalesTotal: '100.00',
      expectedCash: '600.00',
      countedCash: '595.00',
      variance: '-5.00',
      saleCount: 1,
    });
  });

  it('audit event has the FR-025 attributes and never carries the count or the variance', async () => {
    await makeHandler().forceCloseShift(
      request({ event_id: 'evt-t085-shape-1', annotation: 'left at 3pm' }),
    );

    expect(captured).toHaveLength(1);
    const event = captured[0];
    if (event === undefined) throw new Error('no event');
    expect(event).toMatchObject({
      event_id: 'evt-t085-shape-1',
      action_category: 'shift.forced_close',
      tenant_id: SCOPE.tenantId,
      branch_id: SCOPE.branchId,
      originating_terminal_id: SCOPE.terminalId,
      acting_operator_id: 'op-manager-1',
      shift_id: shiftId,
    });
    expect(event.payload).toEqual({
      shift_id: shiftId,
      shift_owner_id: USER,
      forced_close_actor_id: 'op-manager-1',
      forced_close_reason: 'takeover_supersession',
      annotation: 'left at 3pm',
    });
  });

  it('reports delivery sent when the drain delivered it', async () => {
    const result = await makeHandler({ deliverNow: () => Promise.resolve(true) }).forceCloseShift(
      request(),
    );
    expect(result).toMatchObject({ kind: 'forced_closed', delivery: 'sent' });
  });

  it.each([
    ['did not deliver', () => Promise.resolve(false)],
    ['threw', () => Promise.reject(new Error('offline'))],
  ])('reports delivery queued when the drain %s', async (_name, deliverNow) => {
    const result = await makeHandler({ deliverNow }).forceCloseShift(request());
    expect(result).toMatchObject({ kind: 'forced_closed', delivery: 'queued' });
    expect(closeRows()).toHaveLength(1);
  });
});

describe('T085 — idempotency and atomicity', () => {
  it('a retry with the same event_id is forced_closed again; the close and the audit are not repeated', async () => {
    const calls: number[] = [];
    const handler = makeHandler({
      deliverNow: () => {
        calls.push(1);
        return Promise.resolve(true);
      },
    });
    const req = request();

    const first = await handler.forceCloseShift(req);
    const second = await handler.forceCloseShift(req);

    expect(first).toMatchObject({ kind: 'forced_closed', delivery: 'sent' });
    expect(second).toEqual({
      kind: 'forced_closed',
      audit_event_id: req.event_id,
      delivery: 'sent',
    });
    expect(captured).toHaveLength(1);
    expect(closeRows()).toHaveLength(1);
    // The retry kicks delivery again: the first answer may have been lost.
    expect(calls).toHaveLength(2);
  });

  // RT-554 (b): the close is recorded here, but until the server has it the stuck
  // list still shows the shift. A retry must say so: never «state changed».
  it('another event_id on a shift closed here but NOT at the server yet is closed_here_unsent, audit once', async () => {
    const handler = makeHandler();
    await handler.forceCloseShift(request());

    const result = await handler.forceCloseShift(request());

    expect(result).toEqual({ kind: 'refused', category: 'closed_here_unsent' });
    expect(captured).toHaveLength(1);
  });

  it('the same retry is state_invalid once the server has the close (the list is only stale)', async () => {
    const handler = makeHandler();
    await handler.forceCloseShift(request());
    createShiftCashupRepo(handleFor(db)).markSynced({ seq: CLOSE_SEQ, now: CLOSE_AT });

    const result = await handler.forceCloseShift(request());

    expect(result).toEqual({ kind: 'refused', category: 'state_invalid' });
  });

  it('a retry first kicks delivery: if that sends the close, it is state_invalid, not unsent', async () => {
    const repo = createShiftCashupRepo(handleFor(db));
    await makeHandler().forceCloseShift(request());
    const handler = makeHandler({
      deliverNow: () => {
        repo.markSynced({ seq: CLOSE_SEQ, now: CLOSE_AT });
        return Promise.resolve(true);
      },
    });

    const result = await handler.forceCloseShift(request());

    expect(result).toEqual({ kind: 'refused', category: 'state_invalid' });
  });

  it('a retry whose delivery throws still answers closed_here_unsent', async () => {
    await makeHandler().forceCloseShift(request());
    const handler = makeHandler({ deliverNow: () => Promise.reject(new Error('offline')) });

    expect(await handler.forceCloseShift(request())).toEqual({
      kind: 'refused',
      category: 'closed_here_unsent',
    });
  });

  it('an audit failure is invalid_input and leaves the shift open: no close row, no outbox row', async () => {
    const counts = factCounts(db);

    const result = await makeHandler({ auditFails: true }).forceCloseShift(request());

    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(factCounts(db)).toEqual(counts);
    expect(closeRows()).toEqual([]);
  });
});

// ─── refusals ─────────────────────────────────────────────────────────────────

describe('T085 — refusals write nothing', () => {
  async function refused(options: HandlerOptions, over: Partial<ForceCloseShiftRequest> = {}) {
    const counts = factCounts(db);
    const result = await makeHandler(options).forceCloseShift(request(over));
    expect(factCounts(db)).toEqual(counts);
    expect(captured).toHaveLength(0);
    return result;
  }

  it('a cashier is refused role_mismatch (AC-9)', async () => {
    expect(await refused({ session: makeSession({ role: 'cashier' }) })).toEqual({
      kind: 'refused',
      category: 'role_mismatch',
    });
  });

  it('no session is not_signed_in', async () => {
    expect(await refused({ session: null })).toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
  });

  it('a manager session with no users.id is not_signed_in (sign in again)', async () => {
    const without = makeSession();
    delete without.manager_user_id;
    expect(await refused({ session: without })).toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
  });

  it('a session other than the terminal’s live one is not_signed_in', async () => {
    expect(await refused({ session: makeSession({ id: 'another-session' }) })).toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
  });

  it('a locked cash-up session is not_signed_in', async () => {
    harness.state.locked = true;
    expect(await refused({})).toEqual({ kind: 'refused', category: 'not_signed_in' });
  });

  it('a shift this terminal does not hold is not_closable_here', async () => {
    expect(await refused({}, { shift_id: OTHER_SHIFT })).toEqual({
      kind: 'refused',
      category: 'not_closable_here',
    });
  });

  it('with the cash-up feature off there is no local shift: not_closable_here', async () => {
    harness.state.enabled = false;
    expect(await refused({})).toEqual({ kind: 'refused', category: 'not_closable_here' });
  });

  it('drawer cash in flight is close_blocked', async () => {
    seedSettlement(db, { saleId: 'sale-in-flight' });
    expect(await refused({})).toEqual({ kind: 'refused', category: 'close_blocked' });
  });

  it('an implausible count is invalid_input', async () => {
    expect(await refused({}, { counted_cash_minor: 100_000_001 })).toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
  });
});

describe('T085 — logs', () => {
  it('name the outcome and category only: no id, reason, note or count', async () => {
    const lines: unknown[] = [];
    const logger = { info: (...a: unknown[]) => lines.push(a) } as unknown as Logger;
    const handler = makeHandler({ logger });
    seedShiftSale(db, {
      saleId: 'sale-1',
      finalizedAt: '2026-10-05T10:00:00.000Z',
      lines: [cashLine(10_000)],
    });

    await handler.forceCloseShift(
      request({
        event_id: 'evt-secret-456',
        annotation: 'private-note-xyz',
        counted_cash_minor: 123_457,
      }),
    );
    await handler.forceCloseShift(request({ shift_id: 'shift-secret-id-123' }));

    const logged = JSON.stringify(lines);
    expect(logged).toContain('forced_closed');
    expect(logged).toContain('not_closable_here');
    for (const secret of [
      'evt-secret-456',
      'private-note-xyz',
      '123457',
      '1234.57',
      'shift-secret-id-123',
      shiftId,
      MANAGER,
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
