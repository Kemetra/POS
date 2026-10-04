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
 * background pass needs an operator envelope; with none it does nothing (no
 * attempt is counted and nothing changes state). Passes are single-flight.
 */
import type { ReturnActor } from './returns-audit.js';
import type { ReturnsDispatcher } from './returns-dispatch.js';
import type { ReturnScope, ReturnsRepository } from './returns-repository.js';

export interface ResolveSummary {
  readonly confirmed: number;
  readonly refused: number;
  readonly unresolved: number;
}

export interface ReturnsResolver {
  /** Re-send every unresolved return in the actor's scope, oldest first. */
  resolveOnce(actor: Pick<ReturnActor, 'scope'>): Promise<ResolveSummary>;
  /** One background pass for `scope`; skipped while another pass runs or no credential. */
  tick(scope: ReturnScope): Promise<ResolveSummary | null>;
}

export interface ReturnsResolverDeps {
  readonly repo: Pick<ReturnsRepository, 'listUnresolved'>;
  readonly dispatcher: ReturnsDispatcher;
  /** True when an operator envelope is present (a send can authenticate). */
  readonly hasCredential: () => boolean;
}

const EMPTY: ResolveSummary = { confirmed: 0, refused: 0, unresolved: 0 };

export function createReturnsResolver(deps: ReturnsResolverDeps): ReturnsResolver {
  let running: Promise<ResolveSummary> | null = null;

  async function pass(scope: ReturnScope): Promise<ResolveSummary> {
    const tally = { ...EMPTY };
    for (const entry of deps.repo.listUnresolved(scope)) {
      const outcome = await deps.dispatcher.send(entry, 'resolve');
      if (outcome.kind === 'confirmed') tally.confirmed += 1;
      else if (outcome.kind === 'refused') tally.refused += 1;
      else tally.unresolved += 1;
    }
    return tally;
  }

  function singleFlight(scope: ReturnScope): Promise<ResolveSummary> {
    if (running !== null) return running;
    const current = pass(scope).finally(() => {
      running = null;
    });
    running = current;
    return current;
  }

  return {
    resolveOnce: (actor) => singleFlight(actor.scope),
    tick: async (scope) => {
      if (running !== null || !deps.hasCredential()) return null;
      return singleFlight(scope);
    },
  };
}
