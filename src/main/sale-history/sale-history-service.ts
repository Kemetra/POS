/**
 * RT-542 (RT-534 S6) — the `saleHistory.*` handlers: the store-wide sales
 * history and sale detail through Backend-Core, with this terminal's unsent
 * sales merged in, and the local RT-541 read as the honest offline fallback.
 *
 * Data sources (RT-534 comment 12047, data-source matrix):
 *   • ONLINE — Backend-Core's page: the sales the server RECEIVED up to
 *     `as_of`, never "the complete store". Page one also carries this
 *     terminal's unsent sales in the range (pending / dead-letter / not yet
 *     tried), each marked; other terminals' unsent sales cannot be known.
 *     Server rows this terminal made are joined to its own record
 *     (`local_sale_id`) for receipt fidelity.
 *   • OFFLINE — no credential, or the server cannot be reached on page one:
 *     the RT-541 local read, `coverage: this_device_only`.
 * One walk keeps one source: the opaque cursor names it (`s.` server, `n.` /
 * `c.` local), so a later page never mixes the two. A server continuation that
 * fails is `continuation_failed` (the pages shown stay valid); a cursor the
 * server rejects is `cursor_rejected` (start again).
 *
 * The detail fetch is `sale-history-detail.ts`, the reprint
 * `sale-history-reprint.ts`, the cursor codec `sale-history-cursor.ts`, and
 * access `sale-history-access.ts` (the RT-546 gate, reused).
 */

import { isUuid } from '../returns/returns-wire.js';
import type { SaleAuditEmitter } from '../sales/audit-emitter.js';
import type { PrintEventsRepository } from '../sales/repositories/print-events.repository.js';
import type { SalesRepository } from '../sales/repositories/sales.repository.js';
import type { OperatorSessionForSales } from '../sales/sales-bridge.js';
import { planSalesList, runSalesList, toListItem } from '../sales/sales-list.js';
import type { PrintPipeline } from '../receipts/print-pipeline.js';
import type {
  SaleHistoryBridgeAPI,
  SaleHistoryListResponse,
  SaleHistoryLocalPage,
  SaleHistoryRefusalReason,
  SaleHistoryRefused,
  SaleHistoryServerPage,
} from '../../shared/sale-history/types.js';
import type { SaleId } from '../../shared/sales/types.js';
import {
  createSaleHistoryAccess,
  type Admitted,
  type ResolvedCredential,
  type SaleHistoryAccess,
} from './sale-history-access.js';
import type { ListOutcome, SaleHistoryClient } from './sale-history-client.js';
import {
  decodePosition,
  localCursor,
  serverCursor,
  type OfflineReason,
  type Position,
} from './sale-history-cursor.js';
import { createDetailReader } from './sale-history-detail.js';
import type { SaleHistoryLocalReads } from './sale-history-local.js';
import { createSaleHistoryReprint } from './sale-history-reprint.js';
import type { WireHistoryPage } from './sale-history-wire.js';

/** Unsent sales shown on page one; one more is read to know if there are others. */
export const UNSYNCED_SHOWN_MAX = 100;

const LIST_KEYS: ReadonlySet<string> = new Set(['from_day', 'to_day', 'page_size', 'cursor']);
const READ_KEYS: ReadonlySet<string> = new Set(['sale_ref']);

export interface SaleHistoryServiceDeps {
  getCurrentSession: () => OperatorSessionForSales | null;
  isSessionLocked?: () => boolean;
  /** Records `sale.access.refused` and `sale.history.reprinted`. */
  auditEmitter?: Pick<SaleAuditEmitter, 'emitRaw'>;
  resolveCredential: (session: OperatorSessionForSales) => Promise<ResolvedCredential | null>;
  client: SaleHistoryClient;
  local: SaleHistoryLocalReads;
  salesRepo: Pick<SalesRepository, 'listByFinalizedRange' | 'readById'>;
  printEventsRepo: Pick<PrintEventsRepository, 'hasSuccessfulPrint'>;
  /**
   * True when this terminal's void journal holds a live void (pending, unknown
   * or confirmed) of the sale (OD-534-8 B). Absent: never voided.
   */
  isSaleVoided?: (saleId: string) => boolean;
  printer: Pick<PrintPipeline, 'printRendered'>;
  now?: () => string;
  newIdempotencyKey: () => string;
}

export type SaleHistoryService = SaleHistoryBridgeAPI;

export function refused(reason: SaleHistoryRefusalReason): SaleHistoryRefused {
  return { kind: 'refused', reason };
}

type ListPlan = Extract<ReturnType<typeof planSalesList>, { ok: true }>['plan'];

interface ListRun {
  readonly admitted: Admitted;
  readonly position: Position;
  readonly plan: ListPlan;
  readonly from: string;
  readonly to: string;
}

type ListFailure = Exclude<ListOutcome, { kind: 'ok' }>['kind'];

/** A failed first page (other than unreachable, which falls back locally). */
const FIRST_PAGE_FAILURE: Partial<Record<ListFailure, SaleHistoryRefusalReason>> = {
  unauthorized: 'server_refused',
  invalid: 'invalid_request',
};

/** A failed continuation: the walk never switches source. */
const CONTINUATION_FAILURE: Partial<Record<ListFailure, SaleHistoryRefusalReason>> = {
  unauthorized: 'server_refused',
  invalid: 'cursor_rejected',
};

function localPage(
  deps: SaleHistoryServiceDeps,
  run: ListRun,
  reason: OfflineReason,
): SaleHistoryListResponse {
  const answer = runSalesList(deps.salesRepo, run.admitted.scope, run.admitted.owner, run.plan);
  if (answer.kind !== 'ok') return refused('unavailable');
  const page: SaleHistoryLocalPage = {
    kind: 'ok',
    source: 'local',
    coverage: 'this_device_only',
    offline_reason: reason,
    rows: answer.sales,
    next_cursor: localCursor(reason, answer.next_cursor),
  };
  return page;
}

/** OD-534-1 in main: the page's visibility and every row must fit the credential. */
function pageFitsCredential(
  page: WireHistoryPage,
  run: ListRun,
  resolved: ResolvedCredential,
): boolean {
  const expected = run.admitted.owner === null ? 'store' : 'own_sales';
  if (page.visibility !== expected) return false;
  if (page.from_day !== run.from || page.to_day !== run.to) return false;
  if (resolved.cashierUserId === null) return true;
  return page.operator_refs.every((ref) => ref === resolved.cashierUserId);
}

/**
 * A cashier page naming another operator's sale is refused whole; the first
 * such row is recorded through the RT-546 policy (`sale.access.refused`,
 * `not_owner`), as on the detail and reprint paths.
 */
function auditForeignRow(
  access: SaleHistoryAccess,
  run: ListRun,
  resolved: ResolvedCredential,
  page: WireHistoryPage,
): void {
  const index = page.operator_refs.findIndex((ref) => ref !== resolved.cashierUserId);
  const row = page.rows[index];
  if (resolved.cashierUserId === null || row === undefined) return;
  access.owns(run.admitted, resolved, {
    saleRef: row.sale_ref,
    operatorRef: page.operator_refs[index] ?? null,
  });
}

function unsyncedOf(deps: SaleHistoryServiceDeps, run: ListRun) {
  if (run.position.kind !== 'first') return { rows: [], truncated: false };
  const rows = deps.local.unsynced({
    scope: run.admitted.scope,
    selling_operator_id: run.admitted.owner,
    start_inclusive: run.plan.start_inclusive,
    end_exclusive: run.plan.end_exclusive,
    limit: UNSYNCED_SHOWN_MAX + 1,
  });
  return {
    rows: rows.slice(0, UNSYNCED_SHOWN_MAX).map((row) => ({ ...toListItem(row), sync: row.sync })),
    truncated: rows.length > UNSYNCED_SHOWN_MAX,
  };
}

function serverPage(
  deps: SaleHistoryServiceDeps,
  run: ListRun,
  page: WireHistoryPage,
): SaleHistoryServerPage {
  const refs = page.rows.map((row) => row.sale_ref);
  const ids = deps.local.localSaleIds(run.admitted.scope, refs);
  const unsynced = unsyncedOf(deps, run);
  return {
    kind: 'ok',
    source: 'server',
    rows: page.rows.map((row) => ({
      ...row,
      local_sale_id: (ids.get(row.sale_ref) ?? null) as SaleId | null,
    })),
    next_cursor: serverCursor(page.next_cursor),
    as_of: page.as_of,
    store_timezone: page.store_timezone,
    visibility: page.visibility,
    from_day: page.from_day,
    to_day: page.to_day,
    unsynced: unsynced.rows,
    unsynced_truncated: unsynced.truncated,
  };
}

function failedListAnswer(
  deps: SaleHistoryServiceDeps,
  run: ListRun,
  failure: ListFailure,
): SaleHistoryListResponse {
  if (run.position.kind === 'server') {
    return refused(CONTINUATION_FAILURE[failure] ?? 'continuation_failed');
  }
  if (failure === 'unreachable') return localPage(deps, run, 'no_connection');
  if (failure === 'server_error') return localPage(deps, run, 'server_unavailable');
  return refused(FIRST_PAGE_FAILURE[failure] ?? 'unavailable');
}

/** RT-541's planner over the request's days, page size and (local) cursor. */
function planOf(fields: Record<string, unknown>, position: Position) {
  return planSalesList({
    from_day: fields['from_day'],
    to_day: fields['to_day'],
    ...(fields['page_size'] === undefined ? {} : { page_size: fields['page_size'] }),
    ...(position.kind === 'local' ? { cursor: position.cursor } : {}),
  });
}

function planRefusal(refusal: { kind: string; reason?: string }): SaleHistoryRefused {
  return refused(refusal.reason === 'range_too_wide' ? 'range_too_wide' : 'invalid_request');
}

export function createSaleHistoryService(deps: SaleHistoryServiceDeps): SaleHistoryService {
  const access = createSaleHistoryAccess(deps);
  const details = createDetailReader({ client: deps.client, local: deps.local, access });
  const reprint = createSaleHistoryReprint({ deps, access, details });

  /** The validated request, or the refusal. */
  function planList(req: unknown): ListRun | SaleHistoryRefused {
    const gate = access.admit('saleHistory.list', req, LIST_KEYS);
    if (!gate.ok) return refused(gate.reason);
    const fields = req as Record<string, unknown>;
    const position = decodePosition(fields['cursor']);
    if (position === null) return refused('invalid_request');
    const planned = planOf(fields, position);
    if (!planned.ok) return planRefusal(planned.refusal);
    const from = fields['from_day'] as string;
    const to = fields['to_day'] as string;
    return { admitted: gate.admitted, position, plan: planned.plan, from, to };
  }

  async function listOnline(run: ListRun): Promise<SaleHistoryListResponse> {
    const { admitted, position } = run;
    const resolved = await access.credential(admitted);
    if (!access.stillCurrent(admitted)) return refused('session_changed');
    if (resolved === null) {
      return position.kind === 'server'
        ? refused('continuation_failed')
        : localPage(deps, run, 'no_credential');
    }
    const cursor = position.kind === 'server' ? position.cursor : null;
    const query = { from: run.from, to: run.to, pageSize: run.plan.page_size, cursor };
    const outcome = await deps.client.list(query, resolved.credential);
    if (!access.stillCurrent(admitted)) return refused('session_changed');
    if (outcome.kind !== 'ok') return failedListAnswer(deps, run, outcome.kind);
    if (!pageFitsCredential(outcome.page, run, resolved)) {
      auditForeignRow(access, run, resolved, outcome.page);
      return refused('unavailable');
    }
    return serverPage(deps, run, outcome.page);
  }

  return {
    async list(req) {
      const run = planList(req);
      if ('kind' in run) return run;
      if (run.position.kind === 'local') return localPage(deps, run, run.position.reason);
      return listOnline(run);
    },

    async read(req) {
      const gate = access.admit('saleHistory.read', req, READ_KEYS);
      if (!gate.ok) return refused(gate.reason);
      const saleRef = (req as unknown as Record<string, unknown>)['sale_ref'];
      if (typeof saleRef !== 'string' || !isUuid(saleRef)) return refused('invalid_request');
      const fetched = await details.fetchDetail(gate.admitted, saleRef);
      return fetched.ok ? { kind: 'ok', detail: fetched.detail } : refused(fetched.reason);
    },

    reprint: (req) => reprint.reprint(req),
  };
}
