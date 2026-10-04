/**
 * RT-15 S2 — lenient readers for the Backend-Core `Sale`, `SaleReturn` and
 * `Error` bodies (`pos-sales/sales.yaml` 1.4.0-draft).
 *
 * RT-15 D-g: read only the fields the till needs and ignore every other key, so
 * an additive server field never breaks a return. A needed field that is
 * missing or mistyped makes the whole body unreadable (null) — the caller then
 * fails closed. POS has no Zod on its dependency tree (adding one is a gated
 * package change), so these are small typed readers instead; the vendored
 * contract pin (`__tests__/__contract__/sales-returns.contract.ts`) checks at
 * compile time that every field read here exists in the contract with a
 * compatible type.
 *
 * The readers take parsed JSON (`parseJsonBody`). Pure; never throw.
 */

const INVALID: unique symbol = Symbol('invalid');
type Read<T> = (value: unknown) => T | typeof INVALID;
type Spec<T> = { readonly [K in keyof T]-?: Read<T[K]> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  return !Array.isArray(value);
}

const str: Read<string> = (v) => (typeof v === 'string' ? v : INVALID);
const uuid: Read<string> = (v) => (typeof v === 'string' && UUID.test(v) ? v : INVALID);
const currency: Read<string> = (v) => (typeof v === 'string' && CURRENCY.test(v) ? v : INVALID);
const bool: Read<boolean> = (v) => (typeof v === 'boolean' ? v : INVALID);

function readObject<T>(spec: Spec<T>): Read<T> {
  return (value) => {
    if (!isRecord(value)) return INVALID;
    const out: Partial<T> = {};
    for (const key of Object.keys(spec) as (keyof T)[]) {
      const read = spec[key](value[key as string]);
      if (read === INVALID) return INVALID;
      out[key] = read;
    }
    return out as T;
  };
}

function arrayOf<T>(item: Read<T>): Read<T[]> {
  return (value) => {
    if (!Array.isArray(value)) return INVALID;
    const out: T[] = [];
    for (const entry of value) {
      const read = item(entry);
      if (read === INVALID) return INVALID;
      out.push(read);
    }
    return out;
  };
}

/** Absent (undefined) stays undefined; a present value must read. */
function optional<T>(read: Read<T>): Read<T | undefined> {
  return (value) => (value === undefined ? undefined : read(value));
}

export interface WireSaleLine {
  lineRef: string;
  lineName: string;
  quantity: string;
  unitPrice: string;
  lineAmount: string;
  returnedQuantity: string;
  returnableQuantity: string;
}

export interface WireSaleTender {
  method: string;
}

export interface WireSale {
  saleRef: string;
  currencyCode: string;
  voided: boolean;
  lines: WireSaleLine[];
  /** Optional until RT-77 emits it (contract `Sale.tenders`). */
  tenders?: WireSaleTender[] | undefined;
}

export interface WireSaleReturn {
  returnRef: string;
  saleRef: string;
  externalId: string;
  currencyCode: string;
  returnTotal: string;
  recordedAt: string;
}

const readSaleLine = readObject<WireSaleLine>({
  lineRef: uuid,
  lineName: str,
  quantity: str,
  unitPrice: str,
  lineAmount: str,
  returnedQuantity: str,
  returnableQuantity: str,
});

const readSale = readObject<WireSale>({
  saleRef: uuid,
  currencyCode: currency,
  voided: bool,
  lines: arrayOf(readSaleLine),
  tenders: optional(arrayOf(readObject<WireSaleTender>({ method: str }))),
});

const readSaleReturn = readObject<WireSaleReturn>({
  returnRef: uuid,
  saleRef: uuid,
  externalId: str,
  currencyCode: currency,
  returnTotal: str,
  recordedAt: str,
});

const readErrorCodeShape = readObject<{ error: { code: string } }>({
  error: readObject<{ code: string }>({ code: str }),
});

function readWith<T>(json: unknown, read: Read<T>): T | null {
  const value = read(json);
  return value === INVALID ? null : value;
}

/**
 * The response text as JSON, or `undefined` when it is not JSON (which then
 * reads as no body at all).
 */
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The needed `Sale` fields, or null when any is missing or mistyped. */
export function readSaleBody(json: unknown): WireSale | null {
  return readWith(json, readSale);
}

/** The needed `SaleReturn` fields, or null when any is missing or mistyped. */
export function readSaleReturnBody(json: unknown): WireSaleReturn | null {
  return readWith(json, readSaleReturn);
}

/** `error.code` from the canonical `Error` envelope, or null. */
export function readErrorCode(json: unknown): string | null {
  return readWith(json, readErrorCodeShape)?.error.code ?? null;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
