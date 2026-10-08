/**
 * RT-15 S2 — RFC 9562 UUIDv7 for the return `externalId`
 * (`pos-pulse-return:<uuidv7>`, also the Idempotency-Key).
 *
 * 48-bit big-endian Unix milliseconds, version 7, RFC variant, 74 random bits.
 * The clock and the random source are injectable for tests; production uses
 * `Date.now` and `crypto.randomBytes`.
 */
import { randomBytes } from 'node:crypto';

export interface UuidV7Sources {
  readonly now?: () => number;
  readonly random?: (size: number) => Uint8Array;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function uuidv7(sources: UuidV7Sources = {}): string {
  const millis = (sources.now ?? Date.now)();
  const bytes = new Uint8Array(16);
  bytes.set((sources.random ?? randomBytes)(10).subarray(0, 10), 6);
  let time = BigInt(Math.max(0, Math.floor(millis)));
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The return provenance id: `pos-pulse-return:<uuidv7>` (53 characters). */
export const RETURN_EXTERNAL_ID_PREFIX = 'pos-pulse-return:';

export function newReturnExternalId(sources: UuidV7Sources = {}): string {
  return `${RETURN_EXTERNAL_ID_PREFIX}${uuidv7(sources)}`;
}
