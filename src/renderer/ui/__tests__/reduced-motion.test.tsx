import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// T041 — prefers-reduced-motion invariance.
// happy-dom does not compute layout or evaluate media queries, so we use
// two complementary strategies:
//   1. CSS text audit: assert the @media (prefers-reduced-motion: reduce)
//      block is present in tailwind.css and targets each animated surface.
//   2. DOM audit: assert animated components carry the [data-animate] or
//      equivalent marker that CSS uses as the animation hook, so the media
//      query block actually has something to target.

const TAILWIND_CSS = resolve(__dirname, '../../styles/tailwind.css');
const cssText = readFileSync(TAILWIND_CSS, 'utf-8');

// Narrow to just the reduce block(s) for targeted assertions.
const reduceBlocks = cssText
  .split('@media')
  .filter((chunk) => chunk.includes('prefers-reduced-motion') && chunk.includes('reduce'))
  .join('@media');

describe('prefers-reduced-motion guard (T041)', () => {
  afterEach(cleanup);

  // ── CSS text assertions ──────────────────────────────────────────────────

  it('tailwind.css contains at least one prefers-reduced-motion: reduce block', () => {
    expect(cssText).toMatch(/prefers-reduced-motion\s*:\s*reduce/);
  });

  it('reduce block disables Dialog fade-in animation', () => {
    // Dialog overlay or panel animation (the inactivity lock still uses them)
    expect(reduceBlocks).toMatch(/\.dialog|dialog-panel|dialog-overlay|\[role.*dialog\]/);
  });

  it('reduce block disables StatusBanner syncing pulse', () => {
    // syncing pulse on aside[data-state="syncing"] or the dot
    expect(reduceBlocks).toMatch(/syncing|pulse-dot|status.*syncing/);
  });

  it('reduce block sets animation: none or transition: none', () => {
    expect(reduceBlocks).toMatch(/animation\s*:\s*none|transition\s*:\s*none/);
  });

  // ── DOM structural assertions ────────────────────────────────────────────
  // These confirm that the DOM hooks the CSS media query targets actually exist.

  it('StatusBanner syncing: aside carries data-state="syncing" (CSS animation hook)', async () => {
    const { StatusBanner } = await import('../primitives/StatusBanner/StatusBanner');
    render(<StatusBanner state="syncing" message="Syncing..." />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('data-state', 'syncing');
    cleanup();
  });
});
