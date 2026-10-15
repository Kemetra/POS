# 23 — VN-S10: manager/admin surfaces in the V5 frame, and retiring the legacy AppShell (RT-478)

> **Status: APPROVED by the owner on 2026-10-15** (in session): the plan as written, and every
> recommended answer in §6 (D-10-1 … D-10-8). No implementation here. Each slice in §7 becomes its
> own Jira issue. **S10-R is done:** the G-6 references and copy in
> [`visual-acceptance/G6-Manager/`](visual-acceptance/G6-Manager/G6-Spec.html) were owner-approved
> as is on 2026-10-15, so S10-1 can start.
>
> - **Jira:** **RT-478** (Work Mode: **Planning**), parent RT-6, cross-cutting RT-106. It plans
>   slice **VN-S10** from [09](09-implementation-slices.md) and rows 26–31 of
>   [07](07-migration-map.md) §A, plus the VN-S10 rows of 07 §B.
> - **Owner decision already taken:** **OD-6 for manager/admin** (2026-10-14, recorded in RT-478):
>   the legacy placeholder screens are **redesigned in the V5 look and stay in the manager
>   navigation**. They are not removed. For the cashier role, OD-6 is unchanged: the cashier nav
>   shows the Sale only (`CASHIER_NAV` in `v5/frame/nav-model.ts`).
> - **Baseline:** POS `origin/main@91d080ef` (2026-10-15). Every file reference below is at that
>   SHA.
> - **Authorities:** RT-24 (behaviour), [08](08-rt24-invariants.md), [15](15-vnext-freeze-package.md)
>   §3 and §7 (slice rules), [`docs/DESIGN.md`](../../DESIGN.md), the Visual Acceptance Pack
>   ([README](README.md#visual-acceptance-pack-owner-approved)).
> - **Not edited by this plan:** doc 15 and the README index. Sibling planning sessions edit them;
>   the new reference gap is recorded here (§6, G-6) and goes into 15 in the implementing slice.

## 1. The problem

The POS runs two application frames side by side.

- **V5 frame** (`v5/frame/V5AppLayout.tsx` → `V5Frame`): `/app/cart`, `/app/checkout`,
  `/app/shift`, `/app/shift/manager`, `/app/manager/cashiers`, `/app/manager/recovery`.
- **Legacy `AppShell`** (`shell/AppShell.tsx`): every other `/app/*` route (§2.1).

The V5 nav already links to every legacy route (it is derived from the same seven-entry
contract, `specs/003-pos-ui-shell/contracts/shell-routes.ts`). So a manager who opens
«لوحة المتابعة» from a V5 screen drops into the old frame: dark rail, English headings and
«Coming soon» cards. This was observed on the packaged bench on 2026-10-14 (RT-478).

**Goal of VN-S10:** every `/app/*` route renders inside the one V5 frame, every manager/admin
surface uses the V5 vocabulary with Arabic-first copy and honest states, and the legacy shell
code is deleted with a test that stops it from returning.

## 2. Inventory at `91d080ef`

### 2.1 Routes under the legacy `AppShell` (`router.tsx`, the second `/app` layout)

| Route | Component | Origin | What it does today | Guard | Legacy dependencies |
|---|---|---|---|---|---|
| `/app` (index) | `AppIndexRedirect` | 022 US1 / FR-44 | Cashier → `cart`, manager/admin → `dashboard` | operator guard | none |
| `/app/dashboard` | `DashboardRoute` → `DashboardPlaceholder` → `HonestDashboard` | 003, 022, v3.5 Slice 5 | English «Dashboard» `Workspace`; links to the shift manager, cashiers and recovery; three «Coming soon» cards (`DashboardSkeleton`). Cashier sees an English «Section unavailable» error. Dev-only `?demo=1` lazy-loads `DashboardView` with fake data; dev `?state=` gallery | role check in the route (cashier refused) | `Workspace`, `ui/states`, v3.5 classes (`ws-head`, `stat-strip`, `spark`, `dashboard-card*`) |
| `/app/sales` | `SalesWorkspace` → `FindSaleReceipt` | 003, 008 T451 | Find a finalized sale by number and reprint its receipt. English labels, ad-hoc Tailwind utility classes | none in the router (nav hides it from cashiers) | `Workspace`, `ui/states` |
| `/app/returns` | `ReturnsRoute` → `ReturnsScreen` | RT-15 S3 | The manager/admin return flow. Arabic, its own `returns.css` already in the DESIGN.md vocabulary | `manager`, `admin` | `Workspace` only |
| `/app/audit` | `AuditPlaceholder` | v3.5 Slice 1 | English «Coming soon» pane | `manager`, `admin` | `Workspace`, `.placeholder-pane` |
| `/app/inventory` | `InventoryPlaceholder` | 003 | English «Navigation only» pane + link to diagnostics | none | `Workspace`, `ui/states` |
| `/app/inventory/diagnostics` | `CatalogueDiagnostics` | 010 | Terminal, catalogue sync, local read model, read-only search. English, one «Coming soon» section | none | `Workspace`, `.catalogue-diagnostics*`, `.diagnostics-*` |
| `/app/settings` | `SettingsHelpPlaceholder` → `SettingsSkeleton` | 003 | A working **Theme** toggle, then «Coming soon» rows (terminal label, receipt header, connection simulation) | none | `Workspace`, `ThemeToggle`, `.settings-section*` |
| `/app/manager/stuck-shifts` | `StuckShiftSurface` (`ui/operator/ForcedCloseSurface.tsx`, 342 lines) | 004 T090 | Manager forced close of a stuck shift. Unstyled English. **No in-app link reaches it**: the only entry point was `StuckShiftBadge`, which has no importer | `manager`, `admin` | its own dialog markup |
| `/app/manager/force-fail` | `ManagerForceFailRoutePlaceholder` (inside `router.tsx`) | 006 T282 | English one-line placeholder; the real `ForceFailSurface` has no list contract | `manager`, `admin` | none |

One more legacy consumer already sits **inside** the V5 frame: `CheckoutRoute` renders
`CheckoutPlaceholder` (a legacy `Workspace`) when the payments flag is off.

### 2.2 What `AppShell` does that must survive

| Responsibility | In `AppShell` | V5 equivalent today | Gap |
|---|---|---|---|
| Too-small width/height guard, screen unmounts | `viewportShortfall` + `ScreenTooSmall` | `V5Frame` (same hook, same component; 023 G0 parity, RT-313) | none |
| Focus to `<main>` on return from too-small | `useFocusOnReturn` | `V5Frame` | none |
| Connection banner for non-online states | `TopBar` → 007 `StatusBanner` | `V5Frame` → the same 007 `StatusBanner` | none (VN-S6 owns the replacement, §5.3) |
| Forced-shift-close notice | `ShiftClosedBanner` | `V5OperationalNotices` | none |
| Printer-failure banner | `PrinterFailureBanner`, **reprint is a no-op stub** | `V5OperationalNotices`, **reprint and manual override wired** to `receipts.*` | behaviour change on manager screens (D-10-6) |
| D-B1 drawer notice | `DrawerNoticeBanner`, manual override stub | `V5OperationalNotices`, wired | same as above |
| Shift notice | — | `ShiftNotice` in `V5OperationalNotices` | appears on manager screens for the first time (D-10-6) |
| `?conn=` dev toggle | wired on mount, dev builds only | not wired | lost unless moved (D-10-7) |
| Tenant, branch and terminal label | `TopBar` → `IdentityStrip`, but `router.tsx` mounts `<AppShell />` **without** `pairedStatus`, so production shows «— · — · —» | nowhere | none: nothing real is shown today. Showing terminal identity anywhere is new scope (§8) |
| Operator name, role, sign-out | `TopBar` → `OperatorSlot` | `V5Navigation` operator block + `V5SignOut` | none |
| Brand mark | `TopBar` wordmark | `V5Navigation` brand | none |
| Primary nav, role-filtered | `NavRail` | `V5Navigation` (`visibleNavEntries`, adds the cashier allowlist) | none; sub-route "current" mapping (D-10-5) |
| Dialog portal | none (legacy routes have no `DialogHost`; `ReauthDialog` and V5 `Dialog` carry fallbacks) | `V5Frame` → `DialogHost` | the fallbacks become dead once every route is in the frame (§5.1) |

### 2.3 Legacy code and every consumer at `91d080ef`

| Code | Consumers outside the legacy shell | Disposition |
|---|---|---|
| `shell/AppShell.tsx` | `router.tsx` | delete (S10-Z) |
| `shell/regions/TopBar`, `NavRail`, `IdentityStrip`, `OperatorSlot`, `CenterStage` | `AppShell` only | delete (S10-Z) |
| `shell/regions/Workspace` | 10 route components incl. `ReturnsRoute`, `CatalogueDiagnostics`, `CheckoutPlaceholder` | replaced per surface, then delete (S10-Z) |
| `shell/regions/ThemeToggle` | `SettingsSkeleton` | removed with Settings (D-10-3), then delete |
| `shell/StuckShiftBadge.tsx` | **no importer** (dead; only its own test) | delete (S10-Z) |
| `shell/dev/useDevToggles` | `AppShell` | move or delete per D-10-7 |
| `shell/connection/useConnectionState` | `AppShell` only; it re-exports `connection/connection-state` | delete the compat path (S10-Z) |
| `shell/viewport/useViewportTier` | none in V5: it is a compat re-export of `renderer/viewport/useViewportTier` (023 G0) | delete the compat path (S10-Z) |
| `ui/states/ScreenTooSmall` | **`V5Frame`, `FitGuard`, `SupportedViewport`** | **keep**; `ui/states` cannot be retired wholesale |
| `ui/states/Loading/Empty/ErrorState` | the legacy placeholders only | delete once unreferenced |
| 007 `ui/primitives/StatusBanner` | **`V5Frame`** | **keep** until VN-S6 (§5.3) |
| 007 `ui/primitives/Button` | **`session/LockScreen`** | **keep** until the lock screen is recomposed (VN-S8 / RT-116 scope, not VN-S10) |
| 007 `Badge`, `Card`, `Dialog`, `Input`, `Table`, `Toast` | prove at execution with a grep | delete whatever has no production consumer |
| `routes/app/DashboardView`, `DashboardDemo`, `dashboard-demo-data` | the dev `?demo=1` branch only | delete per D-10-4 |
| `routes/app/DashboardSkeleton`, `SettingsSkeleton`, `*Placeholder`, `CheckoutPlaceholder` | their routes | replaced per surface, then delete |
| `--color-accent` (`styles/tailwind.css:27`, `:237`; used only by `.nav-rail__entry` at `:603`, `:611`; `ui/tokens/colors.ts:20`) | the legacy rail | delete with the rail (07 §B) |
| CSS: `.app-shell*`, `.top-bar*`, `.nav-rail*`, `.placeholder-pane`, `.dashboard-*`, `.settings-section*`, `.diagnostics-*`, v3.5 dashboard classes | legacy screens | delete each block once grep shows no consumer; never delete a class another screen still uses |
| `hooks/useTheme`, `stores/theme-store` | `ThemeToggle` | **keep**: OD-4 keeps dark maintained; only the toggle UI goes |
| `shell-routes.ts` contract (`label`, `path`, `allow`) | `v5/frame/nav-model.ts` | **keep**; it is the single nav contract |

### 2.4 Tests that encode shell behaviour

| Test (`src/renderer/shell/__tests__/`) | What it protects | Disposition |
|---|---|---|
| `AppShell.too-small.test.tsx` | screen unmounts below the floor | confirm parity in `v5/__tests__/v5-frame-viewport.test.tsx`; port any missing case, then delete |
| `AppShell.printer-failure-banner.test.tsx` | the banner shows while a failure is unresolved | port to a `V5OperationalNotices` test (none exists today), then delete |
| `viewport-transition.test.tsx` | unmount/remount across the floor | port to the V5 frame, then delete |
| `AppShell.layout.test.tsx`, `AppShell.test.tsx` | landmarks, RTL, nav present | covered by `v5-frame.test.tsx` + router tests; port missing assertions, then delete |
| `AppShell.first-paint-perf.test.tsx` | first-paint budget | port to `V5Frame` (same budget) or record why it is dropped |
| `StuckShiftBadge.test.tsx` | a dead component | delete with the component |

Router-level role-guard tests for `returns`, `audit`, `manager/*` stay and must pass unchanged.

## 3. Per-surface treatment

Categories as in 07: **Restyle** (same behaviour and DOM roles, V5 tokens and Arabic copy) and
**Recompose** (clean-room rebuild on V5 primitives, same behaviour). No surface gains data,
IPC, a contract or a new capability. «Coming soon» and English stubs are removed everywhere; a
surface with no content says so honestly in Arabic.

| Surface | Treatment | Content after VN-S10 | Must not do |
|---|---|---|---|
| Dashboard | **Recompose** as the manager home | V5 page titled «لوحة المتابعة». Entry cards for the three links it has today: the shift manager (`ShiftManagerLink`), Manager → Cashiers (`CashierManagementLink`) and المبيعات المعلقة (`RecoveryLink`). A link to stuck shifts is added only if D-10-2 says so. The **recovery-mode redirect** in `RecoveryLink` is kept as is. No metrics. Cashier on a direct visit: Arabic V5 refusal with a way back to the Sale | show any figure (no metrics contract; the Phase-4 "no fabricated metric" rule stands) |
| Sales | **Recompose** (the VN-S9 lookup part) | Arabic find-by-sale-number, result and reprint, on V5 primitives; same `FindSaleReceipt` behaviour | build the recent-sales list or a short sale number: that is **RT-249 / D-N1** |
| Returns | **Restyle** | Same `ReturnsScreen`; `Workspace` replaced by the V5 screen section; check `returns.css` against the V5 tokens | change the flow, gates or copy owned by RT-15 |
| Audit | **Restyle** | Honest Arabic empty state: the audit log is not shown on this terminal | imply a log exists |
| Inventory | **Restyle** | Honest Arabic empty state + link to catalogue diagnostics | imply inventory management |
| Catalogue diagnostics | **Restyle** | Arabic sections (terminal, catalogue sync, local read model, read-only search); the «Coming soon» section is removed | change the read-down or search calls |
| Settings | **Restyle** | Honest Arabic page. Theme toggle per D-10-3. «Coming soon» rows and the fake "connection simulation" row removed | add a setting, or terminal identity (§8) |
| Stuck shifts / forced close | **Recompose** | `StuckShiftSurface` on V5 `Dialog`/`ConfirmDialog`, Arabic copy, same `operator.forceCloseShift` calls and refusals | change the bridge call, approvals or audit |
| Force-fail placeholder | **Restyle**, stays hidden | Arabic V5 notice; still not in any nav | build a stuck-attempt list (no contract; RT-441 recovery covers stuck attempts) |
| Checkout, payments flag off | **Restyle** | Arabic V5 notice inside the existing frame | change the flag behaviour |

## 4. Navigation model

- **One frame:** `V5AppLayout` is the only layout under `/app`. `AppShell` is no longer routed.
- **Entries:** unchanged. The seven contract entries, role-filtered by `visibleNavEntries`; the
  cashier still sees the Sale only (OD-6, RT-241).
- **Current entry for sub-routes** (D-10-5). Today no nav entry matches `manager/*` or
  `shift/manager`, so nothing is marked current. Proposed: `manager/*` and `shift/manager` mark
  «لوحة المتابعة» current (the dashboard is the manager hub that links to them);
  `inventory/diagnostics` marks «المخزون» current (already true by prefix match).
- **Slim rail** stays route-based on the active-sale routes only (RT-242). Manager screens get
  the labelled panel.
- **Brand and operator** stay in `V5Navigation` only; no screen repeats them.

## 5. Retirement plan

### 5.1 What is deleted (S10-Z)

Everything marked "delete" in §2.3, once a grep shows no production consumer. The
`DialogHost`-missing fallbacks in `ui/operator/ReauthDialog.tsx` and `v5/foundation/Dialog.tsx`
(`useHasDialogHost`) exist for the legacy routes. Remove them only if every remaining caller is
inside the V5 frame. A caller outside `/app` (sign-in, lock) keeps the fallback. The `router.tsx` comment
"the legacy AppShell for every other screen" and the `V5AppLayout` doc comment are updated.

### 5.2 The guard

Extend `src/renderer/styles/__tests__/v4-rebuild-vocabulary.test.ts`, or add a sibling test in
the same folder, so that CI fails if:

1. any module under `src/renderer` imports `shell/AppShell` or `shell/regions/*`;
2. `router.tsx` contains `AppShell`;
3. `--color-accent` is defined in `styles/tailwind.css` or exported from `ui/tokens/colors.ts`;
4. a retired class prefix (`app-shell`, `top-bar`, `nav-rail`, `placeholder-pane`,
   `dashboard-card`, `settings-section`) appears in any `.tsx` or in `tailwind.css`;
5. the visible copy of a manager surface contains «Coming soon».

Each surface slice also adds its `REBUILT_SCREENS` row with the prefixes it retired.

### 5.3 What VN-S10 deliberately does not retire

- **007 `StatusBanner` and the connection banner.** Their replacement (`Banner` +
  `StatusIndicator`) is **VN-S6**, which needs a real connection signal (X-2). VN-S10 leaves them
  in `V5Frame`. If VN-S6 lands first, it removes them; otherwise they outlive VN-S10.
- **007 `Button`**, used by `session/LockScreen`. The lock screen belongs to VN-S8 / RT-116.
- **The theme store and hook** (OD-4: dark is maintained, not offered).

## 6. Owner decisions

**Answered 2026-10-15 (owner, in session): every recommendation below is approved.** So D-10-1 = A
(one frame first), D-10-2 = a (stuck-shifts card on the manager home), and D-10-3 … D-10-8 as
recommended.

| ID | Decision | Options | Recommendation (approved) |
|---|---|---|---|
| **D-10-1** | Order of the move | **A.** Move every route under the V5 frame first (S10-1), with legacy content shown inside the V5 frame until its surface slice lands. **B.** Move each route only when its surface is recomposed; `AppShell` lives until the last one | **A.** The frame switch is the defect seen on the bench, and the legacy content is English in either frame. A ends the switch in one slice and is easy to revert (route composition only). It is a visible change, so S10-1 needs captures and your visual approval like any other slice |
| **D-10-2** | An entry point to stuck shifts. Today nothing links to `/app/manager/stuck-shifts` (§2.1) | **a.** A card on the manager home. **b.** Leave it unlinked, as today | **a.** A manager cannot use a recovery screen they cannot reach. It is a new navigation path to forced close, so it needs your yes. The route guard and main's role check are unchanged |
| **D-10-3** | Theme toggle in manager Settings | remove / keep | **Remove.** OD-4: dark is maintained but not offered. The theme store stays |
| **D-10-4** | v3.5 `DashboardView` + `?demo=1` sample data | retire / keep as a dev preview | **Retire.** It is v3.5 vocabulary with no metrics contract; a real dashboard needs its own contract and design issue |
| **D-10-5** | Nav "current" for `manager/*` and `shift/manager` | dashboard entry / none / new entry | **Dashboard entry** (§4). No new nav entry |
| **D-10-6** | Operational notices on manager screens | accept / suppress | **Accept.** Under `V5OperationalNotices` a manager sees a printer failure with a working reprint and manual override (enabled ⟹ wired), and `ShiftNotice` decides per role as it already does. Under `AppShell` the reprint button did nothing |
| **D-10-7** | `?conn=` dev toggle | move into `V5Frame` (dev builds only) / drop | **Move.** It is the only way to exercise the connection banner until VN-S6 |
| **D-10-8** | Stuck shifts placement | keep its own route, recomposed / fold into Manager → المبيعات المعلقة (RT-441) | **Keep its own route.** Folding is a behaviour and navigation change that RT-441 did not plan |

**New reference gap — G-6, manager/admin surfaces.** Only G-1 (entry screens) and G-3 (Manager →
Cashiers) exist. Under the pack's rule, a screen is implementation-safe only when its visual is
FROZEN, and no manager surface in §3 has a frozen reference. G-6 closes that gap (S10-R) before
any surface slice. Record it in 15 §6 in the S10-R PR, not here.

## 7. Slices

Every implementation slice follows 15 §7 verbatim:

- cites [08](08-rt24-invariants.md) and §3 of [15](15-vnext-freeze-package.md);
- captures its states at 1024 and 1280, in light and `forced-colors`;
- includes a keyboard-only walk and a scanner walk (emulated burst + R-hw on the bench). On these
  screens the scanner walk proves a wedge burst adds nothing and never lands in an input;
- runs axe on touched surfaces;
- runs `typecheck`, `lint` and `test --coverage`;
- records an Impeccable `audit`, then `harden` and `polish` before ship;
- gets owner visual approval before merge.

Plus the repo's CodeScene loop (`code_health_review`, `pre_commit_code_health_safeguard`,
`analyze_change_set`). One repo (`Kemetra/POS`), renderer only, no IPC/DB/API/migration change in
any slice.

| Slice | Work Mode | Scope | Depends on | Acceptance |
|---|---|---|---|---|
| **S10-0** | Planning | This document (RT-478) | — | Owner approves §3–§7 and answers D-10-1…8 |
| **S10-R** G-6 references | Docs (design) | A G-6 reference set under `visual-acceptance/G6-Manager/` in the G-1/G-3 format: manager home (with and without the shift flag), cashier refusal, sales lookup (empty, found, not found, reprint sent/failed), returns in the frame, audit, inventory, diagnostics, settings, stuck shifts (list, confirm, refused), force-fail notice. The checkout-off notice is specified as copy only and reuses the ForceFail notice pattern (no capture). 1024 and 1280, an Arabic copy table, forced-colors notes | S10-0 | Owner approves each reference; G-6 recorded in 15 §6 |
| **S10-1** One frame | Implementation | All `/app/*` children under `V5AppLayout`; a V5 screen-section component replaces `Workspace` for every legacy screen (labelled `<section>` + `<h1>`, no landmark); nav "current" mapping (D-10-5); `?conn=` moved (D-10-7); shell tests ported (§2.4). `AppShell` stays in the tree, unrouted | S10-0; **D-10-1 = A** (with B this slice shrinks to the screen-section component + nav mapping) | No route renders `data-testid="app-shell"`; every legacy route renders inside `v5-frame`; router role-guard tests unchanged and green; captures of every route at 1024/1280; RT-318 re-checked on the packaged build |
| **S10-2** Manager home | Implementation | Dashboard recompose (§3), cashier refusal, `DashboardView`/demo retired (D-10-4), stuck-shifts card per D-10-2 | S10-1, S10-R, D-10-2 | Each link reaches its screen; recovery-mode redirect test still passes; no figure rendered |
| **S10-3** Sales lookup | Implementation | `/app/sales` + `FindSaleReceipt` recompose | S10-1, S10-R | Same find/reprint behaviour and tests; no recent-sales list (RT-249) |
| **S10-4** Returns in the frame | Implementation | `ReturnsRoute` restyle | S10-1, S10-R | RT-15 tests unchanged and green |
| **S10-5** Stuck shifts | Implementation | `StuckShiftSurface` recompose on V5 dialogs | S10-1, S10-R, D-10-8 | Same `forceCloseShift` calls, refusals and audit; every refusal has Arabic copy |
| **S10-6** Honest pages | Implementation | Audit, inventory, diagnostics, settings (theme toggle per D-10-3), force-fail and checkout-off notices | S10-1, S10-R, D-10-3 | No «Coming soon»; no English visible copy except ids and codes |
| **S10-Z** Retire the shell | Implementation | Delete §5.1; the guard in §5.2 | S10-1…6 | Guard green; grep shows no `shell/` import in production code; full suite green |
| **S10-V** Packaged verification | Verification | Packaged build on the bench: manager, admin and cashier walks through every `/app/*` route at 1024×768 and 1280×800, light and forced-colors, keyboard and axe; record lessons in the Confluence runbook (page 18874418) | S10-Z | No legacy frame anywhere; evidence on RT-478's slice issues |

S10-2…6 touch disjoint screen files after S10-1, so they can run in parallel. Two rules keep them
from colliding: only S10-1 and S10-Z edit `router.tsx`, and each surface keeps its CSS in its own
file instead of `tailwind.css`. The `REBUILT_SCREENS` rows in the guard test are the one shared
edit; expect trivial merge conflicts there.

## 8. Outside VN-S10 (coordinate, do not absorb)

| Item | Why it is separate |
|---|---|
| VN-S6 status truthfulness (connection, sync) | needs a real signal (X-2); owns the `StatusBanner` replacement |
| RT-249 / D-N1 | recent-sales list and short sale number |
| RT-445 / RT-471 / RT-446 PK-3 | park/resume UI and its references |
| RT-308 / RT-309 / RT-310 | offline cashier admission and acceptance |
| RT-250 / D-P1 | card outcome input |
| RT-472 / RT-475 / RT-406 | tenant logo on boot, pairing, sign-in and lock |
| Terminal identity in the app frame | the legacy strip never showed real values (§2.2); showing tenant, branch or terminal label is new scope with its own issue |
| RT-479 | FitGuard false block on a large window (cashier path); may affect S10-V captures at large sizes |
| VN-S8 / RT-116 | lock screen, which holds the last 007 `Button` |
| Admin-Console | out of scope for the POS |

## 9. Evidence limits

- Inventory from source at `91d080ef` only: no app run, no packaged build, no tests for this plan.
- The 2026-10-14 bench observation is quoted from RT-478, not repeated.
- "No production consumer" claims in §2.3 come from `grep` at the baseline. Each deleting slice
  re-checks them at its own baseline.
