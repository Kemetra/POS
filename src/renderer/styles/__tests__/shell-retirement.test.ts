import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-504 (VN-S10 S10-Z) — the legacy AppShell is retired and must not come back.
 *
 * Every `/app` route renders in the one V5 frame (RT-498). This guard fails CI
 * when any piece of the old shell reappears (doc 23 §5.2):
 *  1. a module under `src/` or `tests/` imports `shell/AppShell` or `shell/regions/*`
 *     (static, dynamic, `vi.mock`, with or without a `.js` suffix);
 *  2. `router.tsx` names `AppShell` in code (comments are stripped);
 *  3. `--color-accent` or a `--color-rail*` token is defined or read in the
 *     stylesheet, or `accent` is exported from `ui/tokens/colors.ts`;
 *  4. a retired class prefix appears in production `.tsx` or in `tailwind.css`;
 *  5. a manager surface's visible copy says «Coming soon».
 * It also pins that the retired files are gone from disk.
 */

const REPO = resolve(__dirname, '../../../..');
const RENDERER = resolve(__dirname, '../..');
const STYLESHEET = join(RENDERER, 'styles/tailwind.css');

const RETIRED_PATHS = [
  'src/renderer/shell/AppShell.tsx',
  'src/renderer/shell/StuckShiftBadge.tsx',
  'src/renderer/shell/regions',
  'src/renderer/shell/connection',
  'src/renderer/shell/viewport',
  'src/renderer/shell/dev',
];

/** Class prefixes that belonged to the legacy shell and the v3.5 placeholders. */
const RETIRED_PREFIXES = [
  'app-shell',
  'top-bar',
  'nav-rail',
  'identity-strip',
  'operator-slot',
  'center-stage',
  'placeholder-pane',
  'dashboard-card',
  'settings-section',
];

/** The manager surfaces whose copy must stay honest (no «Coming soon»). */
const MANAGER_SURFACES = [
  'routes/app/AuditPlaceholder.tsx',
  'routes/app/InventoryPlaceholder.tsx',
  'routes/app/CatalogueDiagnostics.tsx',
  'routes/app/SettingsHelpPlaceholder.tsx',
  'routes/app/DashboardRoute.tsx',
  'routes/app/SalesWorkspace.tsx',
  'routes/app/checkout/CheckoutPlaceholder.tsx',
];

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

const isSource = (path: string): boolean => ['.ts', '.tsx'].includes(extname(path));
const isTest = (path: string): boolean => /[\\/]__tests__[\\/]|\.test\.tsx?$/.test(path);

const SOURCES = [...walk(join(REPO, 'src'), isSource), ...walk(join(REPO, 'tests'), isSource)];
const PRODUCTION_TSX = walk(RENDERER, (p) => extname(p) === '.tsx' && !isTest(p));

/** Every module specifier a file names: `from`, `import()`, `require()`, `vi.mock()`. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) found.push(match[1] ?? '');
  return found;
}

const LEGACY_SHELL_IMPORT = /(?:^|\/)shell\/(?:AppShell|regions\/)/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function prefixPattern(prefix: string): RegExp {
  // Not preceded by a word character or `-`, so `v5-nav-rail` is not `nav-rail`.
  return new RegExp(`(?<![\\w-])${prefix}(?![\\w])`);
}

describe('shell retirement guard (RT-504, VN-S10 S10-Z)', () => {
  it('scans a real tree, not an empty one', () => {
    expect(SOURCES.length).toBeGreaterThan(500);
    expect(PRODUCTION_TSX.length).toBeGreaterThan(100);
  });

  it.each(RETIRED_PATHS)('%s is gone from disk', (path) => {
    expect(existsSync(join(REPO, path))).toBe(false);
  });

  it('nothing imports shell/AppShell or shell/regions/*', () => {
    const offenders = SOURCES.flatMap((file) =>
      specifiers(readFileSync(file, 'utf-8'))
        .filter((spec) => LEGACY_SHELL_IMPORT.test(spec))
        .map((spec) => `${relative(REPO, file)} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it('router.tsx does not name AppShell in code', () => {
    const router = stripComments(readFileSync(join(RENDERER, 'router.tsx'), 'utf-8'));
    expect(router).not.toMatch(/\bAppShell\b/);
  });

  it('the stylesheet neither defines nor reads --color-accent or --color-rail*', () => {
    const css = readFileSync(STYLESHEET, 'utf-8');
    expect(css).not.toMatch(/--color-accent\b/);
    expect(css).not.toMatch(/--color-rail\b|--color-rail-/);
  });

  it('ui/tokens/colors.ts does not export the accent token', () => {
    const tokens = stripComments(readFileSync(join(RENDERER, 'ui/tokens/colors.ts'), 'utf-8'));
    expect(tokens).not.toMatch(/\baccent\b/);
    expect(tokens).not.toMatch(/--color-accent/);
  });

  it.each(RETIRED_PREFIXES)('the retired prefix %s is in no production .tsx', (prefix) => {
    const pattern = prefixPattern(prefix);
    const offenders = PRODUCTION_TSX.filter((file) =>
      pattern.test(stripComments(readFileSync(file, 'utf-8'))),
    ).map((file) => relative(REPO, file));
    expect(offenders).toEqual([]);
  });

  it.each(RETIRED_PREFIXES)('the retired prefix %s has no rule in tailwind.css', (prefix) => {
    const css = readFileSync(STYLESHEET, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(new RegExp(`\\.${prefix}(?![\\w])`));
  });

  it.each(MANAGER_SURFACES)('%s has no «Coming soon» copy', (file) => {
    const source = stripComments(readFileSync(join(RENDERER, file), 'utf-8'));
    expect(source).not.toMatch(/coming soon/i);
    expect(source).not.toMatch(/قريبًا|قريباً/);
  });
});
