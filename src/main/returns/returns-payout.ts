/**
 * RT-15 S4 — the cash payout of a confirmed return, and its slip (AC9, AC12).
 *
 * ## Order (chosen so that a crash at any step never pays twice)
 *
 *   1. claim   the payout row + `payout_started` audit, one transaction,
 *              BEFORE the drawer opens;
 *   2. kick    the sale drawer's own port (deadline; a fault is a failure);
 *   3. commit  only after the kick reported `opened` (or, for `manual`, after
 *              the operator attested a payout from a drawer opened by hand):
 *              payout row paid + header `confirmed -> paid_out` + `paid_out`
 *              audit, one transaction;
 *   4. slip    printed after the commit; a print failure keeps the payout.
 *
 *   crash before 1     nothing happened; the return is still payable.
 *   crash after 1      the drawer may have opened and cash may be gone: the
 *                      till never offers a fresh payout (`start` is refused
 *                      `payout_started`); an operator completes it with
 *                      `retry_drawer` or `manual`, once.
 *   crash after 3      paid out; the slip can be reprinted (as a copy).
 *
 * A kick failure records nothing paid (`drawer_failed`); the payout stays
 * started for `retry_drawer` or `manual`.
 *
 * ## Authorization
 *
 * Admitted with the RT-197 immutable snapshot (manager/admin, flag on,
 * unlocked); re-checked at the commit point after the kick. The paying
 * operator (the snapshot) is recorded and audited. After the slip prints, an
 * answer is given only to the still-admitted session.
 *
 * ## Exactly once
 *
 * The payout row's start and completion are guarded writes; concurrent calls
 * for one return (double click, two windows) share one in-flight operation.
 * The amount is the journal's server-confirmed total; the request has none.
 *
 * ## Shutdown
 *
 * After stop, nothing is read or written (`shutting_down`); a kick or print
 * in flight at stop writes nothing when it settles.
 */
import type {
  ReturnPayoutAction,
  ReturnPayoutMethod,
  ReturnsPayoutRequest,
  ReturnsPayoutResponse,
  ReturnsRefusalReason,
  ReturnsReprintRequest,
  ReturnsReprintResponse,
  ReturnState,
  ReturnJournalView,
} from '../../shared/returns/types.js';
import type { DrawerKickTransport } from '../drawer/drawer-kick-transport.js';
import type { PrintPipeline, RenderedReceipt } from '../receipts/print-pipeline.js';
import type { SalesRepository } from '../sales/repositories/sales.repository.js';
import type { ReturnActor, ReturnsAudit, SlipAuditOutcome } from './returns-audit.js';
import type { AuthSnapshot, ReturnsAuthorizer } from './returns-auth.js';
import { kickReturnDrawer } from './returns-drawer.js';
import type { PayoutRow, ReturnPayoutsRepository } from './returns-payout-repository.js';
import type { JournalEntry, ReturnScope, ReturnsRepository } from './returns-repository.js';
import { renderReturnSlip, type ReturnSlipVariant } from './returns-slip.js';

export interface ReturnsPayoutDeps {
  readonly authorizer: ReturnsAuthorizer;
  readonly repo: Pick<ReturnsRepository, 'read'>;
  readonly payouts: ReturnPayoutsRepository;
  readonly sales: Pick<SalesRepository, 'readById'>;
  readonly audit: ReturnsAudit;
  /** The sale drawer's hardware port (same instance as sales). */
  readonly drawer: DrawerKickTransport;
  /** The receipt print pipeline (same path selection as a sale receipt). */
  readonly printer: Pick<PrintPipeline, 'printRendered'>;
  /** Run `fn` in one local DB transaction (payouts, journal, audit_events). */
  readonly transaction: <T>(fn: () => T) => T;
  /** True once the return domain is stopping (app shutdown). */
  readonly isStopped: () => boolean;
  readonly now: () => string;
  /** The renderer view of a journal row, with its payout. */
  readonly view: (entry: JournalEntry) => ReturnJournalView;
}

export interface ReturnsPayoutAPI {
  payout(req: ReturnsPayoutRequest): Promise<ReturnsPayoutResponse>;
  reprintSlip(req: ReturnsReprintRequest): Promise<ReturnsReprintResponse>;
}

type PayoutOperation = 'payout' | 'reprint';
type Refused = { readonly kind: 'refused'; readonly reason: ReturnsRefusalReason };
type Target = { readonly kind: 'ok'; readonly entry: JournalEntry } | PayoutRefused;
type PayoutRefused = Extract<ReturnsPayoutResponse, { kind: 'refused' }>;
type PrintResult = { readonly ok: true } | { readonly ok: false; readonly failureReason: string };
interface PaidOut {
  readonly entry: JournalEntry;
  readonly payout: PayoutRow;
}

const SHUTTING_DOWN = { kind: 'refused', reason: 'shutting_down' } as const;

/** Why a payout `action` is refused for a return in `state`, or null. */
export function payoutRefusal(
  state: ReturnState,
  started: boolean,
  action: ReturnPayoutAction,
): ReturnsRefusalReason | null {
  if (state === 'paid_out') return 'already_paid_out';
  if (state !== 'confirmed') return 'not_payable';
  if (action === 'start') return started ? 'payout_started' : null;
  return started ? null : 'payout_not_started';
}

function sameScope(a: ReturnScope, b: ReturnScope): boolean {
  return a.tenantId === b.tenantId && a.branchId === b.branchId && a.terminalId === b.terminalId;
}

/** Run `work` once per key: a concurrent call for the same key shares it. */
function shared<T>(inFlight: Map<string, Promise<T>>, key: string, work: () => Promise<T>) {
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const promise = work().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

class ReturnsPayoutService implements ReturnsPayoutAPI {
  private readonly payouts = new Map<string, Promise<ReturnsPayoutResponse>>();
  private readonly reprints = new Map<string, Promise<ReturnsReprintResponse>>();

  constructor(private readonly deps: ReturnsPayoutDeps) {}

  async payout(req: ReturnsPayoutRequest): Promise<ReturnsPayoutResponse> {
    if (this.deps.isStopped()) return { ...SHUTTING_DOWN, ret: null };
    const admitted = this.admit('payout');
    if (admitted.kind !== 'ok') return { ...admitted, ret: null };
    const outcome = await shared(this.payouts, req.returnId, () =>
      this.runPayout(admitted.actor, req),
    );
    const lost = this.lostAfterAwait(admitted.actor, outcome);
    return lost === null ? outcome : { ...lost, ret: null };
  }

  async reprintSlip(req: ReturnsReprintRequest): Promise<ReturnsReprintResponse> {
    if (this.deps.isStopped()) return SHUTTING_DOWN;
    const admitted = this.admit('reprint');
    if (admitted.kind !== 'ok') return admitted;
    const outcome = await shared(this.reprints, req.returnId, () =>
      this.runReprint(admitted.actor, req.returnId),
    );
    return this.lostAfterAwait(admitted.actor, outcome) ?? outcome;
  }

  /** Gate + snapshot (flag, session, manager/admin, unlocked); refusals audited. */
  private admit(op: PayoutOperation): { kind: 'ok'; actor: AuthSnapshot } | Refused {
    const live = this.deps.authorizer.current();
    if (live.kind === 'ok') return { kind: 'ok', actor: live.actor };
    if (live.actor !== null) this.auditRefusal(live.actor, op, live.reason, null);
    return { kind: 'refused', reason: live.reason };
  }

  /**
   * After the awaited work: null while the admitted actor is still the live
   * one; else the refusal to answer with instead (no data; not audited — the
   * work itself is recorded with its true state).
   */
  private lostAfterAwait(actor: AuthSnapshot, outcome: { kind: string; reason?: unknown }) {
    if (outcome.kind === 'refused' && outcome.reason === 'shutting_down') return null;
    const lost = this.deps.authorizer.recheck(actor);
    return lost === null ? null : ({ kind: 'refused', reason: lost } as const);
  }

  private auditRefusal(
    actor: ReturnActor,
    op: PayoutOperation,
    reason: ReturnsRefusalReason,
    entry: JournalEntry | null,
  ): void {
    this.deps.audit.refused(actor, {
      return_id: entry?.returnId ?? null,
      sale_id: entry?.saleId ?? null,
      sale_ref: entry?.serverSaleRef ?? null,
      operation: op,
      reason,
    });
  }

  private refusePayout(
    actor: AuthSnapshot,
    reason: ReturnsRefusalReason,
    entry: JournalEntry | null,
  ) {
    this.auditRefusal(actor, 'payout', reason, entry);
    const ret = entry === null ? null : this.viewOf(entry);
    return { kind: 'refused', reason, ret } as const;
  }

  /** The journal row as it stands now, as the renderer sees it. */
  private viewOf(entry: JournalEntry): ReturnJournalView {
    return this.deps.view(this.deps.repo.read(entry.returnId) ?? entry);
  }

  /** This terminal's return, or null (another terminal's is never disclosed). */
  private ownReturn(actor: AuthSnapshot, returnId: string): JournalEntry | null {
    const entry = this.deps.repo.read(returnId);
    return entry !== null && sameScope(entry.scope, actor.scope) ? entry : null;
  }

  private target(actor: AuthSnapshot, req: ReturnsPayoutRequest): Target {
    const entry = this.ownReturn(actor, req.returnId);
    if (entry === null) return this.refusePayout(actor, 'return_not_found', null);
    const started = this.deps.payouts.read(entry.returnId) !== null;
    const reason = payoutRefusal(entry.state, started, req.action);
    return reason === null ? { kind: 'ok', entry } : this.refusePayout(actor, reason, entry);
  }

  private async runPayout(actor: AuthSnapshot, req: ReturnsPayoutRequest) {
    const target = this.target(actor, req);
    if (target.kind !== 'ok') return target;
    if (req.action === 'manual') return this.commit(actor, target.entry, 'manual');
    if (req.action === 'start' && !this.claim(actor, target.entry)) {
      return this.refusePayout(actor, 'payout_started', target.entry);
    }
    return this.kickThenCommit(actor, target.entry);
  }

  /** Step 1: the durable claim and its audit, before the drawer opens. */
  private claim(actor: AuthSnapshot, entry: JournalEntry): boolean {
    return this.deps.transaction(() => {
      const started = this.deps.payouts.start({
        returnId: entry.returnId,
        operatorId: actor.operatorId,
        sessionId: actor.operatorSessionId,
        now: this.deps.now(),
      });
      if (started) this.deps.audit.payoutStarted(actor, entry);
      return started;
    });
  }

  /** Steps 2–3: the kick, then (only if it opened and the actor still holds) the commit. */
  private async kickThenCommit(actor: AuthSnapshot, entry: JournalEntry) {
    const kick = await kickReturnDrawer(this.deps.drawer);
    if (this.deps.isStopped()) return { ...SHUTTING_DOWN, ret: null };
    this.deps.audit.drawer(actor, entry, kick);
    if (!kick.ok) {
      return { kind: 'drawer_failed', ret: this.viewOf(entry), reason: kick.reason } as const;
    }
    const lost = this.deps.authorizer.recheck(actor);
    if (lost !== null) return this.refusePayout(actor, lost, entry);
    return this.commit(actor, entry, 'drawer');
  }

  /** Step 3: payout row paid + header paid_out + audit, atomically; then the slip. */
  private async commit(actor: AuthSnapshot, entry: JournalEntry, method: ReturnPayoutMethod) {
    const paid = this.deps.transaction(() => {
      const done = this.deps.payouts.complete({
        returnId: entry.returnId,
        operatorId: actor.operatorId,
        operatorName: actor.displayName ?? null,
        sessionId: actor.operatorSessionId,
        method,
        now: this.deps.now(),
      });
      if (done) this.deps.audit.paidOut(actor, entry, method);
      return done;
    });
    if (!paid) return this.refusePayout(actor, 'already_paid_out', entry);
    const ret = this.viewOf(entry);
    const printed = await this.printSlip(actor, this.paidOut(entry.returnId), { kind: 'original' });
    const slip = printed.ok ? 'printed' : 'failed';
    return { kind: 'paid_out', ret, method, slip } as const;
  }

  /** A paid-out return with its completed payout, or null. */
  private paidOut(returnId: string): PaidOut | null {
    const entry = this.deps.repo.read(returnId);
    const payout = this.deps.payouts.read(returnId);
    if (entry?.state !== 'paid_out' || payout?.paidAt == null) return null;
    return { entry, payout };
  }

  private async runReprint(actor: AuthSnapshot, returnId: string): Promise<ReturnsReprintResponse> {
    const entry = this.ownReturn(actor, returnId);
    if (entry === null) return this.refuseReprint(actor, 'return_not_found', null);
    const paid = this.paidOut(returnId);
    if (paid === null) return this.refuseReprint(actor, 'not_paid_out', entry);
    const printed = await this.printSlip(actor, paid, {
      kind: 'copy',
      reprintedAt: this.deps.now(),
    });
    return printed.ok ? { kind: 'printed' } : { kind: 'print_failed' };
  }

  private refuseReprint(
    actor: AuthSnapshot,
    reason: ReturnsRefusalReason,
    entry: JournalEntry | null,
  ) {
    this.auditRefusal(actor, 'reprint', reason, entry);
    return { kind: 'refused', reason } as const;
  }

  /**
   * Step 4: render (before any await), print, then audit unless stopping.
   * `paid` is null only if the commit's own row vanished (a programming
   * error): reported as a failed slip, never as a lost payout.
   */
  private async printSlip(actor: AuthSnapshot, paid: PaidOut | null, variant: ReturnSlipVariant) {
    if (paid === null) return { ok: false, failureReason: 'os_print_error' } as const;
    const printed = await this.print(() => this.renderSlip(paid, variant));
    if (!this.deps.isStopped()) {
      const copy = variant.kind === 'copy';
      const outcome: SlipAuditOutcome = printed.ok
        ? { copy, ok: true }
        : { copy, ok: false, failureReason: printed.failureReason };
      this.deps.audit.slip(actor, paid.entry, outcome);
    }
    return printed;
  }

  private renderSlip({ entry, payout }: PaidOut, variant: ReturnSlipVariant): RenderedReceipt {
    const sale = this.deps.sales.readById(entry.saleId);
    const header =
      sale === null ? null : { branchName: sale.branch_name, terminalLabel: sale.terminal_label };
    const lines = this.deps.payouts.slipLines(entry.returnId);
    return renderReturnSlip({ entry, payout, lines, sale: header }, variant);
  }

  /**
   * Render (synchronously, before any await: the DB reads happen now) and
   * print; the pipeline's answer as a closed result. A throw from either is
   * an OS print error: the payout is already committed and must not be lost.
   */
  private async print(render: () => RenderedReceipt): Promise<PrintResult> {
    try {
      const result = await this.deps.printer.printRendered(render());
      return result.ok ? { ok: true } : { ok: false, failureReason: result.failure_reason };
    } catch {
      return { ok: false, failureReason: 'os_print_error' };
    }
  }
}

export function createReturnsPayoutService(deps: ReturnsPayoutDeps): ReturnsPayoutAPI {
  return new ReturnsPayoutService(deps);
}
