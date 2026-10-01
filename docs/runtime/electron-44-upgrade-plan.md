# Electron 41 → 44 upgrade plan (RT-65)

> **Status:** Planning artifact for Jira **RT-65** (Work Mode: Planning). Nothing in this document
> changes code or dependencies. Implementation is carried by **RT-108** and **RT-109**, and the
> verification by **RT-110**. Recorded 2026-10-01.

## 1. Baseline (verified)

| Fact | Evidence |
| --- | --- |
| `Kemetra/POS` `origin/main` | `838df0fd02afda132627120bf8c2243f05b4bdc9` |
| `package.json` | `electron: ^41.10.6` (devDependency), `better-sqlite3: ^12.9.0`, `argon2: 0.44.0`, `@electron/rebuild: ^4.0.4`, `electron-builder: ^26.8.1`, `@sentry/electron: ^7.13.0` |
| `package-lock.json` | `electron` 41.10.6; `better-sqlite3` 12.9.0 |
| 40 → 41 change | Dependabot PR #491 (`490b325`). The diff touched only `package.json` (1 line) and `package-lock.json`. No source change. |
| CI evidence for 41 | `ci` was green on PR #491, on `490b325` (run 36837015654) and on `838df0f` (run 36836990134). CI covers `npm ci` (postinstall `electron-rebuild -f -w better-sqlite3`), codegen verify, typecheck, lint, tests, build and `package:dir`. |
| Runtime evidence for 41 | **Missing in the repo.** CI never launches the app, and the vitest suite uses `sql.js`, not the native `better-sqlite3`. The local dev checkout still had Electron 40.9.3 in `node_modules` (no `npm ci` since #491). RT-108 step 1 captures the Electron 41 before-smoke. |
| Electron 41 support status | End of support. The Electron 44.0 release post (2026-08-25) says "Electron 41.x.y has reached end-of-support". The timelines page says "The latest three _stable_ major versions are supported by the Electron team", which on 2026-10-01 means 42, 43 and 44. |
| Target line | npm `dist-tags.latest` = **44.5.1** (Chromium 152.0.7977.x, Node 24.21.0, `NODE_MODULE_VERSION` 149). 45 is alpha (`45.0.0-alpha.13`). Per RT-65, its stable release is scheduled for 2026-10-20, which would take 42 out of support. |

Sources: [Electron 42.0](https://www.electronjs.org/blog/electron-42-0),
[43.0](https://www.electronjs.org/blog/electron-43-0), [44.0](https://www.electronjs.org/blog/electron-44-0),
[breaking changes](https://www.electronjs.org/docs/latest/breaking-changes),
[timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines), `npm view electron dist-tags`.

## 2. Native-module compatibility (scratch experiments, not repo changes)

Each row was built with `@electron/rebuild@4.0.4 -f` against the target Electron headers on the dev
workstation (Windows 11 x64, VS 2022 Build Tools). Runtime rows launched a real Electron main process.
That process opened an in-memory DB with WAL and ran a transaction, then ran an `argon2` hash and verify,
a `safeStorage` encrypt/decrypt round-trip, a sandboxed `BrowserWindow` load and `getPrintersAsync`.

| better-sqlite3 | Electron | Compile | Runtime probe |
| --- | --- | --- | --- |
| 12.9.0 (current) | 41.10.6 | OK | PASS (SQLite 3.53.0, ABI 145) |
| 12.9.0 | 42.11.10 | **FAIL** | — |
| 12.9.0 | 43.7.7 | **FAIL** | — |
| 12.9.0 | 44.5.1 | **FAIL**: `v8::External::Value` / `External::New` / `SetNativeDataProperty` | — |
| **12.11.1** | 41.10.6 | OK | PASS (SQLite 3.53.2) |
| **12.11.1** | 44.5.1 | OK | **PASS** (SQLite 3.53.2, ABI 149, Chromium 152.0.7977.130) |
| 13.0.3 (N-API) | 44.5.1 | OK (prebuilt) | PASS (SQLite 3.53.4) |

`argon2@0.44.0` (N-API) built and passed against 44.5.1 in the same probes.

Findings:

- **The current `better-sqlite3@12.9.0` cannot build for any Electron line after 41.** The upgrade
  therefore needs a co-requisite native bump.
- **`12.11.1` is the minimal fix.** It is the latest 12.x on npm (`12.11.2` and `12.12.0` exist only as
  GitHub releases and are not installable). It sits inside the existing `^12.9.0` range, so the change
  is **lockfile-only**, and it works on both 41 and 44. That allows it to land first on 41 (RT-108), so
  an Electron rollback never touches SQLite.
- Because 12.11.1 sits inside the existing range and has evidence on both runtimes, this co-requisite
  does **not** trigger RT-65's "separate unresolved native-module migration" stop condition.
- `13.x` (N-API, prebuilt, engines `node >= 22`) is viable, but it is a major-version rewrite onto
  `node-addon-api`. 13.0.0 shipped a parameter-binding regression that 13.0.1 fixed, so expect churn.
  It also pulls CI off Node 20. It is a separate, optional follow-up and is not needed for 44.
- **CI blind spot (forward risk).** CI green never proves a native `better-sqlite3` load, because tests
  use `sql.js` and CI never launches Electron. A future Dependabot bump of `better-sqlite3` or a
  same-major Electron bump can pass CI with no runtime evidence. An Electron major bump that stays on
  12.9.0 does fail CI, but only because it doesn't compile.

## 3. Upgrade path decision: direct 41 → 44

| Option | Assessment |
| --- | --- |
| Staged 41 → 42 → 43 → 44 | Isolates nothing. better-sqlite3 12.9.0 fails identically on 42, 43 and 44, and no POS code path hits a 42/43 breaking change (§4). 42 is expected to leave support when 45 goes stable (scheduled for 2026-10-20) and 43 when 46 does, so each stop would be near or past EOL and would add three CI and smoke cycles for no signal. |
| **Direct 41 → 44 (chosen)** | One runtime jump after an isolated native prerequisite. The breaking-change audit is clean and the scratch runtime probe on 44.5.1 passes. |

Sequence: **RT-108** (better-sqlite3 12.11.1 on Electron 41, lockfile only) → **RT-109** (Electron
`^44.<latest>`) → **RT-110** (bench verification). Target the latest 44.x patch available when RT-109
starts. Do not wait for 45: it is not stable, and under the three-major policy 44 stays supported until 47 goes stable.

## 4. Breaking-change audit against POS code

POS Electron surface, from a grep of `src/` and `scripts/`:

- `src/main/index.ts`: `app`, `BrowserWindow`, `ipcMain`, `safeStorage`, `session`.
- `src/main/app/bootstrap-window.ts`: the main window (`contextIsolation`, `nodeIntegration:false`,
  `sandbox`, `webSecurity`), the `will-navigate` allow-list, `setWindowOpenHandler` deny, and the
  session-header CSP.
- `src/main/receipts/os-print-transport.ts`: a hidden print `BrowserWindow` (`paintWhenInitiallyHidden`,
  `backgroundThrottling:false`), a `data:` URL load, `webContents.print` (silent, micron `pageSize`) and
  `getPrintersAsync`.
- `src/main/secrets/*`: `safeStorage.isEncryptionAvailable` / `encryptString` / `decryptString`.
- `src/preload/*`: `contextBridge.exposeInMainWorld` and `ipcRenderer.invoke` only.
- `scripts/dev-electron.cjs`: `require('electron')` to resolve the binary path.

| Version | Breaking change | POS usage | Class |
| --- | --- | --- | --- |
| 42 | Binary download moved from npm `postinstall` to the first run; `ELECTRON_SKIP_BINARY_DOWNLOAD` removed | `dev-electron.cjs` `require('electron')`. 44's `index.js` spawns `install.js` when the binary is missing, which needs network on first run. CI never launches Electron; `electron-builder` downloads its own zip, and `@electron/rebuild` needs only headers. CI never set the env var. | **Needs runtime proof** (first `npm run dev`, RT-109) |
| 42 | macOS notifications (UNNotification, signing) | None. Windows only, and there is no `Notification` usage. | Irrelevant |
| 42 | OSR default scale factor 1.0 | No `offscreen: true`. The print window is a hidden normal window, not OSR. | Irrelevant |
| 42 | `clearStorageData` `quotas` removed | No usage | Irrelevant |
| 42 | `createFromNamedImage` `hslShift` deprecated | No `nativeImage` | Irrelevant |
| 43 | Download / dialog default path is the Downloads folder | No `will-download`, no `dialog` | Irrelevant |
| 43 | `NativeImage.toBitmap()` sRGB normalisation | No `nativeImage` | Irrelevant |
| 43 | Last line with Windows 32-bit binaries | Target is Windows 10/11 **x64** only (constitution and hardware matrix); `electron-builder --win --dir` builds for the host arch (x64 on `windows-latest`) | Irrelevant (confirm x64 in RT-109) |
| 43 | Linux rounded corners / WCO / `showHiddenFiles`; `chrome.scripting` CSS | Not Linux; no extensions | Irrelevant |
| 44 | Renderer `clipboard` removed; clipboard API async | No `clipboard` or `navigator.clipboard` anywhere | Irrelevant |
| 44 | `select-client-certificate` `webContents` may be null | No handler | Irrelevant |
| 44 | Windows x86 / Linux ARM32 binaries removed | x64 only | Irrelevant |
| 44 | Workers need `nodeIntegrationInSubFrames`; DevTools preload scoping | No Workers or subframes; preload runs in the main frame only | Irrelevant |
| 44 | `net.request` frame destinations; ANGLE static; Unity; macOS 12/login items | No `net` module (HTTP goes through Node `fetch`); not macOS or Linux | Irrelevant |
| — | Chromium 146 → 152 under hidden-window `webContents.print` (no listed breaking change) | Receipt OS-print path, BIXOLON SRP-330 II | **Needs runtime proof** (bench, RT-110) |
| — | Chromium profile / `Local State` format moving forward, then back (no listed breaking change) | `safeStorage` (DPAPI key in `Local State`) and the userData DB at `userData/pos-pulse.db` | **Needs runtime proof** (upgrade-in-place and rollback rehearsal, RT-110) |

Other packages:

- **`@sentry/electron` 7.13.0.** It is imported unconditionally in main and renderer, but `init` is
  gated on `SENTRY_DSN` and inert by default. Releases 7.14–7.20 list no Electron-range drop. 7.18.0 has
  breaking changes to log capture only. Keep 7.13.0; RT-109's launch smoke proves the import loads.
- **`@electron/rebuild` 4.0.4.** It worked for ABI 149 in the probes. No change.
- **`electron-builder` 26.8.1.** `package:dir` downloads the matching Electron zip itself. RT-109's CI
  `package:dir` step and the unpacked-exe launch prove it.
- **`node-thermal-printer` 4.6.0.** Pure JS (iconv-lite, pngjs). Not ABI-bound.
- **`argon2` 0.44.0.** N-API, so ABI-stable. CI's argon2 Node↔Electron rebuild dance is unchanged.

Pre-existing drift, noted and **not** fixed by this plan: Electron 41 and 44 both declare
`engines.node >= 22.12.0` and `@electron/rebuild` 4 declares `>= 22.12.0`, yet CI runs Node 20 (EOL).
Moving CI off Node 20 is a CI-workflow change for its own issue, bundled with any better-sqlite3 13.x
move. The constitution's historical "Electron 40 since feature 001 (`electron ^40.9.3`)" note is stale
documentation; its rule "Electron 40+" is still satisfied by 44.

## 5. Regression matrix (Windows POS)

| # | Path | Where | Pass condition |
| --- | --- | --- | --- |
| 1 | Cold start / launch | RT-109 dev + packaged | Window opens, no main-process error, `process.versions` recorded |
| 2 | Pairing and sign-in | RT-109 | Pair, sign in (manager), PIN unlock (cashier) |
| 3 | Barcode scanner keyboard wedge | RT-109 (dev scanner), RT-110 (bench) | Scan → product resolves → confirm-add to cart |
| 4 | Sale and checkout | RT-109 | Cash sale finalizes; receipt preview renders |
| 5 | Offline / local SQLite | RT-109, RT-110 | Sale finalizes with network off; WAL DB intact after restart |
| 6 | Outbox / sync recovery | RT-109, RT-110 | Outbox drains on reconnect; sale reaches Backend-Core |
| 7 | Receipt print, BIXOLON SRP-330 II | **RT-110** | Slip not blank, Arabic legible, 70 mm body with no edge clipping (T301 baseline) |
| 8 | Cash drawer | — | **N/A**: deferred per 008 §A5 (printer-only bench target) |
| 9 | safeStorage persistence | RT-109 (restart), **RT-110** (41 → 44 in place, 44 → 41 rollback) | Device token decrypts; paired state survives |
| 10 | Packaged Windows build | RT-109 CI `package:dir` + exe launch | `win-unpacked` exe launches on a clean profile (no installer target exists) |
| 11 | Renderer captures | RT-109, RT-110 | 1024×768 and 1280×800 screenshots |
| 12 | Electron security posture | RT-109 diff review + DevTools | `webPreferences`, CSP, navigation allow-list and window-open deny unchanged; no new security warnings |
| 13 | Dev launch (lazy binary download) | RT-109 | First `npm run dev` after `npm ci` downloads the binary and launches |

## 6. Rollback

- **Previous state:** `electron 41.10.6` (`package.json ^41.10.6`) and `better-sqlite3 12.9.0`
  (lockfile), at `main` `838df0f`.
- **RT-109 rollback:** revert the PR (`package.json` + `package-lock.json`), then `npm ci`. Postinstall
  rebuilds `better-sqlite3` for ABI 145. Run CI's argon2 Electron rebuild before packaging, as it does
  today. RT-108 (12.11.1) stays, because it is proven on 41.
- **RT-108 rollback:** revert the lockfile PR. The SQLite file format is unchanged between 3.53.0 and
  3.53.2, so no data migration is needed.
- **Packaged builds:** artifacts are per-SHA `win-unpacked` uploads with a 1-day retention. A terminal
  rolls back by redeploying the unpacked build of the pre-upgrade SHA, rebuilt from that SHA if the
  artifact has expired.
- **User data:** the realistic rollback risk is a Chromium profile or `Local State` downgrade
  (152 → 146) affecting the `safeStorage` key or the session. RT-110 row 9 rehearses this before any
  terminal rollout. If the rehearsal fails, rollback on a live terminal means re-pairing, and that has
  to be stated in the rollout runbook before Electron 44 ships to any customer terminal.

## 7. Follow-ups

| Issue | Mode | Depends on | Summary |
| --- | --- | --- | --- |
| **RT-108** | Implementation | — | Electron 41 before-smoke; better-sqlite3 12.9.0 → 12.11.1 lockfile-only; after-smoke |
| **RT-109** | Implementation | RT-108 | Electron `^41.10.6` → `^44.<latest>`; CI green; dev-machine regression subset |
| **RT-110** | Verification | RT-109 | Bench: BIXOLON print, upgrade-in-place, rollback rehearsal, scanner, offline, packaged exe |
| _(not created)_ | — | — | Optional: CI Node 20 → 22/24 together with better-sqlite3 13.x (N-API). This is a CI-workflow change and needs owner authorisation. |

**Next safe action:** execute **RT-108**.
