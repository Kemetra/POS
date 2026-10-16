/**
 * RT-542 — `saleHistory.reprint`: a receipt reprint of a sale the operator may
 * see in the store history, authorized by Backend-Core BEFORE anything prints
 * (`recordSaleReprint`, mode `authorize`; RT-537 D-7). The server audit trail
 * is the authority; this terminal also records `sale.history.reprinted` under
 * the signed-in operator.
 *
 * Order:
 *   1. shape (`sale_ref`, `kind` only: the copy number, the idempotency key
 *      and the credential never come from the renderer) → the RT-546 gate;
 *   2. one reprint of a sale at a time on this terminal (`busy`);
 *   3. a fresh detail (the OD-534-1 ownership check runs on it);
 *   4. for a duplicate: the detail must allow it (complete facts, not voided,
 *      OD-534-3/8) and the slip must be buildable; when THIS terminal made the
 *      sale, its own successful original print is required (OD-534-2 / Q-6)
 *      and its own record is printed;
 *   5. `authorize` with a fresh Idempotency-Key — each call is one audited
 *      authorization, so a retry after a printer fault is a new copy number;
 *   6. print exactly the kind, sale and marks the server authorized, through
 *      the receipt pipeline; audit the outcome.
 *
 * A reprint never kicks the drawer and changes no sale, return, void or
 * payment fact.
 */

import { renderBands, type Band } from '../receipts/template-engine.js';
import type {
  SaleHistoryDetail,
  SaleHistoryReprintKind,
  SaleHistoryReprintRequest,
  SaleHistoryReprintResponse,
} from '../../shared/sale-history/types.js';
import { isUuid } from '../returns/returns-wire.js';
import type { ReceiptPayload } from '../../shared/receipts/types.js';
import type { Admitted, ResolvedCredential, SaleHistoryAccess } from './sale-history-access.js';
import type { WireReprint } from './sale-history-wire.js';
import type { DetailReader } from './sale-history-detail.js';
import type { SaleHistoryServiceDeps } from './sale-history-service.js';
import {
  duplicateBands,
  duplicateFromDetail,
  duplicateFromLocal,
  saleRecordBands,
  type SlipContext,
} from './sale-history-slip.js';

const REPRINT_KEYS: ReadonlySet<string> = new Set(['sale_ref', 'kind']);
const KINDS: readonly SaleHistoryReprintKind[] = ['duplicate', 'sale_record'];

type Refusal = Extract<SaleHistoryReprintResponse, { kind: 'refused' }>;

const refuse = (reason: Refusal['reason']): Refusal => ({ kind: 'refused', reason });

export interface SaleHistoryReprintDeps {
  readonly deps: SaleHistoryServiceDeps;
  readonly access: SaleHistoryAccess;
  readonly details: DetailReader;
}

/** What a duplicate prints, decided before the authorization. */
type DuplicateSource = (copyNumber: number, reprintedAt: string) => ReceiptPayload | null;

const AUTHORIZE_FAILURE: Readonly<Record<string, Refusal['reason']>> = {
  duplicate_unavailable: 'duplicate_unavailable',
  not_found: 'sale_not_found',
  unauthorized: 'server_refused',
};

interface ReprintRequest {
  readonly saleRef: string;
  readonly kind: SaleHistoryReprintKind;
}

interface Prepared {
  readonly detail: SaleHistoryDetail;
  readonly resolved: ResolvedCredential;
  readonly source: DuplicateSource | null;
}

/** The server authorized exactly the sale and kind asked for, before printing. */
function isAuthorizationFor(authorized: WireReprint, request: ReprintRequest): boolean {
  return (
    authorized.sale_ref === request.saleRef &&
    authorized.kind === request.kind &&
    authorized.mode === 'authorize'
  );
}

function readRequest(req: unknown): ReprintRequest | null {
  const fields = req as Record<string, unknown>;
  const saleRef = fields['sale_ref'];
  const kind = fields['kind'];
  if (typeof saleRef !== 'string' || !isUuid(saleRef)) return null;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null;
  return { saleRef, kind: kind as SaleHistoryReprintKind };
}

export function createSaleHistoryReprint(input: SaleHistoryReprintDeps): {
  reprint(req: SaleHistoryReprintRequest): Promise<SaleHistoryReprintResponse>;
} {
  const { deps, access, details } = input;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const running = new Set<string>();

  /** The duplicate source, or why a duplicate cannot be printed. */
  function duplicateSource(detail: SaleHistoryDetail): DuplicateSource | Refusal {
    if (detail.reprint.duplicate !== 'allowed') return refuse('duplicate_unavailable');
    const localId = detail.summary.local_sale_id;
    const row = localId === null ? null : deps.salesRepo.readById(localId);
    if (row !== null) {
      if (!deps.printEventsRepo.hasSuccessfulPrint(row.sale_id)) return refuse('not_yet_printed');
      if (duplicateFromLocal(row, 1, now()) === null) return refuse('duplicate_unavailable');
      return (copy, at) => duplicateFromLocal(row, copy, at);
    }
    if (duplicateFromDetail(detail, 1, now()) === null) return refuse('duplicate_unavailable');
    return (copy, at) => duplicateFromDetail(detail, copy, at);
  }

  function slipBands(
    authorized: WireReprint,
    detail: SaleHistoryDetail,
    source: DuplicateSource | null,
    printedAt: string,
  ): Band[] | null {
    const ctx: SlipContext = {
      detail,
      copyNumber: authorized.copy_number,
      marks: authorized.marks,
      printedAt,
    };
    if (source === null) return saleRecordBands(ctx);
    const payload = source(authorized.copy_number, printedAt);
    return payload === null ? null : duplicateBands(payload, ctx);
  }

  function audit(admitted: Admitted, authorized: WireReprint, outcome: string, at: string): void {
    const { session } = admitted;
    try {
      deps.auditEmitter?.emitRaw({
        action_category: 'sale.history.reprinted',
        attribution_operator_id: session.operator_id,
        tenant_id: session.tenant_id,
        branch_id: session.branch_id,
        originating_terminal_id: session.terminal_id,
        session_id: session.operator_session_id,
        created_at: at,
        payload: {
          sale_ref: authorized.sale_ref,
          kind: authorized.kind,
          copy_number: authorized.copy_number,
          marks: [...authorized.marks],
          outcome,
        },
      });
    } catch {
      // Best-effort: Backend-Core already holds the authoritative record.
    }
  }

  /** The fresh detail and what a duplicate would print, or why not. */
  async function prepare(
    admitted: Admitted,
    saleRef: string,
    kind: SaleHistoryReprintKind,
  ): Promise<Prepared | Refusal> {
    const fetched = await details.fetchDetail(admitted, saleRef);
    if (!fetched.ok) return refuse(fetched.reason);
    const source = kind === 'duplicate' ? duplicateSource(fetched.detail) : null;
    if (source !== null && 'kind' in source) return source;
    return { detail: fetched.detail, resolved: fetched.resolved, source };
  }

  /** Backend-Core's authorization of exactly this sale and kind, or why not. */
  async function authorize(
    admitted: Admitted,
    request: ReprintRequest,
    resolved: ResolvedCredential,
    printedAt: string,
  ): Promise<{ readonly reprint: WireReprint } | Refusal> {
    const { saleRef, kind } = request;
    const outcome = await deps.client.authorizeReprint(
      { saleRef, kind, printedAt, idempotencyKey: deps.newIdempotencyKey() },
      resolved.credential,
    );
    if (!access.stillCurrent(admitted)) return refuse('session_changed');
    if (outcome.kind !== 'ok') return refuse(AUTHORIZE_FAILURE[outcome.kind] ?? 'unavailable');
    return isAuthorizationFor(outcome.reprint, request)
      ? { reprint: outcome.reprint }
      : refuse('unavailable');
  }

  async function run(
    admitted: Admitted,
    request: ReprintRequest,
  ): Promise<SaleHistoryReprintResponse> {
    const prepared = await prepare(admitted, request.saleRef, request.kind);
    if ('kind' in prepared) return prepared;
    const printedAt = now();
    const answer = await authorize(admitted, request, prepared.resolved, printedAt);
    if (!('reprint' in answer)) return answer;
    const authorized = answer.reprint;
    const bands = slipBands(authorized, prepared.detail, prepared.source, printedAt);
    if (bands === null) return refuse('unavailable');
    const printed = await deps.printer.printRendered(renderBands(bands));
    audit(admitted, authorized, printed.ok ? 'printed' : 'print_failed', printedAt);
    if (!printed.ok) return refuse('printer_unavailable');
    return {
      kind: 'ok',
      printed: request.kind,
      copy_number: authorized.copy_number,
      marks: [...authorized.marks],
      printed_at: printedAt,
    };
  }

  return {
    async reprint(req) {
      const gate = access.admit('saleHistory.reprint', req, REPRINT_KEYS);
      if (!gate.ok) return refuse(gate.reason);
      const request = readRequest(req);
      if (request === null) return refuse('invalid_request');
      if (running.has(request.saleRef)) return refuse('busy');
      running.add(request.saleRef);
      try {
        return await run(gate.admitted, request);
      } finally {
        running.delete(request.saleRef);
      }
    },
  };
}
