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
 *   • `resolve` / `list` take no payload;
 *   • RT-15 S4 `payout`: exactly `{ returnId, action }` with a canonical UUID
 *     and an action in the closed set; `reprintSlip`: exactly `{ returnId }`.
 *     No amount can be sent: main pays the journal's server-confirmed total.
 *
 * Session, role, feature gate and every business rule live in the service.
 * The channels are not on the locked-session allowlist, so the guarded
 * `ipcMain` refuses them while the session is locked.
 */
import type { IpcMain } from 'electron';

import { RETURNS_IPC_CHANNELS } from '../../shared/returns/channels.js';
import {
  RETURN_PAYOUT_ACTIONS,
  type ReturnLineInput,
  type ReturnPayoutAction,
  type ReturnsBridgeAPI,
  type ReturnsPayoutRequest,
  type ReturnsQuoteRequest,
  type ReturnsReprintRequest,
} from '../../shared/returns/types.js';
import { isUuid } from '../returns/returns-wire.js';

export const RETURNS_INPUT_BOUNDS = {
  saleNumberMaxLength: 64,
  maxLines: 50,
  maxQuantity: 10_000,
} as const;

const PRINTABLE = /^[^\p{Cc}]+$/u;
const INVALID = { kind: 'refused', reason: 'invalid_input' } as const;

const LINE_KEYS = ['lineRef', 'quantity'] as const;
const LOOKUP_KEYS = ['saleNumber'] as const;
const QUOTE_KEYS = ['saleNumber', 'lines'] as const;
const PAYOUT_KEYS = ['returnId', 'action'] as const;
const REPRINT_KEYS = ['returnId'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  return !Array.isArray(value);
}

/** A plain object whose keys are all in `keys` (closed shape: nothing smuggled in). */
function isClosedShape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((k) => keys.includes(k));
}

/** 1 ≤ n ≤ max — the one bound used for lengths, counts and quantities. */
function isWithin(n: number, max: number): boolean {
  return n >= 1 && n <= max;
}

function isSaleNumber(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return isWithin(value.length, RETURNS_INPUT_BOUNDS.saleNumberMaxLength) && PRINTABLE.test(value);
}

function isLineRef(value: unknown): value is string {
  return typeof value === 'string' && isUuid(value);
}

function isWholeQty(value: unknown): value is number {
  return Number.isSafeInteger(value) && isWithin(value as number, RETURNS_INPUT_BOUNDS.maxQuantity);
}

function isLine(value: ReturnLineInput | null): value is ReturnLineInput {
  return value !== null;
}

function hasUniqueLineRefs(lines: readonly ReturnLineInput[]): boolean {
  return new Set(lines.map((l) => l.lineRef.toLowerCase())).size === lines.length;
}

/** A bounded sale number, or null. */
export function readSaleNumber(value: unknown): string | null {
  return isSaleNumber(value) ? value : null;
}

function readLine(value: unknown): ReturnLineInput | null {
  if (!isClosedShape(value, LINE_KEYS)) return null;
  const { lineRef, quantity } = value;
  return isLineRef(lineRef) && isWholeQty(quantity) ? { lineRef, quantity } : null;
}

/** Validated, unique-per-request lines, or null. */
export function readLines(value: unknown): ReturnLineInput[] | null {
  if (!Array.isArray(value) || !isWithin(value.length, RETURNS_INPUT_BOUNDS.maxLines)) return null;
  const lines = value.map(readLine);
  if (!lines.every(isLine)) return null;
  return hasUniqueLineRefs(lines) ? lines : null;
}

/** `{ saleNumber }` exactly, or null. */
export function readLookupRequest(value: unknown): { saleNumber: string } | null {
  if (!isClosedShape(value, LOOKUP_KEYS)) return null;
  const saleNumber = readSaleNumber(value['saleNumber']);
  return saleNumber === null ? null : { saleNumber };
}

/** `{ saleNumber, lines }` exactly, or null. */
export function readQuoteRequest(value: unknown): ReturnsQuoteRequest | null {
  if (!isClosedShape(value, QUOTE_KEYS)) return null;
  const saleNumber = readSaleNumber(value['saleNumber']);
  const lines = readLines(value['lines']);
  return saleNumber === null || lines === null ? null : { saleNumber, lines };
}

function isReturnId(value: unknown): value is string {
  return typeof value === 'string' && isUuid(value);
}

function isPayoutAction(value: unknown): value is ReturnPayoutAction {
  return (RETURN_PAYOUT_ACTIONS as readonly unknown[]).includes(value);
}

/** `{ returnId, action }` exactly, or null. */
export function readPayoutRequest(value: unknown): ReturnsPayoutRequest | null {
  if (!isClosedShape(value, PAYOUT_KEYS)) return null;
  const { returnId, action } = value;
  return isReturnId(returnId) && isPayoutAction(action) ? { returnId, action } : null;
}

/** `{ returnId }` exactly, or null. */
export function readReprintRequest(value: unknown): ReturnsReprintRequest | null {
  if (!isClosedShape(value, REPRINT_KEYS)) return null;
  const { returnId } = value;
  return isReturnId(returnId) ? { returnId } : null;
}

/** `resolve` / `list` accept no payload (undefined or `{}`). */
function isEmptyPayload(value: unknown): boolean {
  return value === undefined || isClosedShape(value, []);
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

  ipcMain.handle(RETURNS_IPC_CHANNELS.PAYOUT, (_event, request: unknown) => {
    const req = readPayoutRequest(request);
    return req === null ? { ...INVALID, ret: null } : service.payout(req);
  });

  ipcMain.handle(RETURNS_IPC_CHANNELS.REPRINT_SLIP, (_event, request: unknown) => {
    const req = readReprintRequest(request);
    return req === null ? INVALID : service.reprintSlip(req);
  });
}
