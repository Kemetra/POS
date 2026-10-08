/**
 * RT-15 S2 — send one journaled return and record what Backend-Core said.
 *
 * Shared by the submit path and the resolver, so a first send and every
 * re-send behave identically: the journaled body bytes, the same
 * `Idempotency-Key` (= `externalId`), the same outcome mapping.
 *
 *   recorded (201 / 200 / replay)  → confirmed; audit confirmed + payout_ready
 *   refused                        → refused;   audit refused
 *   unknown (timeout / network…)   → unknown;   never success (AC9/AC10)
 *
 * A confirmation must name this return (`externalId`, `saleRef`), be in its
 * currency, return only the requested lines and quantities, and carry exactly
 * the quoted refund (the cash tender the server
 * checked against its own total); otherwise the row stays `unknown` and the anomaly is logged — nothing is
 * paid out on an answer the till cannot match.
 *
 * Confirmation is written once and atomically: the guarded `markConfirmed`
 * and both its audit rows (`confirmed`, `payout_ready`) commit in ONE local
 * transaction (`audit_events` lives in the same SQLite DB), and the audits are
 * written only when the transition changed the row. A second confirmation (a
 * resolver racing a submit, a later replay) therefore writes nothing (AC8). The
 * refusal transition and its audit are atomic the same way. If that local
 * commit fails, it rolls back: the row stays `pending` / `unknown`, the result
 * is `unconfirmed` (never a rejected call once the server has answered), and
 * the resolver's same-key resend confirms it later. Sends of the same return
 * are single-flight within the process.
 */
import type { ReturnsRefusalReason } from '../../shared/returns/types.js';
import { exponentFor } from '../sales-sync/create-sale-sync-client.js';
import type { ReturnsAudit } from './returns-audit.js';
import type { AuthSnapshot, ReturnsAuthorizer } from './returns-auth.js';
import type { RecordReturnOutcome, ReturnsClient } from './returns-client.js';
import { amount4ToMinor, parseAmount4 } from './returns-money.js';
import type { ConfirmInput, JournalEntry, ReturnsRepository } from './returns-repository.js';
import { returnedLinesMatch } from './returns-verify.js';
import type { WireSaleReturn } from './returns-wire.js';

export type DispatchOutcome =
  | { readonly kind: 'confirmed'; readonly entry: JournalEntry; readonly replayed: boolean }
  | { readonly kind: 'unconfirmed'; readonly entry: JournalEntry }
  /** Not sent: the actor is no longer authorized; the row stays pending/unknown. */
  | { readonly kind: 'deferred'; readonly entry: JournalEntry }
  | {
      readonly kind: 'refused';
      readonly reason: ReturnsRefusalReason;
      readonly entry: JournalEntry;
    };

export type DispatchOperation = 'submit' | 'resolve';

export interface ReturnsDispatcher {
  /**
   * Send `entry` on behalf of the authorization `snapshot`: re-checked against
   * the live state right before the POST, which carries the snapshot's envelope.
   */
  send(
    entry: JournalEntry,
    operation: DispatchOperation,
    snapshot: AuthSnapshot,
  ): Promise<DispatchOutcome>;
}

export interface ReturnsDispatchLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ReturnsDispatchDeps {
  readonly client: Pick<ReturnsClient, 'recordReturn'>;
  readonly repo: ReturnsRepository;
  readonly audit: ReturnsAudit;
  /** The choke point: re-authorizes the actor immediately before every send. */
  readonly authorizer: Pick<ReturnsAuthorizer, 'recheck'>;
  /**
   * True once the return domain is stopping (app shutdown). No send starts
   * after it, and a send in flight when it flips does no local reads/writes
   * when it settles (the DB may already be closed).
   */
  readonly isStopped: () => boolean;
  /** Run `fn` in one local DB transaction (journal + audit_events). */
  readonly transaction: <T>(fn: () => T) => T;
  readonly now: () => string;
  readonly logger: ReturnsDispatchLogger;
}

/** What the current journal row says, for a send that changed nothing. */
function outcomeOfState(entry: JournalEntry): DispatchOutcome {
  if (entry.state === 'confirmed' || entry.state === 'paid_out') {
    return { kind: 'confirmed', entry, replayed: false };
  }
  if (entry.state === 'refused' && entry.refusalReason !== null) {
    return { kind: 'refused', reason: entry.refusalReason, entry };
  }
  return { kind: 'unconfirmed', entry };
}

/** The answer names this return: its externalId, sale, currency and lines. */
function isThisReturn(entry: JournalEntry, saleReturn: WireSaleReturn): boolean {
  if (saleReturn.externalId !== entry.externalId) return false;
  if (saleReturn.saleRef.toLowerCase() !== entry.serverSaleRef.toLowerCase()) return false;
  if (saleReturn.currencyCode !== entry.currencyCode) return false;
  return returnedLinesMatch(entry.lines, saleReturn.lines);
}

/** The server's refund in minor units when it matches this return; else null. */
function matchingTotalMinor(entry: JournalEntry, saleReturn: WireSaleReturn): number | null {
  if (!isThisReturn(entry, saleReturn)) return null;
  const total4 = parseAmount4(saleReturn.returnTotal);
  const minor = total4 === null ? null : amount4ToMinor(total4, exponentFor(entry.currencyCode));
  return minor === entry.quotedTotalMinor ? minor : null;
}

interface SendRequest {
  readonly entry: JournalEntry;
  readonly op: DispatchOperation;
  readonly snapshot: AuthSnapshot;
}

class JournaledReturnsDispatcher implements ReturnsDispatcher {
  private readonly inFlight = new Map<string, Promise<DispatchOutcome>>();

  constructor(private readonly deps: ReturnsDispatchDeps) {}

  send(
    entry: JournalEntry,
    operation: DispatchOperation,
    snapshot: AuthSnapshot,
  ): Promise<DispatchOutcome> {
    const running = this.inFlight.get(entry.returnId);
    if (running !== undefined) return running;
    const promise = this.sendOnce({ entry, op: operation, snapshot }).finally(() => {
      this.inFlight.delete(entry.returnId);
    });
    this.inFlight.set(entry.returnId, promise);
    return promise;
  }

  private async sendOnce(send: SendRequest): Promise<DispatchOutcome> {
    const { entry, op } = send;
    if (this.deps.isStopped()) return { kind: 'deferred', entry };
    const current = this.current(entry);
    // Commit point (b): never send for a snapshot whose actor is no longer
    // authorized or whose envelope is no longer live.
    if (this.deps.authorizer.recheck(send.snapshot) !== null) {
      this.deps.logger.warn({ return_id: entry.returnId }, 'returns:send_deferred_unauthorized');
      return { kind: 'deferred', entry: current };
    }
    const attempted = current.attemptCount > 0;
    this.deps.repo.recordAttempt({ returnId: entry.returnId, now: this.deps.now() });
    // A5: the POST carries the rechecked snapshot's own envelope — no live
    // session or token read happens between the recheck and the wire.
    const outcome = await this.deps.client.recordReturn(
      {
        saleRef: entry.serverSaleRef,
        bodyJson: entry.requestBodyJson,
        idempotencyKey: entry.externalId,
        // P1: a send that may follow an earlier one never turns a pre-replay
        // 401/403/404 into a terminal refusal (the return may be recorded).
        // `recordAttempt` is committed before every POST, so a pre-increment
        // count of 0 proves no earlier send reached the server: a first send.
        resend: attempted,
      },
      send.snapshot.envelope,
    );
    // Stopped while the POST was in flight: touch nothing local (the DB may be
    // closed). The row stays pending/unknown; the next start re-sends it.
    if (this.deps.isStopped()) return { kind: 'deferred', entry };
    try {
      return this.apply(entry, outcome, op);
    } catch {
      this.deps.logger.warn({ return_id: entry.returnId }, 'returns:local_commit_failed');
      return this.pendingLocally(entry);
    }
  }

  /** The server answered but the local commit failed: report unknown, never reject. */
  private pendingLocally(entry: JournalEntry): DispatchOutcome {
    try {
      return this.unconfirmed(entry);
    } catch {
      return { kind: 'unconfirmed', entry: { ...entry, state: 'unknown' } };
    }
  }

  private apply(entry: JournalEntry, outcome: RecordReturnOutcome, op: DispatchOperation) {
    if (outcome.kind === 'recorded') {
      return this.confirm(entry, outcome.saleReturn, outcome.replayed);
    }
    if (outcome.kind === 'refused') return this.refuse(entry, outcome.reason, op);
    return this.unconfirmed(entry);
  }

  private current(entry: JournalEntry): JournalEntry {
    return this.deps.repo.read(entry.returnId) ?? entry;
  }

  private unconfirmed(entry: JournalEntry): DispatchOutcome {
    this.deps.repo.markUnknown({ returnId: entry.returnId, now: this.deps.now() });
    return outcomeOfState(this.current(entry));
  }

  private confirm(entry: JournalEntry, saleReturn: WireSaleReturn, replayed: boolean) {
    const totalMinor = matchingTotalMinor(entry, saleReturn);
    if (totalMinor === null) {
      this.deps.logger.warn({ return_id: entry.returnId }, 'returns:confirmation_mismatch');
      return this.unconfirmed(entry);
    }
    const input = {
      returnId: entry.returnId,
      returnRef: saleReturn.returnRef,
      returnTotalMinor: totalMinor,
      now: this.deps.now(),
    };
    const changed = this.deps.transaction(() => this.commitConfirmation(input, replayed));
    const fresh = this.current(entry);
    return changed
      ? ({ kind: 'confirmed', entry: fresh, replayed } as const)
      : outcomeOfState(fresh);
  }

  /** Inside the transaction: the guarded transition, then its two audits. */
  private commitConfirmation(input: ConfirmInput, replayed: boolean): boolean {
    if (!this.deps.repo.markConfirmed(input)) return false;
    const confirmed = this.deps.repo.read(input.returnId);
    if (confirmed === null) throw new Error('returns-dispatch: confirmed row vanished');
    this.deps.audit.confirmed(confirmed, replayed);
    this.deps.audit.payoutReady(confirmed);
    return true;
  }

  private refuse(entry: JournalEntry, reason: ReturnsRefusalReason, op: DispatchOperation) {
    const changed = this.deps.transaction(() => this.commitRefusal(entry, reason, op));
    const fresh = this.current(entry);
    return changed ? ({ kind: 'refused', reason, entry: fresh } as const) : outcomeOfState(fresh);
  }

  /** Inside the transaction: the guarded refusal, then its audit. */
  private commitRefusal(entry: JournalEntry, reason: ReturnsRefusalReason, op: DispatchOperation) {
    const now = this.deps.now();
    if (!this.deps.repo.markRefused({ returnId: entry.returnId, reason, now })) return false;
    const { scope, operatorId, operatorSessionId } = entry;
    this.deps.audit.refused(
      { scope, operatorId, operatorSessionId },
      {
        return_id: entry.returnId,
        sale_id: entry.saleId,
        sale_ref: entry.serverSaleRef,
        operation: op,
        reason,
      },
    );
    return true;
  }
}

export function createReturnsDispatcher(deps: ReturnsDispatchDeps): ReturnsDispatcher {
  return new JournaledReturnsDispatcher(deps);
}
