import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * RT-773 — Playwright Electron smoke PoC. Not wired into CI or `npm test`
 * (Vitest only collects `*.test.ts`); run by hand after `npm run build`:
 *
 *   npx playwright test -c tests/e2e/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  // Keep artefacts out of the repo tree. Playwright empties outputDir at the
  // start of a run, so concurrent invocations each get their own directory.
  outputDir: path.join(os.tmpdir(), `pos-pulse-playwright-results-${String(process.pid)}`),
});
