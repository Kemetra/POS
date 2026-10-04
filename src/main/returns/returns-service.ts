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
import type { Role } from '../../shared/operator/role.js';
import type { SaleRow, SalesRepository } from '../sales/repositories/sales.repository.js';
import type { SaleSyncStateRepo } from '../sales-sync/sale-sync-state-repo.js';
import type { ReturnActor, ReturnsAudit } from './returns-audit.js';
import type { ReturnsClient } from './returns-client.js';
import type { DispatchOutcome, ReturnsDispatcher } from './returns-dispatch.js';
import { assessSale, buildRecordReturnBody, quoteReturn, viewLines } from './returns-quote.js';
import type { ReturnsRepository } from './returns-repository.js';
import type { ResolveSummary } from './returns-resolver.js';
import { hasNonCashLocalTender, toJournalView } from './returns-views.js';
import type { WireSale } from './returns-wire.js';

/** The operator session as the return flow needs it (main-only). */
export interface ReturnsSession {
  readonly role: Role;
  readonly operator_id: string;
  readonly operator_session_id: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly terminal_id: string;
}

export interface ReturnsServiceDeps {
  readonly isEnabled: () => boolean;
  readonly getSession: () => ReturnsSession | null;
  readonly sales: Pick<SalesRepository, 'findByNumber'>;
  readonly saleRefs: Pick<SaleSyncStateRepo, 'findServerSaleRefBySaleId'>;
  readonly client: Pick<ReturnsClient, 'readSale'>;
  readonly repo: ReturnsRepository;
  readonly dispatcher: ReturnsDispatcher;
  readonly resolver: { resolveOnce(actor: ReturnActor): Promise<ResolveSummary> };
  readonly audit: ReturnsAudit;
  readonly now: () => string;
  readonly newReturnId: () => string;
  readonly newExternalId: () => string;
}

/** How many journal rows `returns.list` shows. */
export const RETURNS_LIST_LIMIT = 50;

const RETURN_ROLES: ReadonlySet<Role> = new Set<Role>(['manager', 'admin']);

/** D-b: only a manager or admin may start (or resolve) a return. */
export function isReturnsRole(role: Role): boolean {
  return RETURN_ROLES.has(role);
}

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

type Admitted = { readonly kind: 'ok'; readonly actor: ReturnActor } | ReturnsRefused;
type Loaded = { readonly kind: 'ok'; readonly sale: LiveSale } | ReturnsRefused;

function actorOf(session: ReturnsSession): ReturnActor {
  return {
    scope: {
      tenantId: session.tenant_id,
      branchId: session.branch_id,
      terminalId: session.terminal_id,
    },
    operatorId: session.operator_id,
    operatorSessionId: session.operator_session_id,
  };
}

function toSubmitResponse(outcome: DispatchOutcome): ReturnsSubmitResponse {
  const ret = toJournalView(outcome.entry);
  if (outcome.kind === 'confirmed') return { kind: 'confirmed', ret, replayed: outcome.replayed };
  if (outcome.kind === 'refused') return { kind: 'refused', reason: outcome.reason, ret };
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

  private admit(op: Operation): Admitted {
    if (!this.deps.isEnabled()) return { kind: 'refused', reason: 'feature_disabled' };
    const session = this.deps.getSession();
    if (session === null) return { kind: 'refused', reason: 'no_session' };
    const actor = actorOf(session);
    if (!isReturnsRole(session.role)) return this.refuse(actor, op, 'role_denied');
    return { kind: 'ok', actor };
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
    if (hasNonCashLocalTender(row)) return 'card_tender_blocked';
    return row;
  }

  /** Local lookup, then the live server view (D-a) and its returnability (AC4). */
  private async loadSale(
    actor: ReturnActor,
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
    if (read.kind === 'unavailable') return this.refuse(actor, op, 'offline', { ...ids, saleRef });
    if (read.kind === 'refused') return this.refuse(actor, op, read.reason, { ...ids, saleRef });
    const blocked = assessSale(read.sale);
    if (blocked !== null) return this.refuse(actor, op, blocked, { ...ids, saleRef });
    return { kind: 'ok', sale: { row, saleRef, wire: read.sale } };
  }

  async lookup(req: ReturnsLookupRequest): Promise<ReturnsLookupResponse> {
    const admitted = this.admit('lookup');
    if (admitted.kind !== 'ok') return admitted;
    const loaded = await this.loadSale(admitted.actor, 'lookup', req);
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
  private async priced(actor: ReturnActor, op: Operation, req: ReturnsQuoteRequest) {
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
    return priced.kind === 'ok' ? { kind: 'ok', quote: priced.quote } : priced;
  }

  async submit(req: ReturnsSubmitRequest): Promise<ReturnsSubmitResponse> {
    const admitted = this.admit('submit');
    if (admitted.kind !== 'ok') return { ...admitted, ret: null };
    const { actor } = admitted;
    const priced = await this.priced(actor, 'submit', req);
    if (priced.kind !== 'ok') return { ...priced, ret: null };
    const saleId = priced.sale.row.sale_id;
    if (this.deps.repo.hasUnresolvedForSale(saleId)) {
      const ids: Ids = { saleId, saleRef: priced.sale.saleRef };
      return { ...this.refuse(actor, 'submit', 'unresolved_return_exists', ids), ret: null };
    }
    const entry = this.journal(actor, priced.sale, priced.quote, req.lines);
    return toSubmitResponse(await this.deps.dispatcher.send(entry, 'submit'));
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
    return { kind: 'ok', ...(await this.deps.resolver.resolveOnce(admitted.actor)) };
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
