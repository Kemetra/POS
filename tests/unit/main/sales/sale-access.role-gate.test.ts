/**
 * RT-546 (RT-534 F3) — main-process role gate on every `sales.*` and
 * `receipts.*` handler (OD-534-1 / OD-534-2).
 *
 *   • A cashier reads, previews, reprints and recovers ONLY their own sales; a
 *     request for another operator's sale refuses as `sale_not_found`
 *     (non-disclosing) and writes a `sale.access.refused` audit event.
 *   • A manager or admin reaches every sale in the terminal scope.
 *   • A role outside the allowlist refuses as `role_denied` and is audited.
 *   • No session, or a locked session, refuses as `no_session`, unaudited.
 *   • `sales.subscribe` limits a cashier's `recent` / `banner_state` snapshot to
 *     their own sales.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  createSalesBridge,
  type OperatorSessionForSales,
} from '../../../../src/main/sales/sales-bridge.js';
import { createReceiptsBridge } from '../../../../src/main/receipts/receipts-bridge.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindPrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import { bindDrawerEventsRepository } from '../../../../src/main/sales/repositories/drawer-events.repository.js';
import { bindBannerStateProjector } from '../../../../src/main/sales/banner-state-projector.js';
import type { SaleRawAuditEvent } from '../../../../src/main/sales/audit-emitter.js';
import type { PrintDispatcher } from '../../../../src/main/receipts/print-dispatcher.js';
import type { SaleId, SaleNumber } from '../../../../src/shared/sales/types.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

// Vitest runs from the repository root.
const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const MIGRATIONS = [
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
  '0023_create_drawer_events.sql',
  '0028_extend_sales_with_lines_json.sql',
].map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const SCOPE = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };

function session(role: string, operatorId: string): OperatorSessionForSales {
  return {
    ...SCOPE,
    role: role as OperatorSessionForSales['role'],
    operator_id: operatorId,
    operator_session_id: `sess-${operatorId}`,
  };
}

const CASHIER_A = session('cashier', 'op-cashier-a');
const MANAGER = session('manager', 'op-manager');
const ADMIN = session('admin', 'op-admin');
const UNKNOWN_ROLE = session('auditor', 'op-auditor');

const OWN = { id: 'sale-own', number: 'TERM-01-2026-10-16-000001', seller: 'op-cashier-a' };
const OTHER = { id: 'sale-other', number: 'TERM-01-2026-10-16-000002', seller: 'op-cashier-b' };

let db: SqlJsDatabase;

function seedSale(sale: typeof OWN, finalizedAt: string): void {
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (?, ?, ?, ?, ?, ?, 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
       ?, 'Seller', 'sess-seller',
       5500, 0, 0, '[{"tender_type":"cash","amount_applied_minor":5500,"change_due_minor":0}]',
       ?, ?, 'TRN-100', 'Maadi Branch', '12 Road 9', '2026-10-16',
       '[{"line_id":"l1","item_ref":"SKU-001","display_name":"Paracetamol","quantity":1,"unit_price_minor":5500,"line_subtotal_minor":5500,"note":null,"version":1,"last_action_id":"a1"}]')`,
    [
      sale.id,
      sale.number,
      sale.number,
      `handoff-${sale.id}`,
      `pa-${sale.id}`,
      `cart-${sale.id}`,
      sale.seller,
      finalizedAt,
      finalizedAt,
    ],
  );
}

function seedPrint(saleId: string, outcome: 'success' | 'failure', at: string): void {
  db.run(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES (?, ?, ?, 'first_print', 'escpos_direct', 'op-seller', 'sess-seller', NULL, ?, NULL, ?)`,
    [
      `pe-${saleId}-${outcome}`,
      saleId,
      outcome,
      outcome === 'failure' ? 'printer_offline' : null,
      at,
    ],
  );
}

beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
  // OTHER is the terminal's most recent sale.
  seedSale(OWN, '2026-10-16T09:00:00.000Z');
  seedSale(OTHER, '2026-10-16T10:00:00.000Z');
});

interface Harness {
  locked: boolean;
  audits: SaleRawAuditEvent[];
  dispatcher: {
    dispatchReprint: ReturnType<typeof vi.fn>;
    dispatchRetryPrint: ReturnType<typeof vi.fn>;
  };
}

function harness(): Harness {
  return {
    locked: false,
    audits: [],
    dispatcher: {
      dispatchReprint: vi.fn(() =>
        Promise.resolve({
          result: { ok: true, render_path: 'escpos_direct' },
          print_event_id: 'pe-reprint',
          printed_at: '2026-10-16T11:00:00.000Z',
        }),
      ),
      dispatchRetryPrint: vi.fn(() =>
        Promise.resolve({
          result: { ok: true, render_path: 'escpos_direct' },
          print_event_id: 'pe-retry',
          printed_at: '2026-10-16T11:00:00.000Z',
        }),
      ),
    },
  };
}

function bridges(h: Harness, current: OperatorSessionForSales | null) {
  const handle = makeSqlJsHandle(db);
  const common = {
    getCurrentSession: () => current,
    isSessionLocked: () => h.locked,
    auditEmitter: { emitRaw: (e: SaleRawAuditEvent) => void h.audits.push(e) },
  };
  const sales = createSalesBridge({
    ...common,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    drawerEventsRepo: bindDrawerEventsRepository(handle),
    bannerStateProjector: bindBannerStateProjector(handle),
    newSubscriptionToken: () => 'tok',
  });
  const receipts = createReceiptsBridge({
    ...common,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    printDispatcher: h.dispatcher as unknown as Pick<
      PrintDispatcher,
      'dispatchRetryPrint' | 'dispatchReprint'
    >,
    now: () => '2026-10-16T11:00:00.000Z',
    newPrintEventId: () => 'pe-override',
  });
  return { sales, receipts };
}

const sid = (id: string): SaleId => id as SaleId;
const snum = (n: string): SaleNumber => n as SaleNumber;

function expectRefusal(result: { kind: string; reason?: string }, reason: string): void {
  expect(result).toMatchObject({ kind: 'refused', reason });
}

function expectNotOwnerAudit(h: Harness, action: string, saleId: string): void {
  expect(h.audits).toHaveLength(1);
  expect(h.audits[0]).toMatchObject({
    action_category: 'sale.access.refused',
    attribution_operator_id: CASHIER_A.operator_id,
    session_id: CASHIER_A.operator_session_id,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    originating_terminal_id: 'terminal-1',
    payload: { action, reason: 'not_owner', sale_id: saleId },
  });
}

// ── OD-534-1: sales.read / sales.findByNumber ───────────────────────────────

describe('RT-546 — sales.read', () => {
  it('a cashier reads their own sale', async () => {
    const h = harness();
    const res = await bridges(h, CASHIER_A).sales.read({ sale_id: sid(OWN.id) });
    expect(res).toMatchObject({ kind: 'ok', sale: { sale_id: OWN.id } });
    expect(h.audits).toEqual([]);
  });

  it("a cashier is refused another operator's sale, non-disclosing, and it is audited", async () => {
    const h = harness();
    const res = await bridges(h, CASHIER_A).sales.read({ sale_id: sid(OTHER.id) });
    expectRefusal(res, 'sale_not_found');
    expectNotOwnerAudit(h, 'sales.read', OTHER.id);
  });

  it.each([
    ['manager', MANAGER],
    ['admin', ADMIN],
  ])('a %s reads any sale in scope', async (_label, who) => {
    const h = harness();
    const res = await bridges(h, who).sales.read({ sale_id: sid(OTHER.id) });
    expect(res).toMatchObject({ kind: 'ok', sale: { sale_id: OTHER.id } });
    expect(h.audits).toEqual([]);
  });
});

describe('RT-546 — sales.findByNumber', () => {
  it('a cashier finds their own sale by number', async () => {
    const h = harness();
    const res = await bridges(h, CASHIER_A).sales.findByNumber({ sale_number: snum(OWN.number) });
    expect(res).toMatchObject({ kind: 'ok', sale: { sale_id: OWN.id } });
  });

  it("a cashier probing another operator's number gets sale_not_found, audited", async () => {
    const h = harness();
    const res = await bridges(h, CASHIER_A).sales.findByNumber({
      sale_number: snum(OTHER.number),
    });
    expectRefusal(res, 'sale_not_found');
    expectNotOwnerAudit(h, 'sales.findByNumber', OTHER.id);
  });

  it.each([
    ['manager', MANAGER],
    ['admin', ADMIN],
  ])('a %s finds any sale in scope', async (_label, who) => {
    const h = harness();
    const res = await bridges(h, who).sales.findByNumber({ sale_number: snum(OTHER.number) });
    expect(res).toMatchObject({ kind: 'ok', sale: { sale_id: OTHER.id } });
  });
});

// ── sales.subscribe: the cashier's snapshot is their own ────────────────────

describe('RT-546 — sales.subscribe', () => {
  it("topic=recent gives a cashier their own latest sale, not the terminal's", async () => {
    const res = await bridges(harness(), CASHIER_A).sales.subscribe({ topic: 'recent' });
    expect(res).toMatchObject({ kind: 'ok', recent: { sale_id: OWN.id } });
  });

  it("topic=recent gives a manager the terminal's latest sale", async () => {
    const res = await bridges(harness(), MANAGER).sales.subscribe({ topic: 'recent' });
    expect(res).toMatchObject({ kind: 'ok', recent: { sale_id: OTHER.id } });
  });

  it("topic=banner_state hides another operator's print failure from a cashier", async () => {
    seedPrint(OTHER.id, 'failure', '2026-10-16T10:00:01.000Z');
    const cashier = await bridges(harness(), CASHIER_A).sales.subscribe({ topic: 'banner_state' });
    expect(cashier).toMatchObject({ kind: 'ok', banner_state: { printer_failure: null } });

    const manager = await bridges(harness(), MANAGER).sales.subscribe({ topic: 'banner_state' });
    expect(manager).toMatchObject({
      kind: 'ok',
      banner_state: { printer_failure: { sale_id: OTHER.id } },
    });
  });

  it('topic=banner_state shows a cashier their own print failure', async () => {
    seedPrint(OWN.id, 'failure', '2026-10-16T09:00:01.000Z');
    const res = await bridges(harness(), CASHIER_A).sales.subscribe({ topic: 'banner_state' });
    expect(res).toMatchObject({
      kind: 'ok',
      banner_state: { printer_failure: { sale_id: OWN.id } },
    });
  });
});

// ── OD-534-2: receipts.* ────────────────────────────────────────────────────

interface ReceiptCase {
  action: string;
  /** Print history the handler needs before it acts on `saleId`. */
  seed: (saleId: string) => void;
  call: (b: ReturnType<typeof bridges>, saleId: string) => Promise<{ kind: string }>;
  /** How many side effects (prints / override rows) the call caused. */
  effects: (h: Harness) => number;
  /** Side effects one admitted call causes (preview renders only). */
  expectedEffects: number;
}

const noSeed = (): void => undefined;
const overrideRows = (): number =>
  db.exec(`SELECT 1 FROM print_events WHERE outcome = 'manual_override'`)[0]?.values.length ?? 0;

const RECEIPT_CASES: ReadonlyArray<[string, ReceiptCase]> = [
  [
    'receipts.preview',
    {
      action: 'receipts.preview',
      seed: noSeed,
      call: (b, id) => b.receipts.preview({ sale_id: sid(id), idempotency_key: 'k' }),
      effects: () => 0,
      expectedEffects: 0,
    },
  ],
  [
    'receipts.reprint',
    {
      action: 'receipts.reprint',
      seed: (id) => {
        seedPrint(id, 'success', '2026-10-16T10:30:00.000Z');
      },
      call: (b, id) => b.receipts.reprint({ sale_id: sid(id), idempotency_key: 'k' }),
      effects: (h) => h.dispatcher.dispatchReprint.mock.calls.length,
      expectedEffects: 1,
    },
  ],
  [
    'receipts.retryPrint',
    {
      action: 'receipts.retryPrint',
      seed: (id) => {
        seedPrint(id, 'failure', '2026-10-16T10:30:00.000Z');
      },
      call: (b, id) => b.receipts.retryPrint({ sale_id: sid(id), idempotency_key: 'k' }),
      effects: (h) => h.dispatcher.dispatchRetryPrint.mock.calls.length,
      expectedEffects: 1,
    },
  ],
  [
    'receipts.manualOverride',
    {
      action: 'receipts.manualOverride',
      seed: (id) => {
        seedPrint(id, 'failure', '2026-10-16T10:30:00.000Z');
      },
      call: (b, id) => b.receipts.manualOverride({ sale_id: sid(id), idempotency_key: 'k' }),
      effects: overrideRows,
      expectedEffects: 1,
    },
  ],
];

const SCOPE_ROLES: ReadonlyArray<[string, OperatorSessionForSales]> = [
  ['manager', MANAGER],
  ['admin', ADMIN],
];

describe('RT-546 — receipts.* (OD-534-2)', () => {
  it.each(RECEIPT_CASES)('%s: a cashier acts on their own sale', async (_n, c) => {
    c.seed(OWN.id);
    const h = harness();
    const res = await c.call(bridges(h, CASHIER_A), OWN.id);
    expect(res.kind).toBe('ok');
    expect(c.effects(h)).toBe(c.expectedEffects);
    expect(h.audits.filter((e) => e.action_category === 'sale.access.refused')).toEqual([]);
  });

  it.each(RECEIPT_CASES)(
    "%s: a cashier is refused another operator's sale; nothing happens; audited",
    async (_n, c) => {
      c.seed(OTHER.id);
      const h = harness();
      const res = await c.call(bridges(h, CASHIER_A), OTHER.id);
      expectRefusal(res, 'sale_not_found');
      expect(c.effects(h)).toBe(0);
      expectNotOwnerAudit(h, c.action, OTHER.id);
    },
  );

  describe.each(SCOPE_ROLES)('a %s', (_role, who) => {
    it.each(RECEIPT_CASES)('%s: acts on any sale in scope', async (_n, c) => {
      c.seed(OTHER.id);
      const h = harness();
      const res = await c.call(bridges(h, who), OTHER.id);
      expect(res.kind).toBe('ok');
      expect(c.effects(h)).toBe(c.expectedEffects);
    });
  });
});

// ── Session and role gate, every handler ────────────────────────────────────

type Call = (b: ReturnType<typeof bridges>) => Promise<{ kind: string; reason?: string }>;

const EVERY_HANDLER: ReadonlyArray<[string, Call]> = [
  ['sales.read', (b) => b.sales.read({ sale_id: sid(OWN.id) })],
  ['sales.findByNumber', (b) => b.sales.findByNumber({ sale_number: snum(OWN.number) })],
  ['sales.subscribe', (b) => b.sales.subscribe({ topic: 'recent' })],
  ['receipts.preview', (b) => b.receipts.preview({ sale_id: sid(OWN.id), idempotency_key: 'k' })],
  [
    'receipts.retryPrint',
    (b) => b.receipts.retryPrint({ sale_id: sid(OWN.id), idempotency_key: 'k' }),
  ],
  ['receipts.reprint', (b) => b.receipts.reprint({ sale_id: sid(OWN.id), idempotency_key: 'k' })],
  [
    'receipts.manualOverride',
    (b) => b.receipts.manualOverride({ sale_id: sid(OWN.id), idempotency_key: 'k' }),
  ],
];

describe('RT-546 — every sales/receipts handler gates the session and role', () => {
  it.each(EVERY_HANDLER)(
    '%s refuses a role outside the allowlist as role_denied, audited',
    async (action, call) => {
      const h = harness();
      const res = await call(bridges(h, UNKNOWN_ROLE));
      expectRefusal(res, 'role_denied');
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]).toMatchObject({
        action_category: 'sale.access.refused',
        attribution_operator_id: UNKNOWN_ROLE.operator_id,
        payload: { action, reason: 'role_denied' },
      });
      expect(h.dispatcher.dispatchReprint).not.toHaveBeenCalled();
      expect(h.dispatcher.dispatchRetryPrint).not.toHaveBeenCalled();
    },
  );

  it.each(EVERY_HANDLER)(
    '%s refuses with no session as no_session, unaudited',
    async (_a, call) => {
      const h = harness();
      expectRefusal(await call(bridges(h, null)), 'no_session');
      expect(h.audits).toEqual([]);
    },
  );

  it.each(EVERY_HANDLER)(
    '%s refuses a locked session as no_session, unaudited',
    async (_a, call) => {
      const h = harness();
      h.locked = true;
      expectRefusal(await call(bridges(h, MANAGER)), 'no_session');
      expect(h.audits).toEqual([]);
      expect(h.dispatcher.dispatchReprint).not.toHaveBeenCalled();
    },
  );

  it('an audit sink fault does not turn a refusal into a rejection', async () => {
    const handle = makeSqlJsHandle(db);
    const sales = createSalesBridge({
      getCurrentSession: () => CASHIER_A,
      auditEmitter: {
        emitRaw: () => {
          throw new Error('sink down');
        },
      },
      salesRepo: bindSalesRepository(handle),
      printEventsRepo: bindPrintEventsRepository(handle),
      drawerEventsRepo: bindDrawerEventsRepository(handle),
    });
    expectRefusal(await sales.read({ sale_id: sid(OTHER.id) }), 'sale_not_found');
  });
});
