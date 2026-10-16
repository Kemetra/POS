/**
 * RT-530 — requesting a void, end to end over the full migration stack
 * (sql.js): the real manager PIN store (real Argon2id), the real approval
 * service (action `sale.void`) and the real void service and journal.
 *
 *   • four-eyes: the approver is never the requester and never the sale's
 *     selling operator; the approval is bound to THIS sale and its total and
 *     is single-use (consumed in the journaling transaction);
 *   • same business day only; no second live void; no return;
 *   • a session that could never send the void (a cashier with no envelope) is
 *     refused before an approval is spent;
 *   • the evidence journaled is the approval's own (approver, policy version,
 *     time), with audit events for the grant and the request.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import { seedSale } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createManagerPinStore, type ManagerPinStore } from '../../operator/manager-pin-store.js';
import {
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../../operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { SaleVoidRequestResponse } from '../../../shared/sale-void/types.js';
import { createSaleVoidAudit } from '../sale-void-audit.js';
import {
  createSaleVoidRepository,
  type NewVoidEntry,
  type SaleVoidRepository,
} from '../sale-void-repository.js';
import { toVoidSender, toVoidSession } from '../sale-void-session.js';
import {
  createSaleVoidService,
  SALE_VOID_LIST_LIMIT,
  type SaleVoidService,
} from '../sale-void-service.js';
import { newVoidEntry } from './__helpers__/sale-void-fixture.js';

const TERMINAL = 'term-1';
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL };
const MONA = {
  userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a',
  pin: '246810',
  name: 'Mona Manager',
};
const OMAR = {
  userId: '0190f5a2-3b4c-7d8e-9f01-00000000000b',
  pin: '135790',
  name: 'Omar Manager',
};
const CASHIER_USER = '0190f5a2-3b4c-7d8e-9f01-0000000000cc';
const T0 = '2026-06-07T10:30:00.000Z';
const TENDERS_CASH_1500 = JSON.stringify([
  { tender_type: 'cash', amount_applied_minor: 2000, change_due_minor: 500 },
]);
const TENDERS_CARD = JSON.stringify([
  { tender_type: 'external_card_terminal', amount_applied_minor: 1500 },
]);

function session(
  role: OperatorSessionRecord['role'],
  id: string,
  managerUserId: string = MONA.userId,
): OperatorSessionRecord {
  return {
    id,
    operator_id: `op-${id}`,
    display_name: `Operator ${id}`,
    role,
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    started_at: T0,
    backend_session_id: `b-${id}`,
    last_activity_at: T0,
    lock_state: 'active',
    locked_at: null,
    ...(role === 'cashier' ? { user_id: CASHIER_USER } : { manager_user_id: managerUserId }),
  };
}

let raw: SqlJsDatabase;
let pins: ManagerPinStore;
let approvals: ManagerApprovalService;
let voids: SaleVoidService;
let journal: SaleVoidRepository;
let current: OperatorSessionRecord | null;
let envelope: string | null;
let locked: boolean;
let enabled: boolean;
let clock: string;
let audit: AuditEvent[];
let sellers: Record<string, string>;
let returnedSales: Set<string>;
let ids: number;
let failInsert: boolean;

beforeAll(async () => {
  await initGrantSql();
});

/** The journal as the service sees it; `failInsert` makes the write fail after the approval is spent. */
function failableJournal(repo: SaleVoidRepository): SaleVoidRepository {
  return new Proxy(repo, {
    get(target, prop) {
      if (prop === 'insertFrom' && failInsert) {
        return (build: () => NewVoidEntry) => {
          target.insertFrom(() => {
            build();
            throw new Error('disk full');
          });
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

async function enrolManagers(): Promise<void> {
  for (const m of [MONA, OMAR]) {
    await pins.enrol({
      scope: SCOPE,
      userId: m.userId,
      displayName: m.name,
      sealed: await pins.seal(m.pin),
      now: T0,
      onlineAt: T0,
      guard: () => undefined,
    });
  }
}

function resetState(): void {
  audit = [];
  clock = T0;
  locked = false;
  enabled = true;
  envelope = 'env';
  sellers = {};
  returnedSales = new Set();
  ids = 0;
  failInsert = false;
  current = session('manager', 'mona');
}

function composeVoidService(db: ReturnType<typeof handleFor>, emitter: AuditSink): SaleVoidService {
  return createSaleVoidService({
    isEnabled: () => enabled,
    getSession: () => (current === null ? null : toVoidSession(current, TERMINAL, envelope)),
    isSessionLocked: () => locked,
    sales: bindSalesRepository(db),
    repo: failableJournal(journal),
    hasLiveReturn: (saleId) => returnedSales.has(saleId),
    approvals,
    sellerUserIdOf: (sale) => sellers[sale.sale_id],
    saleRef: () => null,
    currentSender: () => (current === null ? null : toVoidSender(current, TERMINAL, envelope)),
    audit: createSaleVoidAudit({
      sink: emitter,
      now: () => clock,
      newEventId: () => `evt-${String((ids += 1))}`,
    }),
    now: () => clock,
    newVoidId: () => `void-${String((ids += 1))}`,
    newExternalId: () =>
      `pos-pulse-void:0190f5a2-7b3c-7d4e-8f90-${String((ids += 1)).padStart(12, '0')}`,
    localDayOf: (iso) => iso.slice(0, 10),
    captureCurrencyCode: 'EGP',
    isStopped: () => false,
  });
}

interface AuditSink {
  emit: (event: AuditEvent) => void;
}

beforeEach(async () => {
  raw = freshGrantDb();
  const db = handleFor(raw);
  resetState();
  const emitter: AuditSink = { emit: (e) => audit.push(e) };
  pins = createManagerPinStore({ db, safeStorage: aeadSafeStorage() });
  await enrolManagers();
  journal = createSaleVoidRepository(db);
  const ref: { service: SaleVoidService | null } = { service: null };
  approvals = createManagerApprovalService({
    db,
    getSession: () => current,
    isSessionLocked: () => locked,
    currentTerminalId: () => TERMINAL,
    managerPins: pins,
    resolvers: { 'sale.void': (input) => ref.service?.approvalSubject(input) ?? null },
    auditEmitter: emitter,
    now: () => clock,
  });
  voids = composeVoidService(db, emitter);
  ref.service = voids;
  seedSale(raw, { sale_id: 'sale-1', tender_lines_summary_json: TENDERS_CASH_1500 });
  seedSale(raw, { sale_id: 'sale-2', tender_lines_summary_json: TENDERS_CARD });
});

afterEach(() => {
  raw.close();
});

function managerRef(userId: string): string {
  const found = pins
    .list({ scope: SCOPE, now: T0 })
    .find((m) => m.displayName.includes(userId === MONA.userId ? 'Mona' : 'Omar'));
  return found?.managerRef ?? '';
}

async function grant(approver = OMAR, saleId = 'sale-1') {
  return approvals.request({
    action_kind: 'sale.void',
    subject_ref: saleId,
    reason_code: 'sale_void',
    approver_ref: managerRef(approver.userId),
    pin: approver.pin,
  });
}

async function approvedId(approver = OMAR, saleId = 'sale-1'): Promise<string> {
  const outcome = await grant(approver, saleId);
  if (outcome.kind !== 'approved') throw new Error(`not approved: ${outcome.reason}`);
  return outcome.approvalId;
}

function approvalConsumed(id: string): boolean {
  const res = raw.exec('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id])[0];
  return res?.values[0]?.[0] !== null;
}

function request(saleId: string, approvalId: string): Promise<SaleVoidRequestResponse> {
  return voids.request({ sale_id: saleId, approval_id: approvalId });
}

describe('four-eyes on the approval', () => {
  it('a different manager approves: the void is journaled with the approval evidence, audited', async () => {
    const id = await approvedId();
    const answer = await request('sale-1', id);
    expect(answer).toMatchObject({
      kind: 'requested',
      void: {
        sale_number: 'SN-sale-1',
        total_minor: 1500,
        state: 'pending',
        needs_attention: false,
      },
    });
    const row = journal.readByApproval(id);
    expect(row).toMatchObject({
      saleId: 'sale-1',
      approverUserId: OMAR.userId,
      requesterUserId: MONA.userId,
      requesterOperatorId: 'op-mona',
      policyVersion: 'rt114-2026-10-07',
      approvedAt: T0,
      businessDate: '2026-06-07',
      amountMinor: 1500,
      cashMinor: 1500,
      currencyCode: 'EGP',
      state: 'pending',
    });
    expect(row?.externalId).toMatch(/^pos-pulse-void:/);
    expect(approvalConsumed(id)).toBe(true);
    expect(audit.map((e) => e.action_category)).toEqual([
      'manager_approval.granted',
      'sale.void.requested',
    ]);
    expect(audit[1]).toMatchObject({
      approving_supervisor_id: OMAR.userId,
      acting_operator_id: 'op-mona',
      originating_terminal_id: TERMINAL,
      payload: { sale_id: 'sale-1', amount_minor: 1500, policy_version: 'rt114-2026-10-07' },
    });
  });

  it('the requester cannot approve their own void (approver == requester is refused)', async () => {
    await expect(grant(MONA)).resolves.toEqual({ kind: 'refused', reason: 'approval_unavailable' });
    expect(journal.listRecent(SCOPE, 10)).toEqual([]);
  });

  it("the sale's selling operator cannot approve it (approver == seller is refused)", async () => {
    sellers['sale-1'] = OMAR.userId;
    await expect(grant(OMAR)).resolves.toEqual({ kind: 'refused', reason: 'approval_unavailable' });
    // Another manager of the store may approve it.
    current = session('manager', 'omar', OMAR.userId);
    await expect(approvedId(MONA)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a cashier requester with an envelope may ask a manager to approve', async () => {
    current = session('cashier', 'rana');
    const id = await approvedId(OMAR);
    const answer = await request('sale-1', id);
    expect(answer.kind).toBe('requested');
    expect(journal.readByApproval(id)).toMatchObject({
      requesterUserId: CASHIER_USER,
      approverUserId: OMAR.userId,
    });
  });
});

describe('the approval is bound to this sale and spent once', () => {
  it('an approval for one sale cannot void another, and stays unspent', async () => {
    const id = await approvedId(OMAR, 'sale-1');
    await expect(request('sale-2', id)).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(journal.listRecent(SCOPE, 10)).toEqual([]);
    expect(approvalConsumed(id)).toBe(false);
    await expect(request('sale-1', id)).resolves.toMatchObject({ kind: 'requested' });
  });

  it('a retry of the same approval is the same void, not a second one', async () => {
    const id = await approvedId();
    const first = await request('sale-1', id);
    const again = await request('sale-1', id);
    expect(again).toEqual(first);
    expect(journal.listRecent(SCOPE, 10)).toHaveLength(1);
    expect(audit.filter((e) => e.action_category === 'sale.void.requested')).toHaveLength(1);
  });

  it('an approval requested by another operator is not usable', async () => {
    const id = await approvedId();
    current = session('manager', 'someone-else');
    await expect(request('sale-1', id)).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(approvalConsumed(id)).toBe(false);
  });

  it('a lapsed approval (120 s) is refused and nothing is journaled', async () => {
    const id = await approvedId();
    clock = '2026-06-07T10:33:00.000Z';
    await expect(request('sale-1', id)).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(journal.listRecent(SCOPE, 10)).toEqual([]);
  });

  it('rolls the approval back when the journal write fails, so the approval can be spent again', async () => {
    const id = await approvedId();
    failInsert = true;
    await expect(request('sale-1', id)).rejects.toThrow('disk full');
    expect(journal.listRecent(SCOPE, 10)).toEqual([]);
    expect(approvalConsumed(id)).toBe(false);
    expect(audit.map((e) => e.action_category)).toEqual(['manager_approval.granted']);
    failInsert = false;
    await expect(request('sale-1', id)).resolves.toMatchObject({ kind: 'requested' });
  });
});

describe('who and when', () => {
  it('only the same business day (the pinned test day) can be voided', async () => {
    const id = await approvedId();
    clock = '2026-06-08T00:10:00.000Z';
    await expect(request('sale-1', id)).resolves.toEqual({
      kind: 'refused',
      reason: 'not_same_day',
    });
    expect(journal.listRecent(SCOPE, 10)).toEqual([]);
    await expect(grant()).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });

  it('refuses a second live void on the sale, but a refused void frees it', async () => {
    const first = await request('sale-1', await approvedId());
    expect(first.kind).toBe('requested');
    await expect(grant()).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
    const row = journal.listRecent(SCOPE, 1)[0];
    journal.markRefused({ voidId: row?.voidId ?? '', reason: 'void_self_approval', now: clock });
    const second = await request('sale-1', await approvedId());
    expect(second.kind).toBe('requested');
  });

  it('refuses a sale that has a return', async () => {
    returnedSales.add('sale-1');
    await expect(grant()).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
    const sale = await voids.lookup({ sale_number: 'SN-sale-1' });
    expect(sale).toMatchObject({ kind: 'sale', sale: { ineligible: 'has_return' } });
  });

  it('refuses a cashier without an operator envelope before any approval is spent', async () => {
    current = session('cashier', 'rana');
    envelope = null;
    await expect(request('sale-1', '0190f5a2-7b3c-7d4e-8f90-0000000000aa')).resolves.toEqual({
      kind: 'refused',
      reason: 'no_operator_envelope',
    });
    expect(journal.listRecent(SCOPE, 10)).toEqual([]);
  });

  it('lets a manager request offline (no envelope yet): the void waits for the sign-in', async () => {
    envelope = null;
    const answer = await request('sale-1', await approvedId());
    expect(answer).toMatchObject({ kind: 'requested', void: { waiting_for: 'sale_sync' } });
  });

  it('refuses every call with the flag off, no session, or a locked session', async () => {
    enabled = false;
    await expect(voids.lookup({ sale_number: 'SN-sale-1' })).resolves.toEqual({
      kind: 'refused',
      reason: 'feature_disabled',
    });
    enabled = true;
    current = null;
    await expect(voids.list()).resolves.toEqual({ kind: 'refused', reason: 'no_session' });
    current = session('manager', 'mona');
    locked = true;
    await expect(request('sale-1', '0190f5a2-7b3c-7d4e-8f90-0000000000aa')).resolves.toEqual({
      kind: 'refused',
      reason: 'session_locked',
    });
  });
});

describe('lookup, list and acknowledge', () => {
  it('finds a sale of this terminal by its number, with its net cash and eligibility', async () => {
    await expect(voids.lookup({ sale_number: 'SN-sale-1' })).resolves.toMatchObject({
      kind: 'sale',
      sale: { sale_id: 'sale-1', total_minor: 1500, cash_minor: 1500, ineligible: null },
    });
    await expect(voids.lookup({ sale_number: 'SN-sale-2' })).resolves.toMatchObject({
      sale: { cash_minor: 0, ineligible: null },
    });
    await expect(voids.lookup({ sale_number: 'nope' })).resolves.toEqual({
      kind: 'refused',
      reason: 'sale_not_found',
    });
  });

  it("does not find another terminal's sale", async () => {
    seedSale(raw, { sale_id: 'sale-9', terminal_id: 'term-2' });
    await expect(voids.lookup({ sale_number: 'SN-sale-9' })).resolves.toEqual({
      kind: 'refused',
      reason: 'sale_not_found',
    });
  });

  it('marks a sale with a live void as already voided', async () => {
    await request('sale-1', await approvedId());
    await expect(voids.lookup({ sale_number: 'SN-sale-1' })).resolves.toMatchObject({
      sale: { ineligible: 'already_voided' },
    });
  });

  it('lists the voids with what each waits for, and refused ones until acknowledged', async () => {
    await request('sale-1', await approvedId());
    const first = await voids.list();
    expect(first).toMatchObject({
      kind: 'list',
      voids: [{ state: 'pending', waiting_for: 'sale_sync' }],
    });
    const row = journal.listRecent(SCOPE, 1)[0];
    journal.markRefused({
      voidId: row?.voidId ?? '',
      reason: 'void_outside_business_day',
      now: clock,
    });
    const listed = await voids.list();
    expect(listed).toMatchObject({
      voids: [
        {
          state: 'refused',
          refusal_reason: 'void_outside_business_day',
          needs_attention: true,
          waiting_for: null,
        },
      ],
    });
    await expect(voids.acknowledge({ void_id: row?.voidId ?? '' })).resolves.toEqual({
      kind: 'acknowledged',
    });
    await expect(voids.list()).resolves.toMatchObject({ voids: [{ needs_attention: false }] });
    await expect(voids.acknowledge({ void_id: row?.voidId ?? '' })).resolves.toEqual({
      kind: 'refused',
      reason: 'invalid_input',
    });
    await expect(voids.acknowledge({ void_id: 'nope' })).resolves.toEqual({
      kind: 'refused',
      reason: 'invalid_input',
    });
  });

  it('keeps an older unacknowledged refusal listed beyond the recent limit', async () => {
    await request('sale-1', await approvedId());
    const refused = journal.listRecent(SCOPE, 1)[0];
    if (refused === undefined) throw new Error('journaled void missing');
    journal.markRefused({ voidId: refused.voidId, reason: 'void_self_approval', now: clock });
    for (let n = 1; n <= SALE_VOID_LIST_LIMIT; n += 1) {
      seedSale(raw, { sale_id: `bulk-${String(n)}` });
      journal.insert(
        newVoidEntry(n, {
          voidId: `bulk-v${String(n)}`,
          saleId: `bulk-${String(n)}`,
          externalId: `pos-pulse-void:0190f5a2-7b3c-7d4e-8f91-${String(n).padStart(12, '0')}`,
          approvalId: `0190f5a2-7b3c-7d4e-8f90-${String(n + 500).padStart(12, '0')}`,
          now: `2026-06-07T11:${String(n % 60).padStart(2, '0')}:00.000Z`,
        }),
      );
    }
    const listed = await voids.list();
    if (listed.kind !== 'list') throw new Error(`expected a list, got ${listed.kind}`);
    expect(listed.voids.filter((v) => v.needs_attention).map((v) => v.void_id)).toEqual([
      refused.voidId,
    ]);
  });
});
