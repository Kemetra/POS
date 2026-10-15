import { describe, expect, it } from 'vitest';

import { displayNameOf, formatOpenFor, initialOf } from '../stuck-shifts-model';

/** RT-502 — how long a shift has been open, with the RT-258 Arabic plural categories. */
describe('formatOpenFor', () => {
  it.each([
    [0, 'أقل من دقيقة'],
    [0.6, 'أقل من دقيقة'],
    [-3, 'أقل من دقيقة'],
    [Number.NaN, 'أقل من دقيقة'],
    [1, 'دقيقة'],
    [2, 'دقيقتين'],
    [3, '3 دقائق'],
    [10, '10 دقائق'],
    [11, '11 دقيقة'],
    [45, '45 دقيقة'],
    [45.9, '45 دقيقة'],
    [60, 'ساعة'],
    [61, 'ساعة ودقيقة'],
    [62, 'ساعة ودقيقتين'],
    [65, 'ساعة و5 دقائق'],
    [120, 'ساعتين'],
    [190, '3 ساعات و10 دقائق'],
    [600, '10 ساعات'],
    [660, '11 ساعة'],
    [6000, '100 ساعة'],
  ])('%d minutes → «%s»', (minutes, text) => {
    expect(formatOpenFor(minutes)).toBe(text);
  });

  it('never uses Arabic-Indic digits', () => {
    expect(formatOpenFor(190)).not.toMatch(/[٠-٩]/);
  });
});

describe('displayNameOf / initialOf', () => {
  it('keeps a real name as it is', () => {
    expect(displayNameOf('أحمد سمير')).toBe('أحمد سمير');
  });

  it.each([[''], [null], [undefined]])('falls back to «كاشير بلا اسم» for %j', (name) => {
    expect(displayNameOf(name)).toBe('كاشير بلا اسم');
  });

  it('takes the first letter of the shown name', () => {
    expect(initialOf('  ياسمين خالد')).toBe('ي');
    expect(initialOf(displayNameOf(''))).toBe('ك');
  });
});
