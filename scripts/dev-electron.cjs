'use strict';

const { spawnSync, execFileSync } = require('node:child_process');
const waitOn = require('wait-on');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DEV_PORT = 5173;

// Run a package's CLI from this repo's node_modules with the current Node binary,
// so no command is looked up on PATH.
function runLocalBin(pkg, bin, args) {
  const manifestPath = require.resolve(`${pkg}/package.json`, { paths: [ROOT] });
  const binPath = path.join(path.dirname(manifestPath), require(manifestPath).bin[bin]);
  execFileSync(process.execPath, [binPath, ...args], { stdio: 'inherit', cwd: ROOT });
}

// Remove stale JS + map files from a dist subdirectory — never touches source files.
function cleanDistDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.js') || entry.name.endsWith('.js.map')) {
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      fs.unlinkSync(full);
    }
  }
}

// Clean dist/shared (ESM main-process shared modules) and dist/preload
// (bundled CJS preload) so stale artefacts from a previous build cannot
// shadow the freshly-bundled files.
function cleanDistShared() {
  cleanDistDir(path.join(ROOT, 'dist', 'shared'));
}

function cleanDistPreload() {
  cleanDistDir(path.join(ROOT, 'dist', 'preload'));
}

waitOn(
  {
    resources: [`http://localhost:${DEV_PORT}`],
    timeout: 60000,
  },
  (err) => {
    if (err) {
      console.error(
        `[dev-electron] Vite dev server did not start on port ${DEV_PORT}:`,
        err.message,
      );
      console.error(`[dev-electron] Ensure port ${DEV_PORT} is free before running npm run dev.`);
      process.exit(1);
    }

    // Verify the server that answered is actually the current Vite instance
    // by checking for the Vite HMR marker in the response headers.  A stale
    // server from a previous session will not carry that header and we fail
    // loudly rather than launching Electron with a wrong renderer.
    try {
      const result = execFileSync(
        process.execPath,
        [
          '-e',
          `require('http').get('http://localhost:${DEV_PORT}/', (r) => { process.stdout.write(JSON.stringify(r.headers)); r.resume(); }).on('error', () => process.stdout.write('{}'));`,
        ],
        { cwd: ROOT, timeout: 5000 },
      ).toString();
      const headers = JSON.parse(result || '{}');
      // Vite dev server always sets x-powered-by: "Vite Dev Server" or
      // a vary/etag indicating it is an active HMR endpoint.  If neither
      // is present the most likely culprit is a stale non-Vite server.
      if (!headers['x-powered-by'] && !headers['etag'] && !headers['vary']) {
        console.warn(
          `[dev-electron] Warning: http://localhost:${DEV_PORT}/ answered but may be a stale server. Proceeding.`,
        );
      }
    } catch {
      // Header check is best-effort; do not abort.
    }

    // Clean stale dist artefacts before compiling.
    console.log('[dev-electron] Cleaning stale dist/shared and dist/preload...');
    cleanDistShared();
    cleanDistPreload();

    // Bundle preload FIRST so dist/preload/index.js (a CJS IIFE with
    // electron externalised) is ready before Electron launches.  Vite
    // inlines all local shared modules so sandbox require() restrictions
    // cannot prevent contextBridge.exposeInMainWorld from running.
    console.log('[dev-electron] Bundling preload (Vite CJS)...');
    runLocalBin('vite', 'vite', ['build', '--config', 'vite.config.preload.ts']);
    console.log('[dev-electron] Compiling main process (ESM)...');
    runLocalBin('typescript', 'tsc', ['-p', 'tsconfig.main.json']);
    // RT-719 — a dev session reports an UNKNOWN build identity: Vite serves a live-edited
    // renderer, so no stamp could stay true. Drop one left by an earlier `npm run build`.
    fs.rmSync(path.join(ROOT, 'dist', 'build-identity.json'), { force: true });

    console.log('[dev-electron] Launching Electron...');
    const electronBin = require('electron');
    spawnSync(String(electronBin), ['.'], {
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'development' },
    });
  },
);
