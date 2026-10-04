/**
 * RT-15 S2 — resolve returns whose outcome is not known.
 *
 * A return left `pending` (the app stopped between journaling and the answer)
 * or `unknown` (the answer was lost: timeout, network, 5xx) is re-sent with the
 * IDENTICAL request — the journaled body bytes under the same Idempotency-Key —
 * through the shared dispatcher. Backend-Core either replays the recorded
 * return (201 with `Idempotent-Replayed`, or a 200 provenance replay), which
 * confirms it, or records it now, or refuses it. Never a second return.
 *
 * Runs on startup, on a slow interval, and on demand (`returns.resolve`). A
 * pass runs on behalf of one authorization snapshot taken at its start (a
 * signed-in, unlocked manager/admin on the paired terminal, with the envelope
 * it was admitted with — RT-197 A5); every send carries that snapshot's
 * envelope, and the dispatcher re-checks the snapshot against the live state
 * immediately before every send (the `returns-auth` choke point). The first send it refuses stops the pass; the
 * rows wait, unchanged, for a later eligible operator. Passes are single-flight
 * per process (one terminal per process).
 */
import type { AuthSnapshot, ReturnsAuthorizer } from './returns-auth.js';
import type { ReturnsDispatcher } from './returns-dispatch.js';
import type { ReturnsRepository } from './returns-repository.js';

export interface ResolveSummary {
  readonly confirmed: number;
  readonly refused: number;
  readonly unresolved: number;
}

export interface ReturnsResolver {
  /**
   * On demand: re-send every unresolved return in the snapshot's scope, oldest
   * first, on behalf of `snapshot` (the caller's admission; re-checked before
   * each send).
   */
  resolveOnce(snapshot: AuthSnapshot): Promise<ResolveSummary>;
  /**
   * One background pass on behalf of the live authorized actor; a no-op (null)
   * while another pass runs or nobody eligible (with an envelope) is signed in.
   */
  tick(): Promise<ResolveSummary | null>;
  /** Settles when the active pass (if any) has finished, or after `timeoutMs`. */
  drain(timeoutMs: number): Promise<void>;
}

export interface ReturnsResolverDeps {
  readonly repo: Pick<ReturnsRepository, 'listUnresolved'>;
  readonly dispatcher: ReturnsDispatcher;
  /** The choke point; the dispatcher re-checks the pass's actor before each send. */
  readonly authorizer: Pick<ReturnsAuthorizer, 'current' | 'recheck'>;
}

const EMPTY: ResolveSummary = { confirmed: 0, refused: 0, unresolved: 0 };

export function createReturnsResolver(deps: ReturnsResolverDeps): ReturnsResolver {
  let running: Promise<ResolveSummary> | null = null;

  async function pass(snapshot: AuthSnapshot): Promise<ResolveSummary> {
    const tally = { ...EMPTY };
    const rows = deps.repo.listUnresolved(snapshot.scope);
    for (const [index, entry] of rows.entries()) {
      const outcome = await deps.dispatcher.send(entry, 'resolve', snapshot);
      // Not sent: the pass's actor lost authorization (sign-out, switch, lock,
      // unpairing…). Stop; this row and the rest wait for a later pass.
      if (outcome.kind === 'deferred') {
        return { ...tally, unresolved: tally.unresolved + rows.length - index };
      }
      if (outcome.kind === 'confirmed') tally.confirmed += 1;
      else if (outcome.kind === 'refused') tally.refused += 1;
      else tally.unresolved += 1;
    }
    return tally;
  }

  function singleFlight(snapshot: AuthSnapshot): Promise<ResolveSummary> {
    if (running !== null) return running;
    const current = pass(snapshot).finally(() => {
      running = null;
    });
    running = current;
    return current;
  }

  function drain(timeoutMs: number): Promise<void> {
    if (running === null) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    return Promise.race([settled, bound]).finally(() => {
      clearTimeout(timer);
    });
  }

  return {
    drain,
    resolveOnce: singleFlight,
    tick: () => {
      // The pass's authorization snapshot, taken once at its start.
      const live = deps.authorizer.current();
      if (running !== null || live.kind !== 'ok') return Promise.resolve(null);
      if (deps.authorizer.recheck(live.actor) !== null) return Promise.resolve(null);
      return singleFlight(live.actor);
    },
  };
}
