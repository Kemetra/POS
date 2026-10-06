/**
 * RT-17 slice 3 part 2 — `createShiftSyncEngine`: the single-flight drain of
 * the shift sync outbox (migration 0043) on the device path.
 *
 * `runTickOnce()` admits one tick synchronously (`started` with a `completed`
 * report, or `already_running`), like the sale-sync engine. One tick:
 *   1. resolves the CURRENT pairing's terminal (RT-221); none → `unpaired`;
 *   2. asks the repository for the head of that terminal's unsettled facts in
 *      causal order (`nextFact`) and stops on `idle`, `waiting` (the head is
 *      in backoff) or `blocked` (the head is dead-lettered; nothing behind it
 *      is sent until it is repaired);
 *   3. stops on an `envelope` head (`envelope_pending`): a manager-envelope
 *      repair row is never sent with the device bearer. Sending it is a later
 *      part of RT-17 (the envelope client and drain); until then it waits;
 *   4. sends the head through the client method of its kind and records the
 *      outcome, then reads the next head:
 *        ok → `markSynced` (a first record or an idempotent replay);
 *        transient / no_connection / device_unauthorized → `recordRetry`,
 *          next retry after the bounded exponential backoff of the attempt,
 *          and never before the server's `Retry-After`. The head then waits.
 *          A device 401 is a retry, never a dead letter (revoking the device
 *          is the RT-215 detector's call; the client reports it there);
 *        rejected → `markDeadLetter` with the closed-set reason. The head
 *          then blocks;
 *        not_sent (no device token, a re-pair, an envelope row) → no state
 *          change, the tick stops (`held`).
 * A throwing dependency (pairing read, store, clock, client) ends the tick
 * with no further change (`dependency_failure`); so does a transition that
 * did not apply. Hooks are side channels: a throwing hook never stops a tick.
 *
 * Shutdown (RT-198, as the returns domain): once `isStopped()` is true a tick
 * reads and writes nothing more (`stopped`). It is checked before the tick's
 * first read and again when every await resumes, so a send in flight at stop
 * settles WITHOUT any local write — the DB closes right after the
 * synchronous worker stop. The row stays `pending` with its stored bytes and
 * key; the next start re-sends them (an idempotent replay if the server
 * recorded it). `drain(timeoutMs)` resolves once the tick in flight has
 * settled, or after `timeoutMs`, whichever comes first.
 *
 * Not wired yet: no composition root, no IPC, no feature flag (RT-17 slice 3
 * part 3). Hooks receive closed-set values only — never a body, a token or PII.
 */
import {
  backoffMs,
  SALE_SYNC_BACKOFF_POLICY,
  type BackoffPolicy,
} from '../sales-sync/sale-sync-engine.js';
import { settledWithin } from '../sales-sync/settled-within.js';
import type {
  NextShiftFact,
  QueuedShiftFact,
  ShiftCashupRepo,
  ShiftSyncDeadLetterReason,
} from './shift-cashup-repo.js';
import type {
  ShiftSyncClient,
  ShiftSyncNotSentReason,
  ShiftSyncResult,
  ShiftSyncSend,
} from './shift-sync-client.js';
import type { ShiftFactKind } from './shift-wire.js';

export interface ShiftDeadLetterInfo {
  seq: number;
  factKind: ShiftFactKind;
  reason: ShiftSyncDeadLetterReason;
}

export interface ShiftSyncEngineDeps {
  client: ShiftSyncClient;
  repo: Pick<ShiftCashupRepo, 'nextFact' | 'markSynced' | 'recordRetry' | 'markDeadLetter'>;
  tenantId: string;
  branchId: string;
  /** RT-221: the CURRENT pairing's `terminal_id`, read every tick; null when unpaired. */
  resolveTerminalId: () => string | null | Promise<string | null>;
  /** Canonical ISO-8601 UTC instants (`toISOString()`). */
  now: () => string;
  /** Retry backoff; defaults to the sale-sync policy (1 s doubling, 5 min cap). */
  backoff?: BackoffPolicy;
  /** A fact was dead-lettered. */
  onDeadLetter?: (info: ShiftDeadLetterInfo) => void;
  /** A device 401, once per episode (re-armed by any other server answer). */
  onDeviceUnauthorized?: () => void;
  /** A dependency threw, once per episode (re-armed by a tick without a failure). */
  onDependencyFailure?: () => void;
  /** RT-198: true once the worker is stopping (app shutdown); default never. */
  isStopped?: () => boolean;
}

/** Why a tick stopped. */
export type ShiftDrainStop =
  | Exclude<NextShiftFact, { kind: 'due' }>
  | { kind: 'envelope_pending'; seq: number }
  | { kind: 'held'; reason: ShiftSyncNotSentReason }
  | { kind: 'unpaired' }
  | { kind: 'stopped' }
  | { kind: 'dependency_failure' };

export interface ShiftDrainReport {
  /** Facts the server answered or the transport failed on, this tick. */
  sent: number;
  stop: ShiftDrainStop;
}

export type ShiftTickAdmission =
  | { kind: 'started'; completed: Promise<ShiftDrainReport> }
  | { kind: 'already_running' };

export interface ShiftSyncEngine {
  runTickOnce(): ShiftTickAdmission;
  /** Settles when the tick in flight has settled, or after `timeoutMs` (RT-198). */
  drain(timeoutMs: number): Promise<void>;
}

type RetryResult = Extract<
  ShiftSyncResult,
  { kind: 'transient' | 'no_connection' | 'device_unauthorized' }
>;
type SentResult = Exclude<ShiftSyncResult, { kind: 'not_sent' }>;

const SEND: Readonly<
  Record<ShiftFactKind, (client: ShiftSyncClient, input: ShiftSyncSend) => Promise<ShiftSyncResult>>
> = {
  open: (client, input) => client.openShift(input),
  movement: (client, input) => client.recordCashMovement(input),
  close: (client, input) => client.closeShift(input),
};

const DEPENDENCY_FAILURE: ShiftDrainStop = Object.freeze({ kind: 'dependency_failure' });
const UNPAIRED: ShiftDrainStop = Object.freeze({ kind: 'unpaired' });
const STOPPED: ShiftDrainStop = Object.freeze({ kind: 'stopped' });

/** The delay before the next attempt: the backoff, or `Retry-After` when longer. */
function retryDelayMs(input: {
  policy: BackoffPolicy;
  attempt: number;
  result: RetryResult;
}): number {
  const delay = backoffMs(input.policy, input.attempt);
  const retryAfterMs = input.result.kind === 'transient' ? input.result.retryAfterMs : undefined;
  return Math.max(delay, retryAfterMs ?? 0);
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** Run a side-channel hook; a throwing hook never stops the drain. */
function notify(call: () => void): void {
  try {
    call();
  } catch {
    // A failing log sink must not stop the drain.
  }
}

/** A hook reported once per episode until `rearm`. */
function episode(hook: (() => void) | undefined): { report(): void; rearm(): void } {
  let reported = false;
  return {
    report() {
      if (reported) return;
      reported = true;
      notify(() => hook?.());
    },
    rearm() {
      reported = false;
    },
  };
}

export function createShiftSyncEngine(deps: ShiftSyncEngineDeps): ShiftSyncEngine {
  const { repo } = deps;
  const policy = deps.backoff ?? SALE_SYNC_BACKOFF_POLICY;
  const deviceUnauthorized = episode(deps.onDeviceUnauthorized);
  const dependencyFailure = episode(deps.onDependencyFailure);
  const isStopped = deps.isStopped ?? (() => false);
  let inFlight: Promise<ShiftDrainReport> | null = null;

  function retry(input: { fact: QueuedShiftFact; result: RetryResult; now: string }): boolean {
    const { fact, result, now } = input;
    const delay = retryDelayMs({ policy, attempt: fact.attemptCount + 1, result });
    return repo.recordRetry({
      seq: fact.seq,
      now,
      nextRetryAt: addMs(now, delay),
      category: result.kind,
    });
  }

  function deadLetter(input: {
    fact: QueuedShiftFact;
    reason: ShiftSyncDeadLetterReason;
    now: string;
  }): boolean {
    const { fact, reason } = input;
    if (!repo.markDeadLetter({ seq: fact.seq, now: input.now, reason })) return false;
    notify(() => deps.onDeadLetter?.({ seq: fact.seq, factKind: fact.factKind, reason }));
    return true;
  }

  /** Persist one outcome; false when the transition did not apply. */
  function record(fact: QueuedShiftFact, result: SentResult): boolean {
    const now = deps.now();
    if (result.kind === 'ok') return repo.markSynced({ seq: fact.seq, now });
    if (result.kind === 'rejected') return deadLetter({ fact, reason: result.reason, now });
    return retry({ fact, result, now });
  }

  /** A device 401 is reported once per episode; any other server answer re-arms it. */
  function noteAnswer(result: SentResult): void {
    if (result.kind === 'no_connection') return;
    if (result.kind === 'device_unauthorized') deviceUnauthorized.report();
    else deviceUnauthorized.rearm();
  }

  /** Send one due fact; the stop when the tick must end, else null. */
  async function sendOne(input: {
    terminalId: string;
    fact: QueuedShiftFact;
    progress: { sent: number };
  }): Promise<ShiftDrainStop | null> {
    const { terminalId, fact } = input;
    if (fact.authPath !== 'device') return { kind: 'envelope_pending', seq: fact.seq };
    const result = await SEND[fact.factKind](deps.client, { terminalId, fact });
    // Stopped while the request was in flight: touch nothing local (RT-198).
    if (isStopped()) return STOPPED;
    if (result.kind === 'not_sent') return { kind: 'held', reason: result.reason };
    input.progress.sent += 1;
    noteAnswer(result);
    if (!record(fact, result)) throw new Error('shift sync: transition not applied');
    return null;
  }

  /** Drain the current terminal's facts until a stop. */
  async function drainFacts(progress: { sent: number }): Promise<ShiftDrainStop> {
    if (isStopped()) return STOPPED;
    const terminalId = await deps.resolveTerminalId();
    if (isStopped()) return STOPPED;
    if (terminalId === null) return UNPAIRED;
    const scope = { tenantId: deps.tenantId, branchId: deps.branchId, terminalId };
    for (;;) {
      const next = repo.nextFact({ scope, now: deps.now() });
      if (next.kind !== 'due') return next;
      const stop = await sendOne({ terminalId, fact: next.fact, progress });
      if (stop !== null) return stop;
    }
  }

  async function runTick(): Promise<ShiftDrainReport> {
    const progress = { sent: 0 };
    try {
      const stop = await drainFacts(progress);
      dependencyFailure.rearm();
      return { sent: progress.sent, stop };
    } catch {
      dependencyFailure.report();
      return { sent: progress.sent, stop: DEPENDENCY_FAILURE };
    } finally {
      inFlight = null;
    }
  }

  return {
    runTickOnce(): ShiftTickAdmission {
      if (inFlight !== null) return { kind: 'already_running' };
      inFlight = runTick();
      return { kind: 'started', completed: inFlight };
    },
    drain(timeoutMs) {
      return inFlight === null ? Promise.resolve() : settledWithin(inFlight, timeoutMs);
    },
  };
}
