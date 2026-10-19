import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import { initSalesSyncSql } from '../../../../src/main/sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { USER } from '../../../../src/main/shift-cashup/__tests__/__helpers__/shift-sync-fixture.js';
import { setupForcedClose, type ForcedCloseFixture } from './__helpers__/forced-close-fixture.js';

/**
 * T086 (rewritten by RT-554 (b)) — takeover ↔ forced-close separation
 * invariant.
 *
 * Verifies that `operator.session.takeover` and `shift.forced_close` are
 * independent audit rows with separate event_ids, separate timestamps, and
 * separate action_categories — i.e. they are never conflated into one row
 * even when both actions happen in the same workflow. The forced close itself
 * is the manager's close of the terminal's own open shift (see T085).
 */

let db: SqlJsDatabase;
let shiftId: string;
let captured: AuditEvent[];
let makeSession: ForcedCloseFixture['makeSession'];
let makeHandler: ForcedCloseFixture['makeHandler'];
let request: ForcedCloseFixture['request'];

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  ({ db, shiftId, captured, makeSession, makeHandler, request } = setupForcedClose());
});

afterEach(() => {
  db.close();
});

/** What `TakeoverHandler.emitTakeoverAudit()` produces: an independent event. */
function takeoverEvent(eventId: string): AuditEvent {
  return {
    event_id: eventId,
    action_category: 'operator.session.takeover',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    originating_terminal_id: 'term-1',
    acting_operator_id: 'op-manager-1',
    session_id: 'sess-manager-1',
    shift_id: shiftId,
    created_at: new Date().toISOString(),
    approving_supervisor_id: null,
    payload: {
      displaced_operator_id: 'cashier-op-1',
      displaced_session_id: 'old-session-1',
      reason: 'manager_override',
    },
  };
}

async function forceCloseAfterTakeover(
  over: Partial<Parameters<ForcedCloseFixture['request']>[0]> = {},
): Promise<{ takeoverEventId: string; forcedCloseEventId: string }> {
  const takeoverEventId = 'evt-takeover-1';
  captured.push(takeoverEvent(takeoverEventId));
  const req = request(over);
  await makeHandler().forceCloseShift(req);
  return { takeoverEventId, forcedCloseEventId: req.event_id };
}

describe('T086 — takeover ↔ forced-close audit separation invariant', () => {
  it('forced-close emits exactly one shift.forced_close event, not operator.session.takeover', async () => {
    await makeHandler().forceCloseShift(request());

    expect(captured.filter((e) => e.action_category === 'shift.forced_close')).toHaveLength(1);
    expect(captured.filter((e) => e.action_category === 'operator.session.takeover')).toHaveLength(
      0,
    );
  });

  it('when takeover precedes forced-close, both audit rows exist with distinct event_ids', async () => {
    const { takeoverEventId, forcedCloseEventId } = await forceCloseAfterTakeover();

    expect(captured).toHaveLength(2);
    const eventIds = captured.map((e) => e.event_id);
    expect(new Set(eventIds).size).toBe(2);
    expect(eventIds).toContain(takeoverEventId);
    expect(eventIds).toContain(forcedCloseEventId);
  });

  it('takeover and forced-close audit rows have distinct action_categories', async () => {
    await forceCloseAfterTakeover();

    const categories = captured.map((e) => e.action_category);
    expect(categories).toContain('operator.session.takeover');
    expect(categories).toContain('shift.forced_close');
    // No category appears twice — they are independent
    expect(new Set(categories).size).toBe(categories.length);
  });

  it('takeover and forced-close rows reference the same shift_id but have valid timestamps', async () => {
    const beforeTakeover = new Date().toISOString();

    await forceCloseAfterTakeover();

    for (const event of captured) {
      expect(event.shift_id).toBe(shiftId);
      expect(new Date(event.created_at).toISOString()).toBe(event.created_at);
      expect(new Date(event.created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(beforeTakeover).getTime(),
      );
    }
  });

  it('forced-close event_id does not collide with takeover event_id', async () => {
    const takeoverEventId = 'evt-takeover-1';
    captured.push(takeoverEvent(takeoverEventId));

    const result = await makeHandler().forceCloseShift(request());

    expect(result.kind).toBe('forced_closed');
    if (result.kind === 'forced_closed') {
      expect(result.audit_event_id).not.toBe(takeoverEventId);
    }
  });

  it('forced-close acting_operator_id is the manager who initiated the close, not the shift owner', async () => {
    const handler = makeHandler({
      session: makeSession({ operator_id: 'manager-who-closes', role: 'manager' }),
    });

    await handler.forceCloseShift(request({ reason: 'cashier_no_show' }));

    const forced = captured.find((e) => e.action_category === 'shift.forced_close');
    if (forced === undefined) throw new Error('No shift.forced_close event captured');
    expect(forced.acting_operator_id).toBe('manager-who-closes');
    expect(forced.payload).toMatchObject({
      shift_owner_id: USER,
      forced_close_actor_id: 'manager-who-closes',
    });
  });
});
