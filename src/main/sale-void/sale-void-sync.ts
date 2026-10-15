/**
 * RT-530 — send the journaled voids and record what Backend-Core said.
 *
 * A void is sent ONLY under its REQUESTER's own operator envelope: while the
 * operator who requested it is the signed-in operator, holding an envelope
 * (online), on this paired terminal. The server binds `approval.requesterUserId`
 * to the envelope's operator, so a void sent under anyone else's envelope would
 * be refused; this engine never tries. There is no device path for a void. A
 * row whose requester is not that operator, or whose sale has not synced to
 * Backend-Core yet (no server reference), is skipped untouched and keeps
 * waiting: nothing is dropped.
 *
 *   recorded (201 / 200 / replay)  -> confirmed; audit confirmed
 *   refused (a terminal code)      -> refused;   audit refused; visible to staff
 *   unknown (timeout, 5xx, 401...) -> unknown;   the same bytes and key are re-sent
 *
 * Each transition and its audit event commit in ONE local transaction, written
 * only when the guarded transition changed the row, so a replayed answer writes
 * nothing twice. The sender is re-checked immediately before every POST (a
 * sign-out, a switch of operator or a re-pair mid-pass stops the pass), and a
 * send in flight at shutdown writes nothing when it settles (RT-198 posture).
 *
 * Liveness without hammering: an `unknown` row is re-sent only once its own
 * backoff (the sale-sync policy: 1 s doubling, capped at 5 min) has elapsed.
 * A void whose business day has passed is refused by the server
 * (`void_outside_business_day`), a terminal refusal staff see: it is never
 * retried and never dropped.
 */
import {
  backoffMs,
  SALE_SYNC_BACKOFF_POLICY,
  type BackoffPolicy,
} from '../sales-sync/sale-sync-engine.js';
import { settledWithin } from '../sales-sync/settled-within.js';
import type { SaleVoidAudit } from './sale-void-audit.js';
import type { SaleVoidClient, RecordVoidOutcome } from './sale-void-client.js';
import type { SaleVoidRepository, VoidEntry, VoidScope } from './sale-void-repository.js';
import { buildVoidBodyJson } from './sale-void-wire.js';

/** The signed-in operator who may send voids right now. */
export interface VoidSender {
  readonly scope: VoidScope;
  /** The operator's provider-neutral `users.id`, lower-case. */
  readonly operatorUserId: string;
  /** The operator's envelope; never empty. */
  readonly envelope: string;
}

export interface SaleVoidSyncLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface SaleVoidSyncDeps {
  readonly repo: Pick<
    SaleVoidRepository,
    'listUnresolved' | 'read' | 'recordAttempt' | 'markUnknown' | 'markConfirmed' | 'markRefused'
  >;
  readonly client: Pick<SaleVoidClient, 'recordVoid'>;
  /** The sale's stored Backend-Core reference, or null while it has not synced. */
  readonly saleRef: (scope: VoidScope, saleId: string) => string | null;
  readonly audit: Pick<SaleVoidAudit, 'confirmed' | 'refused'>;
  /** The live eligible sender (signed in, unlocked is NOT required, online envelope), or null. */
  readonly currentSender: () => VoidSender | null;
  /** Run `fn` in one local DB transaction (journal + audit_events). */
  readonly transaction: <T>(fn: () => T) => T;
  readonly now: () => string;
  readonly logger: SaleVoidSyncLogger;
  /** True once the domain is stopping (app shutdown). */
  readonly isStopped: () => boolean;
  readonly backoff?: BackoffPolicy;
}

export interface SaleVoidSyncSummary {
  readonly confirmed: number;
  readonly refused: number;
  readonly unresolved: number;
}

export interface SaleVoidSync {
  /** One background pass; null while another pass runs or nobody eligible can send. */
  tick(): Promise<SaleVoidSyncSummary | null>;
  /** Settles when the pass in flight (if any) has finished, or after `timeoutMs`. */
  drain(timeoutMs: number): Promise<void>;
}

/** True when `entry` may be re-sent at `nowMs` (an unknown row waits out its backoff). */
function isDue(entry: VoidEntry, nowMs: number, policy: BackoffPolicy): boolean {
  if (entry.state !== 'unknown' || entry.lastAttemptAt === null) return true;
  const waited = nowMs - Date.parse(entry.lastAttemptAt);
  // An unreadable time or a clock that went backwards never holds a row.
  if (Number.isNaN(waited) || waited < 0) return true;
  return waited >= backoffMs(policy, entry.attemptCount);
}

const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Same tenant, branch and terminal: a re-paired or moved session is another sender. */
const sameScope = (a: VoidScope, b: VoidScope): boolean =>
  a.tenantId === b.tenantId && a.branchId === b.branchId && a.terminalId === b.terminalId;

type Tally = { confirmed: number; refused: number; unresolved: number };

export function createSaleVoidSync(deps: SaleVoidSyncDeps): SaleVoidSync {
  const policy = deps.backoff ?? SALE_SYNC_BACKOFF_POLICY;
  let running: Promise<SaleVoidSyncSummary> | null = null;

  /** One guarded transition and its audit event, in ONE transaction; true when it changed the row. */
  function commit(
    entry: VoidEntry,
    transition: () => boolean,
    audit: (fresh: VoidEntry) => void,
  ): boolean {
    return deps.transaction(() => {
      const changed = transition();
      const fresh = deps.repo.read(entry.voidId);
      if (changed && fresh !== null) audit(fresh);
      return changed;
    });
  }

  /** Commit one terminal transition with its audit; count it only when it changed the row. */
  function settle(
    entry: VoidEntry,
    counter: 'confirmed' | 'refused',
    transition: () => boolean,
    audit: (fresh: VoidEntry) => void,
    tally: Tally,
  ): void {
    if (commit(entry, transition, audit)) tally[counter] += 1;
  }

  /** Apply one answer: the guarded transition and its audit, atomically. */
  function apply(entry: VoidEntry, outcome: RecordVoidOutcome, tally: Tally): void {
    const { voidId } = entry;
    if (outcome.kind === 'recorded') {
      settle(
        entry,
        'confirmed',
        () => deps.repo.markConfirmed({ voidId, voidRef: outcome.eventRef, now: deps.now() }),
        (fresh) => {
          deps.audit.confirmed(fresh, outcome.replayed);
        },
        tally,
      );
      return;
    }
    if (outcome.kind === 'refused') {
      settle(
        entry,
        'refused',
        () => deps.repo.markRefused({ voidId, reason: outcome.reason, now: deps.now() }),
        (fresh) => {
          deps.audit.refused(fresh);
        },
        tally,
      );
      return;
    }
    deps.repo.markUnknown({ voidId: entry.voidId, now: deps.now(), category: outcome.category });
    tally.unresolved += 1;
  }

  /** The sender must still be the row's requester, in the row's own scope, right before its POST. */
  function senderFor(entry: VoidEntry): VoidSender | null {
    const sender = deps.currentSender();
    if (sender === null || !sameScope(sender.scope, entry.scope)) return null;
    return sameUser(sender.operatorUserId, entry.requesterUserId) ? sender : null;
  }

  /** Send one row; false stops the pass (the sender is gone). */
  async function sendOne(entry: VoidEntry, tally: Tally): Promise<boolean> {
    const sender = senderFor(entry);
    if (sender === null) return false;
    const saleRef = deps.saleRef(entry.scope, entry.saleId);
    if (saleRef === null) {
      tally.unresolved += 1;
      return true;
    }
    deps.repo.recordAttempt({ voidId: entry.voidId, now: deps.now() });
    const outcome = await deps.client.recordVoid(
      {
        saleRef,
        bodyJson: buildVoidBodyJson(entry, saleRef),
        idempotencyKey: entry.externalId,
      },
      sender.envelope,
    );
    // Stopped while the POST was in flight: touch nothing local (the DB may be
    // closed). The row stays as it was; the next start re-sends it.
    if (deps.isStopped()) return false;
    try {
      apply(entry, outcome, tally);
    } catch {
      deps.logger.warn({ void_id: entry.voidId }, 'sale_void:local_commit_failed');
      tally.unresolved += 1;
    }
    return true;
  }

  async function pass(sender: VoidSender): Promise<SaleVoidSyncSummary> {
    const tally: Tally = { confirmed: 0, refused: 0, unresolved: 0 };
    const nowMs = Date.parse(deps.now());
    const mine = deps.repo
      .listUnresolved(sender.scope)
      .filter((entry) => sameUser(entry.requesterUserId, sender.operatorUserId));
    for (const entry of mine) {
      if (deps.isStopped()) break;
      if (!isDue(entry, nowMs, policy)) {
        tally.unresolved += 1;
        continue;
      }
      if (!(await sendOne(entry, tally))) break;
    }
    return tally;
  }

  return {
    tick() {
      if (running !== null || deps.isStopped()) return Promise.resolve(null);
      const sender = deps.currentSender();
      if (sender === null) return Promise.resolve(null);
      const current: Promise<SaleVoidSyncSummary> = pass(sender).finally(() => {
        if (running === current) running = null;
      });
      running = current;
      return current;
    },
    drain(timeoutMs) {
      return running === null ? Promise.resolve() : settledWithin(running, timeoutMs);
    },
  };
}
