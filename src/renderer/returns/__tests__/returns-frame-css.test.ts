/**
 * RT-501 (VN-S10 S10-4) — Returns inside the V5 frame, RT-15 content unchanged.
 *
 * `ScreenSection` (inside the frame's clipping `<main>`) owns the screen's
 * padding, its one <h1> and its scrolling. So the returns stylesheet must not
 * add a page-level box of its own that fights the frame: no outer padding, no
 * width cap, no page background.
 *
 * RT-660 (G6R, RD-3): the content moved onto the shared v5 controls
 * (v5-returns.css). The journal panel takes the rest of the height and only its
 * table scrolls, as the stuck-shifts list does; nothing else scrolls.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = resolve(__dirname, '..');
const CSS = readFileSync(resolve(DIR, 'v5-returns.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function declarationsOf(selector: string): string {
  const start = `
${selector} {`;
  const at = `
${CSS}`.indexOf(start);
  expect(at, `${selector} rule not found in v5-returns.css`).toBeGreaterThanOrEqual(0);
  const open = at + start.length;
  const body = CSS.slice(open - 1);
  return body.slice(0, body.indexOf('}'));
}

describe('v5-returns.css sits inside the V5 frame', () => {
  const root = declarationsOf('.v5-returns');

  it.each([
    ['padding', /(^|[\s;])padding(-[a-z-]+)?\s*:/],
    ['margin', /(^|[\s;])margin(-[a-z-]+)?\s*:/],
    ['max-inline-size / max-width', /(^|[\s;])max-(inline-size|width)\s*:/],
    ['overflow', /(^|[\s;])overflow(-[a-z]+)?\s*:/],
    ['page background', /(^|[\s;])background(-[a-z]+)?\s*:/],
  ])('the root rule sets no %s (ScreenSection and the frame own it)', (_label, pattern) => {
    expect(root).not.toMatch(pattern);
  });

  it('is a column stack with a token gap that may take the rest of the height', () => {
    expect(root).toContain('display: flex');
    expect(root).toContain('flex-direction: column');
    expect(root).toContain('gap: var(--space-3)');
  });

  it('only the journal table scrolls (RD-3)', () => {
    const scrolls = CSS.split('}')
      .filter((rule) => /overflow(-[xy])?\s*:\s*(auto|scroll)/.test(rule))
      .map((rule) => rule.slice(0, rule.indexOf('{')).trim());
    expect(scrolls).toEqual(['.v5-returns-table-scroll']);
  });

  it('names no legacy layout-wrapper class', () => {
    expect(CSS).not.toMatch(/\.workspace/);
  });
});

describe('the returns flow does not depend on the legacy layout primitive', () => {
  const sources = readdirSync(DIR)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => [f, readFileSync(resolve(DIR, f), 'utf8')] as const);

  it.each(sources)('%s imports no Workspace and names no workspace class', (_file, source) => {
    expect(source).not.toMatch(/shell\/regions\/Workspace/);
    expect(source).not.toMatch(/className="[^"]*\bworkspace/);
  });
});
