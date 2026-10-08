/**
 * formatRelativeTime — relative "last opened" timestamp for the Slice-4
 * `<DrawerFailureBanner>` (§A1 brief sub-item (g): "last opened: 2 hours ago").
 *
 * Contract:
 *   • Relative, human-readable, Latin digits only (FR-066 — no Arabic-Indic
 *     numerals regardless of locale).
 *   • `now` is INJECTED (never `Date.now()`) so the renderer passes a stable
 *     reference and the formatter is deterministic under test.
 *   • A null / unparseable input returns a safe fallback string, never throws —
 *     the banner must render even if the timestamp is missing/corrupt.
 *   • Future timestamps (clock skew) clamp to «الآن» rather than "in N…".
 *   • RT-240: Arabic only; the banner it serves has no English half.
 */

import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from '../../../../src/shared/formatters/time-formatters.js';

const NOW = '2026-05-29T12:00:00.000Z';

describe('formatRelativeTime', () => {
  // RT-240: the banner is Arabic only, so the relative time is Arabic too, with
  // the dual and the 3-10 / 11+ count forms.
  it('says «الآن» for < 60s ago', () => {
    expect(formatRelativeTime('2026-05-29T11:59:30.000Z', NOW)).toBe('الآن');
    expect(formatRelativeTime('2026-05-29T12:00:00.000Z', NOW)).toBe('الآن');
  });

  it('formats minutes: one, two, 3-10, 11+', () => {
    expect(formatRelativeTime('2026-05-29T11:59:00.000Z', NOW)).toBe('منذ دقيقة');
    expect(formatRelativeTime('2026-05-29T11:58:00.000Z', NOW)).toBe('منذ دقيقتين');
    expect(formatRelativeTime('2026-05-29T11:55:00.000Z', NOW)).toBe('منذ 5 دقائق');
    expect(formatRelativeTime('2026-05-29T11:45:00.000Z', NOW)).toBe('منذ 15 دقيقة');
  });

  it('formats hours: one, two, 3-10, 11+', () => {
    expect(formatRelativeTime('2026-05-29T11:00:00.000Z', NOW)).toBe('منذ ساعة');
    expect(formatRelativeTime('2026-05-29T10:00:00.000Z', NOW)).toBe('منذ ساعتين');
    expect(formatRelativeTime('2026-05-29T09:00:00.000Z', NOW)).toBe('منذ 3 ساعات');
    expect(formatRelativeTime('2026-05-28T13:00:00.000Z', NOW)).toBe('منذ 23 ساعة');
  });

  it('says «أمس» for one day ago, then two, 3-10 and 11+ days', () => {
    expect(formatRelativeTime('2026-05-28T12:00:00.000Z', NOW)).toBe('أمس');
    expect(formatRelativeTime('2026-05-27T12:00:00.000Z', NOW)).toBe('منذ يومين');
    expect(formatRelativeTime('2026-05-26T12:00:00.000Z', NOW)).toBe('منذ 3 أيام');
    expect(formatRelativeTime('2026-05-14T12:00:00.000Z', NOW)).toBe('منذ 15 يومًا');
  });

  // RT-258 / UX-12: the noun form follows the ICU `ar` plural category
  // (3-10 few, 11-99 many, 100+ other), not a hand-rolled `n <= 10` rule.
  it('picks the plural category per count: 3, 10, 11, 100, 101 (RT-258)', () => {
    const minutesAgo = (m: number): string =>
      formatRelativeTime(new Date(Date.parse(NOW) - m * 60_000).toISOString(), NOW);
    const hoursAgo = (h: number): string =>
      formatRelativeTime(new Date(Date.parse(NOW) - h * 3_600_000).toISOString(), NOW);
    const daysAgo = (d: number): string =>
      formatRelativeTime(new Date(Date.parse(NOW) - d * 86_400_000).toISOString(), NOW);

    expect(minutesAgo(3)).toBe('منذ 3 دقائق');
    expect(minutesAgo(10)).toBe('منذ 10 دقائق');
    expect(minutesAgo(11)).toBe('منذ 11 دقيقة');
    expect(hoursAgo(3)).toBe('منذ 3 ساعات');
    expect(hoursAgo(10)).toBe('منذ 10 ساعات');
    expect(hoursAgo(11)).toBe('منذ 11 ساعة');
    expect(daysAgo(3)).toBe('منذ 3 أيام');
    expect(daysAgo(10)).toBe('منذ 10 أيام');
    expect(daysAgo(11)).toBe('منذ 11 يومًا');
    expect(daysAgo(100)).toBe('منذ 100 يومًا');
    expect(daysAgo(101)).toBe('منذ 101 يومًا');
  });

  it('uses Latin digits only (FR-066), never Arabic-Indic numerals', () => {
    const out = formatRelativeTime('2026-05-29T11:45:00.000Z', NOW);
    expect(/[٠-٩]/.test(out)).toBe(false);
    expect(out).toMatch(/\d/);
  });

  it('clamps a future timestamp (clock skew) to «الآن»', () => {
    expect(formatRelativeTime('2026-05-29T12:05:00.000Z', NOW)).toBe('الآن');
  });

  it('returns «غير معروف» for null / unparseable input (never throws)', () => {
    expect(formatRelativeTime(null, NOW)).toBe('غير معروف');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('غير معروف');
    expect(formatRelativeTime('', NOW)).toBe('غير معروف');
  });

  it('never returns Latin letters', () => {
    for (const iso of [null, '2026-05-29T11:00:00.000Z', '2026-05-20T12:00:00.000Z']) {
      expect(formatRelativeTime(iso, NOW)).not.toMatch(/[A-Za-z]/);
    }
  });
});
