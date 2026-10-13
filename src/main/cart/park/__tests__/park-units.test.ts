/**
 * RT-440 (PK-2) — the pure parts of Park v1: the label rule (K2), the stale
 * marker (K4), the request hash (R-7), the resume diff (§3.3) and the
 * catalogue price lookup.
 */
import { describe, expect, it } from 'vitest';

import { cairoBusinessDay, hashRequest, isStale, normalizeLabel } from '../park-rules.js';
import {
  computeResumeDiff,
  createCataloguePriceLookup,
  isAcceptedDiff,
  type PriceAnswer,
} from '../resume-diff.js';

describe('normalizeLabel', () => {
  it('trims, keeps 1–40 characters, and treats absent as no label', () => {
    expect(normalizeLabel(undefined)).toEqual({ ok: true, label: null });
    expect(normalizeLabel('  bag  ')).toEqual({ ok: true, label: 'bag' });
    expect(normalizeLabel('ح'.repeat(40))).toEqual({ ok: true, label: 'ح'.repeat(40) });
  });

  it.each(['', '   ', 'x'.repeat(41), 'a\tb', 'a b', 'a\u0000'])('refuses %j', (label) => {
    expect(normalizeLabel(label)).toEqual({ ok: false, label: null });
  });
});

describe('isStale (K4)', () => {
  it('is not stale the same Cairo day within 12 h', () => {
    expect(isStale('2026-10-13T06:00:00.000Z', new Date('2026-10-13T17:59:00.000Z'))).toBe(false);
  });

  it('is stale after 12 h', () => {
    expect(isStale('2026-10-13T00:00:00.000Z', new Date('2026-10-13T12:00:01.000Z'))).toBe(true);
  });

  it('is stale on the next Cairo business day even within 12 h', () => {
    expect(isStale('2026-10-13T20:00:00.000Z', new Date('2026-10-13T21:30:00.000Z'))).toBe(true);
    expect(cairoBusinessDay(new Date('2026-10-13T21:30:00.000Z'))).toBe('2026-10-14');
  });
});

describe('hashRequest (R-7)', () => {
  it('ignores key order and separates different values', () => {
    expect(hashRequest({ a: '1', b: true })).toBe(hashRequest({ b: true, a: '1' }));
    expect(hashRequest({ a: '1', b: null })).not.toBe(hashRequest({ a: '1', b: 'null' }));
  });
});

const line = (line_id: string, item_ref: string, unit: number, quantity = 1) => ({
  line_id,
  item_ref,
  quantity,
  unit_price_minor: unit,
});

const lookupOf =
  (answers: Record<string, PriceAnswer>) =>
  (_tenant: string, item: string): PriceAnswer =>
    answers[item] ?? { kind: 'unavailable' };

describe('computeResumeDiff (§3.3)', () => {
  it('lists changes with their new subtotal, and gone lines, in line-id order', () => {
    const result = computeResumeDiff(
      't',
      [line('l2', 'A', 100, 3), line('l1', 'B', 50), line('l3', 'C', 70)],
      lookupOf({
        A: { kind: 'price', unit_price_minor: 120 },
        B: { kind: 'gone' },
        C: { kind: 'price', unit_price_minor: 70 },
      }),
    );
    if (result.kind !== 'diff') throw new Error('expected a diff');
    expect(result.diff).toMatchObject({
      changes: [
        { line_id: 'l2', old_unit_minor: 100, new_unit_minor: 120, new_subtotal_minor: 360 },
      ],
      unavailable: ['l1'],
    });
    expect(result.diff.diff_token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('answers catalogue_unavailable for an unreadable catalogue or an unsafe subtotal', () => {
    expect(computeResumeDiff('t', [line('l1', 'A', 1)], lookupOf({}))).toEqual({
      kind: 'catalogue_unavailable',
    });
    const huge: PriceAnswer = { kind: 'price', unit_price_minor: Number.MAX_SAFE_INTEGER };
    expect(computeResumeDiff('t', [line('l1', 'A', 1, 2)], lookupOf({ A: huge }))).toEqual({
      kind: 'catalogue_unavailable',
    });
  });

  it('accepts only the token it issued, and changes only when accepted', () => {
    const same = lookupOf({ A: { kind: 'price', unit_price_minor: 5 } });
    const clean = computeResumeDiff('t', [line('l1', 'A', 5)], same);
    const changed = computeResumeDiff('t', [line('l1', 'A', 5)], lookupOf({ A: { kind: 'gone' } }));
    if (clean.kind !== 'diff' || changed.kind !== 'diff') throw new Error('expected diffs');
    const c = clean.diff;
    const d = changed.diff;
    expect(c.diff_token).not.toBe(d.diff_token);
    expect(isAcceptedDiff(c, { accept_changes: false, diff_token: c.diff_token })).toBe(true);
    expect(isAcceptedDiff(d, { accept_changes: false, diff_token: d.diff_token })).toBe(false);
    expect(isAcceptedDiff(d, { accept_changes: true, diff_token: d.diff_token })).toBe(true);
    expect(isAcceptedDiff(d, { accept_changes: true, diff_token: c.diff_token })).toBe(false);
  });
});

describe('createCataloguePriceLookup', () => {
  const lookup = createCataloguePriceLookup({
    resolveForSeam: (_tenant, id) => {
      switch (id) {
        case 'ok':
          return { kind: 'found', product: { price_minor: 250, active: true } };
        case 'inactive':
          return { kind: 'found', product: { price_minor: 250, active: false } };
        case 'corrupt':
          return { kind: 'found', product: { price_minor: 1.5, active: true } };
        case 'missing':
          return { kind: 'not_found' };
        default:
          return { kind: 'unavailable' };
      }
    },
  });

  it('maps the read model: price, gone (missing or inactive), unavailable', () => {
    expect(lookup('t', 'ok')).toEqual({ kind: 'price', unit_price_minor: 250 });
    expect(lookup('t', 'inactive')).toEqual({ kind: 'gone' });
    expect(lookup('t', 'missing')).toEqual({ kind: 'gone' });
    expect(lookup('t', 'corrupt')).toEqual({ kind: 'unavailable' });
    expect(lookup('t', 'down')).toEqual({ kind: 'unavailable' });
  });
});
