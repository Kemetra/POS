/**
 * RT-15 S2 — shared fixture for the return-domain tests.
 *
 *   • a sql.js database with EVERY migration (incl. 0039) via the sale-sync fixture;
 *   • a synced local sale with a stored server `saleRef` (S1);
 *   • contract-typed `Sale` / `SaleReturn` / `Error` bodies (the vendored pin);
 *   • `FakeBackend` — an in-memory Backend-Core POS sales surface that honours
 *     the Idempotency-Key the way the contract describes (a same-key retry
 *     replays the stored 201 with `Idempotent-Replayed: true`) and records every
 *     request it sees;
 *   • `returnsHarness` — the composed return domain over all of the above.
 */
import type { Database as SqlJsDatabase } from 'sql.js';

import type { AuditEvent } from '../../../../shared/audit/event-shape.js';
import { AuditEmitter } from '../../../audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../../audit/audit-events-store.js';
import type { DatabaseHandle } from '../../../db/client.js';
import type { ReturnsAuditSink } from '../../returns-audit.js';
import { composeReturns, type ComposedReturns } from '../../compose-returns.js';
import type { ReturnsSession } from '../../returns-service.js';
import { createReturnsRepository, type ReturnsRepository } from '../../returns-repository.js';
import type { Role } from '../../../../shared/operator/role.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type {
  ContractError,
  ContractSale,
  ContractSaleLine,
  ContractSaleReturn,
} from '../__contract__/sales-returns.contract.js';

export { initSalesSyncSql as initReturnsSql };

export const BASE_URL = 'https://backend.example.invalid';
export const ENVELOPE = 'opaque-operator-envelope';
export const SALE_ID = 'sale-1';
export const SALE_NUMBER = `SN-${SALE_ID}`;
export const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
export const LINE_A = '0190f5a2-7b3c-7d4e-8f90-00000000000a';
export const LINE_B = '0190f5a2-7b3c-7d4e-8f90-00000000000b';
export const RETURN_REF = '0190f5a2-7b3c-7d4e-8f90-0000000000ff';
export const NOW = '2026-10-04T10:00:00.000Z';

export const CASH_SUMMARY = JSON.stringify([{ tender_type: 'cash', amount_applied_minor: 6500 }]);
export const CARD_SUMMARY = JSON.stringify([
  { tender_type: 'external_card_terminal', amount_applied_minor: 6500 },
]);

export const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };

export function sessionFor(role: Role): ReturnsSession {
  return {
    role,
    operator_id: `op-${role}`,
    operator_session_id: `sess-${role}`,
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    terminal_id: SCOPE.terminalId,
  };
}

/** A contract `SaleLine` as Backend-Core renders it (numeric(19,4) / (19,6) text). */
export function saleLine(overrides: Partial<ContractSaleLine> = {}): ContractSaleLine {
  return {
    lineRef: LINE_A,
    lineName: 'Panadol 500mg',
    unitPrice: '15.0000',
    currencyCode: 'EGP',
    quantity: '3',
    lineAmount: '45.0000',
    taxAmount: null,
    unit: 'unit',
    tenantProductRef: null,
    returnedQuantity: '0',
    returnableQuantity: '3.000000',
    ...overrides,
  };
}

/** A full contract `Sale` with two lines (3 × 15.00 and 1 × 20.00). */
export function saleBody(overrides: Partial<ContractSale> = {}): ContractSale {
  return {
    saleRef: SALE_REF,
    storeId: '0190f5a2-0000-7000-8000-000000000001',
    currencyCode: 'EGP',
    posTotal: '65.0000',
    occurredAt: '2026-10-04T09:00:00.000Z',
    receivedAt: '2026-10-04T09:00:01.000Z',
    businessDate: '2026-10-04',
    processedAt: null,
    sourceClockAt: null,
    sourceSystem: 'pos-pulse',
    externalId: 'pos-pulse:handoff-sale-1',
    mismatchFlag: false,
    syncStatus: 'synced',
    voided: false,
    tenders: [{ method: 'cash', amount: '65.0000' }],
    lines: [
      saleLine(),
      saleLine({
        lineRef: LINE_B,
        lineName: 'Vitamin C',
        unitPrice: '20.0000',
        quantity: '1',
        lineAmount: '20.0000',
        returnableQuantity: '1.000000',
      }),
    ],
    ...overrides,
  };
}

interface SentReturnBody {
  externalId: string;
  lines: { lineRef: string; quantity: string }[];
  refundTenders: { method: 'cash'; amount: string }[];
}

/** The contract `SaleReturn` Backend-Core would answer for a request body. */
export function saleReturnFor(body: SentReturnBody, returnRef = RETURN_REF): ContractSaleReturn {
  const total = body.refundTenders[0]?.amount ?? '0.00';
  return {
    returnRef,
    saleRef: SALE_REF,
    recordedAt: '2026-10-04T10:00:02.000Z',
    businessDate: '2026-10-04',
    sourceSystem: 'pos-pulse',
    externalId: body.externalId,
    currencyCode: 'EGP',
    returnTotal: `${total}00`,
    lines: body.lines.map((l) => ({
      lineRef: l.lineRef,
      quantity: `${l.quantity}.000000`,
      lineAmount: total,
      taxAmount: null,
      returnedQuantity: `${l.quantity}.000000`,
      returnableQuantity: '0.000000',
    })),
    refundTenders: body.refundTenders,
    reason: null,
  };
}

export function errorBody(code: string): ContractError {
  return {
    error: { code, message: 'refused', request_id: '0190f5a2-0000-7000-8000-0000000000ee' },
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export type ReturnResponder = (
  call: RecordedCall,
  backend: FakeBackend,
) => Response | Promise<Response>;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** A copy of `value` without `keys` (to build contract bodies missing optional fields). */
export function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k as K))) as Omit<
    T,
    K
  >;
}

/** In-memory Backend-Core POS sales surface. */
export class FakeBackend {
  readonly calls: RecordedCall[] = [];
  /** The `readSale` answer (a body → 200, a Response → as given). */
  sale: ContractSale | Response = saleBody();
  /** How `recordReturn` answers; defaults to the idempotent recorder below. */
  onReturn: ReturnResponder = (call, backend) => backend.recordIdempotently(call);
  /** Returns recorded so far, by Idempotency-Key. */
  readonly recorded = new Map<string, ContractSaleReturn>();

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url: urlOf(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    this.calls.push(call);
    if (call.method === 'GET')
      return this.sale instanceof Response ? this.sale : jsonResponse(200, this.sale);
    return await this.onReturn(call, this);
  };

  /** 201 the first time a key is seen; a same-key retry replays it (RT-82 K4). */
  recordIdempotently(call: RecordedCall): Response {
    const key = call.headers['Idempotency-Key'] ?? '';
    const existing = this.recorded.get(key);
    if (existing !== undefined) {
      return jsonResponse(201, existing, { 'Idempotent-Replayed': 'true' });
    }
    const created = saleReturnFor(JSON.parse(call.body ?? '{}') as SentReturnBody);
    this.recorded.set(key, created);
    return jsonResponse(201, created);
  }

  returnCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'POST');
  }
}

export interface SeedSyncedSaleInput {
  readonly saleId?: string;
  /** null = synced without a stored saleRef (pre-S1); undefined = SALE_REF. */
  readonly saleRef?: string | null;
  readonly syncStatus?: 'synced' | 'pending';
  readonly tenderSummary?: string;
}

/** A finalized local sale plus its sale_sync_state row. */
export function seedSyncedSale(db: SqlJsDatabase, input: SeedSyncedSaleInput = {}): void {
  const saleId = input.saleId ?? SALE_ID;
  seedSale(db, {
    sale_id: saleId,
    terminal_id: SCOPE.terminalId,
    tender_lines_summary_json: input.tenderSummary ?? CASH_SUMMARY,
  });
  db.run(
    `INSERT INTO sale_sync_state (sale_id, tenant_id, branch_id, sync_status, attempt_count,
       synced_at, created_at, updated_at, server_sale_ref)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      saleId,
      SCOPE.tenantId,
      SCOPE.branchId,
      input.syncStatus ?? 'synced',
      NOW,
      NOW,
      NOW,
      input.saleRef === undefined ? SALE_REF : input.saleRef,
    ],
  );
}

export interface HarnessOptions {
  readonly enabled?: boolean;
  readonly role?: Role | null;
  readonly token?: string | null;
  readonly timeoutMs?: number;
}

export interface HarnessState {
  enabled: boolean;
  role: Role | null;
  token: string | null;
  /** The terminal is paired (the live pairing read; unpaired → no session scope). */
  paired: boolean;
  /** The operator session is inactivity-locked. */
  locked: boolean;
  /** When it returns true for an event, that audit insert throws (fault injection). */
  failAudit: ((event: AuditEvent) => boolean) | null;
}

export interface ReturnsHarness extends ComposedReturns {
  readonly db: SqlJsDatabase;
  readonly handle: DatabaseHandle;
  readonly repo: ReturnsRepository;
  readonly backend: FakeBackend;
  /** The production audit path: 004's validating emitter into `audit_events`. */
  readonly auditSink: ReturnsAuditSink;
  /** The audit rows actually committed to `audit_events`, in insert order. */
  readonly audits: AuditEvent[];
  readonly warnings: string[];
  /** Mutable session / flag / token / fault, read per call like production. */
  readonly state: HarnessState;
  close(): void;
}

/** Every committed `audit_events` row, in insert order, payload parsed. */
export function committedAudits(db: SqlJsDatabase): AuditEvent[] {
  const res = db.exec('SELECT * FROM audit_events ORDER BY rowid')[0];
  if (res === undefined) return [];
  return res.values.map((row) => {
    const rec = Object.fromEntries(res.columns.map((c, i) => [c, row[i]]));
    return {
      ...rec,
      payload: JSON.parse(String(rec['payload'])) as Record<string, unknown>,
    } as AuditEvent;
  });
}

/** The composed return domain over a fresh DB and a FakeBackend. */
export function returnsHarness(options: HarnessOptions = {}): ReturnsHarness {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);
  const backend = new FakeBackend();
  const warnings: string[] = [];
  const state: HarnessState = {
    enabled: options.enabled ?? true,
    role: options.role === undefined ? 'manager' : options.role,
    token: options.token === undefined ? ENVELOPE : options.token,
    paired: true,
    locked: false,
    failAudit: null,
  };
  const emitter = new AuditEmitter(bindAuditEventsStoreDb(handle));
  const auditSink: ReturnsAuditSink = {
    emit: (event) => {
      if (state.failAudit?.(event) === true) throw new Error('audit insert failed');
      emitter.emit(event);
    },
  };
  const composed = composeReturns({
    db: handle,
    http: { baseUrl: BASE_URL, fetch: backend.fetch, getOperatorToken: () => state.token },
    isEnabled: () => state.enabled,
    getSession: () => (state.role === null || !state.paired ? null : sessionFor(state.role)),
    isSessionLocked: () => state.locked,
    auditSink,
    logger: { warn: (_obj, msg) => warnings.push(msg), error: (_obj, msg) => warnings.push(msg) },
    now: () => NOW,
  });
  return {
    ...composed,
    db,
    handle,
    repo: createReturnsRepository(handle),
    backend,
    auditSink,
    get audits() {
      return committedAudits(db);
    },
    warnings,
    state,
    close: () => {
      db.close();
    },
  };
}

/** The audit categories written so far, in order. */
export function categories(audits: readonly AuditEvent[]): string[] {
  return audits.map((a) => a.action_category);
}
