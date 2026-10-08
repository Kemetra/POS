# 13 — POS simplification & responsibility audit (RT-160)

> **Status: Planning deliverable for RT-160, revision 3. Docs only.** No production code, refactor,
> dependency, DB, API or IPC change is made or authorised by this document. Every candidate below is a
> **proposal**. No follow-up Jira issue has been created (RT-160 checkpoint and owner comment 10721).
> **RT-24 remains the behaviour authority**; nothing here changes financial or recovery semantics.
>
> **Revision 2** applied the RT-160 **reference-first design rule** (§7) and closed the eight evidence
> gaps in the RT-160 execution checkpoint (§15). **Revision 3** records the owner's approved decisions
> **D-1, D-2 and D-3** (RT-160 comment 10721, 2026-10-03) in §9.3 and adjusts the candidates to match.
> No owner decision from this audit is pending. Revision 3 also applies the corrections from the
> owner's review (RT-160 comment 10724): shift/cash-up authority and its pilot classification
> (§3.2, §7.2 R-7, §11), the P-1 renderer wording (§1, §4), and the fake-bridge evidence (§4, §9.1).
> It also corrects the audit category count from a PR #511 review comment: POS defines **8** payment
> categories, including the manager `payment.force_failed`, which belongs in the central set (§1 P-2,
> §9.4). A further review comment moved routine `shift.open` / `shift.close` to local-only, because the
> synced shift record is the fact (§9.4).
>
> **Read these limits first**
>
> 1. **Static, git-history and reference evidence only.** This audit read code on POS
>    `main@7384217` and Backend-Core `main@7af7903`, measured git history, and read the reference
>    sources in §7. It ran **no** app, lab or packaged build. All runtime/UX evidence is cited from
>    RT-159 ([12](12-cashier-ux-usability-audit.md)), which ran *before* RT-117.
> 2. **The RT-117 → RT-160 "blocks" link is administratively stale** (owner reconciliation on RT-160,
>    2026-10-03). RT-117 S1 is merged as `7384217` (#509), and this audit uses that baseline.
> 3. **No duplicate ownership.** RT-159 F-01…F-06 and the RT-116 slices (S3–S7) already have owners.
>    RT-161 (lock-screen visual concealment) is separate and does not affect this audit. These are
>    cited as evidence and produce no new candidates here.
> 4. **Competitor references are not re-surveyed.** Shopify POS, Square, Toast and Daftra are cited
>    from RT-111 ([11](11-operational-workflow-benchmark.md) §1), as RT-160's non-goals require.
>    ERPNext/Frappe and Odoo were re-checked for this revision (§7).

## Baseline

| | |
|---|---|
| Repository / branch | `Kemetra/POS`, branch `worktree-rt-160-simplification-audit` (PR #511) |
| Verified POS `origin/main` | **Evidence baseline** `738421703ab92c34cc10693c82cccf47647ac3fd` — RT-117 S1 (#509), 2026-10-03; unchanged through revision 2. Before revision 3, `main` was at `5e23257` (RT-161 #512: lock-screen concealment; 4 renderer files — `SessionLockGate.tsx`, `tailwind.css` and 2 tests). That change touches none of this audit's findings or files, so the evidence baseline stays `7384217`. Re-checked before the comment-10724 corrections: `main` still `5e23257` |
| Verified Backend-Core `origin/main` | `7af79036ea72f5b72da179b0e32e5c4edcf21df8` (`git ls-remote` = local HEAD; read with `git grep` at that SHA). Used only for the audit-ingest and shift-route checks |
| Jira | RT-160, Work Mode **Planning**, parent Epic RT-106; relates to RT-159; RT-117 link stale (limit 2) |
| Inputs read | RT-160 text, reconciliation comment, owner-decision comment 10721 and review comment 10724; RT-17 links; `specs/015-shift-cash-management/spec.md`; `docs/architecture/current.md`, `synchronization.md`; `specs/021-pos-maintainability-rescue/*`; `specs/README.md`; VNext [11](11-operational-workflow-benchmark.md) (RT-111) and [12](12-cashier-ux-usability-audit.md) (RT-159); `specs/010-…/dev-report.md` §B5–B6; `docs/runbook/008-…md`, `sales-cart.md`; `src/**`; reference sources in §7 |
| Reference index | Confluence RETAIL → Technology & Reference Radar → **Retail / POS Reference Library** (page 18120705) |
| Date | 2026-10-03 |

## Evidence labels

| Label | Meaning |
|---|---|
| **C** | Read in source (POS `7384217` or Backend-Core `7af7903`), with file:line where useful. Not run. |
| **G** | Measured from git history (`git show --numstat`) on POS `main`. |
| **X** | Exhaustive reference search: a script read every `.ts/.tsx/.js/.mjs/.cjs` file under `src/`, `tests/` and `scripts/` and listed every static or dynamic import of a module and every mention of its exported names, split into production and test files. |
| **R** | Reference source (§7.1), read this session. Pattern evidence, not code to copy. |
| **D** | Taken from a cited Retail Tower document, not re-verified here. |
| **N** | Not done or not available. Said explicitly. |

Line and file counts are **supporting signals, not proof** (RT-160 §B). The conclusions rest on
*why* a change had to touch a file, not on how many it touched.

---

## 1. Executive summary

**Recommendation: keep Electron and simplify internally. Defer the platform discussion.** Electron's
cost is real but bounded. Across six measured changes, Electron/composition boundary files carried
**5–37 %** of the added production lines (§5). Most of the cost of a POS change comes from three other
places:

1. **Essential safety work.** Money, idempotency, lock and recovery rules, and the tests that prove
   them. Test lines ran **1.3–5.3×** production lines. That is the price of RT-24, and the mature
   references (§7) carry the same rules.
2. **A composition-root hotspot (incidental).** `src/main/index.ts` was touched by **6 of 10** recent
   changes, including changes with no Electron surface at all (RT-79, #472). The reasons are inline
   env/flag parsing (**5 copies** of the same truthy parse) and hand wiring of every repository
   function. 021 removed the root's mutable state, but its size has grown back: **1393 → 1339 → 1437**
   lines (pre-021 → post-021 → now).
3. **Authority in the wrong layer (incidental, mostly fixed).** #470 had to move three money
   decisions from the renderer to main after review. RT-159 F-03 (renderer recomputes change) is the
   same pattern still open in the UI.

**The reference check (§7) confirms the core design.** The parts of the POS that look most complex
are the parts the mature systems also have: idempotent client-to-server order sync, immutable
finalized documents, and session/register lifecycles. **No major POS responsibility needs a new
design from scratch.** Returns and shift/cash-up should adopt the ERPNext/Odoo semantics rather than
be invented. Returns go through a Backend-Core contract. Shift/cash-up keeps its offline lifecycle in
the POS (spec 015) and syncs an immutable record to Backend-Core; it is pilot-critical work (RT-17).

**Four findings matter more than any refactor.** They are hardening and cleanup items, not
simplification. The owner's decisions on P-1 and P-2 are recorded in §9.3:

| # | Finding | Evidence | Kind |
|---|---|---|---|
| **P-1** | **Cashier feature-flag coherence (D-1 decided: fail closed).** Five fail-closed flags are read from the POS process environment at runtime. **Verified (§15 gap 3):** main is compiled by `tsc` (not Vite), so `process.env` is not replaced at build time. The packaged app (`electron-builder.yml`: `target: dir`, `files`: `dist/**`, `package.json`, `node_modules/**`, `migrations/**`) contains no `.env` and no installer. Main loads no dotenv. Dev passes the parent shell's env through (`scripts/dev-electron.cjs:94`). With **payments on and sale finalization off**, payments still settle, but no Sale row, receipt, outbox entry or backend capture is written (`index.ts:1054-1065`). The tender facts stay only in local `payment_attempts` and tender tables. This is the **documented rollback** (`docs/runbook/008-…md:250`), not a bug. The renderer does know the mode: `PaymentSurface` reads `saleFinalization` (`PaymentSurface.tsx:142`), and **after settlement** the completion screen truthfully says «لن يُسجَّل هذا البيع ولا يوجد إيصال له» ("this sale will not be recorded and has no receipt", `:500-503`). **The gap is earlier:** nothing validates the flag profile at startup, and nothing prevents or warns about the mode **before tender**, so the cashier learns it only after the money is taken. **The only artefacts that set the flags are for lab and dev use:** the rt9 lab launcher (`D:\rt9-lab\start-pos.ps1:11-15`, an unpackaged `NODE_ENV=development` run from source) and the Orchestrator smoke runbook (`docs/runbooks/pos-windows-smoke.md`). **Nothing defines how a packaged pilot terminal gets them.** | C | Hardening (D-1 = fail closed) |
| **P-2** | **Audit evidence does not leave the terminal, and wiring alone would not fix it.** **Verified (§15 gap 4):** Backend-Core `main@7af7903` *has* the receiver: contract `packages/contracts/openapi/pos-audit-events.openapi.yaml` and `PosAuditEventsController` at `api/pos/v1/audit-events` (`apps/api/src/pos-audit-events/pos-audit-events.controller.ts:50`), authenticated by a body `device_token_attestation`. POS has **no HTTP implementation** of `AuditSyncClient`, and `AuditSync` has **zero production referrers** (X). The contract's category catalogue is closed: Backend-Core accepts **6** categories (`dto.ts:17-24`: `shift.open/close/forced_close`, `operator.session.takeover`, `cashier.pin.reset/unlock`). POS emits **23** core categories (`src/shared/audit/event-shape.ts:21`) plus **8** payment categories (`PAYMENT_AUDIT_CATEGORIES`, `src/shared/payments/types.ts:109-118`, incl. the manager force-fail `payment.force_failed`). The service enforces that closed set (`pos-audit-events.service.ts:104-107`), so the other **25** (lock/unlock, cart, sale, receipt, drawer, payment, tender) would be rejected as `schema_violation`. `AuditSync` leaves rejected events in the outbox, so they would be retried forever. | C (both repos), X | Cross-repo contract gap (D-2 sets the scope: privileged, security and exception actions only) |
| **P-3** | **RT-117's inactivity timer escapes the documented shutdown order.** `InactivityMonitor.start()` (`index.ts:582`) is never stopped and is not in `workerRegistry`. A lock tick writes `audit_events` (`wireSessionLockAudit`). `current.md` §3 says every background worker must stop before the DB closes. Probability is very low (needs a 10-minute idle lock in the quit window). | C | Hardening (fold into the next RT-116 slice) |
| **P-4** | **Code and a runbook describe behaviour that does not run.** **Verified (§15 gap 5, X):** `session-end-handler.ts` (`registerSessionEndCartDiscardSubscriber`, `discardDraftCartForSessionEnd`) has **0 production referrers**. `LifecycleCascade` is constructed at `index.ts:591` and `void`ed at `:596`; its `notifyTerminalRevoked` / `notifyAccountDisabled` are named only in comments, with no call site. **`docs/runbook/sales-cart.md:87-95, 207-211` states that draft carts are discarded and audited (`cart.discarded_on_session_end`) at session end; that never happens.** This is consistent with RT-159 F-06 (carts survive restart). Also: `api-types.ts` (~24k lines, 281 paths, 4 importers) carries legacy Data-Pulse return/shift schemas (`ReturnRequest`, `ActiveShiftResponse`, float `_egp` amounts) that are **not** Backend-Core POS contracts. | X, C | Cleanup (runbook drift is truthfulness) |

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
- Outbound legs that run today: catalogue read-down and sale capture-up. **Audit upload does not run**
  (P-2). (C, X)

### 3.2 Responsibility map

"State authority" is the place whose value wins when two disagree. The owner class follows the
reference review in §7.

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
| Returns / refunds | `ReturnsPlaceholder.tsx` only; spec 014 **Deferred** | none | **Backend-Core authority** (refundable quantity per original line) + **ERPNext/Odoo semantic reference** (§7.2 R-6) |
| Shift / cash-up | `shifts` table (no drawer math), forced-close, stuck-shift discovery. Spec 015 (indexed Deferred; pilot work via RT-17) requires the terminal to create, persist and finalize the shift locally and compute expected cash, count and variance fully offline, with Backend-Core sync queued asynchronously; sync failure must not block the local close (FR-3–FR-7, NFR-2). Backend-Core serves only `GET api/pos/v1/shifts/stuck` (`pos-shifts.controller.ts:18-22`, C) | **POS local durable store** for the offline lifecycle (open/close state, expected cash, physical count, variance, local finalization); today only partial | **Keep local** the offline shift lifecycle and its facts + **Backend-Core** server contract/orchestration, receipt of the immutable synced record, and the cross-terminal view + **ERPNext/Odoo semantic reference** (§7.2 R-7). **Pilot-critical** (RT-17) |
| Printer / cash drawer | `main/receipts/*`, `main/drawer/*` | local `print_events`, `drawer_events` | **Keep local** |
| Catalogue | read-down stage-and-promote into SQLite; offline lookup | **Backend-Core** resolved store catalogue | **Backend-Core** authority, local read model |
| Audit | 3 emitters (`audit/`, `payments/`, `sales/`) → `audit_events`; upload **not wired** and **not contract-compatible** (P-2) | local only | **Keep local** (capture of everything) + **Backend-Core** (receives **privileged, security and exception** categories only, per D-2; catalogue aligned first) |
| Terminal config (flags) | per-terminal process environment read in `index.ts` | the launching environment | **Candidate incidental** (P-1); the money combination fails closed (D-1); reference analogue is a server-side register profile (§7.2 R-9) |

---

## 4. Essential vs Electron-tax vs Incidental matrix (deliverable 2)

| Area | Essential (keep) | Electron / platform tax | Incidental (self-created) |
|---|---|---|---|
| **Money / payments** | 2 FSMs, idempotency helper, action outbox, live-tender rules (#472), integer minor units | — | Renderer recomputes change after apply (F-03); renderer was de facto authority for handed-off-cart decisions until #470 |
| **Sale durability / sync** | Single finalize tx with idempotency re-check; enqueue/drain split; typed transport unions; dead-letter | — | Flag combination can disable finalization while payments settle, with no startup profile check and no pre-tender prevention or warning; the cashier is told only after settlement (P-1) |
| **Session / lock** | Lock state, unlock rate-limit, locked allowlist, credential split (device token / envelope / JWT) | Push channel + preload wiring for lock state; allowlist must wrap `ipcMain` | Inactivity timer outside worker registry (P-3); `LifecycleCascade` constructed and `void`ed (P-4) |
| **IPC surface** | Sender-origin guard; explicit preload allowlist; boundary id bounds | One operation spans channel const → `bridge-api.ts` type → preload entry → `ipc/<d>.ts` → handler (≈5 files) | Types declared twice: `shared/<d>/bridge-types.ts` and namespace interface in `bridge-api.ts` (1386 lines); `ipc/` vs `<d>/*-bridge.ts` vs `wire-*-handlers.ts` naming is uneven across domains |
| **Composition root** | Ordered start/stop, fail-closed `safeStorage`, migrations halt launch | `index.ts` runs `app.whenReady()` at import, so it cannot be unit-imported → a 25-assertion source-text guard | Env parsing ×5 copies; feature wiring inline (114 imports, 17 `bind*` calls); main-only changes still edit it (§5) |
| **Testability** | Characterization and money tests | Import-time Electron side effects; renderer tests must fake `window.api` | Multiple renderer tests hand-build their own bridge fakes, and there is no shared typed fake factory. RT-117 had to edit **7 unrelated renderer tests** (+11 lines each, G) just to add 3 operator methods. For scale: `grep -rlE '\bOperatorBridgeAPI\b' src tests --include='*.test.ts' --include='*.test.tsx'` lists **15** test files that reference the operator bridge type |
| **Contracts** | Pinned codegen (Constitution V) | — | 24k-line `api-types.ts` (281 paths, 4 importers) with legacy non-POS schemas; `CaptureSaleRequest` hand-vendored separately in `create-sale-sync-client.ts`; audit category catalogue diverged across repos (P-2) |
| **Native / runtime** | `better-sqlite3` on the main thread; ~3.6 s atomic read-down promote accepted for v1 (D: CLAUDE.md 010 T054) | Native module rebuild per Electron major (RT-65/RT-108/RT-109 cost) | — |
| **Config** | Fail-closed defaults | — | Five independent env flags → 32 combinations, with no validated "cashier profile" and no defined provisioning (P-1) |

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
lock-state reader, the "never auto-reverse live tender" sweep rule and the audit categories. The
Electron share is the push channel, preload and bridge types, and the allowlist wrapper. The
allowlist wrapper is really security semantics placed at the right choke point: it refuses future
channels by default. The incidental cost is concentrated: `index.ts` +70 lines; 7 unrelated renderer
tests edited only to add `unlockSession` / `getLockState` / `onSessionStateChanged` to hand-built
fakes; and the timer left outside the registry (P-3). It also added two audit categories that
Backend-Core would reject (P-2). **State authorities involved: 4.** Main lock state is the authority;
the renderer gate is a projection; the activity reporter is a signal; the payments sweep rule is
separate. The design is right: main decides and the renderer projects.

**CS-2 — handed-off cart (#469 then #470).** Adding one manager operation cost a new channel across
five boundary files (37 % of lines). That part is Electron tax. The follow-up (#470) cost almost three
times as many lines, mostly tests (1111), because review found **the renderer was the only place
enforcing** "cart is handed off", "envelope matches" and "not already paid" before `payments.start`.
That cost was self-created: authority was decided in the UI first. **Lesson: decide the main-process
authority before the UI flow exists.** `docs/architecture/current.md` should say so (§14).

**CS-3 — RT-103 voucher flag.** A UI-only rule needed a main edit, because flags are parsed inline in
the root. That edit was the fifth copy-paste of the same truthy parse, even though an `isTruthy`
helper already exists in `dev-seed-catalogue.ts:239`. It also added one more dimension to the flag
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
| C-3 | Preload is a mechanical pass-through: about 69 `ipcRenderer.invoke` lines across 7 files, each typed by a `bridge-api.ts` interface that re-imports `shared/<d>/bridge-types.ts` | C | Partly required: the preload **must** stay an explicit allowlist. The duplication is incidental (§9 S-3) |
| C-4 | IPC guarding is done once at the root: sender origin, then the locked allowlist | C | **Good. Keep.** Do not move guards back into handlers |
| C-5 | Session/role gate lives in each domain bridge (`cart/require-operator-session.ts` 68 lines, `payments/require-operator-session.ts` 115 lines) | C | **Not duplicates.** Payments adds attempt-ownership and terminal-state refusals. A shared *core* (no session / role / tenant isolation) is a candidate; the semantics differ and must stay |
| C-6 | Cross-layer state is mostly pull/poll; one push channel (lock). `*.subscribe` names are polls | C | Fine for a single-window terminal. Naming is misleading; document it rather than rename IPC |
| C-7 | One SQLite handle on the main thread; workers are timers on the same thread | C, D | Essential for durability. Read-down promote blocks ~3.6 s (accepted v1). Moving DB work to a utility process is **not** justified by this evidence |
| C-8 | Inactivity interval outside the worker registry (P-3); `LifecycleCascade` dead wiring (P-4) | C, X | Hardening / cleanup. Small fixes |
| C-9 | Native module coupling: Electron majors force `better-sqlite3` rebuilds (RT-65 / RT-108 / RT-109 chain) | G | Electron tax. Periodic, not per-feature |
| C-10 | Runtime configuration is read from `process.env` at startup, with no config module and no provisioning artefact (P-1) | C | Incidental. One importable config module would make the cashier profile testable |

**Security boundary preserved by every proposal here:** `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`; the renderer has no Node, DB, secrets or network; the
preload stays an explicit per-channel allowlist (never a generic `invoke(channel, …)` pass-through).

---

## 7. Reference-first review (RT-160 §D and the reference-first design rule)

### 7.1 Sources read

| Ref | Source | Used for | Label |
|---|---|---|---|
| ERPNext / Frappe | Retail / POS Reference Library pack (Orchestrator `docs/reference/erpnext/24 Point of Sale System.md`, `16 Transaction Processing.md`, `22 Status Updates and Document Linking.md`; summary pack `04 Transaction Processing`, `11 Localization`, `12 Technical Architecture`). The pack is a **DeepWiki-derived extract**, not official ERPNext documentation; it cites `frappe/erpnext@a9029f83` source lines. Cross-checked against the bench-verified DocType scout (`specs/010-…/dev-report.md` §B5, ERPNext 15.110.0) | Sale lifecycle, POS Invoice, opening/closing, consolidation, returns, extension hooks | R, D |
| Odoo POS | Official docs (`odoo.com/documentation/18.0/applications/sales/point_of_sale.html`); open source `odoo/odoo@18.0` `addons/point_of_sale/models/pos_session.py` and `pos_order.py`. **Read through a fetched-page summary**, not line by line; the field and method names quoted in §7.2 come from that summary. Version note: this uses **Odoo 18.0**, while RT-111 benchmarked Odoo 19 | Session states and cash control, per-session posting, idempotent order sync, refunds, change lines | R (summary) |
| Shopify POS, Square, Toast, Daftra (+ Odoo/ERPNext operational rows) | RT-111 ([11](11-operational-workflow-benchmark.md) §1.1–1.5), not re-surveyed | Offline states, approvals, register/cash, returns, devices, recovery | D |

**N:** the Odoo refund documentation page returned 404, so refund semantics come from `pos_order.py`.
Daftra and the proprietary systems are cited only from RT-111.

### 7.2 Per-responsibility reference findings

Decision vocabulary: **Reuse** semantics/contracts · **Adapt** through Backend-Core/Connector ·
**Keep local** in POS · **Reject** as incompatible. Nothing here copies code or UI.

| # | Responsibility | What the mature references do | Proven pattern / semantic | Retail Tower decision | Smallest justified implementation |
|---|---|---|---|---|---|
| **R-1** | Sign-in / lock / takeover | Per-staff PIN; approver enters a PIN on the same device; one session per device (SH, SQ, TO via RT-111 §1.3–1.4). Odoo: employee login by badge/PIN | Same-device PIN identity; lock keeps the session; approval is a recorded second identity | **Keep local** (already matches: RT-117 same-operator unlock). In-sale approval stays with VN-S7 / RT-28 / MD-2 | None new. RT-116 S3–S7 and MD-2 own the gaps |
| **R-2** | Active sale / cart | ERPNext `ItemCart` + Controller own the draft `POS Invoice` (docstatus 0, editable). Odoo order `state = draft`. SQ "open tickets" / DF hold-resume park carts | A draft is editable, durable and resumable; it becomes immutable only at submission | **Keep local** (cart FSM `editing → frozen_handed_off`). Held-cart resume = RT-116 S4 | None new (RT-116 S4) |
| **R-3** | Checkout and tenders | ERPNext: `payments` table of `Sales Invoice Payment` rows (split tender = several rows), `change_amount` calculated separately. Odoo: `pos.payment` lines with an `is_change` flag for change returned | **Change is its own fact**, not netted into the cash line | **Keep local** (FSMs). **D-3 decided: keep the NET capture contract** (RT-79: cash = applied − change). Both references keep change separate, but that alone does not justify a cross-repo migration (§9.3). POS keeps gross and change locally (`payment_tender_lines`) for receipt and recovery evidence | None. Reopen only on a concrete RT-17 cash-up, reconciliation, fiscal or reporting need |
| **R-4** | Finalization / receipt | ERPNext: submit (docstatus 1) makes the invoice immutable and posts ledgers; cancel (docstatus 2) creates reversing entries. Odoo: order `draft → paid → done (Posted)` | **Finalized = immutable**; corrections are new documents, never edits | **Keep local** (already matches: append-only `sales`, finalize in one tx). **Reject** an on-terminal "cancel a finalized sale" | None new |
| **R-5** | Offline persistence, outbox, exactly-once sync | Odoo: client orders sync through `sync_from_ui` → `_process_order`, deduplicated by a client `uuid` with a `unique (uuid)` constraint. SH/SQ/TO: queued states, and "don't sign out/reset while pending" (RT-111 §1.2). ERPNext v15 core has no native offline | **Client-generated id + server unique constraint** = idempotent sync; a visible pending count | **Keep local** queue + **Backend-Core** dedupe (already matches: `externalId` + `duplicate` result). Gap: the pending count is invisible (RT-159 F-15) → VN-S6 | None new (VN-S6). POS durability (SQLite outbox) is *stronger* than browser-storage references |
| **R-6** | Returns / refunds | ERPNext: return = new document with `is_return` + `return_against`, negative quantities; merged into Credit Notes at closing. Odoo: `_refund()` creates a **new negative order** linked by `refunded_order_id` / `refunded_orderline_id`, tracking `refunded_qty` per original line. SH: refund capped per original method; no-receipt returns under a separate permission | **A return is a new document referencing the original line, with refunded quantity tracked to prevent over-refund** | **Reuse** these semantics in the spec 014 contract; **Backend-Core authority** for refundable quantity (it needs every terminal's history). POS captures a return *fact* through the outbox. **Reject** mutating the original sale | Contract-first Planning item when 014 is scheduled. Not pilot scope (RT-10) |
| **R-7** | Shift / cash-up | ERPNext: mandatory `POS Opening Entry` (opening balance per mode of payment) and `POS Closing Entry` (per-mode opening / expected / closing / difference). Odoo: session `opening_control → opened → closing_control → closed`, with `cash_register_balance_start`, `…_end_real` (counted), `…_end` (theoretical) and `cash_register_difference`. TO: blind count permission. DF: balance to employee custody or treasury | **Per-tender-mode expected vs counted, with a recorded difference**, on a session state machine | **Reuse** the semantics. **Keep local** the offline shift lifecycle: open/close state, expected cash, physical count, variance and local finalization live in the POS durable store, and the close never waits on the network (spec 015 FR-3–FR-7, NFR-2). **Backend-Core** owns the server contract and orchestration, receives the immutable synced shift record, and gives the cross-terminal view (today only `GET shifts/stuck` exists). Blind count and variance approval = RT-17 decisions | **Pilot-critical** (RT-17, which blocks RT-20). Contract-first: blocked on the missing Backend-Core shift-lifecycle contract for the sync leg; the local lifecycle follows spec 015 |
| **R-8** | Accounting posting / consolidation | ERPNext: `POS Invoice Merge Log` consolidates into Sales Invoices / Credit Notes at closing. Odoo: one `account.move` **per session** (`_create_account_move`) | Posting is batched server-side; the till only records facts | **Adapt** through Backend-Core → Connector (already the architecture). **Reject** on-terminal posting or consolidation (dev-report B6.3–B6.4) | None |
| **R-9** | Terminal configuration | ERPNext `POS Profile` (payment methods, item groups, stock behaviour, allowed users). Odoo `pos.config` per register. Both are server-side records | **Register configuration lives on the server and is versioned** | Pilot: **keep local** but make it a validated profile (P-1). Post-pilot: **adapt** a Backend-Core terminal profile (new contract; dev-report B6.7 rejects ERPNext POS Profile as the authority) | Pilot: config module + coherence check that **fails closed** on the money combination (D-1). Post-pilot: Planning item |
| **R-10** | Inventory / item identity | ERPNext POS checks stock against `Bin` and optionally hides unavailable items | Stock is a server concern | **Reject** on-terminal stock authority (ADR-0001, B6.5/B6.8). Read-only availability is spec 013, Deferred | None |
| **R-11** | Tax / fiscal | ERPNext `regional_overrides` + `allow_regional` route country rules without forking core | Country rules are extension points, server-side | **Adapt** via the Connector's fiscal extension points (VAT deferred, 012). **Reject** a tax engine on the terminal | None (012) |
| **R-12** | Audit of sensitive actions | SH activity log incl. the approving manager, kept 1 year; TO void/discount/No-Sale reports by approver (RT-111 §1.3) | **Audit is reviewable off the till** | **Keep local** capture + **Backend-Core** receiver. Receiver exists but its category catalogue covers 6 of 31 POS categories (P-2). **D-2:** centralize only privileged, security and exception actions; sale and payment facts stay authoritative in their own records | Catalogue alignment first, then a scoped POS sender (FU-3, §9.4) |
| **R-13** | Hardware / devices | SH/SQ "Test Cash Drawer / Test Printer"; SH connectivity icon distinguishes hardware-disconnected from offline (RT-111 §1.5) | A device-health surface separate from network health | **Keep local** (RT-111 §6 target surface) | None new (RT-111 §6) |

**Result for the reference-first rule:** every major responsibility maps to a proven pattern. No new
major POS design is proposed from scratch. The two responsibilities without a Retail Tower design yet
both **reuse** the ERPNext/Odoo semantics above. Returns (R-6) are a contract-first Backend-Core item
and post-pilot. Shift/cash-up (R-7) is **pilot-critical** (RT-17): the POS owns the offline lifecycle,
and the Backend-Core sync contract comes first for the server leg.

---

## 8. Is the UI making the system feel more complex than it is? (RT-160 §E)

Target cashier model: **Scan/Search → Cart → Pay → Receipt**, with recovery states only when needed.
RT-159 findings (R-dev, pre-RT-117) sorted by cause:

| Cashier-visible complexity | RT-159 | Cause | Where to fix |
|---|---|---|---|
| Scanner input lands in whatever control has focus; focus returns to search, not scan | F-01, F-02 (UI side), F-07, F-08 | Presentation / focus model | UI (RT-159 pilot slices) |
| Payment commit has no affordance; amount due off-screen | F-09, F-10 | Presentation | VN-S4 |
| Wrong change after apply | F-03 | **Architecture: renderer recomputes money** instead of displaying main's stored `change_due_minor` | UI fix already proposed by RT-159. Principle for all VNext slices: *the renderer displays main's money facts after an apply and never recomputes them* |
| Restart shows an empty cart | F-06 | **Architecture: active cart id held in renderer memory**; the documented session-end discard never runs (P-4) | RT-116 S4 (owned) |
| Absurd tender accepted by main | F-02 (main side) | Contract: main checks only safe-integer and ≥ 0 (`tender-apply.ts:86`) | Decision already raised by RT-159; not duplicated |
| No connection / queue signal | F-15 | Missing aggregate signal (sale-sync status exists as `sales:syncStatus` but is not mounted). References show a pending count (R-5) | VN-S6; needs a real signal |
| Placeholder / "Coming soon" surfaces | F-25 | **Flag matrix + legacy shell** | OD-6 / VN-S10; P-1 reduces the matrix |

**Complexity that must stay hidden:** attempt and tender FSMs, idempotency keys, the outboxes,
read-down promotion, the credential split, and the lock allowlist. None of this needs a cashier-visible
step, and none of RT-159's findings is caused by it being *exposed*. The exception is the lock screen,
which is a deliberate RT-24 state.

**Conclusion:** the cashier journey is long because of focus and step design (RT-159 / VNext scope),
not because the architecture leaks. Two leaks exist (F-03, F-06), and both have owners.

---

## 9. Candidates (deliverable 5), split by kind

RT-160 checkpoint item 7 asks to separate findings that justify **simplification** from findings that
only need **cleanup or hardening**. The test used: *does it reduce the cost of future changes
(simplification), or does it make current behaviour safer or more truthful (hardening / cleanup)?*

### 9.1 Simplification candidates (reduce change cost)

| ID | Candidate | Benefit | Risk | Prerequisites | Affected contracts | Pilot |
|---|---|---|---|---|---|---|
| **S-1** | **Config module.** Move all env/flag parsing out of `index.ts` into one importable module with one truthy parser (the existing semantics) | Ends root edits per new flag (CS-3, CS-4a); makes config unit-testable; prerequisite for H-1 | Low; must keep fail-closed defaults byte-for-byte | Characterization tests of current parsing | None | Pilot-adjacent (needed by H-1) |
| **S-2** | **Shared typed fake-bridge factory (test-only).** One `createFakeApi(overrides)` typed from `bridge-api.ts` | A new bridge method edits one helper instead of many hand-built fakes (RT-117 had to touch 7 unrelated renderer tests) | Over-permissive fakes can hide missing stubs | — | None | Optional pre-pilot enabler |
| **S-3** | **Single declaration per IPC namespace.** Channel name, request type and response type declared once; preload and `bridge-api` derive from it but stay an **explicit enumerated allowlist** | New operation goes from ~5 files to ~3 | Must not become a generic pass-through (security regression); channel names must stay byte-identical | S-2; §A4-style review | All bridge types (shape-preserving) | Post-pilot |
| **S-4** | **Per-domain wiring modules.** `wireOperator`, `wireCart`, `wirePayments`, `wireSales`, `wireCatalogue`, `wireSync` extracted from `index.ts`, each returning its stoppers to `workerRegistry` | Main-only changes stop touching the root; wiring becomes runtime-testable; absorbs H-3 permanently | Static-guard churn (021 lesson); startup-order bugs | S-1; characterization tests per module; guards repointed, not deleted | None (internal) | Post-pilot |
| **S-5** | **Shared session-gate core** for cart and payments (no-session / role / tenant isolation); domain extras stay | One place for the isolation order | Security semantics differ (C-5); refusal reasons are closed sets per domain | Equivalence tests first | Refusal reason sets (unchanged) | Post-pilot, low priority |

### 9.2 Hardening and cleanup items (safety and truthfulness, not simplification)

| ID | Item | Why | Owner / route | Pilot |
|---|---|---|---|---|
| **H-1** | **Fail-closed cashier profile (D-1).** At startup, treat `PAYMENTS` on with `SALE_FINALIZATION` off as an **invalid** pilot cashier profile: main refuses cashier operation, and the renderer only shows the refusal. Retire the "payments continue + manual receipts" rollback for real-money pilot use, and rewrite `docs/runbook/008-…md:250` so a contingency rollback also disables payment-taking (or uses a separately documented manual store procedure outside the POS financial flow) | P-1: payments can settle with no Sale, receipt, outbox entry or capture | FU-1 (not created) | **Pilot-critical** |
| **H-2** | **Pilot terminal provisioning.** Define how a packaged terminal gets its environment (installer, shortcut, machine env) and add a per-terminal readiness check: CART, PAYMENTS, SALE_FINALIZATION, PRODUCT_SEARCH on; VOUCHER_TENDER off. The checklist states the D-1 rule: PAYMENTS never on without SALE_FINALIZATION | P-1: the variables are runtime inputs; only the lab launcher and smoke runbook set them, and nothing covers a packaged install | Pilot runbook (ops), no code | **Pilot-critical** (ops) |
| **H-3** | **Inactivity timer into the worker registry** | P-3: violates the documented shutdown invariant | Next RT-116 slice touching `InactivityMonitor`; no new issue | Pilot-optional |
| **H-4** | **Privileged audit path (D-2).** Central audit covers only privileged, security and exception actions not already represented by an authoritative sale or payment record (§9.4). **Order:** align the Backend-Core category catalogue first (contract revision); then add a POS HTTP client and a sender that sends **only** supported central categories; a `schema_violation` rejection is terminal (dead-lettered and logged), never retried forever. Routine lock/unlock and sale/payment facts stay local | P-2: receiver exists; POS client and contract alignment do not | FU-3 (not created), contract-first, Backend-Core first | **Pilot-critical** |
| **C-1** | **Runbook truth.** Correct `docs/runbook/sales-cart.md` session-end discard section, or wire the subscriber, after RT-116 S4 decides held-cart behaviour | P-4: the runbook describes behaviour that never runs | RT-116 S4 outcome; docs-only fix | Pilot-relevant (operators read runbooks) |
| **C-2** | **Retire or record unwired code** (`LifecycleCascade`; `session-end-handler.ts` depending on C-1); retire or properly gate the `shift.open` smoke handler, whose `NODE_ENV === 'production'` guard a packaged build probably never triggers (§9.4) | P-4: code implies behaviour that does not run | Post-pilot cleanup | Post-pilot |
| **C-3** | **Trim `api-types.ts`** to consumed POS paths; bring the hand-vendored `CaptureSaleRequest` under codegen | P-4: ~24k lines of misleading types | Generated-code + codegen change needs explicit authorisation (CLAUDE.md §10) | Post-pilot |
| **C-4** | **`current.md` drift** (§14) | Canonical doc out of date | Docs-only, after FU-1 / FU-3 change behaviour | Any time |

### 9.3 Owner decisions (approved 2026-10-03, RT-160 comment 10721)

No owner decision from this audit is pending. The decisions below are the owner's, quoted in
substance. Where the owner cited facts this audit did not read itself, they are labelled **D**.

| ID | Decision | What it means for this audit |
|---|---|---|
| **D-1** | **(a) Fail closed.** For the pilot cashier profile, `PAYMENTS` on with `SALE_FINALIZATION` off is **invalid**. The POS must refuse cashier operation rather than settle money without a Sale row, receipt, sync outbox entry or Backend-Core capture. The "payments continue + manual receipt" rollback is **retired for real-money pilot use**. A contingency rollback must also disable POS payment-taking, or use a separately documented external/manual store procedure outside the POS financial flow | H-1 becomes a fail-closed check; runbook 008's rollback row must be rewritten (FU-1). Other flag combinations (e.g. product search without cart) are UX coherence, not money; D-1 does not decide them |
| **D-2** | **Central audit only for privileged, security and exception actions**, not as duplicate business telemetry. Pilot-critical central audit covers actions not already represented by an authoritative sale/payment record: takeover, PIN reset/unlock, manager approval/recovery, forced shift actions, no-sale/privileged drawer actions, and similar overrides. Ordinary sale/payment facts stay authoritative in sales/tender records. Routine auto-lock and same-cashier unlock are not centralized unless a later security requirement says so. **Align the Backend-Core category catalogue first, then wire a POS sender. Never send unsupported categories into an infinite retry loop** | H-4 is scoped to §9.4's central set; FU-3 is contract-first with Backend-Core first |
| **D-3** | **Keep the current NET tender capture contract for now.** Per the owner: Backend-Core defines `SaleTender.amount` as net of change, and ERPNext-Connector requires tender totals to equal the invoice total and posts payment amounts verbatim with zero change residual (**D**, not re-read by this audit). ERPNext/Odoo gross + change is a useful reference but does not by itself justify a cross-repo contract migration. POS may keep gross/change locally for receipt and recovery evidence (it already does: `payment_tender_lines.amount_applied_minor` / `change_due_minor`, migration `0014`). **Reopen** only if RT-17 cash-up, reconciliation, fiscal or reporting requirements produce a concrete need that net tender facts cannot meet | No follow-up. R-3 records the decision and the reopen trigger |

### 9.4 D-2 applied: which POS audit categories go central (proposal for FU-3 to confirm)

This applies the D-2 rule to the 31 categories POS defines today (23 in `event-shape.ts:21-52`, 8 in
`PAYMENT_AUDIT_CATEGORIES`, `src/shared/payments/types.ts:109-118`). It is a **planning proposal**; FU-3 confirms the final catalogue with
Backend-Core. "Accepted today" = in Backend-Core's 6-category set (`dto.ts:17-24`).

| Group | Categories | Accepted today | Proposed treatment |
|---|---|---|---|
| **Central — already accepted** | `operator.session.takeover`, `cashier.pin.reset`, `cashier.pin.unlock`, `shift.forced_close` | Yes (4 of the 6) | Send |
| **Central — catalogue must add** | `cashier.pin.provisioned` (credential event), `cart.cancel.post_handoff` (manager authority), `cart.discount.above_threshold` (override), `sale.receipt.manual_override` (override), `payment.force_failed` (manager recovery; emitted with manager/cashier attribution by `payments-force-fail.ts:139-164`) | No | Send after the catalogue revision |
| **Owner to confirm in FU-3** | `sale.receipt.reprinted` (reprint as a privileged action); `tender.reversed`, `tender.reversal_pending` (a reversed tender on an attempt that never finalizes leaves no central record) | No | Decide per D-2's "not already represented by an authoritative record" test |
| **Local only — routine (D-2)** | `operator.session.locked`, `operator.session.unlocked` | No | Never sent |
| **Local only — the shift record is the fact** | `shift.open`, `shift.close` (routine cashier open/close) | Yes (the other 2 of the 6) | Never sent, even though Backend-Core accepts them. Under spec 015 the closed shift record itself syncs to Backend-Core (§7.2 R-7), so these would duplicate it. D-2 names only *forced* shift actions; the forced variant is `shift.forced_close` above |
| **Local only — represented by authoritative records** | `cart.handoff_to_payment`, `sale.finalized`, `payment.settled`, `tender.applied`, `sale.receipt.printed`, `sale.receipt.print_retried_success`, `sale.drawer.opened` (a drawer opening tied to a sale) | No | Never sent; the sale/tender/print records are the facts |
| **Local only — operational diagnostics** | `sale.finalization_refused`, `sale.receipt.print_failed`, `sale.drawer.suppressed`, `sale.drawer.failed`, `tender.refused`, `payment.cancelled`, `payment.failed` (ordinary failure, not the manager force-fail) | No | Never sent |
| **Not emitted** | `cart.discarded_on_session_end` (P-4: the subscriber is never wired) | No | Decide with C-1 / RT-116 S4 |

A **no-sale drawer** action (named in D-2) has no POS category today because the action does not
exist yet. It belongs in the central set when it is built.

**Shift emitters today (C):** nothing in production code emits `shift.close`. The only `shift.open`
emitter is a quickstart smoke handler (`src/main/ipc/operator.ts:338`, channel
`EMIT_AUDIT_EVENT_SMOKE`, payload `{ smoke: true }` at `:371`).
Its guard refuses only when `NODE_ENV === 'production'` (`:342`), and nothing in the packaged build
sets `NODE_ENV` (main is `tsc`-built and reads the environment at runtime; `electron-builder.yml` sets
none). So the guard probably does **not** fire in a packaged build; this is a code reading, not
verified at runtime. A manager or admin session could then write a smoke `shift.open` row locally.
Classifying `shift.open` as local-only keeps such rows off Backend-Core; retiring or properly gating
the smoke handler is cleanup (C-2).

---

## 10. Must NOT be simplified (deliverable 6)

These protect money, offline durability or security. A "simplification" that removes them is a
regression. The reference check (§7) shows each has a counterpart in mature systems.

1. Finalize as **one transaction** with the idempotency re-check **inside** it; printing outside it
   (R-4: finalized = immutable).
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
11. **Fail-closed** `safeStorage` and fail-closed flag defaults (H-1 adds a fail-closed check on the
    money combination per D-1; it does not flip defaults).
12. RT-117's rule: **the stuck-attempt sweep never auto-reverses live tender**.
13. **Client-generated sale id + server dedupe** (R-5; the same pattern as Odoo `uuid` + unique
    constraint).

---

## 11. Pilot-critical vs post-pilot (deliverable 7)

| Pilot-critical (decide, or consciously accept, before real cashiers) | Post-pilot |
|---|---|
| H-1 (D-1): fail-closed cashier profile + runbook 008 rollback rewrite (FU-1) | S-3 single IPC declaration |
| H-2: terminal provisioning + readiness check incl. the D-1 rule (FU-2, ops) | S-4 per-domain wiring modules |
| H-4 (D-2): privileged audit path, Backend-Core catalogue first (FU-3) | S-5 shared session-gate core |
| C-1: runbook truth for session-end carts (after RT-116 S4) | C-2 unwired code, C-3 `api-types` trim |
| R-7 shift/cash-up (existing **RT-17**, which blocks RT-20; RT-111 OB-10…14, OB-17 = Pilot): local offline lifecycle per spec 015; contract-first and blocked on the missing Backend-Core shift-lifecycle contract for the sync leg | R-6 returns contract (contract-first, when spec 014 is scheduled) |
| (owned elsewhere, cited) RT-159 F-01…F-03, F-07…F-15; RT-116 S3–S7 | |
| Pilot-adjacent: S-1 config module (part of FU-1); optional S-2 | D-3: closed (keep net); reopen only on an RT-17 / reconciliation / fiscal / reporting need |
| Pilot-optional: H-3 timer in registry (fold into RT-116) | C-4 `current.md` drift |

---

## 12. Candidate follow-ups (deliverable 8) — none created

**No follow-up Jira issue is created** by this audit (RT-160 checkpoint; owner comment 10721). These
are the candidates the evidence justifies, adjusted to the approved decisions. The labels are local to
this document and are not Jira keys.

| Candidate | Work Mode | Repo | Scope | Depends on |
|---|---|---|---|---|
| **FU-1** Fail-closed cashier profile (S-1 + H-1) | Implementation | POS | Config module (one parser, existing semantics); startup check that **refuses cashier operation** when `PAYMENTS` is on and `SALE_FINALIZATION` is off, enforced in main; rewrite the runbook 008 rollback per D-1 | D-1 ✅. If showing the refusal needs a new renderer state, that IPC/`app:config` change must be authorised in the issue |
| **FU-2** Pilot terminal provisioning (H-2) | Docs / ops | POS (runbook) | How the packaged terminal receives its environment; readiness checklist including the D-1 rule | Owner choice of provisioning mechanism |
| **FU-3** Privileged audit path (H-4) | Planning (contract-first), then Implementation | Backend-Core first, then POS | Backend-Core: add the §9.4 central categories to the closed catalogue. POS: HTTP client + `AuditSync` sender limited to supported central categories; `schema_violation` is terminal (dead-letter + log), never an infinite retry; routine and sale/payment categories never sent | D-2 ✅; Backend-Core owner; §9.4 "owner to confirm" row settled |
| **FU-4** Shared typed fake bridge (S-2) | Implementation (test-only) | POS | Test helper + migrate the operator fakes | — |
| **FU-5** Composition-root wiring extraction (S-4) | Implementation | POS | Per-domain wiring modules; every timer in the registry; guard repointing; zero behaviour change | FU-1 merged; post-pilot |

H-3 goes to the next RT-116 slice and C-1 follows RT-116 S4, so neither becomes a new issue. **R-7
(shift/cash-up) needs no new candidate**: it is already pilot work in the existing **RT-17**, which
should follow §7.2 R-7 (local offline lifecycle, Backend-Core sync contract first). R-6 belongs to
spec 014 when it is scheduled. **D-3 creates no follow-up**: the net contract stays, with its reopen
trigger recorded in §9.3.

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
  platform-independent, and the mature references carry the same ones (§7).
- The reference systems that run in a browser (Odoo POS, ERPNext POS) keep offline orders in browser
  storage and warn that clearing it loses orders (RT-111 §1.2). POS's SQLite outbox under a trusted
  main process is the stronger position, and it is a reason *for* a native shell, not against one.
- The real platform-specific cost is **periodic**: native module rebuilds per Electron major
  (RT-65 / RT-108 / RT-109). That calls for a maintenance cadence, not a migration.

**What would reopen the question (evidence triggers, not preferences):** a hardware integration
Electron cannot reach reliably (e.g. the deferred ESC/POS / DK1 drawer path); measured main-thread
contention that a utility process cannot solve; or packaged-build or installer constraints the pilot
cannot meet (H-2 is the first place this would show). None is evidenced today.

---

## 14. `current.md` drift found (recorded, not fixed here)

| `docs/architecture/current.md` says | `main@7384217` |
|---|---|
| §7: four flags (`cart`, `payments`, `saleFinalization`, `productSearch`) | Five; `voucherTender` added by RT-103. Flags are runtime process-environment inputs (P-1) |
| §3: workers stop finalize → read-down → sale-sync | True, but the inactivity interval (RT-117) is outside the registry (P-3) |
| §2: trust-boundary enforcement lists the sender guard | Also the locked-session allowlist wrapper (`session-lock-guard.ts`) |
| No statement on main→renderer pushes | One push channel exists (`operator:session-state`) |
| §5: two network legs | Correct for what runs; audit upload is built but not wired and not contract-compatible (P-2) |
| (absent) | Principle from CS-2: main is the authority for any money or cart decision; the renderer only projects |

Also out of date: `specs/README.md` indexes spec 015 as **Deferred**, while RT-111 (OB-10…14, OB-17)
and RT-17 make the register/shift lifecycle pilot work; `docs/runbook/sales-cart.md` session-end
discard (P-4, C-1); and the
`docs/runbook/008-…md:250` rollback row, which D-1 retires for real-money pilot use (rewritten in
FU-1). A docs-only follow-up can fix the rest once FU-1 / FU-3 land and RT-116 S4 decides held carts,
so it does not record a state that is about to change.

---

## 15. RT-160 checkpoint gap closure (revision 2)

| # | Checkpoint item (RT-160, 2026-10-03) | Result | Where |
|---|---|---|---|
| 1 | Re-check ERPNext/Frappe and Odoo semantics with the Reference Library plus official/open-source sources | Done: ERPNext from the Reference Library pack (citing `frappe/erpnext@a9029f83`) and the 010 bench scout; Odoo from official docs and `odoo/odoo@18.0` source | §7.1 |
| 2 | For each major responsibility, the proven pattern and reuse / adapt / keep local / reject | Done for 13 responsibilities | §7.2 |
| 3 | Flags: runtime env or fixed at build time? | **Runtime.** `tsc`-compiled main reads `process.env`; no dotenv; packaged app has no `.env` and no installer. Only the rt9 lab launcher and the Orchestrator smoke runbook set the flags; packaged-terminal provisioning is undefined (H-2) | P-1 |
| 4 | Does Backend-Core have an audit-event receiver? | **Yes**, on `main@7af7903` (contract + controller + service). But POS has no client and no caller, and the service accepts only 6 of 31 POS categories | P-2 |
| 5 | Re-verify unwired paths with stronger evidence | **Confirmed** by exhaustive reference search (X): `AuditSync` 0 production referrers; `session-end-handler.ts` 0; `LifecycleCascade` methods never called. Runbook drift found | P-4 |
| 6 | Keep the payments-on / finalization-off question as a decision candidate; do not create RT-160-A | Kept as **D-1** in revision 2; the owner decided it in comment 10721 (fail closed, recorded in revision 3). No issue created; the earlier "RT-160-A…D" labels are withdrawn | §9.2, §9.3, §12 |
| 7 | Separate simplification from cleanup/hardening | Done | §9.1 vs §9.2 |
| 8 | Exactly one next safe action | Below | — |

---

## Acceptance-criteria trace (RT-160)

| RT-160 acceptance criterion | Where |
|---|---|
| Current `main` verified, baseline SHA recorded | Baseline (`7384217`, fetched three times; Backend-Core `7af7903`) |
| 021 checked against current code | §2 |
| Responsibilities mapped to the correct owner | §3.2, §7.2 |
| Essential / Electron / incidental separated with evidence | §4, §5 |
| ≥ 3 real change paths analysed end-to-end | §5: CS-1…CS-4 + control (six commits) |
| UI-perceived vs backend/runtime complexity separated | §8 |
| ERPNext semantics only where compatible with boundaries | §7 (reuse / adapt / keep local / reject, with B6 non-goals) |
| Candidates bounded; no money/offline/security weakening | §9, §10 |
| Pilot-critical vs post-pilot separated | §11 |
| Implementation decomposed into separate Jira work; none performed | §12 (candidates only, none created, per checkpoint) |
| Reference-first design rule applied | §7 |
| Exactly one next safe action | below |

## Next safe action

**Final RT-160 owner review of PR #511 (revision 3).** D-1, D-2 and D-3 are recorded (§9.3), and no
owner decision from this audit is pending. Creating the follow-up issues (§12) waits on that review.
