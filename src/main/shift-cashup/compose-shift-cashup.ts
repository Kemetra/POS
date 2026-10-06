/**
 * RT-17 slice 3 part 3 — composition of the shift cash-up domain, kept out of
 * `index.ts` so it is unit-tested.
 *
 *   • `composeShiftCashupService` — the main-process service (open, movement,
 *     close, status) over the part 1 repository, the cash-up sources and the
 *     status reader. NOT instantiated by `index.ts` in this part: there is no
 *     consumer until slice 4 adds the UI and its (flag-gated) IPC. The service
 *     gates every call on the flag itself, so wiring it later cannot expose it
 *     with the flag off.
 *   • `registerShiftSync` — the flag gate of the shift sync engine. With
 *     `POS_PULSE_FEATURE_SHIFT_CASHUP` off (default) it registers nothing: the
 *     engine is never built, never scheduled, never sends. With it on, the
 *     engine is a paired-only worker exactly like sale sync (it starts when
 *     the terminal is paired, at boot or in-process — RT-202), and its stop is
 *     registered in the worker registry (`shift-sync interval`), which runs it
 *     before the DB handle closes.
 *   • `startShiftSync` — the engine with the sale-sync sources: the paired
 *     terminal's tenant / branch, the current terminal read live each tick
 *     (RT-221), the sendable device token (null unless paired and not
 *     revoked), the current pairing's terminal for the client's send-time pin,
 *     and the RT-215 detector on every answer. One tick every 5 s (the
 *     sale-sync cadence; the first after one interval); the single-flight
 *     engine coalesces overlapping ticks. The returned stop clears the
 *     interval. Engine hooks become closed-set log lines (P7).
 */
import type { PairedTerminal, PairedWorkers } from '../app/paired-workers.js';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import type { DatabaseHandle } from '../db/client.js';
import { uuidv7 } from '../returns/uuidv7.js';
import { DEFAULT_CURRENCY_CODE } from '../sales-sync/create-sale-sync-client.js';
import { createShiftCashupRepo } from './shift-cashup-repo.js';
import {
  createShiftCashupService,
  type ShiftCashupService,
  type ShiftCashupServiceDeps,
} from './shift-cashup-service.js';
import { createShiftCashupSources } from './shift-cashup-sources.js';
import { createShiftCashupStatusReader } from './shift-cashup-status.js';
import { createShiftSyncClient, type CreateShiftSyncClientDeps } from './shift-sync-client.js';
import { createShiftSyncEngine } from './shift-sync-engine.js';

export type { ShiftCashupSession } from './shift-cashup-service.js';

/** The shift sync tick: the sale-sync cadence (`SALE_SYNC_INTERVAL_MS` in `index.ts`). */
export const SHIFT_SYNC_INTERVAL_MS = 5_000;

export const SHIFT_SYNC_DEAD_LETTER_LOG = 'shift_sync:dead_letter';
export const SHIFT_SYNC_DEVICE_UNAUTHORIZED_LOG = 'shift_sync:device_unauthorized';
export const SHIFT_SYNC_DEPENDENCY_FAILURE_LOG = 'shift_sync:dependency_failure';

export interface ComposeShiftCashupServiceDeps extends Pick<
  ShiftCashupServiceDeps,
  'isEnabled' | 'getSession' | 'isSessionLocked' | 'pairedScope' | 'now'
> {
  db: DatabaseHandle;
  /** The terminal's capture currency; defaults to the sale-sync capture's. */
  currencyCode?: string;
  /** Defaults to a UUIDv7. */
  newId?: () => string;
}

export function composeShiftCashupService(deps: ComposeShiftCashupServiceDeps): ShiftCashupService {
  return createShiftCashupService({
    isEnabled: deps.isEnabled,
    getSession: deps.getSession,
    isSessionLocked: deps.isSessionLocked,
    pairedScope: deps.pairedScope,
    repo: createShiftCashupRepo(deps.db),
    sources: createShiftCashupSources(deps.db),
    status: createShiftCashupStatusReader(deps.db),
    currencyCode: deps.currencyCode ?? DEFAULT_CURRENCY_CODE,
    now: deps.now,
    newId: deps.newId ?? (() => uuidv7()),
  });
}

export interface ShiftSyncLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface StartShiftSyncDeps {
  db: DatabaseHandle;
  /** The paired terminal the paired-workers latch started the engine for. */
  terminal: PairedTerminal;
  client: Pick<
    CreateShiftSyncClientDeps,
    'baseUrl' | 'fetch' | 'detector' | 'getDeviceToken' | 'currentTerminalId'
  >;
  /** The CURRENT pairing's terminal, read every tick (RT-221); null when unpaired. */
  resolveTerminalId: () => Promise<string | null>;
  logger: ShiftSyncLogger;
}

/** Start the shift sync engine on its interval; returns its stop. */
export function startShiftSync(deps: StartShiftSyncDeps): () => void {
  const { logger } = deps;
  const engine = createShiftSyncEngine({
    client: createShiftSyncClient(deps.client),
    repo: createShiftCashupRepo(deps.db),
    tenantId: deps.terminal.tenant_id,
    branchId: deps.terminal.branch_id,
    resolveTerminalId: deps.resolveTerminalId,
    now: () => new Date().toISOString(),
    onDeadLetter: ({ seq, factKind, reason }) => {
      logger.warn({ seq, fact_kind: factKind, reason }, SHIFT_SYNC_DEAD_LETTER_LOG);
    },
    onDeviceUnauthorized: () => {
      logger.warn({}, SHIFT_SYNC_DEVICE_UNAUTHORIZED_LOG);
    },
    onDependencyFailure: () => {
      logger.warn({}, SHIFT_SYNC_DEPENDENCY_FAILURE_LOG);
    },
  });
  // The tick's `completed` never rejects: the engine ends a failing tick
  // with `dependency_failure` (reported above).
  const interval = setInterval(() => {
    engine.runTickOnce();
  }, SHIFT_SYNC_INTERVAL_MS);
  return () => {
    clearInterval(interval);
  };
}

export interface RegisterShiftSyncDeps {
  /** `POS_PULSE_FEATURE_SHIFT_CASHUP` at boot. */
  enabled: boolean;
  pairedWorkers: Pick<PairedWorkers, 'register'>;
  workers: Pick<WorkerRegistry, 'register'>;
  /** `startShiftSync` bound to the composition root's sources. */
  start: (terminal: PairedTerminal) => () => void;
}

/** The flag gate (see the module header). */
export function registerShiftSync(deps: RegisterShiftSyncDeps): void {
  if (!deps.enabled) return;
  deps.pairedWorkers.register('shift-sync engine', (terminal) => {
    deps.workers.register('shift-sync interval', deps.start(terminal));
  });
}
