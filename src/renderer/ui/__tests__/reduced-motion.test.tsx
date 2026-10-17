import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// T041 — prefers-reduced-motion invariance.
// happy-dom does not compute layout or evaluate media queries, so this is a
// CSS text audit: the @media (prefers-reduced-motion: reduce) block is present
// in tailwind.css and targets each animated surface. RT-606 retired the 007
// StatusBanner and its syncing pulse.

const TAILWIND_CSS = resolve(__dirname, '../../styles/tailwind.css');
const cssText = readFileSync(TAILWIND_CSS, 'utf-8');

// Narrow to just the reduce block(s) for targeted assertions.
const reduceBlocks = cssText
  .split('@media')
  .filter((chunk) => chunk.includes('prefers-reduced-motion') && chunk.includes('reduce'))
  .join('@media');

describe('prefers-reduced-motion guard (T041)', () => {
  // ── CSS text assertions ──────────────────────────────────────────────────

  it('tailwind.css contains at least one prefers-reduced-motion: reduce block', () => {
    expect(cssText).toMatch(/prefers-reduced-motion\s*:\s*reduce/);
  });

  it('reduce block disables Dialog fade-in animation', () => {
    // Dialog overlay or panel animation (the inactivity lock still uses them)
    expect(reduceBlocks).toMatch(/\.dialog|dialog-panel|dialog-overlay|\[role.*dialog\]/);
  });

  it('reduce block sets animation: none or transition: none', () => {
    expect(reduceBlocks).toMatch(/animation\s*:\s*none|transition\s*:\s*none/);
  });
});
