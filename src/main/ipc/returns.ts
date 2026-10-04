/**
 * RT-15 S2 — `returns:*` IPC registration (§A4 bridge security).
 *
 * The renderer is untrusted input. Each request is validated here before the
 * service runs, and anything outside the closed shape is `invalid_input`:
 *
 *   • `saleNumber`: a string of 1..64 printable characters (no control chars);
 *   • `lines`: 1..50 entries, each exactly `{ lineRef, quantity }` with a
 *     canonical UUID `lineRef` (unique per request) and a whole `quantity` in
 *     1..10 000;
 *   • no other key anywhere (no operator id, scope, amount, key or saleRef can
 *     be smuggled in — scope, saleRef, money and the Idempotency-Key are
 *     derived in main);
 *   • `resolve` / `list` take no payload.
 *
 * Session, role, feature gate and every business rule live in the service.
 * The channels are not on the locked-session allowlist, so the guarded
 * `ipcMain` refuses them while the session is locked.
 */
import type { IpcMain } from 'electron';

import { RETURNS_IPC_CHANNELS } from '../../shared/returns/channels.js';
import type {
  ReturnLineInput,
  ReturnsBridgeAPI,
  ReturnsQuoteRequest,
} from '../../shared/returns/types.js';
import { isUuid } from '../returns/returns-wire.js';

export const RETURNS_INPUT_BOUNDS = {
  saleNumberMaxLength: 64,
  maxLines: 50,
  maxQuantity: 10_000,
} as const;

const PRINTABLE = /^[^\p{Cc}]+$/u;
const INVALID = { kind: 'refused', reason: 'invalid_input' } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  return !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((k) => keys.includes(k));
}

/** A bounded sale number, or null. */
export function readSaleNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > RETURNS_INPUT_BOUNDS.saleNumberMaxLength) return null;
  return PRINTABLE.test(value) ? value : null;
}

function readLine(value: unknown): ReturnLineInput | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['lineRef', 'quantity'])) return null;
  const { lineRef, quantity } = value;
  if (typeof lineRef !== 'string' || !isUuid(lineRef)) return null;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity)) return null;
  if (quantity < 1 || quantity > RETURNS_INPUT_BOUNDS.maxQuantity) return null;
  return { lineRef, quantity };
}

/** Validated, unique-per-request lines, or null. */
export function readLines(value: unknown): ReturnLineInput[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > RETURNS_INPUT_BOUNDS.maxLines) return null;
  const lines = value.map(readLine);
  if (lines.some((l) => l === null)) return null;
  const valid = lines as ReturnLineInput[];
  const refs = new Set(valid.map((l) => l.lineRef.toLowerCase()));
  return refs.size === valid.length ? valid : null;
}

/** `{ saleNumber }` exactly, or null. */
export function readLookupRequest(value: unknown): { saleNumber: string } | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['saleNumber'])) return null;
  const saleNumber = readSaleNumber(value['saleNumber']);
  return saleNumber === null ? null : { saleNumber };
}

/** `{ saleNumber, lines }` exactly, or null. */
export function readQuoteRequest(value: unknown): ReturnsQuoteRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['saleNumber', 'lines'])) return null;
  const saleNumber = readSaleNumber(value['saleNumber']);
  const lines = readLines(value['lines']);
  if (saleNumber === null || lines === null) return null;
  return { saleNumber, lines };
}

/** `resolve` / `list` accept no payload (undefined or `{}`). */
function isEmptyPayload(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value) && Object.keys(value).length === 0;
}

export interface ReturnsIpcDeps {
  readonly service: ReturnsBridgeAPI;
}

export function registerReturnsHandlers(ipcMain: IpcMain, deps: ReturnsIpcDeps): void {
  const { service } = deps;

  ipcMain.handle(RETURNS_IPC_CHANNELS.LOOKUP, (_event, request: unknown) => {
    const req = readLookupRequest(request);
    return req === null ? INVALID : service.lookup(req);
  });

  ipcMain.handle(RETURNS_IPC_CHANNELS.QUOTE, (_event, request: unknown) => {
    const req = readQuoteRequest(request);
    return req === null ? INVALID : service.quote(req);
  });

  ipcMain.handle(RETURNS_IPC_CHANNELS.SUBMIT, (_event, request: unknown) => {
    const req = readQuoteRequest(request);
    return req === null ? { ...INVALID, ret: null } : service.submit(req);
  });

  ipcMain.handle(RETURNS_IPC_CHANNELS.RESOLVE, (_event, request: unknown) =>
    isEmptyPayload(request) ? service.resolve() : INVALID,
  );

  ipcMain.handle(RETURNS_IPC_CHANNELS.LIST, (_event, request: unknown) =>
    isEmptyPayload(request) ? service.list() : INVALID,
  );
}
