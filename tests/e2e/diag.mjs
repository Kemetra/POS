// RT-775 throwaway diagnostic (not for merge): dump what the first window shows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-diag-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => {
    const n = k.toUpperCase();
    return !n.startsWith('POS_PULSE_') && n !== 'ELECTRON_RUN_AS_NODE' && n !== 'NODE_ENV';
  }),
);
const out = (...a) => console.log('[diag]', ...a);
const app = await electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root, env });
const proc = app.process();
proc.stdout?.on('data', (d) => out('main.stdout:', String(d).trimEnd().slice(0, 1500)));
proc.stderr?.on('data', (d) => out('main.stderr:', String(d).trimEnd().slice(0, 1500)));
app.on('console', (m) => out('main.console:', m.text().slice(0, 500)));
const page = await app.firstWindow();
page.on('console', (m) => out(`renderer.${m.type()}:`, m.text().slice(0, 500)));
page.on('pageerror', (e) => out('renderer.pageerror:', String(e).slice(0, 800)));
page.on('requestfailed', (r) => out('renderer.requestfailed:', r.url(), r.failure()?.errorText));
for (const s of [2, 5, 10, 20]) {
  await page.waitForTimeout(s === 2 ? 2000 : s === 5 ? 3000 : s === 10 ? 5000 : 10000);
  const snap = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      testids: [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')),
      text: document.body?.innerText?.slice(0, 600),
      bridge: typeof window.pos, inner: [innerWidth, innerHeight], screen: [screen.width, screen.height, screen.availWidth, screen.availHeight], dpr: devicePixelRatio,
    }))
    .catch((e) => ({ evalError: String(e) }));
  out(`t+${s}s`, JSON.stringify(snap));
}
const info = await app
  .evaluate(({ app: a, BrowserWindow, safeStorage, screen }) => ({
    windows: BrowserWindow.getAllWindows().length,
    bounds: BrowserWindow.getAllWindows()[0]?.getBounds(),
    content: BrowserWindow.getAllWindows()[0]?.getContentBounds(),
    displays: screen.getAllDisplays().map((d) => ({ size: d.size, work: d.workAreaSize, scale: d.scaleFactor })),
    safeStorage: safeStorage.isEncryptionAvailable(),
    userData: a.getPath('userData'),
    gpu: a.getGPUFeatureStatus(),
    version: process.versions.electron,
  }))
  .catch((e) => ({ evalError: String(e) }));
out('app', JSON.stringify(info));
for (const f of fs.existsSync(userData) ? fs.readdirSync(userData) : []) out('userData/', f);
const logDir = path.join(userData, 'logs');
for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) out('log', f, fs.readFileSync(path.join(logDir, f), 'utf8').slice(-2500));
await app.close().catch(() => undefined);
fs.rmSync(userData, { recursive: true, force: true });
