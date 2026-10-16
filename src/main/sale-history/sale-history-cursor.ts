/**
 * RT-542 — the bridge cursor of a history walk. One walk keeps one source, and
 * the cursor names it: `s.<Backend-Core cursor>` for the server walk,
 * `n.` / `c.` / `u.` + the RT-541 local cursor for the offline walk (no
 * connection / no credential / server unavailable), so a later page never
 * mixes sources. Opaque to the renderer;
 * parsed strictly here (the server part against the contract charset, the
 * local part by RT-541's own codec in `planSalesList`).
 */

import type { SaleHistoryLocalPage } from '../../shared/sale-history/types.js';
import { isServerCursor } from './sale-history-wire.js';

export type OfflineReason = SaleHistoryLocalPage['offline_reason'];

export type Position =
  | { readonly kind: 'first' }
  | { readonly kind: 'server'; readonly cursor: string }
  | { readonly kind: 'local'; readonly reason: OfflineReason; readonly cursor: string };

const SERVER_PREFIX = 's.';
const LOCAL_PREFIX: Readonly<Record<OfflineReason, string>> = {
  no_connection: 'n.',
  no_credential: 'c.',
  server_unavailable: 'u.',
};

const DECODERS: Readonly<Record<string, (cursor: string) => Position | null>> = {
  [SERVER_PREFIX]: (cursor) => (isServerCursor(cursor) ? { kind: 'server', cursor } : null),
  [LOCAL_PREFIX.no_connection]: (cursor) => ({ kind: 'local', reason: 'no_connection', cursor }),
  [LOCAL_PREFIX.no_credential]: (cursor) => ({ kind: 'local', reason: 'no_credential', cursor }),
  [LOCAL_PREFIX.server_unavailable]: (cursor) => ({
    kind: 'local',
    reason: 'server_unavailable',
    cursor,
  }),
};

/** The walk position of a request cursor, or null when it is malformed. */
export function decodePosition(raw: unknown): Position | null {
  if (raw === undefined || raw === null) return { kind: 'first' };
  if (typeof raw !== 'string') return null;
  return DECODERS[raw.slice(0, 2)]?.(raw.slice(2)) ?? null;
}

/** The bridge cursor of a server page's `nextCursor`. */
export function serverCursor(next: string | null): string | null {
  return next === null ? null : `${SERVER_PREFIX}${next}`;
}

/** The bridge cursor of a local page's `next_cursor`. */
export function localCursor(reason: OfflineReason, next: string | null): string | null {
  return next === null ? null : `${LOCAL_PREFIX[reason]}${next}`;
}
