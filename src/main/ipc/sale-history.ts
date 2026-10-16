/**
 * RT-542 — `saleHistory:*` IPC. A thin wire-up: the service validates every
 * field (closed keys, forbidden keys, UUIDs, days, page size, cursor) and runs
 * the RT-546 gate. Here a non-object payload is refused before the service, and
 * an unexpected failure is logged by its error name only (never a payload, a
 * token or a sale fact) and answers `unavailable`. None of these channels is
 * on the locked-session allowlist (default deny).
 */
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import {
  SALE_HISTORY_IPC_CHANNELS,
  type SaleHistoryListRequest,
  type SaleHistoryReadRequest,
  type SaleHistoryRefused,
  type SaleHistoryReprintRequest,
} from '../../shared/sale-history/types.js';
import type { SaleHistoryService } from '../sale-history/sale-history-service.js';

const INVALID: SaleHistoryRefused = { kind: 'refused', reason: 'invalid_request' };
const UNAVAILABLE: SaleHistoryRefused = { kind: 'refused', reason: 'unavailable' };

export interface SaleHistoryIpcDeps {
  readonly service: SaleHistoryService;
  readonly logger: Pick<Logger, 'warn'>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function registerSaleHistoryHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: SaleHistoryIpcDeps,
): void {
  const { service, logger } = deps;
  const run = async <T>(op: string, fn: () => Promise<T>): Promise<T | SaleHistoryRefused> => {
    try {
      return await fn();
    } catch (error) {
      logger.warn(
        { op, error: error instanceof Error ? error.name : typeof error },
        'sale_history:failed',
      );
      return UNAVAILABLE;
    }
  };

  ipcMain.handle(SALE_HISTORY_IPC_CHANNELS.LIST, (_event, request: unknown) =>
    isPlainObject(request)
      ? run('list', () => service.list(request as unknown as SaleHistoryListRequest))
      : INVALID,
  );
  ipcMain.handle(SALE_HISTORY_IPC_CHANNELS.READ, (_event, request: unknown) =>
    isPlainObject(request)
      ? run('read', () => service.read(request as unknown as SaleHistoryReadRequest))
      : INVALID,
  );
  ipcMain.handle(SALE_HISTORY_IPC_CHANNELS.REPRINT, (_event, request: unknown) =>
    isPlainObject(request)
      ? run('reprint', () => service.reprint(request as unknown as SaleHistoryReprintRequest))
      : INVALID,
  );
}
