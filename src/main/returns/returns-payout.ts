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
 * ## Exactly once, one at a time
 *
 * The payout row's start and completion are guarded writes. The terminal has
 * ONE cash drawer, so it runs ONE payout at a time (Codex P2, f1a8907): the
 * same admitted actor's repeat for the same return (double click, second
 * window) shares the running operation; any other payout request meanwhile
 * (another return, another actor) is refused `another_payout_in_progress`,
 * never queued. The slot is process-local: one payout per terminal holds
 * given RT-203's Electron single-instance lock (one app process per
 * terminal). The durable kick lease stays as defence in depth for a single
 * payout's completion.
 * The amount is the journal's server-confirmed total; the request has none.
 *
 * ## Shutdown
 *
 * After stop, nothing is read or written (`shutting_down`); a kick or print
 * in flight at stop writes nothing when it settles (RT-198: the stop latch is
 * the first check after every await). A kick in flight at quit is remembered
 * by its durable `sending` mark (P1): it reads as in flight, then unknown,
 * never retryable; the DB closes right after stop in any case.
 */
import type {
  LocalReturnRefusal,
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
import type {
  DrawerAuditOutcome,
  ReturnActor,
  ReturnsAudit,
  SlipAuditOutcome,
} from './returns-audit.js';
import type { AuthSnapshot, ReturnsAuthorizer } from './returns-auth.js';
import { payoutActionRefusal } from '../../shared/returns/payout-rules.js';
import { kickReturnDrawer, kickStateOf, type ReturnDrawerOutcome } from './returns-drawer.js';
import type {
  CompleteResult,
  KickResult,
  PayoutRow,
  ReturnPayoutsRepository,
} from './returns-payout-repository.js';
import type { JournalEntry, ReturnScope, ReturnsRepository } from './returns-repository.js';
import { renderReturnSlip, slipTotalsAgree, type ReturnSlipVariant } from './returns-slip.js';

/** The slip's lines do not add up to the confirmed refund: printed nowhere. */
class SlipTotalMismatch extends Error {
  constructor() {
    super('returns-payout: slip lines do not add up to the refund');
  }
}

/** The failure reason a slip that does not add up is recorded with. */
const SLIP_TOTAL_MISMATCH = 'slip_total_mismatch';

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
/** A side effect that did not run: the admitted snapshot no longer holds. */
interface Lost {
  readonly lost: LocalReturnRefusal;
}

function isLost(value: unknown): value is Lost {
  return typeof value === 'object' && value !== null && 'lost' in value;
}

type PrintResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failureReason: string }
  | ({ readonly ok: false } & Lost);
interface PaidOut {
  readonly entry: JournalEntry;
  readonly payout: PayoutRow;
}

const SHUTTING_DOWN = { kind: 'refused', reason: 'shutting_down' } as const;

/** The started payout's kick record, as `payoutRefusal` needs it (null: none started). */
export type StartedPayout = Pick<PayoutRow, 'kickOutcome' | 'kickedAt'> | null;

/**
 * Codex P1: a kick still `sending` within the lease is in flight (possibly in
 * another app instance): nothing may complete the payout meanwhile. The lease
 * is bounded on both sides (reviewer P2: a backward clock jump never extends it).
 */
export function kickInFlight(payout: NonNullable<StartedPayout>, now: string): boolean {
  return payout.kickedAt !== null && kickStateOf(payout, now) === 'in_flight';
}

/**
 * Why a payout `action` is refused for a return in `state`, or null.
 * P1: `retry_drawer` only while the last kick provably never reached the
 * drawer (or there was none); after `opened`, `unknown` or a kick still
 * `sending` (a crash mid-kick) only the manual, attested payout remains.
 */
export function payoutRefusal(
  state: ReturnState,
  payout: StartedPayout,
  action: ReturnPayoutAction,
  now: string,
): ReturnsRefusalReason | null {
  const kick = payout === null ? 'none' : kickStateOf(payout, now);
  // The one rule the renderer applies too (src/shared/returns/payout-rules.ts).
  return payoutActionRefusal({ state, started: payout !== null, kick }, action);
}

/**
 * Codex P2: why a completion that changed nothing is refused. Another
 * instance may have won the race between this one's checks and its commit:
 * a kick it sent meanwhile is in progress, never "already paid out".
 */
const NOT_COMPLETED: Readonly<Record<Exclude<CompleteResult, 'completed'>, ReturnsRefusalReason>> =
  {
    already_paid: 'already_paid_out',
    kick_in_progress: 'drawer_kick_in_progress',
    not_started: 'payout_not_started',
    drawer_not_opened: 'drawer_retry_unsafe',
  };

/**
 * What a kick's answer proves about the drawer. Only "no drawer configured"
 * provably never reached the hardware; a timeout, a transport or printer
 * fault, or an answer outside the contract may have opened it.
 */
export function kickResultOf(kick: ReturnDrawerOutcome): KickResult {
  if (kick.ok) return 'opened';
  return kick.reason === 'no_drawer_configured' ? 'failed_before_send' : 'unknown';
}

/** The drawer audit of a kick: opened, or why not and what that proves. */
function drawerAuditOf(kick: ReturnDrawerOutcome): DrawerAuditOutcome {
  if (kick.ok) return kick;
  const kickOutcome = kick.reason === 'no_drawer_configured' ? 'failed_before_send' : 'unknown';
  return { ok: false, reason: kick.reason, kickOutcome };
}

function sameScope(a: ReturnScope, b: ReturnScope): boolean {
  return a.tenantId === b.tenantId && a.branchId === b.branchId && a.terminalId === b.terminalId;
}

/** An operation in flight for one return, and the admitted actor it runs for. */
interface InFlight<T> {
  readonly actor: string;
  readonly promise: Promise<T>;
}

/** The admitted actor's identity: terminal scope + operator session. */
function actorKey(actor: AuthSnapshot): string {
  const { tenantId, branchId, terminalId } = actor.scope;
  return [tenantId, branchId, terminalId, actor.operatorId, actor.operatorSessionId].join('|');
}

const settled = (): void => undefined;

/**
 * One operation per return at a time. The SAME admitted actor (a double
 * click, a second window of the same session) shares the running operation
 * and its answer. Any other actor (a new operator, a new terminal scope)
 * never sees that answer: it waits for the running operation to settle, then
 * runs its own, fully checked one — so no foreign result, no concurrent kick.
 */
function serialized<T>(
  inFlight: Map<string, InFlight<T>>,
  returnId: string,
  actor: AuthSnapshot,
  work: () => Promise<T>,
): Promise<T> {
  const key = actorKey(actor);
  const running = inFlight.get(returnId);
  if (running?.actor === key) return running.promise;
  const before = running === undefined ? Promise.resolve() : running.promise.then(settled, settled);
  const promise: Promise<T> = before.then(work).finally(() => {
    if (inFlight.get(returnId)?.promise === promise) inFlight.delete(returnId);
  });
  inFlight.set(returnId, { actor: key, promise });
  return promise;
}

/** The one payout running on this terminal: its request and admitted actor. */
interface ActivePayout extends InFlight<ReturnsPayoutResponse> {
  readonly returnId: string;
  readonly action: ReturnPayoutAction;
}

class ReturnsPayoutService implements ReturnsPayoutAPI {
  /**
   * One drawer per terminal: one payout at a time (start + kick, retry +
   * kick, through the paid commit; released before the slip prints).
   * Process-local by design: cross-process exclusion relies on RT-203's
   * Electron single-instance lock (one app process per terminal); it is not
   * enforced in the database (owner decision on Codex P1, 60eb2c9).
   */
  private active: ActivePayout | null = null;
  private readonly reprints = new Map<string, InFlight<ReturnsReprintResponse>>();

  constructor(private readonly deps: ReturnsPayoutDeps) {}

  async payout(req: ReturnsPayoutRequest): Promise<ReturnsPayoutResponse> {
    if (this.deps.isStopped()) return { ...SHUTTING_DOWN, ret: null };
    const admitted = this.admit('payout');
    if (admitted.kind !== 'ok') return { ...admitted, ret: null };
    const outcome = await this.exclusive(admitted.actor, req);
    const lost = this.lostAfterAwait(admitted.actor, outcome);
    return lost === null ? outcome : { ...lost, ret: null };
  }

  async reprintSlip(req: ReturnsReprintRequest): Promise<ReturnsReprintResponse> {
    if (this.deps.isStopped()) return SHUTTING_DOWN;
    const admitted = this.admit('reprint');
    if (admitted.kind !== 'ok') return admitted;
    const outcome = await serialized(this.reprints, req.returnId, admitted.actor, () =>
      this.runReprint(admitted.actor, req.returnId),
    );
    return this.lostAfterAwait(admitted.actor, outcome) ?? outcome;
  }

  /**
   * The terminal's one payout slot. The same actor repeating the running
   * request's return joins it; anything else while it runs is refused (not
   * queued: a hidden cash operation must never start later on its own).
   */
  private exclusive(actor: AuthSnapshot, req: ReturnsPayoutRequest) {
    const key = actorKey(actor);
    const running = this.active;
    if (running !== null) return this.whileRunning(running, actor, req);
    const promise = Promise.resolve()
      .then(() => this.runPayout(actor, req))
      .finally(() => {
        if (this.active?.promise === promise) this.active = null;
      });
    this.active = { returnId: req.returnId, action: req.action, actor: key, promise };
    return promise;
  }

  /**
   * Codex P1 (a55ae8e): only an IDENTICAL request (same actor, return and
   * action: a double click, a second window) joins the running payout. The
   * same actor asking another step of it (a manual attestation while its
   * kick runs) is refused `payout_step_in_progress`, never silently joined;
   * anything else is `another_payout_in_progress`.
   */
  private whileRunning(running: ActivePayout, actor: AuthSnapshot, req: ReturnsPayoutRequest) {
    const sameReturn = running.returnId === req.returnId && running.actor === actorKey(actor);
    if (sameReturn && running.action === req.action) return running.promise;
    const reason = sameReturn ? 'payout_step_in_progress' : 'another_payout_in_progress';
    return Promise.resolve(this.busy(actor, req.returnId, reason));
  }

  /**
   * Reviewer P2 (60eb2c9): the drawer work of the running payout is done
   * (paid): free the slot before its slip prints, so a print that never
   * answers cannot hold the drawer. The running payout's own promise (shared
   * by its double click) still settles with the slip.
   */
  private releaseSlot(returnId: string): void {
    if (this.active?.returnId === returnId) this.active = null;
  }

  /** Another payout (step) runs on this terminal: refused, with this terminal's own row. */
  private busy(
    actor: AuthSnapshot,
    returnId: string,
    reason: 'another_payout_in_progress' | 'payout_step_in_progress',
  ) {
    return this.refusePayout(actor, reason, this.ownReturn(actor, returnId));
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
    const payout = this.deps.payouts.read(entry.returnId);
    const reason = payoutRefusal(entry.state, payout, req.action, this.deps.now());
    return reason === null ? { kind: 'ok', entry } : this.refusePayout(actor, reason, entry);
  }

  /**
   * THE gate of every side effect (the RT-197 class rule, applied here to the
   * claim, each drawer kick, the paid commit and each slip print): `run` runs
   * only while the admitted snapshot is still the live, authorized actor,
   * checked immediately before it, synchronously. Facts that already
   * happened (a kick's outcome, a slip's result, a refusal) are recorded
   * without it.
   */
  private effect<T>(actor: AuthSnapshot, run: () => T): T | Lost {
    const lost = this.deps.authorizer.recheck(actor);
    return lost === null ? run() : { lost };
  }

  private async runPayout(actor: AuthSnapshot, req: ReturnsPayoutRequest) {
    // A queued operation may start after stop: touch nothing then.
    if (this.deps.isStopped()) return { ...SHUTTING_DOWN, ret: null };
    // Queued work may run long after admission: the actor must still hold
    // before anything is even read.
    const lost = this.deps.authorizer.recheck(actor);
    if (lost !== null) return this.refusePayout(actor, lost, null);
    const target = this.target(actor, req);
    if (target.kind !== 'ok') return target;
    const { action } = req;
    if (action === 'manual') return this.commit(actor, target.entry, 'manual');
    const kick = this.effect(actor, () => this.markAndKick(actor, target.entry, action));
    if (isLost(kick)) return this.refusePayout(actor, kick.lost, target.entry);
    if (typeof kick === 'string') return this.refusePayout(actor, kick, target.entry);
    return this.afterKick(actor, target.entry, await kick);
  }

  /**
   * One synchronous step behind the gate: mark the kick about to be sent
   * (with the claim for `start`, or a retry after a kick that never left),
   * then call the drawer. Why not, instead of a kick in flight.
   */
  private markAndKick(
    actor: AuthSnapshot,
    entry: JournalEntry,
    action: Exclude<ReturnPayoutAction, 'manual'>,
  ): ReturnsRefusalReason | Promise<ReturnDrawerOutcome> {
    const refused = action === 'start' ? this.claim(actor, entry) : this.markRetry(entry);
    return refused ?? kickReturnDrawer(this.deps.drawer);
  }

  /**
   * Step 1: the durable claim, the kick about to be sent (`sending`) and the
   * `payout_started` audit, in one transaction, before the drawer is kicked.
   * Null when claimed; else why not (another process claimed first).
   */
  private claim(actor: AuthSnapshot, entry: JournalEntry): ReturnsRefusalReason | null {
    return this.deps.transaction(() => {
      const now = this.deps.now();
      const { returnId } = entry;
      const input = {
        returnId,
        operatorId: actor.operatorId,
        sessionId: actor.operatorSessionId,
        now,
      };
      if (!this.deps.payouts.start(input)) return 'payout_started';
      if (!this.deps.payouts.markSending({ returnId, now }))
        throw new Error('returns-payout: claim not kickable');
      this.deps.audit.payoutStarted(actor, entry);
      return null;
    });
  }

  /** A retry: the kick about to be sent, only after one that provably never left. */
  private markRetry(entry: JournalEntry): ReturnsRefusalReason | null {
    const marked = this.deps.payouts.markSending({
      returnId: entry.returnId,
      now: this.deps.now(),
    });
    return marked ? null : 'drawer_retry_unsafe';
  }

  /**
   * Steps 2–3 after the kick. RT-198: the stop latch first — after stop the
   * DB is closed, and the durable `sending` mark already remembers the kick
   * (P1). Then its outcome persisted and audited (before any recheck can
   * return: the till must remember a drawer that opened); then, only if it
   * opened, the commit (itself behind the gate).
   */
  private async afterKick(actor: AuthSnapshot, entry: JournalEntry, kick: ReturnDrawerOutcome) {
    if (this.deps.isStopped()) return { ...SHUTTING_DOWN, ret: null };
    this.persistKick(actor, entry, kick);
    if (!kick.ok) {
      return { kind: 'drawer_failed', ret: this.viewOf(entry), reason: kick.reason } as const;
    }
    return this.commit(actor, entry, 'drawer');
  }

  /** The kick's outcome and its audit, in one transaction. */
  private persistKick(actor: AuthSnapshot, entry: JournalEntry, kick: ReturnDrawerOutcome): void {
    const outcome = kickResultOf(kick);
    const audited = drawerAuditOf(kick);
    this.deps.transaction(() => {
      if (this.deps.payouts.recordKick({ returnId: entry.returnId, outcome })) {
        this.deps.audit.drawer(actor, entry, audited);
      }
    });
  }

  /**
   * Step 3: payout row paid + header paid_out + audit, atomically; then the
   * slip, outside the terminal slot (printing never touches the drawer).
   */
  private async commit(actor: AuthSnapshot, entry: JournalEntry, method: ReturnPayoutMethod) {
    const paid = this.effect(actor, () => this.completePayout(actor, entry, method));
    if (isLost(paid)) return this.refusePayout(actor, paid.lost, entry);
    if (paid !== 'completed') return this.refusePayout(actor, NOT_COMPLETED[paid], entry);
    this.releaseSlot(entry.returnId);
    const ret = this.viewOf(entry);
    const printed = await this.printSlip(actor, this.paidOut(entry.returnId), { kind: 'original' });
    const slip = printed.ok ? 'printed' : 'failed';
    return { kind: 'paid_out', ret, method, slip } as const;
  }

  /** The payout row paid + header paid_out + the `paid_out` audit, in one transaction. */
  private completePayout(actor: AuthSnapshot, entry: JournalEntry, method: ReturnPayoutMethod) {
    return this.deps.transaction(() => {
      const done = this.deps.payouts.complete({
        returnId: entry.returnId,
        operatorId: actor.operatorId,
        operatorName: actor.displayName ?? null,
        sessionId: actor.operatorSessionId,
        method,
        now: this.deps.now(),
      });
      if (done === 'completed') this.deps.audit.paidOut(actor, entry, method);
      return done;
    });
  }

  /** A paid-out return with its completed payout, or null. */
  private paidOut(returnId: string): PaidOut | null {
    const entry = this.deps.repo.read(returnId);
    const payout = this.deps.payouts.read(returnId);
    if (entry?.state !== 'paid_out' || payout?.paidAt == null) return null;
    return { entry, payout };
  }

  private async runReprint(actor: AuthSnapshot, returnId: string): Promise<ReturnsReprintResponse> {
    if (this.deps.isStopped()) return SHUTTING_DOWN;
    // Queued work: the actor must still hold before anything is read.
    const lost = this.deps.authorizer.recheck(actor);
    if (lost !== null) return this.refuseReprint(actor, lost, null);
    const entry = this.ownReturn(actor, returnId);
    if (entry === null) return this.refuseReprint(actor, 'return_not_found', null);
    const paid = this.paidOut(returnId);
    if (paid === null) return this.refuseReprint(actor, 'not_paid_out', entry);
    const printed = await this.printSlip(actor, paid, {
      kind: 'copy',
      reprintedAt: this.deps.now(),
    });
    if (printed.ok) return { kind: 'printed' };
    if (isLost(printed)) return this.refuseReprint(actor, printed.lost, entry);
    // Not a printer failure: the slip is refused (and audited as not printed).
    if (printed.failureReason === SLIP_TOTAL_MISMATCH)
      return { kind: 'refused', reason: SLIP_TOTAL_MISMATCH };
    return { kind: 'print_failed' };
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
    const printed = await this.print(actor, () => this.renderSlip(paid, variant));
    // Nothing was printed for a lost actor: not a print failure, no audit.
    if (isLost(printed)) return printed;
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
    const total = entry.returnTotalMinor ?? entry.quotedTotalMinor;
    if (!slipTotalsAgree(lines, total)) throw new SlipTotalMismatch();
    return renderReturnSlip({ entry, payout, lines, sale: header }, variant);
  }

  /**
   * Render (synchronously, before any await: the DB reads happen now) and
   * print, behind the gate; the pipeline's answer as a closed result. A throw from either is
   * an OS print error: the payout is already committed and must not be lost.
   */
  private async print(actor: AuthSnapshot, render: () => RenderedReceipt): Promise<PrintResult> {
    try {
      // Behind the gate: render and hand to the printer only for a live actor.
      const sent = this.effect(actor, () => this.deps.printer.printRendered(render()));
      if (isLost(sent)) return { ok: false, lost: sent.lost };
      const result = await sent;
      return result.ok ? { ok: true } : { ok: false, failureReason: result.failure_reason };
    } catch (err) {
      const reason = err instanceof SlipTotalMismatch ? SLIP_TOTAL_MISMATCH : 'os_print_error';
      return { ok: false, failureReason: reason };
    }
  }
}

export function createReturnsPayoutService(deps: ReturnsPayoutDeps): ReturnsPayoutAPI {
  return new ReturnsPayoutService(deps);
}
