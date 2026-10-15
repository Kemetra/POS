/**
 * RT-501 (VN-S10 S10-4) — Returns inside the V5 frame, RT-15 content unchanged.
 *
 * `ScreenSection` (inside the frame's clipping `<main>`) owns the screen's
 * padding, its one <h1> and its scrolling. So the returns stylesheet must not
 * add a page-level box of its own that fights the frame: no outer padding, no
 * width cap, no scroll container, no page background. The panels, fields,
 * buttons and notices below the root keep their RT-15 rules untouched.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = resolve(__dirname, '..');
const CSS = readFileSync(resolve(DIR, 'returns.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function declarationsOf(selector: string): string {
  const start = `
${selector} {`;
  const at = `
${CSS}`.indexOf(start);
  expect(at, `${selector} rule not found in returns.css`).toBeGreaterThanOrEqual(0);
  const open = at + start.length;
  const body = CSS.slice(open - 1);
  return body.slice(0, body.indexOf('}'));
}

describe('returns.css sits inside the V5 frame', () => {
  const root = declarationsOf('.rt-returns');

  it.each([
    ['padding', /(^|[\s;])padding(-[a-z-]+)?\s*:/],
    ['margin', /(^|[\s;])margin(-[a-z-]+)?\s*:/],
    ['max-inline-size / max-width', /(^|[\s;])max-(inline-size|width)\s*:/],
    ['overflow', /(^|[\s;])overflow(-[a-z]+)?\s*:/],
    ['min-block-size / height', /(^|[\s;])(min-block-size|min-height|block-size|height)\s*:/],
    ['page background', /(^|[\s;])background(-[a-z]+)?\s*:/],
  ])('the root rule sets no %s (ScreenSection and the frame own it)', (_label, pattern) => {
    expect(root).not.toMatch(pattern);
  });

  it('keeps the RT-15 stack: a grid with a token gap', () => {
    expect(root).toContain('display: grid');
    expect(root).toContain('gap: var(--space-4)');
  });

  it('declares no scroll container anywhere in the stylesheet', () => {
    expect(CSS).not.toMatch(/overflow(-[xy])?\s*:\s*(auto|scroll)/);
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
