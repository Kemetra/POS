import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import postcss, { type AtRule, type Rule } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LockScreen } from '../../session/LockScreen';
import type { LockStateView } from '../../../shared/bridge-api';

afterEach(cleanup);

/**
 * T041 / RT-813 (RT-260 F1, F2) — prefers-reduced-motion invariance.
 *
 * happy-dom evaluates no media queries, so the proof ties two live things
 * together instead of grepping text:
 *   1. the real CSS sources, parsed with postcss into rules that carry their
 *      `@media (prefers-reduced-motion: reduce)` / `@layer` context and source
 *      order, and
 *   2. real production DOM (the lock screen mounted standalone, exactly as
 *      `SessionLockGate` renders it: no `.v5-frame` ancestor), asked with
 *      `matches()` / `closest()` which reduce rules actually reach it.
 * A selector that stops matching a live element, or a reduce rule that is
 * removed or reintroduces a duration, turns a test red. The computed-style
 * proof under a real `prefers-reduced-motion: reduce` stays with RT-260.
 *
 * The first version of this test matched `.dialog-panel` / `.dialog-overlay`,
 * classes no component uses, so it passed while the lock dialog and the text
 * inputs still animated.
 */

const RENDERER = resolve(__dirname, '../..');

interface CssRule {
  file: string;
  selectors: string[];
  decls: Record<string, string>;
  reduce: boolean;
  layer: string;
  offset: number;
}

const REDUCE_MEDIA = /prefers-reduced-motion\s*:\s*reduce/;

function listCss(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : listCss(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

/** Where a rule sits: reduce media, named layer, or somewhere we do not model (other media, keyframes). */
function contextOf(rule: Rule): { reduce: boolean; layer: string; modelled: boolean } {
  let reduce = false;
  let layer = '';
  let modelled = true;
  let node: Rule['parent'] = rule.parent;
  while (node !== undefined && node.type !== 'root') {
    if (node.type === 'atrule') {
      const at = node as AtRule;
      if (at.name === 'media' && REDUCE_MEDIA.test(at.params)) reduce = true;
      else if (at.name === 'layer') layer = at.params;
      else modelled = false;
    }
    node = node.parent;
  }
  return { reduce, layer, modelled };
}

function parse(file: string): CssRule[] {
  const rules: CssRule[] = [];
  postcss.parse(readFileSync(file, 'utf-8'), { from: file }).walkRules((rule) => {
    const { reduce, layer, modelled } = contextOf(rule);
    if (!modelled) return;
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop] = d.value.trim();
    });
    rules.push({
      file,
      selectors: rule.selectors,
      decls,
      reduce,
      layer,
      offset: rule.source?.start?.offset ?? 0,
    });
  });
  return rules;
}

const ALL_CSS = listCss(RENDERER).flatMap(parse);
const TAILWIND = resolve(RENDERER, 'styles/tailwind.css');
const REDUCE_RULES = ALL_CSS.filter((r) => r.reduce);
const BASE_RULES = ALL_CSS.filter((r) => !r.reduce);

/** A reduced value that carries no motion: `none`, or only zero times. */
function isStill(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim();
  if (v === 'none') return true;
  const times = [...v.matchAll(/(\d*\.?\d+)(ms|s)\b/g)];
  return times.length > 0 && times.every((t) => Number(t[1]) === 0);
}

/** Does `el` match any selector of the rule? Selectors happy-dom cannot parse count as no match. */
function reaches(el: Element, rule: CssRule): boolean {
  return rule.selectors.some((sel) => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  });
}

/** Does `el` or an ancestor match any selector of the rule (a custom property inherits down)? */
function reachesAncestry(el: Element, rule: CssRule): boolean {
  return rule.selectors.some((sel) => {
    try {
      return el.closest(sel) !== null;
    } catch {
      return false;
    }
  });
}

const LOCKED: LockStateView = {
  state: 'locked',
  locked_at: '2026-10-01T10:10:00.000Z',
  role: 'manager',
  display_name: 'Manager One',
  summary: null,
};

/** The lock, mounted standalone: the same shape `SessionLockGate` renders, with no V5 frame around it. */
function renderLock(): void {
  render(
    <LockScreen
      view={LOCKED}
      unlock={vi.fn(() => Promise.resolve({ kind: 'unlocked' as const }))}
      onUnlocked={vi.fn()}
    />,
  );
}

describe('the guard reads live CSS (not a dead selector)', () => {
  it('finds the reduce blocks and the base rules it reasons about', () => {
    expect(REDUCE_RULES.length).toBeGreaterThan(0);
    expect(BASE_RULES.some((r) => r.selectors.includes('.v5-dialog'))).toBe(true);
    expect(
      BASE_RULES.some((r) => r.file === TAILWIND && r.selectors.includes("input[type='text']")),
    ).toBe(true);
  });

  it('every selector it relies on is used by production TSX (the old guard matched classes no component renders)', () => {
    const tsx = listTsx(RENDERER).map((f) => readFileSync(f, 'utf-8'));
    const used = (needle: string): boolean => tsx.some((src) => src.includes(needle));
    expect(used('v5-dialog-host')).toBe(true);
    expect(used('v5-dialog')).toBe(true);
    expect(used('type="text"')).toBe(true);
  });
});

function listTsx(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : listTsx(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('F1 — a dialog hosted outside .v5-frame (the lock) stops animating under reduce', () => {
  it('boundary: the lock dialog has no .v5-frame ancestor, so a frame-only reduce rule never reaches it', () => {
    renderLock();
    const dialog = document.querySelector('.v5-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.closest('.v5-frame')).toBeNull();
  });

  it('a reduce rule zeroes the dialog-in role for the lock dialog (or its host), without a frame', () => {
    renderLock();
    const dialog = document.querySelector('.v5-dialog');
    if (dialog === null) throw new Error('lock dialog not rendered');
    const zeroesRole = REDUCE_RULES.some(
      (r) => isStill(r.decls['--motion-dialog-in']) && reachesAncestry(dialog, r),
    );
    const stopsPanel = REDUCE_RULES.some(
      (r) =>
        reaches(dialog, r) &&
        (isStill(r.decls['animation']) || isStill(r.decls['animation-duration'])),
    );
    expect(zeroesRole || stopsPanel).toBe(true);
  });

  it('the panel still animates in with the 220 ms role under normal motion (unchanged)', () => {
    const panel = BASE_RULES.find((r) => r.selectors.includes('.v5-dialog'));
    expect(panel?.decls['animation']).toMatch(
      /^v5-dialog-in var\(--motion-dialog-in, 220ms\) var\(--motion-ease, ease-out\) both$/,
    );
    const frame = BASE_RULES.find((r) => r.selectors.includes('.v5-frame'));
    expect(frame?.decls['--motion-dialog-in']).toBe('var(--duration-3)');
    // No unconditional rule may zero the role: only the reduce path may.
    const unconditional = BASE_RULES.filter(
      (r) =>
        r.decls['--motion-dialog-in'] !== undefined &&
        !r.selectors.includes('.v5-frame') &&
        isStill(r.decls['--motion-dialog-in']),
    );
    expect(unconditional).toEqual([]);
  });
});

describe('F2 — the global text/number input transition stops under reduce', () => {
  function liveTextInput(): HTMLInputElement {
    renderLock();
    const input = document.querySelector<HTMLInputElement>('input[type="text"]');
    if (input === null) throw new Error('lock text input not rendered');
    return input;
  }

  function numberInput(): HTMLInputElement {
    // No production component renders type="number" today; the global rule's
    // selector list is the contract, so this element stands for it.
    const input = document.createElement('input');
    input.type = 'number';
    document.body.appendChild(input);
    return input;
  }

  it.each([
    ['text (the lock identifier field)', liveTextInput],
    ['number', numberInput],
  ] as const)(
    'a reduce rule stops the %s input transition, after (and in the same layer as) the rule that sets it',
    (_name, make) => {
      const input = make();
      const setters = BASE_RULES.filter(
        (r) => reaches(input, r) && r.decls['transition'] !== undefined,
      );
      expect(setters.length, 'the global rule that animates the input').toBeGreaterThan(0);
      for (const setter of setters) {
        // Normal motion is unchanged: the 150 ms border/shadow transition stays.
        expect(setter.decls['transition']).toMatch(
          /border-color 150ms ease,\s*box-shadow 150ms ease/,
        );
        const stops = REDUCE_RULES.filter(
          (r) =>
            r.file === setter.file &&
            reaches(input, r) &&
            (isStill(r.decls['transition']) || isStill(r.decls['transition-duration'])) &&
            r.layer === setter.layer &&
            r.offset > setter.offset,
        );
        expect(
          stops.length,
          'a later same-layer reduce rule with transition: none',
        ).toBeGreaterThan(0);
      }
    },
  );
});

describe('no reduce rule reintroduces motion', () => {
  const MOTION = ['animation', 'animation-duration', 'transition', 'transition-duration'];

  it('every animation/transition a reduce block declares is none or zero-length', () => {
    const offenders = REDUCE_RULES.flatMap((r) =>
      MOTION.filter((p) => r.decls[p] !== undefined && !isStill(r.decls[p])).map(
        (p) => `${r.file}: ${r.selectors.join(', ')} { ${p}: ${r.decls[p] ?? ''} }`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
