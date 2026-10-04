/**
 * RT-15 S2 — the main-process return domain behind the `returns.*` bridge.
 *
 * Every call passes the same admission gate, in order:
 *   1. `POS_PULSE_FEATURE_RETURNS` on (default off — AC1), else `feature_disabled`;
 *   2. an operator session on a paired terminal, else `no_session`;
 *   3. role manager or admin, checked here in main (D-b, AC2), else
 *      `role_denied` — audited.
 *
 * A return is then built only from a LIVE `readSale` (D-a): the sale is looked
 * up by its local sale number on this terminal (D-d), must be synced with a
 * stored server `saleRef` (AC3), not voided and with something returnable
 * (AC4), and cash-only (D-c). Quantities are whole, 1..returnable (D-e, AC5);
 * the refund is priced exactly by the contract rule (AC6). The return is
 * journaled BEFORE it is sent (AC8) and sent by the shared dispatcher, so a
 * timeout leaves it `unknown`, never success (AC9/AC10). Every refusal after
 * admission is audited (AC11).
 */
import type {
  LocalReturnRefusal,
  ReturnLineInput,
  ReturnQuoteView,
  ReturnsBridgeAPI,
  ReturnsListResponse,
  ReturnsLookupRequest,
  ReturnsLookupResponse,
  ReturnsQuoteRequest,
  ReturnsQuoteResponse,
  ReturnsRefusalReason,
  ReturnsRefused,
  ReturnsResolveResponse,
  ReturnsSubmitRequest,
  ReturnsSubmitResponse,
} from '../../shared/returns/types.js';
import type { SaleRow, SalesRepository } from '../sales/repositories/sales.repository.js';
import type { SaleSyncStateRepo } from '../sales-sync/sale-sync-state-repo.js';
import type { ReturnActor, ReturnsAudit } from './returns-audit.js';
import type { AuthorizedActor, ReturnsAuthorizer } from './returns-auth.js';
import type { ReadSaleOutcome, ReturnsClient } from './returns-client.js';
import type { DispatchOutcome, ReturnsDispatcher } from './returns-dispatch.js';
import { assessSale, buildRecordReturnBody, quoteReturn, viewLines } from './returns-quote.js';
import type { ReturnsRepository } from './returns-repository.js';
import type { ResolveSummary } from './returns-resolver.js';
import { isExpectedSale } from './returns-verify.js';
import { cashOnlyVerdict, localTenderEvidence, serverTenderEvidence } from './returns-tender.js';
import { toJournalView } from './returns-views.js';
import type { WireSale } from './returns-wire.js';

export type { ReturnsSession } from './returns-auth.js';

export interface ReturnsServiceDeps {
  /** The terminal's capture currency (the sale-sync capture's own source). */
  readonly captureCurrencyCode: string;
  /** The single authorization choke point (admission + every re-check). */
  readonly authorizer: ReturnsAuthorizer;
  readonly sales: Pick<SalesRepository, 'findByNumber'>;
  readonly saleRefs: Pick<SaleSyncStateRepo, 'findServerSaleRefBySaleId'>;
  readonly client: Pick<ReturnsClient, 'readSale'>;
  readonly repo: ReturnsRepository;
  readonly dispatcher: ReturnsDispatcher;
  readonly resolver: { resolveOnce(actor: AuthorizedActor): Promise<ResolveSummary> };
  readonly audit: ReturnsAudit;
  readonly now: () => string;
  readonly newReturnId: () => string;
  readonly newExternalId: () => string;
}

/** How many journal rows `returns.list` shows. */
export const RETURNS_LIST_LIMIT = 50;

type Operation = 'lookup' | 'quote' | 'submit' | 'resolve' | 'list';

/** A live, returnable sale: the local row, its server ref and the server view. */
interface LiveSale {
  readonly row: SaleRow;
  readonly saleRef: string;
  readonly wire: WireSale;
}

interface Ids {
  readonly saleId?: string;
  readonly saleRef?: string;
}

type Admitted = { readonly kind: 'ok'; readonly actor: AuthorizedActor } | ReturnsRefused;
type Loaded = { readonly kind: 'ok'; readonly sale: LiveSale } | ReturnsRefused;
type Checked = { readonly kind: 'ok'; readonly sale: WireSale } | ReturnsRefused;

/** The local sale row and its stored server reference. */
interface LocalSale {
  readonly row: SaleRow;
  readonly saleRef: string;
}

/** The sale ids known from an awaited load, for refusal audits. */
function idsOf(awaited: Loaded | null): Ids {
  if (awaited?.kind !== 'ok') return {};
  return { saleId: awaited.sale.row.sale_id, saleRef: awaited.sale.saleRef };
}

function toSubmitResponse(outcome: DispatchOutcome): ReturnsSubmitResponse {
  const ret = toJournalView(outcome.entry);
  if (outcome.kind === 'confirmed') return { kind: 'confirmed', ret, replayed: outcome.replayed };
  if (outcome.kind === 'refused') return { kind: 'refused', reason: outcome.reason, ret };
  // `unconfirmed` (answer lost) and `deferred` (not sent: authorization lost
  // right before the send) both leave the journaled return unresolved.
  return { kind: 'unconfirmed', ret };
}

class ReturnsService implements ReturnsBridgeAPI {
  constructor(private readonly deps: ReturnsServiceDeps) {}

  private refuse(actor: ReturnActor, op: Operation, reason: ReturnsRefusalReason, ids: Ids = {}) {
    this.deps.audit.refused(actor, {
      return_id: null,
      sale_id: ids.saleId ?? null,
      sale_ref: ids.saleRef ?? null,
      operation: op,
      reason,
    });
    return { kind: 'refused', reason } as const;
  }

  /**
   * The choke point after an await: null while the admitted actor is still
   * authorized; else the audited refusal to return instead (no data).
   */
  private recheckAfterAwait(actor: AuthorizedActor, op: Operation, awaited: Loaded | null = null) {
    const lost = this.deps.authorizer.recheck(actor);
    if (lost === null) return null;
    // Already refused for this very reason by an inner re-check (and audited).
    if (awaited?.kind === 'refused' && awaited.reason === lost) return awaited;
    return this.refuse(actor, op, lost, idsOf(awaited));
  }

  /** Gate + capture the authorized actor (flag, session, manager/admin, unlocked). */
  private admit(op: Operation): Admitted {
    const live = this.deps.authorizer.current();
    if (live.kind === 'ok') return { kind: 'ok', actor: live.actor };
    if (live.actor === null) return { kind: 'refused', reason: live.reason };
    return this.refuse(live.actor, op, live.reason);
  }

  /** The local sale, synced, cash-only on the till's own record (D-c, D-d, AC3). */
  private localSale(actor: ReturnActor, req: ReturnsLookupRequest): SaleRow | LocalReturnRefusal {
    const { tenantId, branchId, terminalId } = actor.scope;
    const row = this.deps.sales.findByNumber(req.saleNumber, {
      tenant_id: tenantId,
      branch_id: branchId,
      terminal_id: terminalId,
    });
    if (row === null) return 'sale_not_found';
    // D-c: a contradicting local tender refuses before any network call.
    if (localTenderEvidence(row) === 'non_cash') return 'card_tender_blocked';
    return row;
  }

  /** Local lookup, then the live server view (D-a) and its returnability (AC4). */
  private async loadSale(
    actor: AuthorizedActor,
    op: Operation,
    req: ReturnsLookupRequest,
  ): Promise<Loaded> {
    const row = this.localSale(actor, req);
    if (typeof row === 'string') return this.refuse(actor, op, row);
    const ids: Ids = { saleId: row.sale_id };
    const { tenantId, branchId } = actor.scope;
    const saleRef = this.deps.saleRefs.findServerSaleRefBySaleId(
      { tenantId, branchId },
      row.sale_id,
    );
    if (saleRef === null) return this.refuse(actor, op, 'sale_not_synced', ids);
    const read = await this.deps.client.readSale(saleRef);
    // The re-check is the first thing run after the await (inside postRead).
    const checked = this.postRead(actor, { row, saleRef }, read);
    if (checked.kind === 'refused') {
      return this.refuse(actor, op, checked.reason, { ...ids, saleRef });
    }
    return { kind: 'ok', sale: { row, saleRef, wire: checked.sale } };
  }

  /**
   * The post-read guard pipeline, in order: re-authorize the actor (before
   * any branch), map the readSale outcome, then the live-sale checks.
   */
  private postRead(actor: AuthorizedActor, local: LocalSale, read: ReadSaleOutcome): Checked {
    const lost = this.deps.authorizer.recheck(actor);
    if (lost !== null) return { kind: 'refused', reason: lost };
    if (read.kind === 'unavailable') return { kind: 'refused', reason: 'offline' };
    if (read.kind === 'refused') return read;
    const reason = this.liveSaleRefusal(local, read.sale);
    return reason === null ? { kind: 'ok', sale: read.sale } : { kind: 'refused', reason };
  }

  /** The live sale is the one asked for (sweep), provably cash (D-c), returnable (AC4). */
  private liveSaleRefusal(local: LocalSale, sale: WireSale): ReturnsRefusalReason | null {
    const expected = {
      saleRef: local.saleRef,
      currencyCode: this.deps.captureCurrencyCode,
      linesJson: local.row.lines_json,
    };
    if (!isExpectedSale(sale, expected)) return 'sale_mismatch';
    // D-c fails closed: cash-refundable only when a source PROVES all-cash.
    const tender = cashOnlyVerdict([localTenderEvidence(local.row), serverTenderEvidence(sale)]);
    return tender ?? assessSale(sale);
  }

  async lookup(req: ReturnsLookupRequest): Promise<ReturnsLookupResponse> {
    const admitted = this.admit('lookup');
    if (admitted.kind !== 'ok') return admitted;
    const loaded = await this.loadSale(admitted.actor, 'lookup', req);
    const lost = this.recheckAfterAwait(admitted.actor, 'lookup', loaded);
    if (lost !== null) return lost;
    if (loaded.kind !== 'ok') return loaded;
    const { row, saleRef, wire } = loaded.sale;
    return {
      kind: 'ok',
      sale: {
        saleId: row.sale_id,
        saleNumber: row.sale_number,
        saleRef,
        currencyCode: wire.currencyCode,
        lines: viewLines(wire),
      },
    };
  }

  /** Load and price; shared by quote and submit. */
  private async priced(actor: AuthorizedActor, op: Operation, req: ReturnsQuoteRequest) {
    const loaded = await this.loadSale(actor, op, req);
    if (loaded.kind !== 'ok') return loaded;
    const ids: Ids = { saleId: loaded.sale.row.sale_id, saleRef: loaded.sale.saleRef };
    const quoted = quoteReturn(loaded.sale.wire, req.lines);
    if (quoted.kind !== 'ok') return this.refuse(actor, op, quoted.reason, ids);
    return { kind: 'ok', sale: loaded.sale, quote: quoted.quote } as const;
  }

  async quote(req: ReturnsQuoteRequest): Promise<ReturnsQuoteResponse> {
    const admitted = this.admit('quote');
    if (admitted.kind !== 'ok') return admitted;
    const priced = await this.priced(admitted.actor, 'quote', req);
    const lost = this.recheckAfterAwait(admitted.actor, 'quote', priced);
    if (lost !== null) return lost;
    return priced.kind === 'ok' ? { kind: 'ok', quote: priced.quote } : priced;
  }

  async submit(req: ReturnsSubmitRequest): Promise<ReturnsSubmitResponse> {
    const admitted = this.admit('submit');
    if (admitted.kind !== 'ok') return { ...admitted, ret: null };
    const { actor } = admitted;
    const priced = await this.priced(actor, 'submit', req);
    // Choke point (a): the first statement after the await — before any
    // branch, early exit or refusal, and so before the journal insert.
    const lost = this.recheckAfterAwait(actor, 'submit', priced);
    if (lost !== null) return { ...lost, ret: null };
    if (priced.kind !== 'ok') return { ...priced, ret: null };
    const saleId = priced.sale.row.sale_id;
    if (this.deps.repo.hasUnresolvedForSale(saleId)) {
      const ids: Ids = { saleId, saleRef: priced.sale.saleRef };
      return { ...this.refuse(actor, 'submit', 'unresolved_return_exists', ids), ret: null };
    }
    const entry = this.journal(actor, priced.sale, priced.quote, req.lines);
    // Choke point (b) runs inside the dispatcher, immediately before the POST.
    const outcome = await this.deps.dispatcher.send(entry, 'submit', actor);
    return this.submitResponseFor(actor, outcome);
  }

  /**
   * After the send: answer the admitted actor only if still authorized. If the
   * session changed while the POST was awaited, the outcome is withheld from
   * the new session (`session_changed`, no data). The return itself is already
   * journaled and audited with its true state; an eligible operator sees it via
   * `returns.list` / `returns.resolve`. Not audited as a refusal: nothing was.
   */
  private submitResponseFor(actor: AuthorizedActor, outcome: DispatchOutcome) {
    const lost = this.deps.authorizer.recheck(actor);
    if (lost === null) return toSubmitResponse(outcome);
    return { kind: 'refused', reason: lost, ret: null } as const;
  }

  /**
   * Write the return to the journal — with its `attempted` audit, atomically —
   * before anything is sent (AC8).
   */
  private journal(
    actor: ReturnActor,
    sale: LiveSale,
    quote: ReturnQuoteView,
    lines: readonly ReturnLineInput[],
  ) {
    const returnId = this.deps.newReturnId();
    const externalId = this.deps.newExternalId();
    this.deps.repo.insert(
      {
        returnId,
        scope: actor.scope,
        saleId: sale.row.sale_id,
        saleNumber: sale.row.sale_number,
        serverSaleRef: sale.saleRef,
        externalId,
        operatorId: actor.operatorId,
        operatorSessionId: actor.operatorSessionId,
        currencyCode: quote.currencyCode,
        quotedTotalMinor: quote.totalMinor,
        requestBodyJson: JSON.stringify(buildRecordReturnBody(externalId, quote)),
        lines: lines.map((l) => ({ lineRef: l.lineRef, quantity: l.quantity })),
        now: this.deps.now(),
      },
      (inserted) => {
        this.deps.audit.attempted(inserted);
      },
    );
    const entry = this.deps.repo.read(returnId);
    if (entry === null) throw new Error('returns-service: journaled return not found');
    return entry;
  }

  async resolve(): Promise<ReturnsResolveResponse> {
    const admitted = this.admit('resolve');
    if (admitted.kind !== 'ok') return admitted;
    const tally = await this.deps.resolver.resolveOnce(admitted.actor);
    return this.recheckAfterAwait(admitted.actor, 'resolve') ?? { kind: 'ok', ...tally };
  }

  list(): Promise<ReturnsListResponse> {
    const admitted = this.admit('list');
    if (admitted.kind !== 'ok') return Promise.resolve(admitted);
    const entries = this.deps.repo.listRecent(admitted.actor.scope, RETURNS_LIST_LIMIT);
    return Promise.resolve({ kind: 'ok', returns: entries.map(toJournalView) });
  }
}

export function createReturnsService(deps: ReturnsServiceDeps): ReturnsBridgeAPI {
  return new ReturnsService(deps);
}
