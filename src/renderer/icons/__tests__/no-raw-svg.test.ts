import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-695 (doc 25 IC-2) — product code draws no glyph of its own. Every icon
 * comes from the semantic registry (`src/renderer/icons/`), and the only other
 * inline SVG is a brand mark (`src/renderer/v5/brand/`, D-263-7). A raw
 * `<svg` anywhere else in the renderer fails here.
 */

const RENDERER = resolve(__dirname, '../..');
const ALLOWED_DIRS = ['icons', 'v5/brand'].map((dir) => resolve(RENDERER, dir));

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionSources(path);
    return /\.(tsx?|jsx?|html)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

const RAW_SVG = /<svg[\s>/]|createElement(?:NS)?\([^)]*['"]svg['"]/;

describe('no raw <svg> outside the icon registry and brand marks', () => {
  const sources = productionSources(RENDERER);

  it('finds the renderer sources it guards', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((p) => p.endsWith(join('icons', 'Icon.tsx')))).toBe(true);
  });

  it('keeps every inline SVG inside icons/ or v5/brand/', () => {
    const offenders = sources
      .filter((path) => !ALLOWED_DIRS.some((dir) => path.startsWith(dir + sep)))
      .filter((path) => RAW_SVG.test(readFileSync(path, 'utf-8')))
      .map((path) => relative(RENDERER, path));
    expect(offenders).toEqual([]);
  });

  it('would catch one', () => {
    expect(RAW_SVG.test('return <svg viewBox="0 0 24 24" />;')).toBe(true);
    expect(RAW_SVG.test("document.createElementNS(NS, 'svg')")).toBe(true);
    expect(RAW_SVG.test('<Icon name="search" />')).toBe(false);
  });
});
