/**
 * RT-530 — composition of the sale-void domain (used by `src/main/index.ts`).
 *
 * Builds journal repository, audit, client, send engine and service from
 * primitive dependencies, and schedules the background send. Kept out of
 * `index.ts` so the wiring is unit-tested.
 *
 * The send engine's only credential is the signed-in operator's own envelope
 * (`getOperatorEnvelope`, the token reader sale sync also uses), and a void is
 * sent only while its REQUESTER is that operator: there is no device bearer in
 * this composition at all.
 */
import { randomUUID } from 'node:crypto';

import type { DatabaseHandle } from '../db/client.js';
import type { ManagerApprovalService } from '../operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../operator/session-manager.js';
import { resolveSessionScope } from '../operator/resolve-session-scope.js';
import type { SaleAuditEmitter } from '../sales/audit-emitter.js';
import { createSaleAccessPolicy } from '../sales/sale-access-policy.js';
import { bindSalesRepository, type SaleRow } from '../sales/repositories/sales.repository.js';
import { DEFAULT_CURRENCY_CODE } from '../sales-sync/create-sale-sync-client.js';
import { createSaleSyncStateRepo } from '../sales-sync/sale-sync-state-repo.js';
import { createSellingUserIdResolver } from '../sales-sync/selling-user-id.js';
import { DRAIN_MARGIN_MS } from '../sales-sync/settled-within.js';
import { uuidv7 } from '../returns/uuidv7.js';
import { BusinessDayError, businessDayOf } from '../../shared/time/business-day.js';
import { createSaleVoidAudit, type SaleVoidAuditSink } from './sale-void-audit.js';
import {
  SALE_VOID_REQUEST_TIMEOUT_MS,
  createSaleVoidClient,
  type CreateSaleVoidClientDeps,
} from './sale-void-client.js';
import {
  createSaleVoidRepository,
  type SaleVoidRepository,
  type VoidScope,
} from './sale-void-repository.js';
import { toVoidSender, toVoidSession } from './sale-void-session.js';
import { createSaleVoidService, type SaleVoidService } from './sale-void-service.js';
import { createSaleVoidSync, type SaleVoidSync } from './sale-void-sync.js';

export interface SaleVoidLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ComposeSaleVoidDeps {
  readonly db: DatabaseHandle;
  /** Backend-Core base URL and fetch. */
  readonly http: Omit<CreateSaleVoidClientDeps, 'timeoutMs'>;
  /** The signed-in operator's envelope, read in-process per use; never bridged. */
  readonly getOperatorEnvelope: () => string | null;
  readonly getSession: () => OperatorSessionRecord | null;
  /** The live paired terminal id; null while unpaired or revoked. */
  readonly getTerminalId: () => string | null;
  readonly isSessionLocked: () => boolean;
  readonly isEnabled: () => boolean;
  readonly approvals: Pick<ManagerApprovalService, 'consume' | 'evidence'>;
  readonly auditSink: SaleVoidAuditSink;
  /**
   * RT-741: records `sale.access.refused` for the shared RT-546 gate that
   * `saleVoid.lookup` runs (the same emitter the sales and receipts bridges use).
   */
  readonly accessAudit: Pick<SaleAuditEmitter, 'emitRaw'>;
  readonly logger: SaleVoidLogger;
  readonly now: () => string;
  /** The terminal's capture currency (the sale-sync capture's own source). */
  readonly captureCurrencyCode?: string;
  /**
   * The business day of an instant; defaults to {@link voidBusinessDay}, the
   * store business day. Tests may pin a simpler day function.
   */
  readonly localDayOf?: (iso: string) => string;
}

export interface ComposedSaleVoid {
  readonly service: SaleVoidService;
  readonly sync: SaleVoidSync;
  readonly repo: SaleVoidRepository;
  /**
   * Latch the domain stopped (RT-198): every `saleVoid.*` call answers
   * `void_unavailable`, no send starts, and a send in flight writes nothing when
   * it settles (the DB closes right after). Idempotent and synchronous.
   */
  readonly stop: () => void;
}

/**
 * RT-552 (RT-545 S3) — the store business day (`YYYY-MM-DD`, Africa/Cairo) of
 * an ISO instant, through the shared RT-550 module: never the Windows or
 * process zone. Backend-Core refuses a void whose `businessDate` is not the
 * sale's `business_date` (422 `void_outside_business_day`), which it computes
 * in the store zone. An unreadable instant (`BusinessDayError`) is marked so
 * it never matches a real day; any other fault surfaces instead of being
 * masked as a silent `not_same_day` refusal.
 */
export function voidBusinessDay(iso: string): string {
  try {
    return businessDayOf(iso);
  } catch (error) {
    if (error instanceof BusinessDayError) return `invalid:${iso}`;
    throw error;
  }
}

interface Row1 {
  get(...params: unknown[]): unknown;
}

const LIVE_RETURN_SQL = `
  SELECT 1 FROM return_journal
   WHERE sale_id = ? AND state IN ('pending', 'unknown', 'confirmed', 'paid_out') LIMIT 1`;

export function composeSaleVoid(deps: ComposeSaleVoidDeps): ComposedSaleVoid {
  const { db, now } = deps;
  let stopped = false;
  const isStopped = (): boolean => stopped;
  const repo = createSaleVoidRepository(db);
  const sales = bindSalesRepository(db);
  const saleRefs = createSaleSyncStateRepo(db);
  const sellers = createSellingUserIdResolver({
    db,
    onLookupFailed: () => {
      deps.logger.warn({}, 'sale_void:seller_lookup_failed');
    },
  });
  const hasLiveReturn = db.prepare(LIVE_RETURN_SQL) as Row1;
  const audit = createSaleVoidAudit({ sink: deps.auditSink, now, newEventId: randomUUID });
  // RT-741: the shared RT-546 gate, over the same live session and lock.
  const access = createSaleAccessPolicy({
    getCurrentSession: () => resolveSessionScope(deps.getSession(), deps.getTerminalId()),
    isSessionLocked: deps.isSessionLocked,
    auditEmitter: deps.accessAudit,
    now,
  });

  /**
   * The selling cashier's `users.id` from the sale's own settled event, when
   * provable. The resolver never throws: a failed lookup holds the sale (no
   * `device` route), and Backend-Core still refuses the seller as approver.
   */
  function sellerUserIdOf(sale: SaleRow): string | undefined {
    const route = sellers.resolve([sale], sale.terminal_id).get(sale.sale_id);
    return route?.kind === 'device' ? route.operatorUserId.toLowerCase() : undefined;
  }

  /** The sale's stored Backend-Core reference, or null while it has not synced. */
  const saleRefOf = (scope: VoidScope, saleId: string): string | null =>
    saleRefs.findServerSaleRefBySaleId(
      { tenantId: scope.tenantId, branchId: scope.branchId },
      saleId,
    );

  const currentSender = () => {
    const session = deps.getSession();
    const terminalId = deps.getTerminalId();
    if (session === null || terminalId === null) return null;
    return toVoidSender(session, terminalId, deps.getOperatorEnvelope());
  };

  const service = createSaleVoidService({
    isEnabled: deps.isEnabled,
    getSession: () => {
      const session = deps.getSession();
      const terminalId = deps.getTerminalId();
      if (session === null || terminalId === null) return null;
      return toVoidSession(session, terminalId, deps.getOperatorEnvelope());
    },
    isSessionLocked: deps.isSessionLocked,
    access,
    sales,
    repo,
    hasLiveReturn: (saleId) => hasLiveReturn.get(saleId) !== undefined,
    approvals: deps.approvals,
    sellerUserIdOf,
    saleRef: saleRefOf,
    currentSender,
    audit,
    now,
    newVoidId: randomUUID,
    newExternalId: () => `pos-pulse-void:${uuidv7()}`,
    localDayOf: deps.localDayOf ?? voidBusinessDay,
    captureCurrencyCode: deps.captureCurrencyCode ?? DEFAULT_CURRENCY_CODE,
    isStopped,
  });

  const sync = createSaleVoidSync({
    repo,
    client: createSaleVoidClient(deps.http),
    saleRef: saleRefOf,
    audit,
    currentSender,
    transaction: (fn) => db.transaction(fn)(),
    now,
    logger: deps.logger,
    isStopped,
  });

  return {
    service,
    sync,
    repo,
    stop: () => {
      stopped = true;
    },
  };
}

/** The longest the stop waits for a pass in flight: the request timeout plus the drain margin. */
export const SALE_VOID_DRAIN_TIMEOUT_MS = SALE_VOID_REQUEST_TIMEOUT_MS + DRAIN_MARGIN_MS;

export interface ScheduleSaleVoidInput {
  readonly sync: Pick<SaleVoidSync, 'tick' | 'drain'>;
  /** Latches the domain stopped (`ComposedSaleVoid.stop`). */
  readonly stopDomain: () => void;
  readonly intervalMs: number;
  readonly drainTimeoutMs: number;
  readonly logger: Pick<SaleVoidLogger, 'error'>;
}

/**
 * Run one send pass now (startup) and then every `intervalMs`. Each pass reads
 * its sender live, so a requester who signs in later is picked up without a
 * restart. Returns the worker stopper (called synchronously right before the DB
 * closes): it clears the interval and latches the domain stopped, and returns a
 * promise that settles when the pass in flight is done (bounded by `drainTimeoutMs`).
 */
export function scheduleSaleVoidSync(input: ScheduleSaleVoidInput): () => Promise<void> {
  const run = (): void => {
    input.sync.tick().catch((err: unknown) => {
      input.logger.error({ err }, 'sale_void_sync:tick_unexpected');
    });
  };
  run();
  const timer = setInterval(run, input.intervalMs);
  return () => {
    clearInterval(timer);
    input.stopDomain();
    return input.sync.drain(input.drainTimeoutMs);
  };
}
