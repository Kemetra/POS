import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * POS v3.5 Phase 1 — theme-contract guard (ADR-0004).
 *
 * REPLACES the legacy T019 "no-dark-mode" guard. T019 forbade any dark
 * register at all (the terminal was light-only). ADR-0004 then made dark the
 * default with light as the toggle target.
 *
 * SUPERSEDED IN PART by spec 022 (POS UI v4.0), owner decision A/§A2: v4.0 is
 * LIGHT-FIRST. The default flips back to light; the dark register REMAINS and
 * is retuned to the v4.0 teal identity (022 T024 option (a)) rather than
 * frozen. This is the single owner-sanctioned test change in 022 — only the
 * DEFAULT-register assertions move. Every structural guard below (dark
 * register exists, token-VALUE overrides only, no forked components, RTL
 * systemic, persistence) is preserved verbatim, because those are what stop
 * the theme system rotting regardless of which register is default.
 *
 *   1. The dark register exists and is keyed on the document root attribute.
 *   2. LIGHT is the DEFAULT (022) — baked into index.html and the store default.
 *   3. The toggle flips token VALUES ONLY — every declaration in the dark
 *      block is a `--*` custom property (plus the one allowlisted
 *      `color-scheme`), and the block introduces NO new component-class
 *      selector. This is what actually prevents forked dark components.
 *   4. Selection persists to localStorage and re-hydrates.
 *   5. RTL is systemic at the root (Arabic-first).
 */

const STYLES_DIR = resolve(__dirname, '..');
const RENDERER_DIR = resolve(__dirname, '../..');

const tailwindCss = readFileSync(resolve(STYLES_DIR, 'tailwind.css'), 'utf-8');
const indexHtml = readFileSync(resolve(RENDERER_DIR, 'index.html'), 'utf-8');

/**
 * Extract the body of the dark register block
 * (`:root[data-theme='dark'] { … }`). The selector's specificity (0,2,0)
 * makes it win over :root regardless of order — asserted indirectly by the
 * selector shape below.
 */
function extractDarkBlock(css: string): string {
  const match = css.match(/:root\[data-theme=['"]dark['"]\]\s*\{([\s\S]*?)\n\}/);
  return match?.[1] ?? '';
}

describe('theme contract — light default + dark toggle (022 v4.0; supersedes ADR-0004 default)', () => {
  // 1 — dark register present, keyed on the root attribute
  it('defines a dark register on :root[data-theme="dark"]', () => {
    expect(tailwindCss).toMatch(/:root\[data-theme=['"]dark['"]\]\s*\{/);
  });

  it('the dark register overrides the core surface + ink tokens', () => {
    const block = extractDarkBlock(tailwindCss);
    expect(block).toMatch(/--color-background:/);
    expect(block).toMatch(/--color-surface:/);
    expect(block).toMatch(/--color-text:/);
    expect(block).toMatch(/--color-primary:/);
  });

  // 2 — LIGHT is the DEFAULT (022 v4.0; supersedes ADR-0004's dark default)
  it('index.html bakes data-theme="light" on <html> as the flash-free default (022)', () => {
    expect(indexHtml).toMatch(/<html[^>]*\bdata-theme=['"]light['"]/);
  });

  // 3 — token-VALUE overrides only: no forked components, no stray properties
  it('every declaration in the dark register is a custom-property override (color-scheme allowlisted)', () => {
    const block = extractDarkBlock(tailwindCss);
    expect(block.length).toBeGreaterThan(0);
    // Strip comments from the WHOLE block first — a comment may contain a `;`
    // (e.g. prose), so splitting on `;` before stripping would leave a stray
    // comment fragment masquerading as a declaration.
    const declarations = block
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d.length > 0)
      .filter((d) => d.includes(':'));
    for (const decl of declarations) {
      const property = decl.split(':')[0]?.trim() ?? '';
      const ok = property.startsWith('--') || property === 'color-scheme';
      expect(ok, `dark register has a non-token declaration: "${decl}"`).toBe(true);
    }
  });

  it('the dark register introduces NO component-class selector (no forked dark components)', () => {
    const match = tailwindCss.match(/:root\[data-theme=['"]dark['"]\]\s*\{([\s\S]*?)\n\}/);
    const block = match?.[1] ?? '';
    // A nested selector inside the block would show a `{` — token overrides never do.
    expect(block).not.toContain('{');
    // And there is exactly one dark-register selector (no `.dark .foo`-style forks).
    const forkedSelectors = tailwindCss.match(/\[data-theme=['"]dark['"]\]\s+\.[a-z]/gi);
    expect(forkedSelectors).toBeNull();
  });

  // 5 — RTL systemic at the root
  it('index.html sets dir="rtl" lang="ar" at the root (Arabic-first, systemic RTL)', () => {
    expect(indexHtml).toMatch(/<html[^>]*\bdir=['"]rtl['"]/);
    expect(indexHtml).toMatch(/<html[^>]*\blang=['"]ar['"]/);
  });
});

describe('theme store — default, toggle, persistence (ADR-0004)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to light when nothing is persisted (022)', async () => {
    const { readPersistedTheme, DEFAULT_THEME } = await import('../../stores/theme-store');
    expect(DEFAULT_THEME).toBe('light');
    expect(readPersistedTheme()).toBe('light');
  });

  it('initTheme applies the default and sets the root attribute', async () => {
    const { initTheme, useThemeStore } = await import('../../stores/theme-store');
    initTheme();
    expect(useThemeStore.getState().theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('toggling flips light → dark, persists, and repaints the root', async () => {
    const { initTheme, useThemeStore, THEME_STORAGE_KEY } =
      await import('../../stores/theme-store');
    initTheme();
    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('re-hydrates the persisted dark choice on next boot (non-default beats the default)', async () => {
    const { initTheme, useThemeStore, THEME_STORAGE_KEY } =
      await import('../../stores/theme-store');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const applied = initTheme();
    expect(applied).toBe('dark');
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('falls back to light on a corrupt persisted value (022)', async () => {
    const { readPersistedTheme, THEME_STORAGE_KEY } = await import('../../stores/theme-store');
    localStorage.setItem(THEME_STORAGE_KEY, 'midnight');
    expect(readPersistedTheme()).toBe('light');
  });
});
