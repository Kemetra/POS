/**
 * RT-530 — `sale-void:*` IPC.
 *
 * Closed shapes, validated before the service runs; anything else answers
 * `invalid_input` and reaches nothing. None of these channels is on the
 * locked-session allowlist (default deny). An unexpected failure is logged by
 * its name only and answers `void_unavailable`.
 */
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import {
  SALE_VOID_IPC_CHANNELS,
  type SaleVoidAcknowledgeRequest,
  type SaleVoidLookupRequest,
  type SaleVoidRefused,
  type SaleVoidRequest,
} from '../../shared/sale-void/types.js';
import type { SaleVoidService } from '../sale-void/sale-void-service.js';

const INVALID: SaleVoidRefused = { kind: 'refused', reason: 'invalid_input' };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SALE_NUMBER_MAX_LENGTH = 64;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

export function readLookup(value: unknown): SaleVoidLookupRequest | null {
  if (!closed(value, ['sale_number'])) return null;
  const { sale_number } = value;
  const valid =
    typeof sale_number === 'string' &&
    sale_number.trim().length > 0 &&
    sale_number.length <= SALE_NUMBER_MAX_LENGTH;
  return valid ? { sale_number: sale_number.trim() } : null;
}

export function readRequest(value: unknown): SaleVoidRequest | null {
  if (!closed(value, ['sale_id', 'approval_id'])) return null;
  const { sale_id, approval_id } = value;
  const valid = isId(sale_id) && typeof approval_id === 'string' && APPROVAL_ID.test(approval_id);
  return valid ? { sale_id, approval_id } : null;
}

export function readAcknowledge(value: unknown): SaleVoidAcknowledgeRequest | null {
  if (!closed(value, ['void_id'])) return null;
  return isId(value['void_id']) ? { void_id: value['void_id'] } : null;
}

export interface SaleVoidIpcDeps {
  service: Pick<SaleVoidService, 'lookup' | 'request' | 'list' | 'acknowledge'>;
  logger: Pick<Logger, 'warn'>;
}

export function registerSaleVoidHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: SaleVoidIpcDeps,
): void {
  const { service, logger } = deps;
  const unavailable = (op: string, error: unknown): SaleVoidRefused => {
    logger.warn(
      { op, error: error instanceof Error ? error.name : typeof error },
      'sale_void:failed',
    );
    return { kind: 'refused', reason: 'void_unavailable' };
  };
  const run = async <T>(op: string, fn: () => Promise<T>): Promise<T | SaleVoidRefused> => {
    try {
      return await fn();
    } catch (error) {
      return unavailable(op, error);
    }
  };

  ipcMain.handle(SALE_VOID_IPC_CHANNELS.LOOKUP, (_event, request: unknown) => {
    const req = readLookup(request);
    return req === null ? INVALID : run('lookup', () => service.lookup(req));
  });
  ipcMain.handle(SALE_VOID_IPC_CHANNELS.REQUEST, (_event, request: unknown) => {
    const req = readRequest(request);
    return req === null ? INVALID : run('request', () => service.request(req));
  });
  ipcMain.handle(SALE_VOID_IPC_CHANNELS.LIST, (_event, request: unknown) =>
    request === undefined ? run('list', () => service.list()) : INVALID,
  );
  ipcMain.handle(SALE_VOID_IPC_CHANNELS.ACKNOWLEDGE, (_event, request: unknown) => {
    const req = readAcknowledge(request);
    return req === null ? INVALID : run('acknowledge', () => service.acknowledge(req));
  });
}
