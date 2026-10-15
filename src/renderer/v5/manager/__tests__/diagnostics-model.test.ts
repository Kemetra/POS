import { describe, expect, it } from 'vitest';

import {
  formatSyncTime,
  freshnessText,
  freshnessView,
  refreshMessage,
  searchMessage,
} from '../diagnostics/diagnostics-model';
import { formatHumanDateTime } from '../../../ui/format/human-format';

const ISO = '2026-10-15T09:42:00Z';

describe('refreshMessage — honest status, never "done"', () => {
  it.each([
    ['started', 'بدأ التحديث.'],
    ['already_running', 'التحديث جارٍ بالفعل.'],
    ['refused', 'تعذّر بدء التحديث.'],
  ] as const)('%s → %s', (kind, text) => {
    expect(refreshMessage(kind)).toBe(text);
  });

  it('no refresh message claims the refresh completed', () => {
    for (const kind of ['started', 'already_running', 'refused'] as const) {
      expect(refreshMessage(kind)).not.toMatch(/اكتمل|تم التحديث|انتهى/);
    }
  });
});

describe('freshness', () => {
  it('never synced → «لم يُحدَّث بعد»', () => {
    const v = freshnessView({ kind: 'ok', last_success_at: null, is_empty: true });
    expect(freshnessText(v)).toBe('لم يُحدَّث بعد');
  });

  it('refused → «غير متاح»', () => {
    const v = freshnessView({ kind: 'refused', reason: 'no_session' });
    expect(freshnessText(v)).toBe('غير متاح');
  });

  it('synced but empty → «حُدِّث ولا توجد أصناف», with its time', () => {
    const v = freshnessView({ kind: 'ok', last_success_at: ISO, is_empty: true });
    expect(freshnessText(v)).toBe('حُدِّث ولا توجد أصناف');
    expect(v).toEqual({ kind: 'empty', at: ISO });
  });

  it('synced with items → the time alone', () => {
    const v = freshnessView({ kind: 'ok', last_success_at: ISO, is_empty: false });
    expect(freshnessText(v)).toBeNull();
    expect(v).toEqual({ kind: 'synced', at: ISO });
  });

  it('not read yet → a neutral ellipsis, not a state', () => {
    expect(freshnessText(freshnessView(null))).toBe('…');
  });

  it('the time comes from the shared formatter; an unparseable one stays verbatim', () => {
    expect(formatSyncTime(ISO)).toBe(formatHumanDateTime(ISO, { withYear: true }));
    expect(formatSyncTime('not-a-date')).toBe('not-a-date');
  });
});

describe('searchMessage', () => {
  const items = (n: number) =>
    ({
      kind: 'results',
      items: Array.from({ length: n }, (_, i) => ({ product_id: `p-${String(i)}` })),
      truncated: false,
    }) as never;

  it('nothing searched → nothing said', () => {
    expect(searchMessage(null)).toBeNull();
  });

  it.each([
    [1, 'نتيجة واحدة'],
    [2, 'نتيجتان'],
    [5, '5 نتائج'],
    [12, '12 نتيجة'],
    [20, '20 نتيجة'],
  ])('%i results → %s', (n, text) => {
    expect(searchMessage(items(n))).toBe(text);
  });

  it('not found → «لا توجد نتائج»', () => {
    expect(searchMessage({ kind: 'not_found' })).toBe('لا توجد نتائج');
  });

  it.each([
    { kind: 'refused', reason: 'no_session' },
    { kind: 'too_short' },
    { kind: 'catalogue_unavailable' },
  ] as const)('$kind → «غير متاح»', (res) => {
    expect(searchMessage(res as never)).toBe('غير متاح');
  });
});
