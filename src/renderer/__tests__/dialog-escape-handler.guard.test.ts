import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Dialog-Escape static guard (whole-UI a11y audit — primitive-bypass P1 #5).
 *
 * WCAG 2.1.1: a modal dialog must be dismissible by keyboard (Escape). The
 * design system ships a `Dialog` (`v5/foundation/Dialog.tsx`) that handles
 * Escape (RT-504 retired the older `primitives/Dialog`); but several surfaces hand-roll `role="dialog"` divs
 * instead of using it, and the audit found three that shipped with NO Escape
 * handler (ForcedCloseSurface, TakeoverPrompt, CashierManagement Reset-PIN) —
 * a keyboard trap in cashier-critical flows.
 *
 * This is the recurrence gate: any non-test renderer `.tsx` that contains the
 * literal `role="dialog"` MUST also contain an Escape handler. (A consumer that
 * renders <Dialog/> does NOT contain the `role="dialog"` string — that literal
 * only appears in Dialog.tsx itself and in hand-rolled dialogs — so the rule is
 * simply: declare a dialog ⇒ handle Escape. Dialog.tsx satisfies it on its own.)
 *
 * Mirrors the existing source-sweep pattern in
 * `no-jwt-in-renderer-or-preload.test.ts`.
 */

const RENDERER_ROOT = resolve(__dirname, '../');

function collectTsxFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      result.push(...collectTsxFiles(full));
    } else if (extname(entry) === '.tsx' && !entry.endsWith('.test.tsx')) {
      result.push(full);
    }
  }
  return result;
}

/** A file "handles Escape" if it references the Escape key in any form. */
function handlesEscape(content: string): boolean {
  return /['"]Escape['"]/.test(content);
}

/** A file "declares a hand-rolled dialog" if it contains the role literal. */
function declaresDialogRole(content: string): boolean {
  return /role="dialog"/.test(content);
}

describe('dialog-escape static guard (a11y audit P1 #5)', () => {
  it('every renderer file declaring role="dialog" also handles Escape (WCAG 2.1.1)', () => {
    const files = collectTsxFiles(RENDERER_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      if (declaresDialogRole(content) && !handlesEscape(content)) {
        violations.push(file.replace(RENDERER_ROOT, 'src/renderer/'));
      }
    }

    expect(
      violations,
      `Hand-rolled role="dialog" without an Escape handler (keyboard trap, WCAG 2.1.1).\n` +
        `Add an Escape→close keydown handler (see v5/foundation/Dialog.tsx) or use the ` +
        `Dialog primitive:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('finds at least one dialog-declaring file (guard is actually scanning)', () => {
    // Sanity: ensure the collector/scan works so the guard can't silently pass
    // by matching zero files (e.g. if the root path breaks).
    const files = collectTsxFiles(RENDERER_ROOT);
    const dialogFiles = files.filter((f) => declaresDialogRole(readFileSync(f, 'utf-8')));
    expect(dialogFiles.length).toBeGreaterThan(0);
  });
});
