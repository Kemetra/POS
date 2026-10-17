import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import * as colors from '../colors';
import * as spacing from '../spacing';
import * as typography from '../typography';
import * as radius from '../radius';
import * as shadow from '../shadow';
import * as motion from '../motion';
import { density } from '../density';
import { touchTarget } from '../touch';

/**
 * T008 — Design token parity + completeness test.
 *
 * Asserts per contracts/design-tokens.md:
 * 1. Every TS token export has a matching CSS custom property in tailwind.css
 * 2. Every CSS custom property under :root has a matching TS export
 * 3. density enum has exactly two members (comfortable, compact)
 * 4. touchTarget.min === 44
 */

const TAILWIND_CSS_PATH = resolve(__dirname, '../../../styles/tailwind.css');
const cssContent = readFileSync(TAILWIND_CSS_PATH, 'utf-8');

function extractCssVars(css: string): Set<string> {
  const vars = new Set<string>();
  // Match --var-name: inside :root { ... } block
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/s);
  if (!rootMatch) return vars;
  const body = rootMatch[1] ?? '';
  for (const m of body.matchAll(/--([a-z][a-z0-9-]*)\s*:/g)) {
    const name = m[1];
    if (name) vars.add(`--${name}`);
  }
  return vars;
}

const cssVars = extractCssVars(cssContent);

// Build the expected CSS var names from TS exports
function camelToKebab(s: string): string {
  return s.replace(/([A-Z])/g, '-$1').toLowerCase();
}

describe('design token parity (T008)', () => {
  it('density has exactly two members: comfortable and compact', () => {
    const members = Object.keys(density);
    expect(members).toHaveLength(2);
    expect(members).toContain('comfortable');
    expect(members).toContain('compact');
  });

  it('touchTarget.min === 44', () => {
    expect(touchTarget.min).toBe(44);
  });

  describe('color tokens', () => {
    it('every TS color export has a matching CSS --color-* var', () => {
      for (const key of Object.keys(colors)) {
        const cssVar = `--color-${camelToKebab(key)}`;
        expect(cssVars, `Missing CSS var ${cssVar} for colors.${key}`).toContain(cssVar);
      }
    });
  });

  describe('spacing tokens', () => {
    it('every TS spacing key has a matching CSS --space-* var', () => {
      for (const key of Object.keys(spacing.spacing)) {
        const cssVar = `--space-${key}`;
        expect(cssVars, `Missing CSS var ${cssVar} for spacing[${key}]`).toContain(cssVar);
      }
    });
  });

  describe('typography tokens', () => {
    it('every TS font-family has a matching CSS --font-family-* var', () => {
      for (const key of Object.keys(typography.typography.family)) {
        const cssVar = `--font-family-${key}`;
        expect(cssVars, `Missing CSS var ${cssVar}`).toContain(cssVar);
      }
    });

    it('every TS font-weight has a matching CSS --font-weight-* var', () => {
      for (const key of Object.keys(typography.typography.weight)) {
        const cssVar = `--font-weight-${key}`;
        expect(cssVars, `Missing CSS var ${cssVar}`).toContain(cssVar);
      }
    });

    it('every TS font-size has a matching CSS --font-size-* var', () => {
      for (const key of Object.keys(typography.typography.size)) {
        const cssVar = `--font-size-${key}`;
        expect(cssVars, `Missing CSS var ${cssVar}`).toContain(cssVar);
      }
    });

    it('every TS line-height has a matching CSS --line-height-* var', () => {
      for (const key of Object.keys(typography.typography.lineHeight)) {
        const cssVar = `--line-height-${key}`;
        expect(cssVars, `Missing CSS var ${cssVar}`).toContain(cssVar);
      }
    });
  });

  describe('radius tokens', () => {
    it('every TS radius export has a matching CSS --radius-* var', () => {
      for (const key of Object.keys(radius.radius)) {
        const cssVar = `--radius-${key}`;
        expect(cssVars, `Missing CSS var ${cssVar}`).toContain(cssVar);
      }
    });
  });

  describe('shadow tokens', () => {
    it('every TS shadow export has a matching CSS --shadow-* var', () => {
      for (const key of Object.keys(shadow.shadow)) {
        const cssVar = `--shadow-${key}`;
        expect(cssVars, `Missing CSS var ${cssVar}`).toContain(cssVar);
      }
    });
  });

  describe('CSS vars have matching TS exports', () => {
    it('every --color-* CSS var has a matching TS color export', () => {
      for (const cssVar of cssVars) {
        if (!cssVar.startsWith('--color-')) continue;
        const key = cssVar
          .replace('--color-', '')
          .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        expect(colors, `CSS var ${cssVar} has no matching TS export colors.${key}`).toHaveProperty(
          key,
        );
      }
    });

    it('every --space-* CSS var has a matching TS spacing key', () => {
      for (const cssVar of cssVars) {
        if (!cssVar.startsWith('--space-')) continue;
        const key = cssVar.replace('--space-', '');
        expect(
          spacing.spacing,
          `CSS var ${cssVar} has no matching TS export spacing[${key}]`,
        ).toHaveProperty(key);
      }
    });

    it('every --radius-* CSS var has a matching TS radius key', () => {
      for (const cssVar of cssVars) {
        if (!cssVar.startsWith('--radius-')) continue;
        const key = cssVar.replace('--radius-', '');
        expect(radius.radius, `CSS var ${cssVar} has no matching TS radius.${key}`).toHaveProperty(
          key,
        );
      }
    });

    it('every --shadow-* CSS var has a matching TS shadow key', () => {
      for (const cssVar of cssVars) {
        if (!cssVar.startsWith('--shadow-')) continue;
        const key = cssVar.replace('--shadow-', '');
        expect(shadow.shadow, `CSS var ${cssVar} has no matching TS shadow.${key}`).toHaveProperty(
          key,
        );
      }
    });
  });

  describe('S1 additive token parity (T016)', () => {
    it('--color-surface-sunken CSS var exists', () => {
      expect(cssVars).toContain('--color-surface-sunken');
    });

    it('colors.surfaceSunken TS export exists and references the correct CSS var', () => {
      expect(colors.surfaceSunken).toBe('var(--color-surface-sunken)');
    });

    it('--shadow-inset CSS var exists', () => {
      expect(cssVars).toContain('--shadow-inset');
    });

    it('shadow.shadow.inset TS export exists and references the correct CSS var', () => {
      expect(shadow.shadow.inset).toBe('var(--shadow-inset)');
    });

    it('--space-9 CSS var exists', () => {
      expect(cssVars).toContain('--space-9');
    });

    it('spacing.spacing[9] TS export exists and references the correct CSS var', () => {
      expect(spacing.spacing[9]).toBe('var(--space-9)');
    });

    it('--duration-1 CSS var exists', () => {
      expect(cssVars).toContain('--duration-1');
    });

    it('--duration-2 CSS var exists', () => {
      expect(cssVars).toContain('--duration-2');
    });

    it('--duration-3 CSS var exists', () => {
      expect(cssVars).toContain('--duration-3');
    });

    it('--duration-4 CSS var exists', () => {
      expect(cssVars).toContain('--duration-4');
    });

    it('--ease-out CSS var exists', () => {
      expect(cssVars).toContain('--ease-out');
    });

    it('--ease-in-out CSS var exists', () => {
      expect(cssVars).toContain('--ease-in-out');
    });

    it('motion.duration has keys 1, 2, 3, 4 each referencing the correct CSS var', () => {
      expect(motion.duration[1]).toBe('var(--duration-1)');
      expect(motion.duration[2]).toBe('var(--duration-2)');
      expect(motion.duration[3]).toBe('var(--duration-3)');
      expect(motion.duration[4]).toBe('var(--duration-4)');
    });

    it('motion.easing has keys out and inOut each referencing the correct CSS var', () => {
      expect(motion.easing.out).toBe('var(--ease-out)');
      expect(motion.easing.inOut).toBe('var(--ease-in-out)');
    });
  });
});
