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
 * A confirmation must name this return (`externalId`) and carry exactly the
 * quoted refund (the cash tender the server checked against its own total);
 * otherwise the row stays `unknown` and the anomaly is logged — nothing is
 * paid out on an answer the till cannot match.
 *
 * Confirmation is written once: `markConfirmed` only moves a row out of
 * `pending` / `unknown`, so a second confirmation of the same return (a
 * resolver racing a submit, a later replay) emits no second audit event and no
 * second payout-ready (AC8). Sends of the same return are also single-flight
 * within the process.
 */
import type { ReturnsRefusalReason } from '../../shared/returns/types.js';
import { exponentFor } from '../sales-sync/create-sale-sync-client.js';
import type { ReturnsAudit } from './returns-audit.js';
import type { RecordReturnOutcome, ReturnsClient } from './returns-client.js';
import { amount4ToMinor, parseAmount4 } from './returns-money.js';
import type { JournalEntry, ReturnsRepository } from './returns-repository.js';
import type { WireSaleReturn } from './returns-wire.js';

export type DispatchOutcome =
  | { readonly kind: 'confirmed'; readonly entry: JournalEntry; readonly replayed: boolean }
  | { readonly kind: 'unconfirmed'; readonly entry: JournalEntry }
  | {
      readonly kind: 'refused';
      readonly reason: ReturnsRefusalReason;
      readonly entry: JournalEntry;
    };

export type DispatchOperation = 'submit' | 'resolve';

export interface ReturnsDispatcher {
  send(entry: JournalEntry, operation: DispatchOperation): Promise<DispatchOutcome>;
}

export interface ReturnsDispatchLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ReturnsDispatchDeps {
  readonly client: Pick<ReturnsClient, 'recordReturn'>;
  readonly repo: ReturnsRepository;
  readonly audit: ReturnsAudit;
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

/** The server's refund in minor units when it matches this return; else null. */
function matchingTotalMinor(entry: JournalEntry, saleReturn: WireSaleReturn): number | null {
  if (saleReturn.externalId !== entry.externalId) return null;
  if (saleReturn.saleRef.toLowerCase() !== entry.serverSaleRef.toLowerCase()) return null;
  const total4 = parseAmount4(saleReturn.returnTotal);
  const minor = total4 === null ? null : amount4ToMinor(total4, exponentFor(entry.currencyCode));
  return minor === entry.quotedTotalMinor ? minor : null;
}

class JournaledReturnsDispatcher implements ReturnsDispatcher {
  private readonly inFlight = new Map<string, Promise<DispatchOutcome>>();

  constructor(private readonly deps: ReturnsDispatchDeps) {}

  send(entry: JournalEntry, operation: DispatchOperation): Promise<DispatchOutcome> {
    const running = this.inFlight.get(entry.returnId);
    if (running !== undefined) return running;
    const promise = this.sendOnce(entry, operation).finally(() => {
      this.inFlight.delete(entry.returnId);
    });
    this.inFlight.set(entry.returnId, promise);
    return promise;
  }

  private async sendOnce(entry: JournalEntry, op: DispatchOperation): Promise<DispatchOutcome> {
    this.deps.repo.recordAttempt({ returnId: entry.returnId, now: this.deps.now() });
    const outcome = await this.deps.client.recordReturn({
      saleRef: entry.serverSaleRef,
      bodyJson: entry.requestBodyJson,
      idempotencyKey: entry.externalId,
    });
    return this.apply(entry, outcome, op);
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
    const changed = this.deps.repo.markConfirmed({
      returnId: entry.returnId,
      returnRef: saleReturn.returnRef,
      returnTotalMinor: totalMinor,
      now: this.deps.now(),
    });
    const fresh = this.current(entry);
    if (!changed) return outcomeOfState(fresh);
    this.deps.audit.confirmed(fresh, replayed);
    this.deps.audit.payoutReady(fresh);
    return { kind: 'confirmed', entry: fresh, replayed } as const;
  }

  private refuse(entry: JournalEntry, reason: ReturnsRefusalReason, op: DispatchOperation) {
    const changed = this.deps.repo.markRefused({
      returnId: entry.returnId,
      reason,
      now: this.deps.now(),
    });
    const fresh = this.current(entry);
    if (!changed) return outcomeOfState(fresh);
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
    return { kind: 'refused', reason, entry: fresh } as const;
  }
}

export function createReturnsDispatcher(deps: ReturnsDispatchDeps): ReturnsDispatcher {
  return new JournaledReturnsDispatcher(deps);
}
