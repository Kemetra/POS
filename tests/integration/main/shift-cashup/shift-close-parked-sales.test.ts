/**
 * RT-440 (PK-2, spec 024 K4, owner decision OP-2) — closing the terminal's
 * open shift (the cash session) is refused while any sale is parked on the
 * terminal, whoever parked it. The refusal carries a count only. Once the
 * sales are resumed, or cancelled by a manager through recovery (RT-441,
 * `recovery.cancelHeldCart`), the close goes through.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../../../src/main/sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import { createManagerRecovery } from '../../../../src/main/recovery/manager-recovery.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { createShiftCashupBridge } from '../../../../src/main/shift-cashup/shift-cashup-bridge.js';
import type { ShiftCashupService } from '../../../../src/main/shift-cashup/shift-cashup-service.js';
import {
  CLOSED_AT,
  serviceHarness,
} from '../../../../src/main/shift-cashup/__tests__/__helpers__/shift-cashup-service-fixture.js';
import {
  OTHER_TERMINAL,
  SCOPE,
} from '../../../../src/main/shift-cashup/__tests__/__helpers__/shift-sync-fixture.js';
import type { ShiftScope } from '../../../../src/main/shift-cashup/shift-cashup-repo.js';

const FLOAT = 50_000;
let db: SqlJsDatabase;
let service: ShiftCashupService;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  const harness = serviceHarness(db);
  service = harness.service;
  service.openShift({ openingFloatMinor: FLOAT });
  harness.state.clock = CLOSED_AT;
});

afterEach(() => {
  db.close();
});

function parkedSale(cart_id: string, operator: string, scope: ShiftScope = SCOPE): void {
  db.run(
    `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
       operator_session_id, state, cart_subtotal_minor, created_at, updated_at, parked_at,
       park_label, last_action_id)
     VALUES (?, ?, ?, ?, ?, ?, 'editing', 900, ?, ?, ?, 'secret bag', 'a')`,
    [
      cart_id,
      scope.tenantId,
      scope.branchId,
      scope.terminalId,
      operator,
      `sess-${operator}`,
      CLOSED_AT,
      CLOSED_AT,
      CLOSED_AT,
    ],
  );
}

const refusedWith = (parkedCount: number): Error =>
  expect.objectContaining({
    name: 'ShiftCashupRefusedError',
    reason: 'parked_sales_present',
    parkedCount,
  }) as Error;

describe('shift close with parked sales (K4, OP-2)', () => {
  it('refuses with the count of every operator’s parked sales on this terminal', () => {
    parkedSale('c-1', 'cashier-1');
    parkedSale('c-2', 'cashier-2');
    expect(() => service.closeShift({ countedCashMinor: FLOAT })).toThrow(refusedWith(2));
  });

  it('refuses the variance approval as well (the same pre-check)', async () => {
    parkedSale('c-1', 'cashier-1');
    await expect(
      service.verifyApprover({
        countedCashMinor: FLOAT + 5,
        managerRef: 'm',
        managerPin: '246810',
      }),
    ).rejects.toThrow(refusedWith(1));
  });

  it('ignores parked sales on another terminal, and resumed or cancelled carts', () => {
    parkedSale('c-other', 'cashier-1', OTHER_TERMINAL);
    parkedSale('c-resumed', 'cashier-1');
    db.run(`UPDATE carts SET parked_at = NULL WHERE cart_id = 'c-resumed'`);
    parkedSale('c-voided', 'cashier-1');
    db.run(`UPDATE carts SET state = 'cancelled' WHERE cart_id = 'c-voided'`);
    expect(service.closeShift({ countedCashMinor: FLOAT })).toMatchObject({ varianceMinor: 0 });
  });

  it('is answered by the bridge with the count only: no owner, label or amount', async () => {
    parkedSale('c-1', 'cashier-1');
    const logged: unknown[] = [];
    const bridge = createShiftCashupBridge({
      service,
      enrollment: {} as never,
      logger: { info: (p) => logged.push(p), warn: (p) => logged.push(p) },
    });
    const answer = await bridge.close({ countedCashMinor: FLOAT });
    expect(answer).toEqual({ kind: 'refused', reason: 'parked_sales_present', parkedCount: 1 });
    expect(JSON.stringify([answer, logged])).not.toMatch(/secret bag|cashier-1|900/);
  });
});

describe('RT-441 — a manager cancel through recovery unblocks the close', () => {
  it('cancels the abandoned parked sale with an approval; the close then goes through', () => {
    parkedSale('c-abandoned', 'cashier-gone');
    const handle = makeSqlJsHandle(db);
    const manager: OperatorSessionRecord = {
      id: 'sess-mgr',
      operator_id: 'op-mgr',
      display_name: 'Mona',
      role: 'manager',
      tenant_id: SCOPE.tenantId,
      branch_id: SCOPE.branchId,
      started_at: CLOSED_AT,
      backend_session_id: 'b',
      last_activity_at: CLOSED_AT,
      lock_state: 'active',
      locked_at: null,
    };
    const audit: unknown[] = [];
    const recovery = createManagerRecovery({
      db: handle,
      getSession: () => manager,
      resolveTerminalId: () => SCOPE.terminalId,
      approvals: { consume: () => ({ kind: 'consumed', approverUserId: 'mgr-user' }) },
      cartStore: bindCartStore(handle),
      payments: {} as never,
      auditEmitter: { emit: (e) => audit.push(e) },
      endRecoverySession: () => Promise.resolve(),
    });

    const listed = recovery.listHeld();
    expect(listed.kind === 'held' && listed.held).toEqual([
      expect.objectContaining({ cart_id: 'c-abandoned', parked: true }),
    ]);
    expect(JSON.stringify(listed)).not.toContain('secret bag');
    expect(() => service.closeShift({ countedCashMinor: FLOAT })).toThrow(refusedWith(1));

    expect(recovery.cancelHeldCart({ cart_id: 'c-abandoned', approval_id: 'appr-1' })).toEqual({
      kind: 'cancelled',
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action_category: 'cart.held_cancelled_by_manager',
      payload: { cart_id: 'c-abandoned', parked: true },
    });
    expect(service.closeShift({ countedCashMinor: FLOAT })).toMatchObject({ varianceMinor: 0 });
  });
});
