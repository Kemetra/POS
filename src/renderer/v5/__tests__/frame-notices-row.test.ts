import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The notices strip above every screen: banners take a full row each, the quiet
 * one-line links («حالة الوردية», «إلغاء بيع») share one row. Stacked, those two
 * links cost ~29px and pushed the Checkout keypad's last row (00 · 0 · ⌫) out of
 * view at 1024×768. A source tripwire, not cascade verification: the measured
 * evidence is the 1024×768 Checkout capture on the branch.
 */
describe('frame notices strip CSS', () => {
  const css = readFileSync(resolve(__dirname, '../frame/frame.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('wraps its children instead of stacking them as grid rows', () => {
    expect(css).toMatch(/\.v5-frame__notices\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap/);
  });

  it('gives every notice a full row by default', () => {
    expect(css).toMatch(/\.v5-frame__notices > \*\s*\{[^}]*flex:\s*1 1 100%/);
  });

  it('lets the shift and void links share one row', () => {
    expect(css).toMatch(
      /\.v5-frame__notices > :is\(\.v5-shift-notice, \.v5-void-link\)\s*\{[^}]*flex:\s*0 1 auto/,
    );
  });
});
