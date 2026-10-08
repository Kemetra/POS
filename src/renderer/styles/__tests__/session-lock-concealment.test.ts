import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-161 — the inactivity lock must CONCEAL the sale it preserves.
 *
 * While locked, `SessionLockGate` keeps the sale mounted (so the same operator
 * resumes it exactly) and the lock screen shows TOTALS ONLY. The sale itself —
 * line items, product names, amounts — must not be readable behind the lock
 * on an unattended till.
 *
 * jsdom loads no stylesheet, so the renderer tests can only see the class the
 * gate sets. This guard checks the rules that class and the lock backdrop rely
 * on, in both themes:
 *   1. the concealed app wrapper is `visibility: hidden` (inherited by the
 *      whole sale subtree; it stays mounted);
 *   2. the lock's own backdrop is an OPAQUE token, not the translucent dialog
 *      scrim;
 *   3. ordinary dialogs keep the translucent scrim (lock-specific change only).
 */

const css = readFileSync(resolve(__dirname, '../tailwind.css'), 'utf-8');
const scrubbed = css.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.\\>[\]'()]/g, '\\$&').replace(/\s+/g, '\\s*');
  const rule = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(scrubbed);
  if (rule === null) throw new Error(`rule ${selector} not found`);
  return rule[1] ?? '';
}

function declaration(selector: string, property: string): string {
  const decl = new RegExp(`(?:^|;|\\n)\\s*${property}:\\s*([^;]+)`).exec(ruleBody(selector));
  if (decl === null) throw new Error(`${selector} declares no ${property}`);
  return (decl[1] ?? '').trim();
}

function tokenValue(block: string, token: string): string {
  const match = new RegExp(`--${token}:\\s*([^;]+);`).exec(block);
  if (match === null) throw new Error(`token --${token} not found`);
  return (match[1] ?? '').trim();
}

const lightBlock = ruleBody(':root');
const darkBlock = ruleBody(":root[data-theme='dark']");

describe('RT-161 lock conceals the preserved sale', () => {
  it('hides the preserved app subtree while it stays mounted', () => {
    expect(declaration('.session-lock-app--concealed', 'visibility')).toBe('hidden');
  });

  it('gives the lock an opaque backdrop in both themes', () => {
    const backdrop = declaration('.session-lock > .dialog-overlay', 'background');
    const token = /^var\(\s*--([\w-]+)\s*\)$/.exec(backdrop)?.[1];
    expect(token, `lock backdrop must be a single colour token, got "${backdrop}"`).toBeDefined();
    for (const block of [lightBlock, darkBlock]) {
      // A 6-digit hex has no alpha channel — fully opaque.
      expect(tokenValue(block, token ?? '')).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('leaves ordinary dialogs on the translucent scrim', () => {
    expect(declaration('.dialog-overlay', 'background')).toBe('var(--color-overlay-scrim)');
  });
});
