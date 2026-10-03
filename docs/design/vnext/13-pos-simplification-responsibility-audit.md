# 13 — POS simplification & responsibility audit (RT-160)

> **Status: Planning deliverable for RT-160. Docs only.** No production code, refactor, dependency,
> DB, API or IPC change is made or authorised by this document. Every simplification below is a
> **proposal**; implementation needs its own bounded Jira issue and owner approval. **RT-24 remains
> the behaviour authority**; nothing here changes financial or recovery semantics.
>
> **Read these limits first**
>
> 1. **Static and historical evidence only.** This audit read code on `main@7384217` and measured
>    git history. It ran **no** app, lab or packaged build. All runtime/UX evidence is cited from
>    RT-159 ([12](12-cashier-ux-usability-audit.md)), which itself ran *before* RT-117.
> 2. **RT-117 is merged but still open in Jira.** RT-160 is linked "is blocked by RT-117". The
>    sequencing rule ("execute from the post-RT-117 `main` baseline") is met: S1 merged as `7384217`
>    (#509). The Jira link itself is the owner's to reconcile.
> 3. **No duplicate ownership.** RT-159 F-01…F-06 and the RT-116 slices (S3–S7) already have owners.
>    They are cited as evidence and generate no new slices here.
> 4. **ERPNext semantics are cited from the bench-verified scout** (`specs/010-…/dev-report.md` §B5,
>    ERPNext 15.110.0 DocType JSON) — not reconstructed from memory, and not re-verified this session.

## Baseline

| | |
|---|---|
| Repository / branch | `Kemetra/POS`, worktree branch `worktree-rt-160-simplification-audit` |
| Verified `origin/main` | `738421703ab92c34cc10693c82cccf47647ac3fd` — RT-117 S1 (#509), 2026-10-03. Fetched at start and again before writing; unchanged |
| Jira | RT-160, Work Mode **Planning**, parent Epic RT-106; relates to RT-159; blocked-by link to RT-117 (merged, see limit 2) |
| Inputs read | RT-160 text; `docs/architecture/current.md`, `synchronization.md`; `specs/021-pos-maintainability-rescue/*`; `specs/README.md`; VNext [11](11-operational-workflow-benchmark.md) (RT-111) and [12](12-cashier-ux-usability-audit.md) (RT-159); `specs/010-…/dev-report.md` §B5–B6; `docs/runbook/008-…md`; `src/**` |
| Date | 2026-10-03 |

## Evidence labels

| Label | Meaning |
|---|---|
| **C** | Read in source at `7384217`, with file:line where useful. Not run. |
| **G** | Measured from git history (`git show --numstat`) on `main`. |
| **D** | Taken from a cited document, not re-verified here. |
| **N** | Not done or not available. Said explicitly. |

Line and file counts are **supporting signals, not proof** (RT-160 §B). The conclusions rest on
*why* a change had to touch a file, not on how many it touched.

---

## 1. Executive summary

**Verdict: keep Electron and simplify internally. Do not open a platform evaluation now.** Electron's
cost is real but bounded. Across six measured changes, Electron/composition boundary files carried
**5–37 %** of the added production lines (§5). Most of the cost of a POS change comes from three other
places:

1. **Essential safety work.** Money, idempotency, lock and recovery rules, and the tests that prove
   them. Test lines ran **1.3–5.3×** production lines. That is the price of RT-24 and should be kept.
2. **A composition-root hotspot (incidental).** `src/main/index.ts` was touched by **6 of 10** recent
   changes, including changes with no Electron surface at all (RT-79, #472). The reasons are inline
   env/flag parsing (**5 copies** of the same truthy parse) and hand wiring of every repository
   function. 021 removed the root's mutable state, but its size has grown back: **1393 → 1339 → 1437**
   lines (pre-021 → post-021 → now).
3. **Authority in the wrong layer (incidental, mostly fixed).** #470 had to move three money
   decisions from the renderer to main after review. RT-159 F-03 (renderer recomputes change) is the
   same pattern still open in the UI.

**Four findings matter more than any refactor:**

| # | Finding | Evidence | Class |
|---|---|---|---|
| **P-1** | **Cashier feature-flag coherence.** Five fail-closed env flags (`CART`, `PAYMENTS`, `SALE_FINALIZATION`, `PRODUCT_SEARCH`, `VOUCHER_TENDER`) are read from `process.env` in main (no dotenv loader in `src/main`). Whether a packaged build gets them from the terminal's OS environment or has them fixed at build time is **not verified (N)**; that decides whether the check below is per terminal or per build. With **payments on and sale finalization off**, payments still settle, but no Sale row, receipt, outbox entry or backend capture is written (`index.ts:1054-1065`). This is the **documented rollback** (`docs/runbook/008-…md:250`), not a bug. But nothing at startup validates the combination, and the renderer has no state that tells the cashier they are in manual-receipt mode. The tender facts stay only in local `payment_attempts` and tender tables. | C, D | **Pilot-critical** (ops check now; slice S-A) |
| **P-2** | **Audit events never leave the terminal.** `AuditSync` (`src/main/audit/audit-sync.ts`) is implemented and tested but has **no production caller**. Lock/unlock, payment and sale audit rows accumulate in local `audit_events` only. | C | **Pilot decision** (slice S-B) |
| **P-3** | **RT-117's inactivity timer escapes the documented shutdown order.** `InactivityMonitor.start()` (`index.ts:582`) is never stopped and is not in `workerRegistry`. A lock tick writes `audit_events` (`wireSessionLockAudit`). `current.md` §3 says every background worker must stop before the DB closes. Probability is very low (needs a 10-minute idle lock in the quit window). | C | Fold into the next RT-116 slice — no new issue |
| **P-4** | **Built-but-unwired code suggests behaviour that does not run.** `AuditSync` (P-2); `LifecycleCascade` constructed then `void`ed (`index.ts:591-596`); `registerSessionEndCartDiscardSubscriber` with no caller (also RT-111 OB-06); ~24k-line `api-types.ts` with 281 paths and 4 importers, carrying legacy Data-Pulse return/shift schemas (`ReturnRequest`, `ActiveShiftResponse` with float `_egp` amounts) that are **not** Backend-Core POS contracts. | C | Post-pilot cleanup, except where P-2 decides otherwise |

**The cashier-facing complexity RT-159 found is mostly presentation and focus, not architecture.**
Two items are architectural: renderer-side money recompute (F-03) and renderer-memory cart identity
on restart (F-06, owned by RT-116 S4). See §8.

---

## 2. 021 maintainability rescue — re-verified on current `main`

| 021 claim (2026-09-18) | Now (`7384217`) | Evidence |
|---|---|---|
| SC-1: no process-lifetime mutable state in `index.ts` | **Holds.** `grep '^let ' src/main/index.ts` → 0 | C |
| Worker lifecycle extracted; stop order finalize → read-down → sale-sync | **Holds for those three; broken by a fourth.** RT-117's inactivity interval is outside the registry (P-3) | C |
| Window/trust boundary extracted (`bootstrap-window.ts`) with 12 tests | **Holds.** Sender guard + locked-session allowlist now wrap `ipcMain` once (`session-lock-guard.ts`), the same "enforce once at the root" pattern | C |
| DB holder extracted; open/migrate stay at root | **Holds** | C |
| R2 naming: `CheckoutPlaceholder` deliberately kept (accurate) | **Holds** (`CheckoutRoute.tsx:47`) | C |
| Composition root size reduced | **Regrown.** 1393 (pre-021 `69c19f4`) → 1339 (post-021 `5bee8ce`) → **1437** now; `bridge-api.ts` 1305 → 1305 → **1386** | G |
| `current.md` is the canonical internal map | **Drifted** (not fixed here, see §14): flags 4 → 5; no mention of the locked-session allowlist, the first main→renderer push channel, or the inactivity timer | C |

**Reading:** 021 fixed *lifecycle* and *naming*. It did not change how features are *wired*, so the
root regrew along exactly that axis. A second extraction pass must target wiring and config, not
lifecycle again.

---

## 3. Current architecture and responsibility map (deliverable 1)

### 3.1 Process and layer map (as it runs today)

```
Renderer (React, sandboxed)                 Preload                Main (Node, trusted)                     Network
─────────────────────────────               ──────────             ─────────────────────────────────        ──────────────
routes/, v5/, ui/, session/                 contextBridge          ipcMain ── sender guard (origin)          Backend-Core only
stores/ (zustand projections)  ─invoke──▶   'api' object   ──▶       └─ locked-session allowlist (RT-117)
 operator-session, cart, payment,           (pass-through,           └─ ipc/<domain>.ts  (thin registration)
 feature-flags, catalogueSearch             ~65 channels)             └─ <domain>/*-bridge.ts (role gate +
                               ◀─push──     session-state                 business rules)
                               (1 channel: operator:session-state)    └─ repositories ─▶ SQLite (WAL, 1 handle)
                                                                     workers: finalize listener, read-down
                                                                       driver, sale-sync interval  [registry]
                                                                       + inactivity monitor        [NOT in registry]
```

- About **65 `ipcMain` registrations** (63 `handle`, 2 `on`) in 15 `src/main/ipc/*` files; **one**
  main→renderer push (`index.ts:614`). The `*.subscribe` channels are snapshot reads the renderer
  **polls** (`sales-bridge.ts:13`), not subscriptions. (C)
- The renderer reaches main only through `window.api` (`preload/index.ts:171`). The renderer
  isolation flags are unchanged and guarded. (C)

### 3.2 Responsibility map

"State authority" is the place whose value wins when two disagree.

| Responsibility | Lives today | State authority | Owner class |
|---|---|---|---|
| Sign-in / PIN / takeover | `main/operator/*` (sign-in, takeover, PIN seal/lockout); Clerk + Backend-Core for manager/admin | main `SessionManager`; PIN hash local | **Keep local** (PIN, session); **Backend-Core** (active-session check, roster, takeover-confirm) |
| Inactivity lock / unlock (RT-117) | `inactivity-monitor`, `session-manager` lock_state, `session-unlock-handler`, `session-lock-guard`, renderer `SessionLockGate` + `activity-reporter` | main `SessionManager.lock_state` (in-memory); renderer is a projection via push + `getLockState` | **Keep local** |
| Active sale / cart | `main/cart/cart-bridge.ts` (1378 lines) + `cart-store.ts`; renderer `useSaleCartController` | main SQLite `carts` / `cart_lines`; **renderer holds the active cart id** (restart gap F-06) | **Keep local**; cart identity on restart → RT-116 S4 |
| Checkout and tenders | `main/payments/*` (2 FSMs, 13 handlers, idempotency, action outbox); renderer `PaymentSurface` (720 lines) | main `payment_attempts` + `payment_tender_lines`; **renderer recomputes change for display** (F-03) | **Keep local**; voucher authority = **Backend-Core** (client only) |
| Finalization / receipt | `finalize-transaction.ts` (one tx, idempotency re-check inside), print dispatcher, OS-print / ESC/POS adapters | main `sales` (append-only trigger) | **Keep local** |
| Offline persistence | `better-sqlite3`, 36 migrations, append-only triggers | SQLite | **Keep local** |
| Outbox / retry / exactly-once capture | `sync-outbox/` (enqueue inside finalize tx) + `sales-sync/` (drain, typed result union, dead-letter) | local outbox → **Backend-Core** idempotent `captureSale` (externalId) | **Keep local** (queue) + **Backend-Core** (dedupe/authority) → Connector → ERPNext |
| Restart / recovery | stuck-attempt sweep (`sweep-stuck-attempt.ts`), deferred-reversal resolver, read-down resume; held-cart re-attach **missing** | SQLite | **Keep local**; contract in RT-116 S4–S6 |
| Returns / refunds | `ReturnsPlaceholder.tsx` only; spec 014 **Deferred** | none | **Backend-Core authority** (return against original sale) + **ERPNext reference** (`is_return` / `return_against`) |
| Shift / cash-up | `shifts` table (no drawer math), forced-close, stuck-shift discovery; spec 015 **Deferred**; no Backend-Core lifecycle contract (D: dev-report row 5, RT-111 §5) | partial local | **Backend-Core authority** + **ERPNext reference** (POS Opening/Closing Entry); local count capture stays POS |
| Printer / cash drawer | `main/receipts/*`, `main/drawer/*` | local `print_events`, `drawer_events` | **Keep local** |
| Catalogue | read-down stage-and-promote into SQLite; offline lookup | **Backend-Core** resolved store catalogue | **Backend-Core** authority, local read model |
| Audit | 3 emitters (`audit/`, `payments/`, `sales/`) → `audit_events`; **upload unwired** (P-2) | local only | **Keep local** (capture) + **Backend-Core** (upload, if decided) |
| Terminal config (flags) | per-terminal OS env vars read in `index.ts` | the terminal's environment | **Candidate incidental** (P-1); post-pilot analogue = Backend-Core terminal profile (§7) |

---

## 4. Essential vs Electron-tax vs Incidental matrix (deliverable 2)

| Area | Essential (keep) | Electron / platform tax | Incidental (self-created) |
|---|---|---|---|
| **Money / payments** | 2 FSMs, idempotency helper, action outbox, live-tender rules (#472), integer minor units | — | Renderer recomputes change after apply (F-03); renderer was de facto authority for handed-off-cart decisions until #470 |
| **Sale durability / sync** | Single finalize tx with idempotency re-check; enqueue/drain split; typed transport unions; dead-letter | — | Flag combination can disable finalization while payments settle, with no startup check or cashier-visible state (P-1) |
| **Session / lock** | Lock state, unlock rate-limit, locked allowlist, credential split (device token / envelope / JWT) | Push channel + preload wiring for lock state; allowlist must wrap `ipcMain` | Inactivity timer outside worker registry (P-3); `LifecycleCascade` constructed and `void`ed |
| **IPC surface** | Sender-origin guard; explicit preload allowlist; boundary id bounds | One operation spans channel const → `bridge-api.ts` type → preload entry → `ipc/<d>.ts` → handler (≈5 files) | Types declared twice: `shared/<d>/bridge-types.ts` and namespace interface in `bridge-api.ts` (1386 lines); `ipc/` vs `<d>/*-bridge.ts` vs `wire-*-handlers.ts` naming is uneven across domains |
| **Composition root** | Ordered start/stop, fail-closed `safeStorage`, migrations halt launch | `index.ts` runs `app.whenReady()` at import, so it cannot be unit-imported → a 25-assertion source-text guard | Env parsing ×5 copies; feature wiring inline (114 imports, 17 `bind*` calls); main-only changes still edit it (§5) |
| **Testability** | Characterization and money tests | Import-time Electron side effects; renderer tests must fake `window.api` | **77** test files hand-build an operator bridge fake; no shared typed fake factory, so RT-117 edited 7 unrelated renderer tests (+11 lines each) just to add 3 methods |
| **Contracts** | Pinned codegen (Constitution V) | — | 24k-line `api-types.ts` (281 paths, 4 importers) with legacy non-POS schemas; `CaptureSaleRequest` hand-vendored separately in `create-sale-sync-client.ts` |
| **Native / runtime** | `better-sqlite3` on the main thread; ~3.6 s atomic read-down promote accepted for v1 (D: CLAUDE.md 010 T054) | Native module rebuild per Electron major (RT-65/RT-108/RT-109 cost) | — |
| **Config** | Fail-closed defaults | — | Five independent env flags → 32 combinations, with no validated "cashier profile" (P-1) |

---

## 5. Change-amplification case studies (deliverable 4)

### 5.1 Measurements (G)

"Boundary" = `src/shared/bridge-api.ts`, `src/preload/**`, `src/main/ipc/**`, `**/channels.ts`,
`src/main/index.ts`. Lines are additions.

| Change | Prod files (layers) | Prod +lines | Boundary +lines (share) | `index.ts` touched | IPC change | Test files / ratio | Runtime-only proof needed | Dominant source |
|---|---|---|---|---|---|---|---|---|
| **CS-1** RT-117 S1 lock (#509) | 25 (main 13, renderer 6, shared 4, preload 2) | 1345 | 378 (**28 %**) | yes (+70) | +2 invoke, +1 push, allowlist wrapper | 28 / 1.65× | Yes: real idle timing, lock screen inertness, packaged build (RT-159 re-audit pending) | **Essential** (lock + live-tender safety), then Electron tax (push/preload), then incidental (root wiring, fake-bridge fan-out, P-3) |
| **CS-2a** #469 post-handoff cancel | 10 (main 5, shared 3, preload 1, renderer 1) | 172 | 63 (**37 %**) | yes | +1 invoke | 9 / 5.3× | No | Electron tax (new channel across 5 boundary files) + essential money rule |
| **CS-2b** #470 main becomes authority | 12 (main 9, renderer 2, shared 1) | 461 | 21 (**5 %**) | yes | id bounds only | 18 / 2.4× | No | **Incidental**: authority had to move from renderer to main after the §A4 review |
| **CS-3** RT-103 voucher flag (#493) | 6 (renderer 4, shared 1, main 1) | 68 | 8 (12 %) | yes (flag parse #5) | `app:config` shape +1 field | 6 / 5.0× | No | **Incidental**: flag pipeline env → root → `AppConfig` → `app:config` → store → 2 consumers |
| **CS-4a** RT-79 tenders on capture (#492) | 4 (main 4) | 246 | 19 (8 %) | yes (env parse + DI) | none | 5 / 1.3× | Yes: Backend-Core acceptance (live-smoke gate) | Essential (contract/money) + incidental root edit |
| **CS-4b** #472 never pay twice | 5 (main 5) | 92 | 16 (17 %) | yes (+1 injected repo fn) | id bounds | 6 / 2.9× | No | Essential; root edited only to inject one function |
| **Control** RT-35 `tenantProductRef` (#484) | 1 (main) | 24 | 0 | no | none | 2 / 2.6× | Yes (backend) | Well-factored seam: a contract change absorbed in one file |

### 5.2 What each case shows

**CS-1 — RT-117 inactivity lock.** This is the largest recent change, and most of it is correct
essential complexity. About 72 % of production lines sit outside the boundary files. Roughly 420 of
those are the lock UI (LockScreen 243, SessionLockGate 71, activity-reporter 57, CSS 51). The rest
(about 550) are main-side lock semantics: unlock handler and rate limit, session-manager lock state,
lock-state reader, the "never auto-reverse live tender" sweep rule and the audit categories. The Electron share is the
push channel, preload and bridge types, and the allowlist wrapper. The allowlist wrapper is really
security semantics placed at the right choke point: it refuses future channels by default. The
incidental cost is concentrated: `index.ts` +70 lines; 7 unrelated renderer tests edited only to add
`unlockSession` / `getLockState` / `onSessionStateChanged` to hand-built fakes; and the timer left
outside the registry (P-3). **State authorities involved: 4.** Main lock state is the authority; the
renderer gate is a projection; the activity reporter is a signal; the payments sweep rule is
separate. The design is right: main decides and the renderer projects.

**CS-2 — handed-off cart (#469 then #470).** Adding one manager operation cost a new channel across
five boundary files (37 % of lines). That part is Electron tax. The follow-up (#470) cost almost three
times as many lines, mostly tests (1111), because review found **the renderer was the only place
enforcing** "cart is handed off", "envelope matches" and "not already paid" before `payments.start`.
That cost was self-created: authority was decided in the UI first. **Lesson: decide the main-process
authority before the UI flow exists.** `docs/architecture/current.md` should say so (§14).

**CS-3 — RT-103 voucher flag.** A UI-only rule needed a main edit, because flags are parsed inline in
the root. That edit was the fifth copy-paste of the same truthy parse, even though an `isTruthy`
helper already exists in `dev-seed-catalogue.ts`. It also added one more dimension to the flag
matrix that P-1 describes.

**CS-4 — RT-79 and #472.** Neither change touches the renderer, preload or IPC registration, yet both
edit `index.ts`: one to read a new env var, one to pass one more bound repository function into a
handler factory. That cost is not Electron. It comes from building the domain at the root instead of
in per-domain wiring modules.

**Control — RT-35.** Where a concern already has a home (`capture-payload.ts`), a backend contract
change costs one production file. The architecture is not uniformly expensive. The amplification is
concentrated in root wiring, flag plumbing, bridge-type duplication and test fakes.

---

## 6. Main / Preload / Renderer factoring (RT-160 §C)

| ID | Observation | Evidence | Assessment |
|---|---|---|---|
| C-1 | `index.ts` composes ~10 domains inline (114 imports, 9 `register*Handlers`, 17 `bind*`), 1437 lines | C | Incidental. Needs per-domain `wire<Domain>(ctx)` modules that return their stoppers to the registry |
| C-2 | `index.ts` cannot be imported in Vitest (`app.whenReady()` at module load), so wiring is tested by a 25-assertion source-text guard; 021 tripped a second, unplanned guard | C, D (021 T035) | Electron tax made worse by structure. Extracted wiring modules are importable, which lets most regex assertions become runtime tests |
| C-3 | Preload is a mechanical pass-through: about 69 `ipcRenderer.invoke` lines across 7 files, each typed by a `bridge-api.ts` interface that re-imports `shared/<d>/bridge-types.ts` | C | Partly required: the preload **must** stay an explicit allowlist. The duplication is incidental (§9 S-E) |
| C-4 | IPC guarding is done once at the root: sender origin, then the locked allowlist | C | **Good. Keep.** Do not move guards back into handlers |
| C-5 | Session/role gate lives in each domain bridge (`cart/require-operator-session.ts` 68 lines, `payments/require-operator-session.ts` 115 lines) | C | **Not duplicates.** Payments adds attempt-ownership and terminal-state refusals. A shared *core* (no session / role / tenant isolation) is a candidate; the semantics differ and must stay |
| C-6 | Cross-layer state is mostly pull/poll; one push channel (lock). `*.subscribe` names are polls | C | Fine for a single-window terminal. Naming is misleading; document it rather than rename IPC |
| C-7 | One SQLite handle on the main thread; workers are timers on the same thread | C, D | Essential for durability. Read-down promote blocks ~3.6 s (accepted v1). Moving DB work to a utility process is **not** justified by this evidence |
| C-8 | Inactivity interval outside the worker registry (P-3); `LifecycleCascade` dead wiring | C | Incidental. Small fixes |
| C-9 | Native module coupling: Electron majors force `better-sqlite3` rebuilds (RT-65 / RT-108 / RT-109 chain) | G | Electron tax. Periodic, not per-feature |

**Security boundary preserved by every proposal here:** `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`; the renderer has no Node, DB, secrets or network; the
preload stays an explicit per-channel allowlist (never a generic `invoke(channel, …)` pass-through).

---

## 7. Derive instead of reinvent — ERPNext / Backend-Core semantics (RT-160 §D)

Source: `specs/010-…/dev-report.md` §B5 (ERPNext 15.110.0 DocType JSON, bench-verified 2026-06-07)
and §B6 (non-goals). **D** throughout. No ERPNext POS UI or core code is copied, and there is no
POS → ERPNext call.

| Topic | ERPNext reference | Retail Tower position | Class |
|---|---|---|---|
| Sale lifecycle | POS Invoice Draft → Submitted → Consolidated; Merge Log consolidates into a Sales Invoice at shift close | POS emits an immutable, idempotent sale **fact**; consolidation is server-side (Backend-Core → Connector) | **Adapt through Backend-Core / Connector**. Never on the terminal (B6.3) |
| Payment / tender meaning | `payments` rows per Mode of Payment (split tender = several rows); `paid_amount`, `change_amount`, `account_for_change_amount` | POS keeps tender FSMs local. RT-79 sends cash **net** (applied − change) | **Reuse semantics** for the contract: change is its own fact, not netted away. Check with Backend-Core / Connector whether net cash loses anything ERPNext `change_amount` needs (**open question, not decided here**) |
| Inventory / accounting identity | Item master, stock ledger | ERPNext Item = accounting identity only (ADR-0001); Connector maps a pre-resolved `erpnextItemRef` | **Adapt through Connector**. POS never touches stock (B6.5, B6.8) |
| Opening / closing / cash-up | POS Opening Entry (per user, per shift, float by mode); POS Closing Entry (per-mode opening / expected / closing / difference) | No Backend-Core shift lifecycle contract yet (RT-111 §5, RT-17) | **Reuse semantics** for the RT-17 / 015 contract (per-tender-mode expected vs counted). Local count capture is **POS-specific**; authority is **Backend-Core** |
| Cancellation / reversal | Submitted docs are cancelled (docstatus 2) or returned (`is_return` + `return_against`, negative-qty credit note) | POS `sales` are append-only. Pre-handoff void and post-handoff cancel create no sale | **Reuse semantics**: a return references the original sale and never mutates it (014 contract via Backend-Core). Do **not** mirror "cancel" onto finalized POS sales |
| Tax / fiscal | Taxes table + regional override hooks | VAT deferred (012); Connector drops `taxAmount` today | **Connector adapter / fiscal extension point**. Not on the terminal (B6.6) |
| Terminal configuration | POS Profile (payments, warehouse, price list, users) | Binding comes from Backend-Core pairing; flags are local env (P-1) | **Not applicable as an authority** (B6.7). The *idea* of a server-issued terminal profile is a post-pilot **Backend-Core** candidate and needs a new contract |
| Loyalty | Loyalty fields on POS Invoice | Out of pilot scope | **Not applicable** |

---

## 8. Is the UI making the system feel more complex than it is? (RT-160 §E)

Target cashier model: **Scan/Search → Cart → Pay → Receipt**, with recovery states only when needed.
RT-159 findings (R-dev, pre-RT-117) sorted by cause:

| Cashier-visible complexity | RT-159 | Cause | Where to fix |
|---|---|---|---|
| Scanner input lands in whatever control has focus; focus returns to search, not scan | F-01, F-02 (UI side), F-07, F-08 | Presentation / focus model | UI (RT-159 pilot slices) |
| Payment commit has no affordance; amount due off-screen | F-09, F-10 | Presentation | VN-S4 |
| Wrong change after apply | F-03 | **Architecture: renderer recomputes money** instead of displaying main's stored `change_due_minor` | UI fix already proposed by RT-159. Principle for all VNext slices: *the renderer displays main's money facts after an apply and never recomputes them* |
| Restart shows an empty cart | F-06 | **Architecture: active cart id held in renderer memory** | RT-116 S4 (owned) |
| Absurd tender accepted by main | F-02 (main side) | Contract: main checks only safe-integer and ≥ 0 (`tender-apply.ts:86`) | Decision already raised by RT-159; not duplicated |
| No connection / queue signal | F-15 | Missing aggregate signal (sale-sync status exists as `sales:syncStatus` but is not mounted) | VN-S6; needs a real signal |
| Placeholder / "Coming soon" surfaces | F-25 | **Flag matrix + legacy shell** | OD-6 / VN-S10; P-1 reduces the matrix |

**Complexity that must stay hidden:** attempt and tender FSMs, idempotency keys, the outboxes,
read-down promotion, the credential split, and the lock allowlist. None of this needs a cashier-visible
step, and none of RT-159's findings is caused by it being *exposed*. The exception is the lock screen,
which is a deliberate RT-24 state.

**Conclusion:** the cashier journey is long because of focus and step design (RT-159 / VNext scope),
not because the architecture leaks. Two leaks exist (F-03, F-06), and both have owners.

---

## 9. Simplification candidates (deliverable 5)

| ID | Candidate | Benefit | Risk | Prerequisites | Affected contracts | Pilot |
|---|---|---|---|---|---|---|
| **S-A** | **Cashier profile coherence.** Move flag/env parsing out of `index.ts` into one importable config module (one truthy parser, reusing the existing semantics). Validate the combination at startup (e.g. `productSearch` needs `cart`; `payments` without `saleFinalization`). Make the rollback mode **explicit and visible** | Removes P-1; testable config; ends root edits for each new flag | Must not remove the documented rollback (runbook 008) without an owner decision | **Owner decision D-1** (below) | `AppConfig` / `app:config` only if a visible mode is added (IPC shape change, must be authorised) | **Pilot-critical** |
| **S-B** | **Audit upload decision.** Decide whether pilot audit evidence must reach Backend-Core. If yes, wire `AuditSync` against a confirmed Backend-Core endpoint. If no, record that terminal-local audit is accepted and say how it is retrieved | Auditability for lock, payments and manager actions | Wiring without a live contract would invent one | Backend-Core endpoint status (**N**: not verified this session) | Backend-Core audit ingestion (cross-repo) | **Pilot decision** (Planning first) |
| **S-C** | **Per-domain wiring modules.** Extract `wireOperator`, `wireCart`, `wirePayments`, `wireSales`, `wireCatalogue`, `wireSync` from `index.ts`. Each returns its stoppers to `workerRegistry` (absorbs P-3) | Main-only changes stop touching the root; wiring becomes runtime-testable; guards repointed, not deleted | Static guard churn (021 lesson); ordering bugs at startup | S-A first (config out of the root); characterization tests per module | None (internal) | Post-pilot |
| **S-D** | **Shared typed fake-bridge factory (test-only).** One `createFakeApi(overrides)` built from `bridge-api.ts` types | A new bridge method edits one helper instead of 7 (RT-117) up to 77 tests | Over-permissive fakes can hide missing stubs | — | None | Pre-pilot enabler (optional, cheap) |
| **S-E** | **Single declaration per IPC namespace.** Channel name, request type and response type declared once; preload and `bridge-api` derive from it, but stay an **explicit enumerated allowlist** | New operation goes from ~5 files to ~3 | Must not become a generic pass-through (security regression); channel names must stay byte-identical | S-D (tests survive the move); §A4-style review | All bridge types (shape-preserving) | Post-pilot |
| **S-F** | **Retire unwired code or record its intent** (`LifecycleCascade`, `registerSessionEndCartDiscardSubscriber`, depending on RT-116 S4). Trim `api-types.ts` to consumed POS paths and bring the hand-vendored `CaptureSaleRequest` under codegen | Code stops implying behaviour that does not run; ~24k lines of misleading types removed | Generated-code and codegen change: needs explicit authorisation (CLAUDE.md §10); the cart-discard subscriber may be RT-116's to decide | RT-116 S4 outcome; owner OK for codegen change | Codegen pipeline | Post-pilot |
| **S-G** | **Shared session-gate core** for cart and payments (no-session / role / tenant isolation). Domain extras stay | One place for the isolation order | Security semantics differ (C-5); refusal reasons are closed sets per domain | Equivalence tests first | Refusal reason sets (unchanged) | Post-pilot, low priority |

**Owner decision D-1 (needed before S-A):** with payments on and sale finalization off, should the
terminal **(a)** refuse to start the cashier surface, removing the documented rollback, or **(b)**
keep the rollback but show a persistent cashier-visible "manual receipt mode" state and log it at
startup? (b) preserves runbook 008; (a) is simpler but needs a replacement rollback. This audit does
not choose.

**Immediate operational action (no code, pilot readiness):** every pilot terminal is checked for
`POS_PULSE_FEATURE_CART`, `…_PAYMENTS`, `…_SALE_FINALIZATION` and `…_PRODUCT_SEARCH` **on**, and
`…_VOUCHER_TENDER` **off** (RT-10 D2, RT-103). Main reads them from `process.env` and loads no `.env`
file (C: no dotenv loader in `src/main`). This audit did **not** verify whether a packaged build takes
them from the terminal's OS environment at runtime or has them fixed at build time (**N**). The
answer decides whether the check is per terminal or per build artifact, and it belongs in the pilot
runbook.

---

## 10. Must NOT be simplified (deliverable 6)

These protect money, offline durability or security. A "simplification" that removes them is a
regression.

1. Finalize as **one transaction** with the idempotency re-check **inside** it; printing outside it.
2. The **enqueue/drain split** (`sync-outbox/` inside the finalize tx; `sales-sync/` outside it). 021
   already rejected merging them (T060).
3. **Typed transport result unions**: `no_connection` / `authority_unreachable` must never become a
   business refusal.
4. Payment-attempt and tender-line **FSMs**, the **action outboxes** used as local idempotency ledgers
   (`cart_action_outbox`, `payment_action_outbox`; no network drain), and #472's live-tender rules.
5. **Append-only triggers** on `sales`, the outboxes and audit tables; **integer minor units** with
   `Number.isSafeInteger` guards.
6. The **credential split**: device token / operator envelope / operator JWT.
7. **Local PIN hashing and lockout**; unlock single-flight and rate limit (RT-117 M1).
8. **Root-level IPC guards**: sender origin plus locked-session allowlist (refuse-by-default for future
   channels).
9. The **renderer trust boundary** and the explicit preload allowlist.
10. **Stage-and-promote** read-down and its single atomic promote.
11. **Fail-closed** `safeStorage` and fail-closed flag defaults (S-A validates combinations; it does
    not flip defaults).
12. RT-117's rule: **the stuck-attempt sweep never auto-reverses live tender**.

---

## 11. Pilot-critical vs post-pilot (deliverable 7)

| Pilot-critical (resolve or consciously accept before real cashiers) | Post-pilot |
|---|---|
| P-1 / S-A: flag coherence + **ops check now** (D-1 decision) | S-C per-domain wiring modules |
| P-2 / S-B: audit upload decision | S-E single IPC declaration |
| P-3: inactivity timer in the registry (fold into the next RT-116 slice touching inactivity) | S-F unwired-code and `api-types` cleanup |
| (owned elsewhere, cited) RT-159 F-01…F-03, F-07…F-15; RT-116 S3–S7 | S-G shared session-gate core |
| Optional enabler: S-D fake-bridge factory (lowers the cost of every pilot slice) | `current.md` drift fixes (§14) — docs, any time |

---

## 12. Proposed bounded Jira slices (deliverable 8) — proposals only, none created

Created only where the evidence justifies it, and none duplicates RT-159 / RT-116 ownership.

| Proposal | Work Mode | Repo | Scope | Depends on |
|---|---|---|---|---|
| **RT-160-A** Cashier profile coherence (S-A) | Implementation | POS | Extract config parsing to an importable module; startup combination validation; D-1 outcome (refuse or visible manual-receipt mode); runbook update | Owner **D-1**; if (b), authorise the `app:config` shape change |
| **RT-160-B** Pilot audit evidence path (S-B) | Planning | POS + Backend-Core | Confirm whether a Backend-Core audit ingestion contract exists and whether pilot needs upload; output: decision + (if yes) contract-first implementation slice | Backend-Core owner |
| **RT-160-C** Shared typed fake bridge (S-D) | Implementation (test-only) | POS | Test helper + migrate the operator fakes; no production code | — |
| **RT-160-D** Composition-root wiring extraction (S-C) | Implementation | POS | Per-domain wiring modules, registry ownership of every timer, guard repointing; zero behaviour change | RT-160-A merged; post-pilot |

P-3 is **not** a new issue: it is noted for the next RT-116 slice that touches `InactivityMonitor`. S-E,
S-F and S-G stay in this document until post-pilot planning picks them up.

---

## 13. Platform recommendation (deliverable 9)

**Keep Electron and simplify internally. Defer the platform discussion.** No framework decision is
made from preference.

- Electron/composition boundary files carried **5–37 %** of production lines in the measured changes
  (§5.1). The highest share (#469) is a brand-new channel, which any isolated-renderer architecture
  (Tauri commands, a .NET host bridge, a local web server) also requires in some form.
- The recurring costs (root wiring, flag plumbing, duplicated bridge types, hand-built fakes) are
  **self-created** and would be carried into any new platform unchanged.
- The essential costs (money FSMs, idempotency, durability, lock safety and their tests) are
  platform-independent.
- The real platform-specific cost is **periodic**: native module rebuilds per Electron major
  (RT-65 / RT-108 / RT-109). That calls for a maintenance cadence, not a migration.

**What would reopen the question (evidence triggers, not preferences):** a hardware integration
Electron cannot reach reliably (e.g. the deferred ESC/POS / DK1 drawer path); measured main-thread
contention that a utility process cannot solve; or packaged-build or installer constraints the pilot
cannot meet. None is evidenced today.

---

## 14. `current.md` drift found (recorded, not fixed here)

| `docs/architecture/current.md` says | `main@7384217` |
|---|---|
| §7: four flags (`cart`, `payments`, `saleFinalization`, `productSearch`) | Five; `voucherTender` added by RT-103 |
| §3: workers stop finalize → read-down → sale-sync | True, but the inactivity interval (RT-117) is outside the registry (P-3) |
| §2: trust-boundary enforcement lists the sender guard | Also the locked-session allowlist wrapper (`session-lock-guard.ts`) |
| No statement on main→renderer pushes | One push channel exists (`operator:session-state`) |
| (absent) | Principle from CS-2: main is the authority for any money or cart decision; the renderer only projects |
| (absent) | Audit capture is local-only; `AuditSync` is unwired (P-2) |

A docs-only follow-up can fix these once P-2 / P-3 are decided, so it does not record a state that is
about to change.

---

## Acceptance-criteria trace (RT-160)

| RT-160 acceptance criterion | Where |
|---|---|
| Current `main` verified, baseline SHA recorded | Baseline (`7384217`, fetched twice) |
| 021 checked against current code | §2 |
| Responsibilities mapped to the correct owner | §3.2, §7 |
| Essential / Electron / incidental separated with evidence | §4, §5 |
| ≥ 3 real change paths analysed end-to-end | §5: CS-1…CS-4 + control (six commits) |
| UI-perceived vs backend/runtime complexity separated | §8 |
| ERPNext semantics only where compatible with boundaries | §7 (with B6 non-goals) |
| Candidates bounded; no money/offline/security weakening | §9, §10 |
| Pilot-critical vs post-pilot separated | §11 |
| Implementation decomposed into separate Jira work; none performed | §12 (proposals, none created) |
| Exactly one next safe action | below |

## Next safe action

**The owner decides D-1** (§9), refuse vs visible manual-receipt mode for payments-on /
finalization-off. That is the only decision that unblocks the one pilot-critical slice this audit
proposes (RT-160-A).

(The no-code terminal flag check in §9 is a pilot-readiness item for the pilot runbook. It is not a
second next action of this audit.)
