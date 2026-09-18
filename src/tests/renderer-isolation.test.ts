import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * The BrowserWindow security flags moved from `main/index.ts` to
 * `main/app/bootstrap-window.ts` in 021 S3 (composition-root extraction). The
 * policy is unchanged — only its address is — so this guard follows it.
 */
const mainSource = readFileSync(
  path.join(__dirname, '..', 'main', 'app', 'bootstrap-window.ts'),
  'utf8',
);

/**
 * T028 — Constitution Principle III regression guard.
 *
 * Real packaged-build renderer isolation (window.require / process / Buffer
 * unreachable) cannot be tested in Vitest, because happy-dom v20 exposes
 * Node compatibility shims on its window object and Vitest itself runs on
 * Node. Real isolation is verified by:
 *   - T034 manual smoke (DevTools console in `npm run dev`)
 *   - T079 polish-phase packaged-build smoke
 *
 * What this test DOES guard against is the real regression risk: someone
 * silently weakening the four BrowserWindow security flags in the Electron
 * main process source. If a future change drops `nodeIntegration: false` or
 * flips any other flag, CI fails here before the change can land.
 */
describe('renderer isolation (Principle III static-source guard)', () => {
  it('main process sets nodeIntegration: false', () => {
    expect(mainSource).toMatch(/nodeIntegration:\s*false/);
  });

  it('main process sets contextIsolation: true', () => {
    expect(mainSource).toMatch(/contextIsolation:\s*true/);
  });

  it('main process sets sandbox: true', () => {
    expect(mainSource).toMatch(/sandbox:\s*true/);
  });

  it('main process sets webSecurity: true', () => {
    expect(mainSource).toMatch(/webSecurity:\s*true/);
  });
});
