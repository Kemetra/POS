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
| `POS_PULSE_SUPPORT_RESET_CASHIER_CLAIM_REFUSED` | **Support only, normally unset.** `1` re-queues, once per start, this terminal's sales dead-lettered as `cashier_claim_refused` (RT-225). See §7. Any other value does nothing. | Not a secret. |

### 3.3 Must be **unset** on a pilot terminal

| Variable | Why |
| :-- | :-- |
| `NODE_ENV` | `development` makes the packaged app load the renderer from `http://localhost:5173` and trust that origin for IPC. |
| `ELECTRON_RUN_AS_NODE` | Turns `POS Pulse.exe` into a plain Node runtime. |
| `POS_PULSE_DEV_*` | Ignored by the shipped app, including a renamed copy of the exe (RT-165 shipped-app guard, §11). Unset anyway, as hygiene. |

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
   (especially `--remote-debugging-port` or `--user-data-dir`; the packaged build
   refuses the debugging ones at startup since RT-164, §11) and launching from
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
paired or already paired to the correct store, a separate local admin account,
**every cashier Windows account a standard user (not a local administrator)**,
and the pilot values from the deployment owner's secure channel (never from this
repo). A cashier account with admin rights can change Machine scope itself, which
removes the reason for choosing it. The §6.1 check fails on such an account.

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
# S-1-5-32-544 = local Administrators. whoami lists it even for a non-elevated (UAC-filtered) admin.
# Full path so no other 'whoami' on PATH can answer; no output at all fails closed.
$groups = @(& "$env:SystemRoot\System32\whoami.exe" /groups 2>$null)
$isLocalAdmin = ($groups.Count -eq 0) -or [bool]($groups | Select-String 'S-1-5-32-544')
Check (-not $isLocalAdmin) 'this Windows account is a standard user (not a local administrator)'
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

1. The POS opens. **No** «إعداد نقطة البيع غير صالح» dialog appears. If the POS
   closes at once with **no** dialog, look in the main log for
   `app:debug_switch_refused`: the shortcut carries a debugging switch (§11).
   Fix the shortcut (Target = the exe path, nothing after it).
2. The terminal is paired to the intended store, and an operator can sign in.
3. The Sale screen shows the catalogue search/scan field, and a scanned or
   searched product can be added to the cart (CART + PRODUCT_SEARCH).
4. **Void the test cart while it is still being edited**, before handing it to
   payment. A cashier may do this. The cart never reaches payment and no money
   moves.

Never complete a settled test sale: it would create a durable Sale, a receipt, a
sync outbox entry and a Backend-Core capture with ERP posting.

PAYMENTS, SALE_FINALIZATION and VOUCHER_TENDER are proven by Part A, which reads
the same environment the POS receives. D-1 adds a second guard: if PAYMENTS were
on with finalization off, step 1 would already have failed, because the POS
refuses to open.

**Optional B2 — PAYMENTS observed in the app (manager present).** Add a line and
hand the cart to payment. Check that «المتابعة إلى الدفع» ("Continue to payment")
is **enabled**; it shows disabled when PAYMENTS is off. **Do not press it.** A
**manager** then voids the handed-off cart. That void is a recorded, manager-only
action: it leaves one `cart.cancel.post_handoff` audit event
(`manager_voided_post_handoff`). Note it in §6.4 so later review does not treat it
as a real cancellation.

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

The self-test leaves one real `app:cashier_profile_refused` line in that
account's POS log. Note its time in §6.4 so incident triage can tell it apart
from a genuine refusal.

### 6.4 Record

Record one line per terminal in the pilot go/no-go record (Jira comment or the
store's pilot log). Include no values, only results:

| Terminal | Date/time | Build (exe SHA-256) | Cashier account standard user? | Part A | Part B (B2?) | Part C (time) | Checked by |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `<terminal name>` | `<ISO time>` | `<hash>` | yes / **no = not ready** | READY / NOT READY | pass / fail (B2 void time or skipped) | pass at `<time>` / skipped | `<admin>` |

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
   # Order matters: PAYMENTS first.
   [Environment]::SetEnvironmentVariable('POS_PULSE_FEATURE_PAYMENTS', '0', 'Machine')
   [Environment]::SetEnvironmentVariable('POS_PULSE_FEATURE_SALE_FINALIZATION', '0', 'Machine')
   [Environment]::SetEnvironmentVariable('POS_PULSE_FEATURE_CART', '0', 'Machine')
   [Environment]::SetEnvironmentVariable('POS_PULSE_FEATURE_PRODUCT_SEARCH', '0', 'Machine')
   ```

3. **Reboot.**
4. Run §6.1 with `$expectRollback = $true`. It must print `[READY]`, which here
   means "ready in the rolled-back state": all four flags off, voucher off.
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

**Recovery of cashier sales refused as `cashier_claim_refused` (RT-225):** a cashier sale whose cashier claim Backend-Core refused (device-path 403) is dead-lettered and never retried on its own. The sale stays intact on the terminal. Before RT-225 this hit sales finalized late by boot recovery. A POS build with RT-225 sends those with `admissionCheckAt` (the settled time), and it needs Backend-Core #710 or later deployed first. To re-send the existing ones: in **admin** PowerShell set `POS_PULSE_SUPPORT_RESET_CASHIER_CLAIM_REFUSED` to `1` (Machine), restart the POS, and check the main log for one `sale_sync:cashier_claim_refused_reset` line with the count. Then remove the variable (`[NullString]::Value`, §5) and restart again. A sale refused again is dead-lettered again. A sale made in offline grace after the admission expired can still be refused; that case stays with RT-113.

**Recovery from a forward clock jump (RT-113 offline sign-in):** after a clock that ran ahead is corrected, offline cashier admission stays refused until real time passes the highest time the POS saw (5 min tolerance); fix the time source (NTP) and keep trading online. Never set the clock forward again or edit the database.

## 8. Lab and dev launches — not pilot provisioning

These exist for development and lab evidence. **None of them is a supported way to
configure a pilot terminal**, and a pilot terminal must not depend on any of them.

| Mechanism | Where it is used | Why it is not pilot provisioning |
| :-- | :-- | :-- |
| Shell-exported vars + `npm run dev` | Developer machines | Unpackaged build; `NODE_ENV=development`; Vite renderer on `localhost:5173` |
| `.env` / `.env.example` | Developer reference only | Main reads no `.env` in **any** build (`.env.example`'s "read in main" means the variable names, not the file) |
| `POS_PULSE_DEV_*` bypasses and seeds | Developer machines | Ignored by packaged builds |
| Lab launchers (rt9 `start-pos.ps1`, Orchestrator smoke runbook, RT-110 bench) | Isolated labs | Process-scope env, a scratch `--user-data-dir`, a CDP port. All three are forbidden on a pilot shortcut (§4). Since RT-164 they must drive the **unpackaged** build (`electron .`): a packaged exe refuses CDP (§11) |
| `--remote-debugging-port` / `-pipe`, `--inspect*`, `ELECTRON_RUN_AS_NODE` | Lab automation and evidence, **unpackaged builds only** | Hand control of the running POS to anything on the machine. Since RT-164 the packaged exe refuses or ignores all of them (§11); **never** put one on a pilot terminal |

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
| Every case, run from a non-elevated local-admin account | `[FAIL] this Windows account is a standard user`. A UAC-filtered admin is still detected. The check calls `System32\whoami.exe` by full path: an earlier draft ran plain `whoami`, which Git Bash's `whoami` answered, so it passed wrongly. |

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
- **Residual risk recorded here — closed by RT-164 (§11).** At `main@4881eb6`
  the packaged build set no Electron fuses: it accepted
  `--remote-debugging-port` (this evidence relied on it), `ELECTRON_RUN_AS_NODE`
  and `--inspect`. RT-164 hardened the packaged build, so this section's CDP
  method can no longer be repeated on a packaged exe.
- The owner's real POS profile (`%APPDATA%\pos-pulse`) was not touched. The test
  variables were removed afterwards, and a `reg query` confirmed none were left.

## 11. Packaged-build hardening (RT-164, 2026-10-03)

Owner decisions (RT-164): **D-1** the hardening is pilot-blocking; **D-2** there
is one packaged build and it is always hardened. Lab and automation that need
Node, an inspector or CDP use the unpackaged build (`electron .`).

**What the packaged build does now**

| Vector | Control | Behaviour |
| :-- | :-- | :-- |
| `ELECTRON_RUN_AS_NODE=1` | Fuse `RunAsNode` off | Ignored; the exe starts as the POS, not as Node |
| `NODE_OPTIONS=--require …` | Fuse `EnableNodeOptionsEnvironmentVariable` off (Electron already restricted most options in packaged apps) | Ignored |
| `--inspect`, `--inspect-brk`, `--inspect-port` | Fuse `EnableNodeCliInspectArguments` off, plus the startup guard | No inspector; the POS exits, logging `app:debug_switch_refused` |
| `--remote-debugging-port`, `--remote-debugging-pipe` (any of `--` `-` `/` prefixes, any case) | Startup guard in main (`src/main/app/launch-switch-guard.ts`); no fuse exists for these | The POS exits before the DB, IPC or a window exists, logging `app:debug_switch_refused` with the switch **name** only |
| App code replaced outside `app.asar`, or `app.asar` tampered | Fuses `OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation` on | Only the integrity-checked archive loads |

Kept at Electron's default, with reasons:

- `GrantFileProtocolExtraPrivileges` stays **on**. Turned off, the packaged
  renderer (Vite ES-module scripts from `file://`) failed to load: the window
  landed on `chrome-error://`. Turning it off needs the renderer served from a
  custom protocol first, which is a separate change.
- `EnableCookieEncryption` stays **off**. The POS keeps no secret in Chromium
  cookies, and turning it on is a one-way cookie-store migration.

**Evidence.** The same harness ran against the packaged build before
(`main@4881eb6` code, which `cd9dfa2` leaves unchanged; no fuses) and after (RT-164 branch, SHA-256
`94dc43a5…29ec51b`). Each launch used a scratch `--user-data-dir`.

| Vector | Before | After |
| :-- | :-- | :-- |
| `ELECTRON_RUN_AS_NODE=1` + script | Script ran (`ran:40.9.3`) | Did not run |
| `NODE_OPTIONS=--require` | Did not run (Electron's packaged-app restriction) | Did not run |
| `--inspect=9339` | Inspector reachable | Not reachable; process exited; refusal logged (`switches: ["inspect"]`) |
| `--remote-debugging-port=9334` | CDP reachable | Not reachable; exited; refusal logged |
| `/remote-debugging-port=9335` | CDP reachable | Not reachable; exited; refusal logged |
| `--REMOTE-DEBUGGING-PORT=9336` | CDP reachable | Not reachable; exited; refusal logged |
| `--remote-debugging-pipe` | Process kept running | Exited; refusal logged |
| Copy of the shipped folder, exe **renamed** `electron.exe`, `--remote-debugging-port` | (probed during RT-164) CDP reachable, pairing page open | Not reachable; exited; refusal logged |
| **Stock** `electron.exe` + the shipped `app.asar`, `--remote-debugging-port` | (probed during RT-164) CDP reachable, pairing page open | Not reachable; exited; refusal logged |
| Normal launch | Started; DB migrated; `app:ready` | Same. The window's accessibility tree shows the pairing screen ("Enter the pairing code…", "Pair terminal"), so the renderer, preload bridge and IPC all work |

The two rename rows exist because Electron's `app.isPackaged` comes from the
exe **file name**. The first guard used it alone, and both probes got past it.
The guard now also treats "the app is running from an `.asar`" as shipped,
which a rename cannot change.

Fuse read-back after (`npx electron-fuses read --app "POS Pulse.exe"`):
`RunAsNode` Disabled · `EnableNodeOptionsEnvironmentVariable` Disabled ·
`EnableNodeCliInspectArguments` Disabled · `OnlyLoadAppFromAsar` Enabled ·
`EnableEmbeddedAsarIntegrityValidation` Enabled ·
`GrantFileProtocolExtraPrivileges` Enabled · `EnableCookieEncryption` Disabled.

Limits:

- Chromium opens a `--remote-debugging-port` listener at process start, before
  main runs. The guard closes it within the first moments of startup, before
  any page, preload or POS state exists, but the port is briefly open.
- **This stops switches and shortcuts, not someone already running code as the
  cashier.** Anyone who can run their own programs as the cashier can extract
  `app.asar` and run it with a stock Electron, and can read that account's POS
  profile, whose DPAPI protection is per-user. The defence there is the
  Windows account and application control on the terminal (a standard user
  with no way to run unapproved programs), not the POS binary.
- **Finding, not fixed in RT-164 (owner decision); fixed in RT-165, see below:** in a renamed copy of the
  shipped exe, `app.isPackaged` is false. The `POS_PULSE_DEV_*` bypasses (and
  any other `isPackaged`-keyed check, such as the SecretStore's production
  refusal) then activate: the probe logged `pairing.dev_bypass.active` and
  `operator.dev_bypass.active`, a fixture pairing plus an auto-signed-in
  fixture **manager** session. The shipped exe, as a control, ignored them.
  Electron takes the default profile folder from the app's `package.json` name,
  not the exe name, so a renamed copy is expected to open the real
  `%APPDATA%\pos-pulse` profile. That last point was not exercised, to keep
  the real profile untouched. Remedy candidate: key those checks on the same
  "shipped" signal as the launch guard.

**RT-165: renamed exe keeps production behaviour.** `src/main/app/shipped-app.ts`
holds the launch guard's "shipped" signal (`app.isPackaged`, or running from an
`.asar`). Every check that used `app.isPackaged` alone now keys on it: the four
`POS_PULSE_DEV_*` bypasses (pairing, operator sign-in, catalogue seed, cart item
resolver), the SecretStore production refusal, and the migrations directory.
That last one also mattered. A renamed exe used to read `migrations/*.sql` from
whatever folder it was launched in, so it would run any SQL placed there.
Unpackaged `electron .` keeps every dev bypass.

Probe: all four `POS_PULSE_DEV_*` flags set. Each run had its own scratch
`--user-data-dir` and `APPDATA`, and was launched from a folder holding the real
migrations plus a decoy `9999_rt165_decoy.sql`.

| Run | Bypass log lines | Fixture pairing row | Fixture products | Decoy SQL applied |
| :-- | :-- | :-- | :-- | :-- |
| `main@607bbfe`, exe renamed `electron.exe` (control) | seed, pairing, operator | yes | 12 | **yes** |
| RT-165, exe renamed `electron.exe` | none | no | 0 | no |
| RT-165, `POS Pulse.exe` | none | no | 0 | no |
| RT-165, unpackaged `electron .` | seed, pairing, operator | yes | 12 | n/a |
| RT-165, renamed + `--remote-debugging-port` | refused, exited before the DB opened | – | – | – |

The cart item resolver and the SecretStore refusal leave no log line or DB
trace in a launch, and the refusal needs DPAPI to be unavailable. Unit tests
cover those two, not the probe. Residual: a stock `electron.exe` pointed at an
**extracted** app folder is not detected. That is the code-running case under
"Limits" above.
