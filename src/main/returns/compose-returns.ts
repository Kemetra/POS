/**
 * RT-15 S2 — composition of the return domain (used by `src/main/index.ts`).
 *
 * Builds client → repository → audit → dispatcher → resolver → service from
 * primitive dependencies, and schedules the background resolver. Kept out of
 * `index.ts` so the wiring itself is unit-tested.
 */
import { randomUUID } from 'node:crypto';

import type { ReturnsBridgeAPI } from '../../shared/returns/types.js';
import type { DatabaseHandle } from '../db/client.js';
import { bindSalesRepository } from '../sales/repositories/sales.repository.js';
import { DEFAULT_CURRENCY_CODE } from '../sales-sync/create-sale-sync-client.js';
import { createSaleSyncStateRepo } from '../sales-sync/sale-sync-state-repo.js';
import { createReturnsAudit, type ReturnsAuditSink } from './returns-audit.js';
import { createReturnsClient, type CreateReturnsClientDeps } from './returns-client.js';
import { createReturnsDispatcher } from './returns-dispatch.js';
import { createReturnsRepository } from './returns-repository.js';
import { createReturnsResolver, type ReturnsResolver } from './returns-resolver.js';
import { createReturnsAuthorizer, type ReturnsSession } from './returns-auth.js';
import { createReturnsService } from './returns-service.js';
import { newReturnExternalId } from './uuidv7.js';

export interface ReturnsLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ComposeReturnsDeps {
  readonly db: DatabaseHandle;
  /** Backend-Core base URL, fetch and the in-process envelope reader. */
  readonly http: Omit<CreateReturnsClientDeps, 'timeoutMs'>;
  readonly isEnabled: () => boolean;
  /** The live operator session on the live paired terminal (null if either is absent). */
  readonly getSession: () => ReturnsSession | null;
  /** True while the operator session is inactivity-locked (RT-117). */
  readonly isSessionLocked: () => boolean;
  readonly auditSink: ReturnsAuditSink;
  readonly logger: ReturnsLogger;
  readonly now: () => string;
  /**
   * The terminal's capture currency — the same source as the sale-sync
   * capture (`createSaleSyncClient` `currencyCode ?? DEFAULT_CURRENCY_CODE`).
   */
  readonly captureCurrencyCode?: string;
}

export interface ComposedReturns {
  readonly service: ReturnsBridgeAPI;
  readonly resolver: ReturnsResolver;
  /**
   * Latch the domain stopped (no send starts; an in-flight send touches
   * nothing local when it settles). Idempotent; synchronous, like every
   * worker stop in `bootstrap-workers.ts`.
   */
  readonly stop: () => void;
}

export function composeReturns(deps: ComposeReturnsDeps): ComposedReturns {
  const { now } = deps;
  let stopped = false;
  const client = createReturnsClient(deps.http);
  const repo = createReturnsRepository(deps.db);
  const audit = createReturnsAudit({ sink: deps.auditSink, now, newEventId: randomUUID });
  const authorizer = createReturnsAuthorizer({
    isEnabled: deps.isEnabled,
    getSession: deps.getSession,
    isSessionLocked: deps.isSessionLocked,
    hasEnvelope: () => (deps.http.getOperatorToken() ?? '').length > 0,
  });
  const dispatcher = createReturnsDispatcher({
    authorizer,
    client,
    repo,
    audit,
    now,
    logger: deps.logger,
    isStopped: () => stopped,
    transaction: <T>(fn: () => T): T => deps.db.transaction(fn)(),
  });
  const resolver = createReturnsResolver({ repo, dispatcher, authorizer });
  const service = createReturnsService({
    authorizer,
    captureCurrencyCode: deps.captureCurrencyCode ?? DEFAULT_CURRENCY_CODE,
    sales: bindSalesRepository(deps.db),
    saleRefs: createSaleSyncStateRepo(deps.db),
    client,
    repo,
    dispatcher,
    resolver,
    audit,
    now,
    newReturnId: randomUUID,
    newExternalId: () => newReturnExternalId(),
  });
  const stop = (): void => {
    stopped = true;
  };
  return { service, resolver, stop };
}

export interface ScheduleResolverInput {
  readonly resolver: Pick<ReturnsResolver, 'tick' | 'drain'>;
  /** Latches the domain stopped (`ComposedReturns.stop`). */
  readonly stopDomain: () => void;
  readonly intervalMs: number;
  /** Upper bound on waiting for an in-flight pass (the client timeout). */
  readonly drainTimeoutMs: number;
  readonly logger: Pick<ReturnsLogger, 'error'>;
}

/**
 * Run one resolver tick now (startup) and then every `intervalMs`. Each tick
 * resolves its scope live, so a terminal paired in-process is picked up
 * without a restart.
 *
 * Returns the worker stopper (registered in `bootstrap-workers.ts`, called
 * synchronously right before the DB closes). It clears the interval and
 * latches the domain stopped, so no send starts and an in-flight send skips
 * all local writes when it settles — closing the DB right after is safe. It
 * also returns a promise that settles when the active pass is done (bounded
 * by `drainTimeoutMs`).
 */
export function scheduleReturnsResolver(input: ScheduleResolverInput): () => Promise<void> {
  const run = (): void => {
    input.resolver.tick().catch((err: unknown) => {
      input.logger.error({ err }, 'returns_resolver:tick_unexpected');
    });
  };
  run();
  const timer = setInterval(run, input.intervalMs);
  return () => {
    clearInterval(timer);
    input.stopDomain();
    return input.resolver.drain(input.drainTimeoutMs);
  };
}
