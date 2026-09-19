import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const STYLES_DIR = resolve(__dirname, '..');

function collectCssFiles(rootDir: string): string {
  const chunks: string[] = [];
  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      const fullPath = join(currentDir, name);
      if (entry.isDirectory() && name !== '__tests__') {
        walk(fullPath);
      } else if (entry.isFile() && name.endsWith('.css')) {
        chunks.push(readFileSync(fullPath, 'utf-8'));
      }
    }
  }
  walk(rootDir);
  return chunks.join('\n');
}

const styleContents = collectCssFiles(STYLES_DIR);

describe('no-proprietary-brand-font guard (T018)', () => {
  it('no @font-face under src/renderer/styles references Inter Tight', () => {
    const fontFaceBlocks = [...styleContents.matchAll(/@font-face\s*\{[^}]*\}/gs)].map((m) => m[0]);
    for (const block of fontFaceBlocks) {
      expect(block).not.toMatch(/Inter Tight/i);
    }
  });

  it('JetBrains Mono is not a primary font face (must only appear in --font-family-mono fallback chain)', () => {
    const fontFaceBlocks = [...styleContents.matchAll(/@font-face\s*\{[^}]*\}/gs)].map((m) => m[0]);
    for (const block of fontFaceBlocks) {
      expect(block).not.toMatch(/JetBrains Mono/i);
    }
  });

  it('no proprietary brand font introduced via @font-face', () => {
    const match = styleContents.match(/@font-face[^}]*Inter Tight[^}]*\}/s);
    expect(match).toBeNull();
  });

  /**
   * 022 T026 — the sans stack is Arabic-first.
   *
   * SUPERSEDED: this assertion previously required the stack to BEGIN with
   * `'Inter Variable', Inter`. Those faces are unresolvable in this app (no
   * package, no @font-face, no bundled file), so Arabic fell through to
   * uncontrolled OS fallback — the defect spec 022 exists to fix. The guard's
   * actual purpose (see the title and the three @font-face assertions above)
   * is "no PROPRIETARY BRAND FONT is introduced", which a declared system
   * stack satisfies by construction.
   *
   * What is asserted now is the property that matters: the first family is a
   * font that actually renders Arabic on the target OS, and the whole stack
   * remains system-resolvable — no bundled or downloaded face.
   */
  it('--font-family-sans leads with an Arabic-capable system face (022 T026)', () => {
    const match = styleContents.match(/--font-family-sans\s*:\s*([^;]+);/);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? '').trim();
    // Dubai ships with Windows 10/11 and renders Arabic correctly; Segoe UI
    // and Tahoma are the ordered fallbacks that also carry Arabic coverage.
    expect(value).toMatch(/^'Dubai',\s*'Segoe UI',\s*Tahoma/);
    // The unresolvable Inter faces must not come back.
    expect(value).not.toMatch(/Inter/i);
    // Still a system stack — the guard's real subject.
    expect(value).toMatch(/sans-serif\s*$/);
  });

  it('--font-family-mono begins with ui-monospace', () => {
    const match = styleContents.match(/--font-family-mono\s*:\s*([^;]+);/);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? '').trim();
    expect(value).toMatch(/^ui-monospace/);
  });
});
