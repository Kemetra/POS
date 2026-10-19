/**
 * RT-741 (RT-546 follow-up) — `saleVoid.lookup` runs the shared RT-546 sale
 * access gate (`sale-access-policy.ts`), composed as in the app:
 *
 *   • a cashier finds only their own sale; another operator's sale refuses as
 *     `role_denied` with nothing else in the answer (no total, cash or name) and
 *     is audited as `sale.access.refused` / `not_owner`;
 *   • a manager or admin finds any sale of this terminal;
 *   • a locked session or no session is refused before any sale is read, with
 *     the void domain's own reasons, and is not audited.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import { seedSale } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import type { SaleRawAuditEvent } from '../../sales/audit-emitter.js';
import type { Role } from '../../../shared/operator/role.js';
import { composeSaleVoid, type ComposedSaleVoid } from '../compose-sale-void.js';

const TERMINAL = 'term-1';
const T0 = '2026-06-07T10:30:00.000Z';
const TENDERS = JSON.stringify([{ tender_type: 'cash', amount_applied_minor: 1500 }]);
const OWN_SALE = 'sale-own';
const OTHER_SALE = 'sale-other';

function session(role: Role, operatorId: string): OperatorSessionRecord {
  return {
    id: `sess-${operatorId}`,
    operator_id: operatorId,
    display_name: `Operator ${operatorId}`,
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: T0,
    backend_session_id: `b-${operatorId}`,
    last_activity_at: T0,
    lock_state: 'active',
    locked_at: null,
    ...(role === 'cashier'
      ? { user_id: '0190f5a2-3b4c-7d8e-9f01-0000000000c1' }
      : { manager_user_id: '0190f5a2-3b4c-7d8e-9f01-0000000000a1' }),
  };
}

let raw: SqlJsDatabase;
let domain: ComposedSaleVoid;
let current: OperatorSessionRecord | null;
let locked: boolean;
let accessAudits: SaleRawAuditEvent[];

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  raw = freshGrantDb();
  current = session('cashier', 'op-cashier');
  locked = false;
  accessAudits = [];
  domain = composeSaleVoid({
    db: handleFor(raw),
    http: {
      baseUrl: 'https://api.example.test',
      fetch: (() => undefined) as unknown as typeof fetch,
    },
    getOperatorEnvelope: () => 'envelope',
    getSession: () => current,
    getTerminalId: () => TERMINAL,
    isSessionLocked: () => locked,
    isEnabled: () => true,
    approvals: { consume: () => undefined, evidence: () => undefined } as never,
    auditSink: { emit: () => undefined },
    accessAudit: { emitRaw: (event) => accessAudits.push(event) },
    logger: { warn: () => undefined, error: () => undefined },
    now: () => T0,
    localDayOf: (iso) => iso.slice(0, 10),
  });
  seedSale(raw, {
    sale_id: OWN_SALE,
    selling_operator_id: 'op-cashier',
    finalized_at: T0,
    tender_lines_summary_json: TENDERS,
  });
  seedSale(raw, {
    sale_id: OTHER_SALE,
    selling_operator_id: 'op-other',
    finalized_at: T0,
    tender_lines_summary_json: TENDERS,
  });
});

afterEach(() => {
  raw.close();
});

const lookup = (saleId: string) => domain.service.lookup({ sale_number: `SN-${saleId}` });

describe('RT-741 — saleVoid.lookup ownership gate', () => {
  it('a cashier finds their own sale', async () => {
    await expect(lookup(OWN_SALE)).resolves.toMatchObject({
      kind: 'sale',
      sale: { sale_id: OWN_SALE },
    });
    expect(accessAudits).toEqual([]);
  });

  it("a cashier is refused another operator's sale as role_denied, nothing disclosed, audited", async () => {
    await expect(lookup(OTHER_SALE)).resolves.toEqual({ kind: 'refused', reason: 'role_denied' });
    expect(accessAudits).toHaveLength(1);
    expect(accessAudits[0]).toMatchObject({
      action_category: 'sale.access.refused',
      attribution_operator_id: 'op-cashier',
      session_id: 'sess-op-cashier',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      originating_terminal_id: TERMINAL,
      payload: { action: 'saleVoid.lookup', reason: 'not_owner', sale_id: OTHER_SALE },
    });
  });

  it('a cashier asking for a number that does not exist still gets sale_not_found', async () => {
    await expect(domain.service.lookup({ sale_number: 'SN-nope' })).resolves.toEqual({
      kind: 'refused',
      reason: 'sale_not_found',
    });
    expect(accessAudits).toEqual([]);
  });

  it('a cashier session with no operator id is refused (fail closed), never matched', async () => {
    current = { ...session('cashier', ''), id: 'sess-blank' };
    seedSale(raw, {
      sale_id: 'sale-blank',
      selling_operator_id: '',
      finalized_at: T0,
      tender_lines_summary_json: TENDERS,
    });
    await expect(lookup('sale-blank')).resolves.toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it.each<Role>(['manager', 'admin'])("a %s finds another operator's sale", async (role) => {
    current = session(role, 'op-lead');
    await expect(lookup(OTHER_SALE)).resolves.toMatchObject({
      kind: 'sale',
      sale: { sale_id: OTHER_SALE, selling_operator_display_name: expect.any(String) as string },
    });
    expect(accessAudits).toEqual([]);
  });

  it('a locked session is refused before any sale is read, unaudited', async () => {
    locked = true;
    await expect(lookup(OTHER_SALE)).resolves.toEqual({
      kind: 'refused',
      reason: 'session_locked',
    });
    expect(accessAudits).toEqual([]);
  });

  it('no session is refused, unaudited', async () => {
    current = null;
    await expect(lookup(OTHER_SALE)).resolves.toEqual({ kind: 'refused', reason: 'no_session' });
    expect(accessAudits).toEqual([]);
  });

  it('an access-audit fault still refuses (never a rejection, never the sale)', async () => {
    domain = composeSaleVoid({
      db: handleFor(raw),
      http: {
        baseUrl: 'https://api.example.test',
        fetch: (() => undefined) as unknown as typeof fetch,
      },
      getOperatorEnvelope: () => 'envelope',
      getSession: () => current,
      getTerminalId: () => TERMINAL,
      isSessionLocked: () => false,
      isEnabled: () => true,
      approvals: { consume: () => undefined, evidence: () => undefined } as never,
      auditSink: { emit: () => undefined },
      accessAudit: {
        emitRaw: () => {
          throw new Error('sink down');
        },
      },
      logger: { warn: () => undefined, error: () => undefined },
      now: () => T0,
      localDayOf: (iso) => iso.slice(0, 10),
    });
    await expect(lookup(OTHER_SALE)).resolves.toEqual({ kind: 'refused', reason: 'role_denied' });
  });
});
