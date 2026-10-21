import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * RT-773 — Playwright Electron smoke PoC. Not wired into CI or `npm test`
 * (Vitest only collects `*.test.ts`); run by hand after `npm run build`:
 *
 *   npx playwright test -c tests/e2e/playwright.config.ts
 */

// Keep artefacts out of the repo tree. Playwright empties outputDir at the
// start of a run, so concurrent invocations each need their own directory.
// Workers re-load this file in their own process, so the runner fixes the
// directory once and hands it down through the environment (workers inherit
// it). Only the runner (the process that set it) removes it, on exit, after
// Playwright's own last write (`.last-run.json`).
if (process.env['POS_PW_OUTPUT_DIR'] === undefined) {
  const runDir = path.join(os.tmpdir(), `pos-pulse-playwright-results-${String(process.pid)}`);
  process.env['POS_PW_OUTPUT_DIR'] = runDir;
  process.on('exit', () => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });
}

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: process.env['POS_PW_OUTPUT_DIR'],
});
