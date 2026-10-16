/**
 * RT-542 — fakes for the sale-history service: a session holder, a scripted
 * Backend-Core client, the local reads and a recording printer.
 */
import { vi, type Mock } from 'vitest';

import type { OperatorSessionForSales } from '../../../sales/sales-bridge.js';
import type {
  SaleListRow,
  SaleRow,
  SalesRepository,
} from '../../../sales/repositories/sales.repository.js';
import type {
  ListOutcome,
  ReadOutcome,
  ReprintOutcome,
  SaleHistoryClient,
} from '../../sale-history-client.js';
import type { SaleHistoryServiceDeps } from '../../sale-history-service.js';
import { createStoreZoneMonitor, type StoreZoneMonitor } from '../../store-zone-monitor.js';
import type { SaleHistoryLocalReads } from '../../sale-history-local.js';
import { readHistoryDetail, readHistoryPage, readReprintBody } from '../../sale-history-wire.js';
import { CASHIER_USER, wireDetail, wirePage, wireReprint } from './wire-fixtures.js';

export const MANAGER: OperatorSessionForSales = {
  role: 'manager',
  operator_id: 'op-manager',
  operator_session_id: 'sess-manager',
  tenant_id: 't1',
  branch_id: 'b1',
  terminal_id: 'term-1',
};

export const CASHIER: OperatorSessionForSales = {
  ...MANAGER,
  role: 'cashier',
  operator_id: 'op-cashier',
  operator_session_id: 'sess-cashier',
};

export const ENVELOPE_TOKEN = 'env-token';
export const DEVICE_TOKEN = 'device-token';
export const ADMISSION_ID = '0190a3c4-0000-4000-8000-00000000ad01';

export function okPage(overrides: Record<string, unknown> = {}): ListOutcome {
  const page = readHistoryPage(wirePage(overrides));
  if (page === null) throw new Error('fixture page is off-contract');
  return { kind: 'ok', page };
}

export function okDetail(
  overrides: Record<string, unknown> = {},
  summary: Record<string, unknown> = {},
): ReadOutcome {
  const detail = readHistoryDetail(wireDetail(overrides, summary));
  if (detail === null) throw new Error('fixture detail is off-contract');
  return { kind: 'ok', detail };
}

export function okReprint(overrides: Record<string, unknown> = {}): ReprintOutcome {
  const reprint = readReprintBody(wireReprint(overrides));
  if (reprint === null) throw new Error('fixture reprint is off-contract');
  return { kind: 'ok', reprint };
}

export function localRow(overrides: Partial<SaleListRow> = {}): SaleListRow {
  return {
    sale_id: 'sale-local-1',
    sale_number: 'T1-20261016-0009',
    finalized_at: '2026-10-16T08:30:00.000Z',
    terminal_label: 'Till 1',
    selling_operator_display_name: 'Mona',
    subtotal_minor: 1000,
    total_tax_minor: 0,
    ...overrides,
  };
}

export function localSaleRow(overrides: Partial<SaleRow> = {}): SaleRow {
  return {
    sale_id: 'sale-local-1',
    sale_number: 'T1-20261016-0001',
    receipt_number: 'T1-20261016-0001',
    envelope_handoff_action_id: 'h1',
    payment_attempt_id: 'pa1',
    envelope_cart_id: 'c1',
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term-1',
    terminal_label: 'Till 1 (local)',
    selling_operator_id: 'op-cashier',
    selling_operator_display_name: 'Mona',
    selling_operator_session_id: 'sess-cashier',
    subtotal_minor: 2550,
    total_tax_minor: 0,
    total_change_due_minor: 450,
    tender_lines_summary_json: JSON.stringify([
      { tender_type: 'cash', amount_applied_minor: 2550, change_due_minor: 450 },
    ]),
    settled_at: '2026-10-16T07:59:58.000Z',
    finalized_at: '2026-10-16T08:00:00.000Z',
    tenant_tax_registration_id: '123-456-789',
    branch_name: 'Local Branch Name',
    branch_address: 'Local address',
    local_calendar_day: '2026-10-16',
    lines_json: JSON.stringify([
      {
        item_ref: 'p1',
        display_name: 'Panadol 500mg',
        quantity: 2,
        unit_price_minor: 1275,
        line_subtotal_minor: 2550,
        note: null,
      },
    ]),
    ...overrides,
  };
}

export interface Harness {
  deps: SaleHistoryServiceDeps;
  session: { current: OperatorSessionForSales | null; locked: boolean };
  client: {
    list: Mock<SaleHistoryClient['list']>;
    read: Mock<SaleHistoryClient['read']>;
    authorizeReprint: Mock<SaleHistoryClient['authorizeReprint']>;
  };
  audit: Mock;
  printed: string[];
  printResult: { ok: boolean };
  unsynced: Mock<SaleHistoryLocalReads['unsynced']>;
  localIds: Map<string, string>;
  localSales: Map<string, SaleRow>;
  successfulPrints: Set<string>;
  localVoided: Set<string>;
  localList: Mock<SalesRepository['listByFinalizedRange']>;
  credential: { value: 'auto' | null };
  /** RT-553: the real monitor the service feeds, and its warning log. */
  zone: StoreZoneMonitor;
  zoneWarn: Mock;
}

/** The role's credential, or none while `credential.value` is null. */
function fakeCredentials(credential: {
  value: 'auto' | null;
}): SaleHistoryServiceDeps['resolveCredential'] {
  return (s) => {
    if (credential.value === null) return Promise.resolve(null);
    return Promise.resolve(
      s.role === 'cashier'
        ? {
            credential: { kind: 'device', token: DEVICE_TOKEN, admissionId: ADMISSION_ID },
            cashierUserId: CASHIER_USER,
          }
        : { credential: { kind: 'envelope', token: ENVELOPE_TOKEN }, cashierUserId: null },
    );
  };
}

/** Records each printed slip's HTML; fails while `result.ok` is false. */
function fakePrinter(
  printed: string[],
  result: { ok: boolean },
): SaleHistoryServiceDeps['printer'] {
  return {
    printRendered: (rendered) => {
      printed.push(rendered.html);
      return Promise.resolve(
        result.ok
          ? { ok: true, render_path: 'os_print' }
          : { ok: false, render_path: 'os_print', failure_reason: 'printer_offline' },
      );
    },
  };
}

export function harness(session: OperatorSessionForSales | null = MANAGER): Harness {
  const state = { current: session, locked: false };
  const credential: { value: 'auto' | null } = { value: 'auto' };
  const printed: string[] = [];
  const printResult = { ok: true };
  const localIds = new Map<string, string>();
  const localSales = new Map<string, SaleRow>();
  const successfulPrints = new Set<string>();
  const localVoided = new Set<string>();
  const client = {
    list: vi.fn<SaleHistoryClient['list']>(() => Promise.resolve(okPage())),
    read: vi.fn<SaleHistoryClient['read']>(() => Promise.resolve(okDetail())),
    authorizeReprint: vi.fn<SaleHistoryClient['authorizeReprint']>(() =>
      Promise.resolve(okReprint()),
    ),
  };
  const unsynced = vi.fn<SaleHistoryLocalReads['unsynced']>(() => []);
  const localList = vi.fn<SalesRepository['listByFinalizedRange']>(() => [localRow()]);
  const audit: Mock = vi.fn();
  const zoneWarn: Mock = vi.fn();
  const zone = createStoreZoneMonitor({ logger: { warn: zoneWarn } });
  const deps: SaleHistoryServiceDeps = {
    getCurrentSession: () => state.current,
    isSessionLocked: () => state.locked,
    auditEmitter: { emitRaw: audit },
    resolveCredential: fakeCredentials(credential),
    client,
    local: {
      unsynced,
      localSaleIds: (_scope, refs) =>
        new Map(refs.flatMap((r) => (localIds.has(r) ? [[r, localIds.get(r) ?? '']] : []))),
    },
    salesRepo: {
      listByFinalizedRange: localList,
      readById: (id: string) => localSales.get(id) ?? null,
    },
    printEventsRepo: { hasSuccessfulPrint: (id: string) => successfulPrints.has(id) },
    isSaleVoided: (id: string) => localVoided.has(id),
    printer: fakePrinter(printed, printResult),
    now: () => '2026-10-16T11:00:00.000Z',
    newIdempotencyKey: () => 'pos-pulse-reprint:0190a3c4-0000-4000-8000-000000000001',
    storeZone: zone,
  };
  return {
    deps,
    session: state,
    client,
    audit,
    printed,
    printResult,
    unsynced,
    localIds,
    localSales,
    successfulPrints,
    localVoided,
    localList,
    credential,
    zone,
    zoneWarn,
  };
}
