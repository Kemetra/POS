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
}

export interface ComposedReturns {
  readonly service: ReturnsBridgeAPI;
  readonly resolver: ReturnsResolver;
}

export function composeReturns(deps: ComposeReturnsDeps): ComposedReturns {
  const { now } = deps;
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
    transaction: <T>(fn: () => T): T => deps.db.transaction(fn)(),
  });
  const resolver = createReturnsResolver({ repo, dispatcher, authorizer });
  const service = createReturnsService({
    authorizer,
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
  return { service, resolver };
}

export interface ScheduleResolverInput {
  readonly resolver: Pick<ReturnsResolver, 'tick'>;
  readonly intervalMs: number;
  readonly logger: Pick<ReturnsLogger, 'error'>;
}

/**
 * Run one resolver tick now (startup) and then every `intervalMs`; returns
 * stop(). Each tick resolves its scope live, so a terminal paired in-process
 * is picked up without a restart.
 */
export function scheduleReturnsResolver(input: ScheduleResolverInput): () => void {
  const run = (): void => {
    input.resolver.tick().catch((err: unknown) => {
      input.logger.error({ err }, 'returns_resolver:tick_unexpected');
    });
  };
  run();
  const timer = setInterval(run, input.intervalMs);
  return () => {
    clearInterval(timer);
  };
}
