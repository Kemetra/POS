/**
 * RT-840 (RT-754 F-A) — a programmatic `focus()` after a pointer interaction
 * does not match `:focus-visible` in Chromium, so the V5 ring was never drawn
 * on the control that owns focus after a confirm click. `focusVisibly` asks
 * for the ring explicitly (`focusVisible: true`); it never changes WHICH
 * element holds focus.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { focusVisibly } from '../focus-visibly';

describe('focusVisibly', () => {
  it('focuses the element asking for the visible ring', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const spy = vi.spyOn(button, 'focus');
    focusVisibly(button);
    expect(spy).toHaveBeenCalledWith({ focusVisible: true });
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('is a no-op for null or undefined', () => {
    expect(() => {
      focusVisibly(null);
      focusVisibly(undefined);
    }).not.toThrow();
  });
});

describe('V5 focus ring CSS contract', () => {
  const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');

  it('draws the token ring on .v5-btn and swaps to Highlight in forced-colors', () => {
    const css = read('buttons.css');
    expect(css).toMatch(
      /\.v5-btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-focus-ring\)/,
    );
    expect(css).toMatch(
      /forced-colors: active[\s\S]*\.v5-btn:focus-visible\s*\{\s*outline-color:\s*Highlight/,
    );
  });

  it('keeps one frame-wide :focus-visible treatment on the token', () => {
    expect(read('foundation.css')).toMatch(
      /\.v5-frame :focus-visible\s*\{[^}]*var\(--v5-focus-ring\)/,
    );
  });
});
