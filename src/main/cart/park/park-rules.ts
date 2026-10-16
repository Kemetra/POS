/**
 * RT-440 (PK-2, spec 024 K2 / K4 / R-7) — the pure rules of Park v1: the
 * label, the stale marker and the request hash. No I/O.
 */
import { createHash } from 'node:crypto';

import { PARK_LABEL_MAX_LENGTH, PARK_STALE_AFTER_MS } from '../../../shared/cart/park-types.js';
import { businessDayOf } from '../../../shared/time/business-day.js';

/** Control and line-separator characters: a label is one line of plain text. */
const NOT_PLAIN_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export type NormalizedLabel = { ok: true; label: string | null } | { ok: false; label: null };

/**
 * K2 / §3.1: absent → no label; otherwise plain text of 1–40 characters after
 * trimming (UTF-16 units: never looser than SQLite's character count).
 * Anything else is refused, including a label that trims to ''.
 */
export function normalizeLabel(label: string | undefined): NormalizedLabel {
  if (label === undefined) return { ok: true, label: null };
  const trimmed = label.trim();
  const plain = !NOT_PLAIN_TEXT.test(trimmed);
  const sized = trimmed.length > 0 && trimmed.length <= PARK_LABEL_MAX_LENGTH;
  return plain && sized ? { ok: true, label: trimmed } : { ok: false, label: null };
}

/**
 * The Africa/Cairo calendar day of an instant, as `YYYY-MM-DD`. RT-550: the
 * zone and the conversion live in the shared business-day module.
 */
export function cairoBusinessDay(instant: Date): string {
  return businessDayOf(instant);
}

/**
 * K4 (display only): older than 12 h, or parked on an earlier Cairo business
 * day than `now` (the D-N1 rule). Revalidation runs on every resume anyway.
 */
export function isStale(parkedAt: string, now: Date): boolean {
  const parked = new Date(parkedAt);
  if (now.getTime() - parked.getTime() > PARK_STALE_AFTER_MS) return true;
  return cairoBusinessDay(parked) < cairoBusinessDay(now);
}

/** R-7: a stable digest of a request's fields, in a fixed key order. */
export function hashRequest(fields: Record<string, string | boolean | null>): string {
  const ordered = Object.keys(fields)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => [key, fields[key]]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}
