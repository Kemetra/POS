import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-241 — the Dialog's motion and radius come from DESIGN.md through tokens
 * (source tripwire; the R-dev captures are the visual proof). The duration is
 * the `--motion-dialog-in` alias, which foundation.css zeroes under reduced
 * motion, so reduced motion needs no separate rule here.
 */
const css = readFileSync(resolve(__dirname, '../dialog.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const panel = /\.v5-dialog\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

describe('dialog.css', () => {
  it('animates in with the dialog-in motion role, never a literal duration', () => {
    expect(panel).toMatch(
      /animation:\s*v5-dialog-in var\(--motion-dialog-in[^)]*\) var\(--motion-ease/,
    );
  });

  it('uses the overlay pane radius (DESIGN.md Elevation)', () => {
    expect(panel).toMatch(/border-radius:\s*var\(--radius-pane\)/);
  });
});
