import { describe, expect, it } from 'vitest';
import { compareCodeUnits } from '../compare-code-units.js';

describe('compareCodeUnits', () => {
  it('orders by UTF-16 code unit, like the default sort', () => {
    const keys = ['a', 'B', '_x', 'Z', '10', '9', 'é', 'e'];
    expect([...keys].sort(compareCodeUnits)).toEqual(['10', '9', 'B', 'Z', '_x', 'a', 'e', 'é']);
  });

  it('is locale-independent: upper case before underscore before lower case', () => {
    expect(['a', '_x', 'B'].sort(compareCodeUnits)).toEqual(['B', '_x', 'a']);
  });

  it('returns 0 for equal strings and a signed result otherwise', () => {
    expect(compareCodeUnits('k', 'k')).toBe(0);
    expect(compareCodeUnits('a', 'b')).toBeLessThan(0);
    expect(compareCodeUnits('b', 'a')).toBeGreaterThan(0);
  });
});
