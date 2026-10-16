/**
 * RT-530 — the main-process sale-void domain behind the `saleVoid.*` bridge.
 *
 * `lookup` finds a finalized sale of this terminal by its receipt number and
 * says whether it can be voided now. `request` spends a manager approval on
 * that sale: in ONE transaction it consumes the single-use RT-114 approval
 * (bound to the sale, its total and the requester), reads back the approval's
 * evidence and journals the void with an audit event. Nothing is sent here:
 * the send engine posts it later under the requester's own envelope.
 *
 * Eligibility (owner decisions, Jira RT-530 comment 11988): the sale's
 * business day is today's (the store business day, RT-552), it has no live
 * void and no return. The approval is four-eyes (the approval service refuses the
 * requester and the sale's selling operator as approver; Backend-Core checks
 * both again). A session that could never send the void is refused up front: a
 * cashier needs an operator envelope, a manager or admin signs in with one.
 *
 * Every call passes the same admission gate: the feature flag, an operator
 * session on a paired terminal, not locked. Shutdown (RT-198): once stopped
 * every call answers `void_unavailable` before touching the database.
 */
import type {
  ApprovalEvidence,
  ApprovalSubject,
  ManagerApprovalService,
} from '../operator/manager-approval-service.js';
import type { SaleRow, SalesRepository } from '../sales/repositories/sales.repository.js';
import { saleNetCashMinor } from '../shift-cashup/shift-cashup-calculator.js';
import type {
  LocalVoidRefusal,
  SaleVoidAcknowledgeRequest,
  SaleVoidAcknowledgeResponse,
  SaleVoidBridgeAPI,
  SaleVoidJournalView,
  SaleVoidListResponse,
  SaleVoidLookupRequest,
  SaleVoidLookupResponse,
  SaleVoidRequest,
  SaleVoidRequestResponse,
  SaleVoidSaleView,
  SaleVoidWaitingFor,
} from '../../shared/sale-void/types.js';
import type { SaleVoidAudit } from './sale-void-audit.js';
import type { SaleVoidRepository, VoidEntry, VoidScope } from './sale-void-repository.js';
import type { VoidSender } from './sale-void-sync.js';

/** How many journal rows `saleVoid.list` shows. */
export const SALE_VOID_LIST_LIMIT = 50;

/** The `action_kind` of the approval a void spends. */
export const SALE_VOID_ACTION_KIND = 'sale.void' as const;

/** The live operator session on the paired terminal, as the void domain reads it. */
export interface VoidSession {
  readonly sessionId: string;
  readonly operatorId: string;
  readonly displayName: string;
  readonly role: 'cashier' | 'manager' | 'admin';
  readonly scope: VoidScope;
  /** The operator's provider-neutral `users.id`, lower-case; null when unknown. */
  readonly userId: string | null;
  /** True when the session holds a non-empty operator envelope right now. */
  readonly hasEnvelope: boolean;
}

export interface SaleVoidServiceDeps {
  readonly isEnabled: () => boolean;
  readonly getSession: () => VoidSession | null;
  readonly isSessionLocked: () => boolean;
  readonly sales: Pick<SalesRepository, 'findByNumber' | 'readById'>;
  readonly repo: SaleVoidRepository;
  /** True when the sale has a return that is not refused (any other state counts). */
  readonly hasLiveReturn: (saleId: string) => boolean;
  readonly approvals: Pick<ManagerApprovalService, 'consume' | 'evidence'>;
  /** The sale's selling operator as a lower-case `users.id`, when provable. */
  readonly sellerUserIdOf: (sale: SaleRow) => string | undefined;
  /** The sale's stored Backend-Core reference, or null while it has not synced. */
  readonly saleRef: (scope: VoidScope, saleId: string) => string | null;
  /** The live eligible sender, to say what a queued void is waiting for. */
  readonly currentSender: () => VoidSender | null;
  readonly audit: Pick<SaleVoidAudit, 'requested'>;
  readonly now: () => string;
  readonly newVoidId: () => string;
  /** `pos-pulse-void:<uuid>`. */
  readonly newExternalId: () => string;
  /**
   * The store business day (`YYYY-MM-DD`) of an ISO instant (RT-552). The
   * same-day check and the `businessDate` sent both use it, so they agree.
   */
  readonly localDayOf: (iso: string) => string;
  readonly captureCurrencyCode: string;
  readonly isStopped: () => boolean;
}

export interface SaleVoidService extends SaleVoidBridgeAPI {
  /** The approval subject of `sale.void` for `subjectRef` (the local sale id), or null. */
  approvalSubject(input: {
    subjectRef: string;
    session: { tenant_id: string; branch_id: string };
  }): ApprovalSubject | null;
}

type Refusal = { kind: 'refused'; reason: LocalVoidRefusal };
const refuse = (reason: LocalVoidRefusal): Refusal => ({ kind: 'refused', reason });

/** A consumed approval that did not hold: thrown to roll the request back. */
class ApprovalRefused extends Error {
  constructor(readonly reason: LocalVoidRefusal) {
    super(reason);
  }
}

type Ineligible = SaleVoidSaleView['ineligible'];

/** Net cash of the sale, or null when its tender summary cannot be read faithfully. */
function cashOf(sale: SaleRow): number | null {
  try {
    return saleNetCashMinor(sale.tender_lines_summary_json);
  } catch {
    return null;
  }
}

/** A session that could never send the void is refused before an approval is spent. */
function canEverSend(session: VoidSession): boolean {
  if (session.userId === null) return false;
  return session.role !== 'cashier' || session.hasEnvelope;
}

export function createSaleVoidService(deps: SaleVoidServiceDeps): SaleVoidService {
  /** The admission gate: flag, live unlocked session, not shutting down. */
  function admit(): { kind: 'ok'; session: VoidSession } | Refusal {
    if (deps.isStopped()) return refuse('void_unavailable');
    if (!deps.isEnabled()) return refuse('feature_disabled');
    const session = deps.getSession();
    if (session === null) return refuse('no_session');
    if (deps.isSessionLocked()) return refuse('session_locked');
    return { kind: 'ok', session };
  }

  const inScope = (sale: SaleRow, scope: VoidScope): boolean =>
    sale.tenant_id === scope.tenantId &&
    sale.branch_id === scope.branchId &&
    sale.terminal_id === scope.terminalId;

  /** Why the sale cannot be voided now, or null. */
  function ineligibleReason(sale: SaleRow): Ineligible {
    if (deps.localDayOf(sale.finalized_at) !== deps.localDayOf(deps.now())) return 'not_same_day';
    if (deps.repo.liveForSale(sale.sale_id) !== null) return 'already_voided';
    if (deps.hasLiveReturn(sale.sale_id)) return 'has_return';
    return null;
  }

  function saleView(sale: SaleRow): SaleVoidSaleView {
    return {
      sale_id: sale.sale_id,
      sale_number: sale.sale_number,
      finalized_at: sale.finalized_at,
      total_minor: sale.subtotal_minor,
      cash_minor: cashOf(sale) ?? 0,
      selling_operator_display_name: sale.selling_operator_display_name,
      ineligible: ineligibleReason(sale),
    };
  }

  function waitingFor(entry: VoidEntry): SaleVoidWaitingFor | null {
    if (entry.state !== 'pending' && entry.state !== 'unknown') return null;
    if (deps.saleRef(entry.scope, entry.saleId) === null) return 'sale_sync';
    const sender = deps.currentSender();
    const mine =
      sender !== null &&
      sender.operatorUserId.toLowerCase() === entry.requesterUserId.toLowerCase();
    return mine ? null : 'requester_sign_in';
  }

  function journalView(entry: VoidEntry): SaleVoidJournalView {
    return {
      void_id: entry.voidId,
      sale_number: entry.saleNumber,
      total_minor: entry.amountMinor,
      requested_at: entry.requestedAt,
      state: entry.state,
      requester_display_name: entry.requesterDisplayName,
      waiting_for: waitingFor(entry),
      refusal_reason: entry.refusalReason,
      needs_attention: entry.state === 'refused' && entry.acknowledgedAt === null,
      confirmed_at: entry.confirmedAt,
    };
  }

  /** The approval subject: this sale, its total, and (when provable) its seller. */
  function subjectOf(sale: SaleRow): ApprovalSubject {
    const sellerUserId = deps.sellerUserIdOf(sale);
    return {
      version: `sale-void:${sale.sale_id}`,
      amountMinor: sale.subtotal_minor,
      ...(sellerUserId === undefined ? {} : { sellerUserId }),
    };
  }

  function approvalSubject(input: {
    subjectRef: string;
    session: { tenant_id: string; branch_id: string };
  }): ApprovalSubject | null {
    const sale = deps.sales.readById(input.subjectRef);
    if (sale === null) return null;
    if (sale.tenant_id !== input.session.tenant_id || sale.branch_id !== input.session.branch_id) {
      return null;
    }
    return ineligibleReason(sale) === null ? subjectOf(sale) : null;
  }

  /**
   * The journal write, ONE transaction (the repository's): spend the approval,
   * read its evidence, insert the row, audit. Any refusal or failure rolls the
   * whole thing back, so a refused or failed request never spends the approval.
   */
  function journal(input: {
    sale: SaleRow;
    session: VoidSession;
    approvalId: string;
    cashMinor: number;
    userId: string;
  }): VoidEntry {
    const { sale, session, approvalId } = input;
    const voidId = deps.newVoidId();
    deps.repo.insertFrom(
      () => {
        const evidence = spendApproval(input);
        return {
          voidId,
          scope: session.scope,
          saleId: sale.sale_id,
          saleNumber: sale.sale_number,
          externalId: deps.newExternalId(),
          approvalId,
          approverUserId: evidence.approverUserId,
          requesterUserId: input.userId,
          requesterOperatorId: session.operatorId,
          requesterDisplayName: session.displayName,
          operatorSessionId: session.sessionId,
          policyVersion: evidence.policyVersion,
          approvedAt: evidence.issuedAt,
          businessDate: deps.localDayOf(sale.finalized_at),
          amountMinor: sale.subtotal_minor,
          cashMinor: input.cashMinor,
          currencyCode: deps.captureCurrencyCode,
          now: deps.now(),
        };
      },
      (inserted) => {
        deps.audit.requested(inserted);
      },
    );
    const entry = deps.repo.read(voidId);
    if (entry === null) throw new Error('sale-void: journaled row vanished');
    return entry;
  }

  /** Consume the approval against this sale and read back what it proved. */
  function spendApproval(input: {
    sale: SaleRow;
    session: VoidSession;
    approvalId: string;
    userId: string;
  }): ApprovalEvidence {
    const { sale, session, approvalId } = input;
    const consumed = deps.approvals.consume({
      approvalId,
      actionKind: SALE_VOID_ACTION_KIND,
      subjectRef: sale.sale_id,
      subject: subjectOf(sale),
      session: {
        operator_id: session.operatorId,
        tenant_id: session.scope.tenantId,
        branch_id: session.scope.branchId,
      },
    });
    if (consumed.kind === 'refused') throw new ApprovalRefused(consumed.reason);
    const evidence = deps.approvals.evidence(approvalId);
    // The approval must have been granted to THIS requester (their users.id).
    if (evidence === null || evidence.requesterUserId !== input.userId) {
      throw new ApprovalRefused('approval_invalid');
    }
    return evidence;
  }

  /** The requester's own retry of an approval already journaled: the same void. */
  function replayOf(
    approvalId: string,
    sale: SaleRow,
    userId: string,
  ): SaleVoidRequestResponse | null {
    const existing = deps.repo.readByApproval(approvalId);
    if (existing === null) return null;
    const same = existing.saleId === sale.sale_id && existing.requesterUserId === userId;
    return same ? { kind: 'requested', void: journalView(existing) } : refuse('approval_invalid');
  }

  /** The sale of this terminal a request names, or why there is none. */
  function saleOf(session: VoidSession, saleId: string): SaleRow | Refusal {
    const sale = deps.sales.readById(saleId);
    return sale !== null && inScope(sale, session.scope) ? sale : refuse('sale_not_found');
  }

  /** Journal the void: spend the approval, or answer why it did not hold. */
  function journalRequested(input: {
    sale: SaleRow;
    session: VoidSession;
    approvalId: string;
    userId: string;
  }): SaleVoidRequestResponse {
    const cashMinor = cashOf(input.sale);
    if (cashMinor === null) return refuse('void_unavailable');
    try {
      const entry = journal({ ...input, cashMinor });
      return { kind: 'requested', void: journalView(entry) };
    } catch (err) {
      if (err instanceof ApprovalRefused) return refuse(err.reason);
      throw err;
    }
  }

  function requestAdmitted(session: VoidSession, req: SaleVoidRequest): SaleVoidRequestResponse {
    const userId = session.userId;
    if (userId === null || !canEverSend(session)) return refuse('no_operator_envelope');
    const sale = saleOf(session, req.sale_id);
    if ('kind' in sale) return sale;
    const replay = replayOf(req.approval_id, sale, userId);
    if (replay !== null) return replay;
    const ineligible = ineligibleReason(sale);
    if (ineligible !== null) return refuse(ineligible);
    return journalRequested({ sale, session, approvalId: req.approval_id, userId });
  }

  /* The bridge methods are async so an unexpected throw is a rejected promise, never a sync throw. */
  return {
    approvalSubject,

    // eslint-disable-next-line @typescript-eslint/require-await
    async lookup(req: SaleVoidLookupRequest): Promise<SaleVoidLookupResponse> {
      const admitted = admit();
      if (admitted.kind !== 'ok') return admitted;
      const sale = deps.sales.findByNumber(req.sale_number, {
        tenant_id: admitted.session.scope.tenantId,
        branch_id: admitted.session.scope.branchId,
        terminal_id: admitted.session.scope.terminalId,
      });
      if (sale === null) return refuse('sale_not_found');
      return { kind: 'sale', sale: saleView(sale) };
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async request(req: SaleVoidRequest): Promise<SaleVoidRequestResponse> {
      const admitted = admit();
      if (admitted.kind !== 'ok') return admitted;
      return requestAdmitted(admitted.session, req);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async list(): Promise<SaleVoidListResponse> {
      const admitted = admit();
      if (admitted.kind !== 'ok') return admitted;
      const scope = admitted.session.scope;
      const recent = deps.repo.listRecent(scope, SALE_VOID_LIST_LIMIT);
      // A refusal stays visible until acknowledged, however many newer voids exist.
      const listed = new Set(recent.map((row) => row.voidId));
      const olderRefused = deps.repo
        .listUnacknowledgedRefused(scope)
        .filter((row) => !listed.has(row.voidId));
      return { kind: 'list', voids: [...recent, ...olderRefused].map(journalView) };
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async acknowledge(req: SaleVoidAcknowledgeRequest): Promise<SaleVoidAcknowledgeResponse> {
      const admitted = admit();
      if (admitted.kind !== 'ok') return admitted;
      const row = deps.repo.read(req.void_id);
      const own =
        row !== null &&
        row.scope.tenantId === admitted.session.scope.tenantId &&
        row.scope.branchId === admitted.session.scope.branchId &&
        row.scope.terminalId === admitted.session.scope.terminalId;
      if (!own || !deps.repo.acknowledge({ voidId: req.void_id, now: deps.now() })) {
        return refuse('invalid_input');
      }
      return { kind: 'acknowledged' };
    },
  };
}
