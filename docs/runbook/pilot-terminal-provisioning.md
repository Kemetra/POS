# Runbook — Pilot terminal provisioning and readiness check

How a **packaged** Windows POS terminal receives its runtime settings before a
real-money pilot, how to prove each terminal is ready, and how to roll a terminal
back so it cannot keep taking payments.

> **Authority.** Jira **RT-163** (Work Mode: Docs), from RT-160 **FU-2 / H-2**
> ([audit §9 / §11–§12](../design/vnext/13-pos-simplification-responsibility-audit.md)).
> It builds on RT-162 / owner decision **D-1**, which is already on `main`: **PAYMENTS
> is never on while SALE_FINALIZATION is off.** Baseline: `Kemetra/POS`
> `main@4881eb6`. Code is the source of truth. If this runbook and `main`
> disagree, `main` wins and the runbook is corrected.
>
> **Scope.** Packaged builds only (`npm run package:dir` → `POS Pulse.exe`). Dev and
> lab launches are covered only in §8, to keep them apart from pilot use.

---

## 1. How a packaged terminal receives its configuration today

There is exactly **one** runtime configuration channel: **the process
environment `POS Pulse.exe` inherits when it starts.**

| Surface | Packaged behaviour (verified at `main@4881eb6`) |
| :-- | :-- |
| Main-process settings | Main is compiled with `tsc`, not Vite. It reads `process.env` directly (`src/main/index.ts`; flags in `src/main/app/feature-flags.ts`). Nothing is baked in at build time. |
| `.env` file | **Not read by any build.** No `dotenv` or `--env-file` exists. `.env` is gitignored and not in `electron-builder.yml` `files`. A `.env` placed next to the exe does nothing. |
| Renderer | Gets settings only through the `app:config` bridge call (`window.api.appConfig()`), which main answers from its own `process.env`. No runtime `import.meta.env.VITE_*` value is inlined into the bundle. |
| Installer / auto-update | None. `electron-builder.yml` targets `dir` (an unpacked folder). There is no NSIS/MSI step that could write config, and no updater. |
| In-app settings screen / DB | None for these settings. |
| Device credential | **Not** an environment value. Pairing stores the device token in the local DB, encrypted with Electron `safeStorage` (DPAPI). Never put it, or any credential, in the environment. |

When this matters:

- Feature flags are parsed at startup. The RT-162 D-1 check runs before the
  database opens. Flags are re-parsed for each `app:config` call, but **always
  from the process's own environment, which is frozen when the process starts.**
- **A registry or System-Properties change never reaches a POS that is already
  running.** It takes effect only for a `POS Pulse.exe` started *after* Windows
  has handed the new environment to the launching shell (§4).

## 2. Chosen pilot mechanism — Machine-scope Windows environment variables

**The pilot mechanism:** a Windows administrator sets the terminal's settings as
**Machine (system) environment variables**
(`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`), then
**reboots**. The cashier starts the POS from a plain shortcut that points straight
at `POS Pulse.exe` with **no arguments and no wrapper script**.

Why this one: it needs **no code, installer, or package change** (the RT-163
non-goal). Windows persists it across app restarts and reboots. Changing it needs
admin rights, which a standard cashier account does not have. It covers every
account that signs in on the terminal.

Rejected alternatives:

| Alternative | Why not for the pilot |
| :-- | :-- |
| User-scope env vars (`HKCU\Environment`) | Any cashier can edit their own without admin rights. They are per Windows account, so a second cashier account would start with a different profile. |
| Wrapper `.cmd` / `.ps1` launcher that sets vars and starts the exe | Bypassable. Starting the exe directly (Start menu, Explorer, a re-pinned taskbar icon) skips the wrapper. Edits to it are also untracked. |
| A `.env` file beside the exe | Not read by any build (§1). Supporting it would be a code change, outside this Docs task. |
| Settings baked in by an installer | No installer exists. Building one is a separate Implementation item. |

> **Owner note.** RT-160 FU-2 left the mechanism as an owner choice. This runbook
> records Machine scope as the recommended and documented path. If the owner picks
> another one, this runbook is revised before any terminal is provisioned.

## 3. Pilot settings

### 3.1 The pilot cashier profile (pinned)

Use the canonical values `1` and `0`. The parser accepts `1|true|yes|on`
(case-insensitive, trimmed) as on, and **anything else, or unset, as off**
(fail-closed). Canonical values keep the readiness check unambiguous.

| Variable | Pilot value | Effect |
| :-- | :-- | :-- |
| `POS_PULSE_FEATURE_CART` | `1` | Live Sale cart |
| `POS_PULSE_FEATURE_PAYMENTS` | `1` | PaymentSurface at checkout (needs cart) |
| `POS_PULSE_FEATURE_SALE_FINALIZATION` | `1` | Sale row, receipt, sync outbox entry and Backend-Core capture |
| `POS_PULSE_FEATURE_PRODUCT_SEARCH` | `1` | Catalogue search and scan in the Sale screen (needs cart) |
| `POS_PULSE_FEATURE_VOUCHER_TENDER` | `0` | Voucher tile shown **disabled**. Vouchers are excluded from the pilot (RT-10 D2). |

**D-1 (RT-162): `PAYMENTS=1` with `SALE_FINALIZATION` not `1` is an invalid money
profile.** The POS refuses to start in that state. Main logs
`app:cashier_profile_refused` and shows «إعداد نقطة البيع غير صالح» («Invalid POS
setup»). The readiness check (§6) rejects the profile **before** anyone tries to
start the POS.

### 3.2 Other runtime settings on a pilot terminal

| Variable | Pilot rule | Sensitivity |
| :-- | :-- | :-- |
| `VITE_API_BASE_URL` | **Required.** The pilot Backend-Core base URL. Unset falls back to the non-routable `https://example.invalid`, so pairing, read-down and sync fail closed. | Not a secret, but environment endpoints are **not** published in the repo, Jira or screenshots. |
| `CLERK_PUBLISHABLE_KEY` | **Required** for manager/admin sign-in. Unset or malformed means sign-in refuses. | Not a secret (a publishable key). Still kept out of the repo. |
| `SENTRY_DSN` | Optional. Unset means crash reporting is inert. | Treat as sensitive: never printed, pasted or screenshotted. |
| `POS_PULSE_FEATURE_SALE_TENDERS_SINCE` | Set **only** as the RT-79 tender rollout instructs: a future ISO instant with an explicit zone. Unparseable means tenders are off, with a warning. | Not a secret. |
| `POS_PULSE_RECEIPT_WEBSITE` | Optional receipt footer text. | Not a secret. |

### 3.3 Must be **unset** on a pilot terminal

| Variable | Why |
| :-- | :-- |
| `NODE_ENV` | `development` makes the packaged app load the renderer from `http://localhost:5173` and trust that origin for IPC. |
| `ELECTRON_RUN_AS_NODE` | Turns `POS Pulse.exe` into a plain Node runtime. |
| `POS_PULSE_DEV_*` | Ignored by packaged builds (`app.isPackaged` guard). Unset anyway, as hygiene. |

## 4. Source, precedence, ownership, persistence

**Precedence.** Windows builds each logon session's environment from Machine
scope, then User scope; a User value **overrides** a Machine value with the same
name. Any process that starts the exe can override both for that one launch.

```text
launching process (wrapper / shell)  >  User (HKCU)  >  Machine (HKLM)  >  unset (= off)
```

Pilot rules that follow:

1. POS variables live **only** in Machine scope.
2. **User scope holds no `POS_PULSE_*` variable** for any account that runs the
   POS. The readiness check fails if it finds one.
3. The POS is launched only from the plain shortcut. A wrapper, `--` switches
   (especially `--remote-debugging-port` or `--user-data-dir`) and launching from
   an admin's console are not allowed.

**Ownership.**

| Who | Owns |
| :-- | :-- |
| Pilot deployment owner (Retail Tower) | The approved profile for each terminal (this runbook) and the go/no-go decision |
| Store IT administrator (local admin on the terminal) | Setting and removing the Machine variables, rebooting, running the readiness check, recording sign-off |
| Cashier (standard Windows account, **not** a local admin) | Nothing in this runbook. Reports the refusal dialog if it ever appears. |

**Persistence.** Machine variables are stored in the registry. They survive POS
restarts and reboots, and Windows loads them into every new logon session. A
change reaches the POS only after the POS is **fully quit** and Windows has a
refreshed environment. The pilot rule is simple: **every change is followed by a
reboot, then the readiness check (§6).**

## 5. Provisioning procedure (per terminal)

Prerequisites: packaged build installed in its final folder, terminal not yet
paired or already paired to the correct store, a local admin account, and the
pilot values from the deployment owner's secure channel (never from this repo).

1. Quit the POS and confirm no `POS Pulse` process is left running (Task
   Manager → Details).
2. Open **PowerShell as Administrator** and set the Machine variables. Replace
   every `<…>` placeholder; never paste real values into tickets or chat.

   ```powershell
   $machine = @{
     'POS_PULSE_FEATURE_CART'              = '1'
     'POS_PULSE_FEATURE_PAYMENTS'          = '1'
     'POS_PULSE_FEATURE_SALE_FINALIZATION' = '1'
     'POS_PULSE_FEATURE_PRODUCT_SEARCH'    = '1'
     'POS_PULSE_FEATURE_VOUCHER_TENDER'    = '0'
     'VITE_API_BASE_URL'                   = '<pilot Backend-Core base URL>'
     'CLERK_PUBLISHABLE_KEY'               = '<pilot Clerk publishable key>'
     # Optional, only when instructed: SENTRY_DSN, POS_PULSE_FEATURE_SALE_TENDERS_SINCE,
     # POS_PULSE_RECEIPT_WEBSITE
   }
   foreach ($k in $machine.Keys) { [Environment]::SetEnvironmentVariable($k, $machine[$k], 'Machine') }
   ```

   To **remove** a variable, pass `[NullString]::Value`, not `$null` or `''`.
   PowerShell turns `$null` into an empty string, which leaves an empty value
   behind instead of deleting the variable.

   ```powershell
   [Environment]::SetEnvironmentVariable('<NAME>', [NullString]::Value, 'Machine')
   ```

3. Create (or check) the cashier shortcut. **Target** is the full path to
   `POS Pulse.exe` with **nothing after it**; **Start in** is its folder.
4. **Reboot** the terminal.
5. Run the readiness check (§6) from the **cashier's** Windows account.

## 6. Readiness check (before every terminal takes real money)

Run it after initial provisioning, after **any** environment change, after a
build swap, and after a rollback (with the rollback profile). All three parts must
pass, and the result is recorded (§6.4).

### 6.1 Part A — environment check (cashier account, **not** elevated)

Sign in to Windows as the cashier, open a normal (non-admin) PowerShell window
from the Start menu, and paste the block below. It prints names and PASS/FAIL
only: URL, key and DSN values are never shown. The process scope it reads is the
environment a POS launched from the same session would receive.

```powershell
# RT-163 pilot readiness - environment check. Prints no secret values.
# Set $expectRollback = $true when verifying a rollback (runbook section 7).
# ASCII-only on purpose: works when pasted into Windows PowerShell 5.1 or PowerShell 7.
$expectRollback = $false
$expected = [ordered]@{
  POS_PULSE_FEATURE_CART              = -not $expectRollback
  POS_PULSE_FEATURE_PAYMENTS          = -not $expectRollback
  POS_PULSE_FEATURE_SALE_FINALIZATION = -not $expectRollback
  POS_PULSE_FEATURE_PRODUCT_SEARCH    = -not $expectRollback
  POS_PULSE_FEATURE_VOUCHER_TENDER    = $false
}
function On([string]$v) { $null -ne $v -and @('1','true','yes','on') -contains $v.Trim().ToLower() }
$fail = 0
function Check([bool]$ok, [string]$msg) { if ($ok) { "[PASS] $msg" } else { "[FAIL] $msg"; $script:fail++ } }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Check (-not $isAdmin) 'running as the cashier (not elevated)'
foreach ($n in $expected.Keys) {
  $p = [Environment]::GetEnvironmentVariable($n, 'Process')
  $m = [Environment]::GetEnvironmentVariable($n, 'Machine')
  $want = $expected[$n]
  Check ((On $p) -eq $want) "$n effective = $(if (On $p) {'on'} else {'off'}) (expected $(if ($want) {'on'} else {'off'}))"
  Check ($p -eq $m) "$n effective value comes from Machine scope"
  Check ($m -eq $(if ($want) {'1'} else {'0'})) "$n Machine value is canonical ($(if ($want) {'1'} else {'0'}))"
}
$pay = On ([Environment]::GetEnvironmentVariable('POS_PULSE_FEATURE_PAYMENTS', 'Process'))
$fin = On ([Environment]::GetEnvironmentVariable('POS_PULSE_FEATURE_SALE_FINALIZATION', 'Process'))
Check (-not ($pay -and -not $fin)) 'D-1: PAYMENTS is not on while SALE_FINALIZATION is off'
$userPos = @((Get-Item 'HKCU:\Environment').Property | Where-Object { $_ -like 'POS_PULSE_*' })
Check ($userPos.Count -eq 0) "no POS_PULSE_* variable in User scope (found: $($userPos -join ', '))"
foreach ($n in 'VITE_API_BASE_URL','CLERK_PUBLISHABLE_KEY') {
  Check (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($n, 'Machine'))) "$n is set in Machine scope (value not shown)"
}
foreach ($n in 'NODE_ENV','ELECTRON_RUN_AS_NODE') {
  Check ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($n, 'Process'))) "$n is unset"
}
$dev = @(Get-ChildItem Env: | Where-Object { $_.Name -like 'POS_PULSE_DEV_*' -and $_.Value -ne '' })
Check ($dev.Count -eq 0) 'no POS_PULSE_DEV_* variable set'
if ($fail -eq 0) { '[READY] environment check passed' } else { "[NOT READY] $fail check(s) failed - do not take payments" }
```

Any `[FAIL]` line means **not ready**. Fix the Machine values (§5), reboot, and run
the check again. A `[FAIL]` on "effective value comes from Machine scope" usually
means a User-scope override, or a change made without a reboot.

### 6.2 Part B — in-app check (no money moves)

Start the POS **from the cashier shortcut** and confirm:

1. The POS opens. **No** «إعداد نقطة البيع غير صالح» dialog appears.
2. The terminal is paired to the intended store, and an operator can sign in.
3. The Sale screen shows the catalogue search/scan field, and a scanned or
   searched product can be added to the cart (CART + PRODUCT_SEARCH).
4. At checkout the payment surface is shown, not the "payments unavailable"
   placeholder (PAYMENTS).
5. The voucher tender tile is visible but **disabled** (VOUCHER_TENDER off).
6. **Abandon the test cart without tendering.** Do **not** complete a settled test
   sale: it would create a durable Sale, a receipt, a sync outbox entry and a
   Backend-Core capture with ERP posting.

SALE_FINALIZATION is proven by Part A together with D-1. If PAYMENTS were on with
finalization off, step 1 would already have failed, because the POS refuses to
open.

### 6.3 Part C — D-1 guard self-test (optional, once per new build)

This confirms the build in front of you carries the RT-162 guard. It is harmless:
the refusal happens before the database is opened, and a process-scope override
affects this one launch only. From the non-admin PowerShell window:

```powershell
$env:POS_PULSE_FEATURE_SALE_FINALIZATION = '0'   # this window only
& '<full path to>\POS Pulse.exe'
```

Expect the «إعداد نقطة البيع غير صالح» dialog. Close it; the process exits. Then
**close that PowerShell window** so the override is gone. The next normal launch
from the shortcut must open as usual.

### 6.4 Record

Record one line per terminal in the pilot go/no-go record (Jira comment or the
store's pilot log). Include no values, only results:

| Terminal | Date/time | Build (exe SHA-256) | Part A | Part B | Part C | Checked by |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `<terminal name>` | `<ISO time>` | `<hash>` | READY / NOT READY | pass / fail | pass / skipped | `<admin>` |

`Get-FileHash '<full path to>\POS Pulse.exe'` gives the build hash.

## 7. Rollback and recovery

Rollback stops **all** POS payment-taking on the terminal. It never leaves
payments on with sale finalization off. This expands
[008 runbook T525](008-sale-finalization-and-receipts.md#t525--rollback-strategy)
into terminal steps; T525 remains the authority on *what* rollback means.

1. **Stop trading on the POS.** Quit the POS and confirm in Task Manager that no
   `POS Pulse` process is left. A running POS keeps its launch-time profile
   whatever the registry says.
2. In **admin** PowerShell, turn **PAYMENTS off first**, then SALE_FINALIZATION.
   This order never creates the D-1 state; if the POS were started between the
   two steps, it would open with payments off.

   ```powershell
   [Environment]::SetEnvironmentVariable('POS_PULSE_FEATURE_PAYMENTS', '0', 'Machine')
   [Environment]::SetEnvironmentVariable('POS_PULSE_FEATURE_SALE_FINALIZATION', '0', 'Machine')
   ```

   Leaving CART and PRODUCT_SEARCH on is valid. To match the
   `$expectRollback = $true` check exactly, set them to `0` too.

3. **Reboot.**
4. Run §6.1 with `$expectRollback = $true`. It must print `[READY]`. In the app,
   checkout must show the placeholder; no tender can be started.
5. Any trading continues **only** through the store's separate manual procedure,
   outside the POS financial flow (T525). It is never done by re-enabling payments
   on a terminal whose finalization is off.

Never do these:

- Set **only** `SALE_FINALIZATION=0`. That is the D-1 state: the POS refuses to
  open, and it is not a rollback.
- Down-migrate or delete the 008 tables (`sales`, `print_events`,
  `drawer_events`, `sale_sync_outbox`). They are durable financial records; fix
  forward (T525 (b)).
- Hand-edit a User-scope variable to "quickly" re-enable a terminal.

**Recovery from a bad profile found by the readiness check:** do not open the
till. Correct the Machine values (§5), reboot, and run §6 again from the top. If
the POS showed the refusal dialog in production, the main log holds one
`app:cashier_profile_refused` line with the parsed flag values: booleans only, no
secrets. The log lives under `%APPDATA%\pos-pulse\logs` for the account that
launched it. Attach the line (not a screenshot of the environment dialog) to the
incident.

## 8. Lab and dev launches — not pilot provisioning

These exist for development and lab evidence. **None of them is a supported way to
configure a pilot terminal**, and a pilot terminal must not depend on any of them.

| Mechanism | Where it is used | Why it is not pilot provisioning |
| :-- | :-- | :-- |
| Shell-exported vars + `npm run dev` | Developer machines | Unpackaged build; `NODE_ENV=development`; Vite renderer on `localhost:5173` |
| `.env` / `.env.example` | Developer reference only | Main reads no `.env` in **any** build (`.env.example`'s "read in main" means the variable names, not the file) |
| `POS_PULSE_DEV_*` bypasses and seeds | Developer machines | Ignored by packaged builds |
| Lab launchers (rt9 `start-pos.ps1`, Orchestrator smoke runbook) | Isolated labs | Process-scope env, a scratch `--user-data-dir`, a CDP port. All three are forbidden on a pilot shortcut (§4) |
| `--remote-debugging-port=<n>` | Lab automation and evidence | Gives full control of the running POS to anything on the machine. **Never** on a pilot terminal |

## 9. Secrets handling

- Nothing in this runbook is a real value. Every URL, key and DSN is a `<…>`
  placeholder.
- Values travel from the deployment owner to the store admin through the
  owner's secure channel. They never go in Jira, Confluence, chat or Git.
- The readiness check prints names and PASS/FAIL only. Do not screenshot
  *System Properties → Environment Variables*, because it shows values.
- The device token and PIN credentials are not environment values. They live
  in the local DB, with the token protected by DPAPI (`safeStorage`).

## 10. Evidence (RT-163, 2026-10-03)

Run on the packaged build from `main@4881eb6`
(`npm run build && npm run package:dir`; `POS Pulse.exe` SHA-256
`E4B1D2E3…C225AD`). Each launch went **through Explorer**
(`explorer.exe <shortcut>`), so the process received the registry environment and
not the test shell's own. Each used a scratch `--user-data-dir`; `app:config` was
read over CDP from the running packaged renderer.

| Phase | Registry profile | Result |
| :-- | :-- | :-- |
| P0 control | all five empty | `app:config.features` all `false` |
| P1 launch 1 + restart | `PAYMENTS=1`, finalization off | Refused both times: two `app:cashier_profile_refused` lines, `reason: payments_without_sale_finalization` |
| P2 launch 1 + restart | `CART/PAYMENTS/SALE_FINALIZATION/PRODUCT_SEARCH=1`, voucher unset | Both launches: `{cart:true, payments:true, saleFinalization:true, productSearch:true, voucherTender:false}`; no new refusal line |

The §6.1 environment check was run verbatim, extracted from this file, in both
Windows PowerShell 5.1 and PowerShell 7, under three process-scope profiles. No
registry writes were involved.

| Case | Result (both shells) |
| :-- | :-- |
| Nothing provisioned | `[NOT READY]`: four flags off, URL/key missing |
| D-1 invalid (`PAYMENTS=1`, finalization off) | `[NOT READY]` with an explicit `[FAIL] D-1: PAYMENTS is not on while SALE_FINALIZATION is off` |
| Pilot profile set **only** in process scope (a wrapper-style override) | Flags evaluate as expected, but each `effective value comes from Machine scope` line fails, giving `[NOT READY]` |

Limits, stated plainly:

- The `[READY]` path needs real Machine-scope values, so it was not run here
  (session not elevated). Its first run is the pilot terminal's own §6.1.

- **User scope (HKCU) stood in for Machine scope**, because the session was not
  elevated. Explorer's environment inheritance is the same for both, and
  Machine is still the one to use for the pilot. The first Machine-scope run
  happens on the pilot terminal, and §6 is its proof.
- **Reboot survival was not exercised in this session.** Machine variables are
  persistent registry state by design. Each terminal proves it through the
  mandatory "reboot → §6" step.
- The owner's real POS profile (`%APPDATA%\pos-pulse`) was not touched. The test
  variables were removed afterwards, and a `reg query` confirmed none were left.
