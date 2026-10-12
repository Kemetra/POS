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

/** The body of the rule whose selector list is exactly `selectors`. */
function ruleBody(selectors: string): string {
  for (const rule of css.split('}')) {
    const [head, body] = rule.split('{');
    if (head?.replace(/\s+/g, ' ').trim() === selectors) return body ?? '';
  }
  throw new Error(`no rule for ${selectors}`);
}

const ACTION_ROW = '.v5-dialog > div:last-child, .v5-dialog > form:last-child > div:last-child';

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

/**
 * RT-313 (RT-312 B2) — a dialog taller than the viewport scrolls inside its
 * panel with the action row pinned, instead of being clipped at both ends.
 * happy-dom does not lay out, so these are source tripwires; the Chromium
 * probe recorded on RT-313 is the layout proof.
 */
describe('dialog.css — never taller than the viewport (RT-313)', () => {
  it('caps the panel at the viewport minus a gutter on each side', () => {
    expect(panel).toMatch(
      /max-block-size:\s*calc\(100dvh - 2 \* var\(--v5-gutter, var\(--space-3\)\)\)/,
    );
  });

  it('scrolls a taller body inside the panel', () => {
    expect(panel).toMatch(/overflow-y:\s*auto/);
    expect(panel).toMatch(/overscroll-behavior:\s*contain/);
  });

  it('reserves the pinned row as end scroll padding, so a focused field is never hidden under it', () => {
    expect(panel).toMatch(
      /scroll-padding-block-end:\s*calc\(var\(--v5-target, 44px\) \+ var\(--space-5\) \+ var\(--space-2\)\)/,
    );
  });

  it('pins the action row at the foot of the panel, on an opaque fill', () => {
    const row = ruleBody(ACTION_ROW);
    expect(row).toMatch(/position:\s*sticky/);
    expect(row).toMatch(/inset-block-end:\s*0/);
    expect(row).toMatch(/background:\s*var\(--color-surface\)/);
  });

  it('moves the panel bottom padding onto the pinned row (Chromium pins inside padding)', () => {
    expect(ruleBody(ACTION_ROW)).toMatch(/padding-block-end:\s*var\(--space-5\)/);
    expect(
      ruleBody('.v5-dialog:has(> div:last-child, > form:last-child > div:last-child)'),
    ).toMatch(/padding-block-end:\s*0/);
  });
});
