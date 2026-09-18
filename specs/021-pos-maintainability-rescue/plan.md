# Implementation Plan: POS Maintainability Rescue (R1 Composition Refactor · R2 Comprehension Cleanup)

**Feature ID:** 021-pos-maintainability-rescue
**Spec:** [./spec.md](./spec.md)
**Plan Version:** 1.0
**Created:** 2026-09-18
**Last Updated:** 2026-09-18
**Constitution version pinned:** v1.5.1

> **PLAN-ONLY.** `/speckit-plan` output. No production code edited, no tasks generated, no commit, no
> branch, no PR. Task IDs materialize in `/speckit-tasks`.

---

## Technical Context

No new technology is introduced. This feature is a behavior-preserving restructuring within the existing
stack; every row below restates a choice the constitution or the existing tree already pins.

| Area | Choice | Source |
|:--|:--|:--|
| Runtime / shell | Electron 40, main + preload + renderer processes | constitution v1.5.1 (Tech Stack, frozen) |
| Language | TypeScript 5.6 strict, three `tsconfig` projects | constitution v1.5.1 (Principle V) |
| Tests | Vitest only; 467 test files present | constitution v1.5.1 (Principle VI) |
| Local DB | `better-sqlite3`, WAL, custom migration runner | constitution v1.5.1; untouched by this feature |
| New dependencies | **None permitted** | spec FR-22 / NFR-4 |
| Schema / migrations | **No change** | spec FR-22 |
| IPC / preload contracts | **No change** | spec FR-22; constitution Principle III |
| Extraction target dir | `src/main/app/` (new) | spec FR-1; audit evidence |
| Doc authority target | `docs/architecture/current.md` (new) | spec FR-18 (clarified 2026-09-18) |
| Spec index target | `specs/README.md` (new) | spec FR-17b (clarified 2026-09-18) |

### Evidence base (verified against `main` @ `69c19f4` this session)

| Fact | Value | Why it matters |
|:--|:--|:--|
| `src/main/index.ts` | 1,393 LOC | R1 target |
| Module-scope mutable handles | 4 — `dbHandle` (:308), `finalizeListenerStop` (:316), `readDownDriverStop` (:324), `saleSyncIntervalStop` (:325) | FR-2 target |
| Worker assignment sites | `:776` read-down · `:1260` finalize · `:1328` sale-sync | S1 scope |
| `closeDbHandle()` | `:1365` — stops **all three workers in fixed order**, *then* closes DB | S1/S2 boundary (see AD-2) |
| `closeDbHandle()` call sites | 3 — `:1349` (startup `.catch`), `:1384` (`window-all-closed`), `:1392` (`quit`) | Re-entrancy risk (see AD-3) |
| `createWindow()` | `:202–:262`, already a standalone top-level function | S3 is the cleanest extraction |
| Composition-root test coverage | **1 file** — `bootstrap-wires-operator.test.ts` (101 LOC), a **static source-text** guard | AD-4; R-1 risk |
| Baseline gate status | **UNVERIFIED — `node_modules` absent** | See "Validation prerequisite" |

---

## Validation prerequisite (blocker for implementation, not for planning)

`npm run typecheck`, `npm run lint`, and `npm test` **cannot currently run in this working copy**:
`node_modules` is not installed, so `tsc`, `eslint`, and `vitest` are unresolvable. Both commands were
executed this session and exited non-zero with `'tsc' is not recognized` / `'eslint' is not recognized`.

**This is an environment state, not a code defect, and not a regression introduced by this feature.**

Consequences for this plan:

- **No green baseline is asserted anywhere in this plan.** Spec NFR-1 has been corrected accordingly.
- `npm install` MUST be run and the three gates MUST be captured green **before S1 begins**. That is an
  environment step, not a code change; it touches no tracked file. The plan does **not** authorize any
  lockfile or `package.json` edit (FR-22, NFR-4).
- If the baseline is **not** green after install, the failures MUST be recorded and triaged **before**
  any extraction. Refactoring onto an unknown baseline makes "behavior preserved" unprovable.

---

## Constitution Check (Initial)

| Principle / Constraint | Status | Notes |
|:--|:--:|:--|
| I. Offline-First | **PASS** | No network, sync, or offline path is altered. FR-20/FR-21 forbid it. |
| II. Financial Precision | **PASS** | Not touched. No money code in scope; FR-22 forbids FSM/finalization change. |
| III. Process-Boundary Discipline | **PASS (active care)** | S3 relocates window creation. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, preload path, `will-navigate` allow-list, `setWindowOpenHandler` deny, and both CSP layers move **verbatim**. Sender-guarded `ipcMain` unchanged. |
| IV. Hardware Loud, Not Silent | **PASS** | Printer/drawer paths untouched. |
| V. Type Safety End-to-End | **PASS (gated)** | Strict TS retained; each slice must typecheck. Blocked on the validation prerequisite above. |
| VI. Test-First, Coverage-Gated | **PASS (active care)** | S1–S3 author tests **before** extraction (see Test Strategy). No test may be deleted or skipped to pass a slice (SC-3). |
| VII. Observability | **PASS** | Logger/Sentry init order preserved exactly; no log-shape change. |
| VIII. Terminal Identity ≠ User | **PASS** | Pairing/operator identity untouched; paired/unpaired gating preserved (FR-5). |
| IX. Reference, Not Inheritance | **PASS** | No `_reference/` consultation; nothing copied. |
| Platform Integration | **PASS** | `POS → Data-Pulse → Connector → ERPNext` preserved; no cross-repo work (FR-19). |
| Security | **PASS (active care)** | See III. No secret handling, PIN, or token path altered. |
| Hardware Matrix | **PASS** | Not touched. |
| Domain — Pharmacy POS | **PASS** | No domain behavior in scope. |
| P13 Small Scoped PRs | **PASS** | One slice per PR; bounded files; stage only named files. |
| P16 Feature Scope Discipline | **PASS** | No domain owned by another feature is implemented. |

No VIOLATION. No WAIVED entry.

---

## Phase 0 — Research

See [./research.md](./research.md). Phase 0 records the two non-trivial technique decisions this plan
makes (the S1/S2 shutdown split, and the S2 mechanism) together with rejected alternatives.

## Phase 1 — Design & Contracts

- **Data model:** **N/A.** This feature introduces, modifies, and removes **zero** persistent entities.
  The spec's *Key Entities* section states this explicitly, and FR-22 forbids schema and migration
  change. No `data-model.md` is produced — a stub would be exactly the kind of ceremonial artifact R2
  exists to remove.
- **Contracts:** **N/A.** No IPC channel, preload bridge shape, or HTTP contract changes (FR-22, SC-4).
  No `contracts/` directory is produced.
- **Quickstart:** **N/A for this feature.** The developer-facing outcome *is* `docs/architecture/current.md`,
  delivered by S7. Duplicating it into `quickstart.md` would create the second competing source of truth
  that risk R-7 names.

---

## Architecture decisions

### AD-1 — `src/main/app/` is the extraction home; the conceptual tree is not a folder mandate

Extracted bootstrap units land in `src/main/app/`. The spec's conceptual target tree (app · terminal ·
operator · catalogue · cart · checkout · sales · receipts · sync · hardware · db) is a **comprehension
goal** (spec A-5); the current tree already approximates it. **No subsystem directory is renamed or moved
by R1.** Directory moves are considered only in S5, and only on evidence (FR-13).

### AD-2 — S1 owns worker stop-ordering; S2 owns DB close. `closeDbHandle` becomes a thin composer.

**This is the load-bearing decision of the plan.** `closeDbHandle()` is not a database function — it is
the combined shutdown orchestrator. Its own comment states the reason: workers are stopped first *"so a
mid-flight background tick cannot run against a closed handle."* Splitting workers from DB-close naively
would tear one atomic invariant across two modules.

Therefore:

| Element | Destination | Slice |
|:--|:--|:--:|
| 3 worker handles + their assignment sites (`:776`, `:1260`, `:1328`) | `src/main/app/bootstrap-workers.ts` | S1 |
| `runStopper` + the 3 ordered `runStopper` calls | `src/main/app/bootstrap-workers.ts` (as `stopAll()`) | S1 |
| `dbHandle`, `dbHandle.close()` block | stays in `index.ts` | S1 (untouched) → S2 |
| `closeDbHandle()` | remains in `index.ts`, reduced to: `stopAll()` **then** close DB | S1 |

**The invariant S1 preserves, in one line:** *`stopAll()` completes before `dbHandle.close()`, at every
one of the three call sites, in the order finalize → read-down → sale-sync.*

### AD-3 — Shutdown is re-entrant by design; extraction MUST preserve idempotency

`closeDbHandle()` is reachable twice on a normal Windows exit: `window-all-closed` calls it **and** then
`app.quit()`, whose `quit` handler calls it again. Today this is safe because `runStopper` returns `null`
(nulling each handle) and the DB close is guarded by `dbHandle !== null`.

An extracted `stopAll()` that does not null its handles would **double-invoke every worker stop routine**
on every normal exit. S1 MUST preserve null-out-on-stop, and MUST prove it with a dedicated test
("calling `stopAll()` twice stops each worker exactly once").

### AD-4 — The existing bootstrap guard is static source-text; slices must budget for it

`src/main/__tests__/bootstrap-wires-operator.test.ts` `readFileSync`s `index.ts` and regex-asserts ~20
import/call strings. Its docstring explains why: `index.ts` calls `app.whenReady()` at module load and
**cannot be imported under Vitest**.

- **S1 does not trip it** — verified: every assertion targets operator, audit, or pairing wiring; none
  targets worker handles, `runStopper`, or `closeDbHandle`.
- **S2 and S3 may trip it** if they relocate asserted imports. Each slice MUST check this file and, in the
  **same slice**, either update its assertions or convert the relevant assertion to an executable test
  against the extracted module.
- **The deeper point:** this guard is static *because the composition root is untestable by construction*.
  An extracted `bootstrap-workers.ts` with injected dependencies **is** importable under Vitest. S1's
  primary value is **testability unlocked**, not code relocated — and LOC is explicitly barred as a
  metric (spec SC block).

### AD-5 — S2 is narrowed, not a lift-out (corrects the candidate sequence on evidence)

The candidate sequence implies S2 extracts "database bootstrap" as a block. **The evidence does not
support that.** `dbHandle` is opened at `:367` and then threaded through ~900 subsequent lines —
`bindAuditEventsStoreDb`, `createProductRepo`, `bindPaymentAttemptsRepository`, and every other subsystem
constructor consume it. Bootstrap is **interleaved with** subsystem construction, not a separable phase.

**Decision: S2 is narrowed** to extracting *open + migrate + close* mechanics behind a small module,
while `dbHandle` continues to be threaded as a value exactly as today. Rejected alternatives are recorded
in `research.md` (notably: threading a context object through all constructors — rejected as precisely the
giant refactor FR-6 prohibits).

**Consequence:** S2 is lower-value and higher-friction than S3. The sequence is reordered accordingly
(see below).

### AD-6 — R2 renames are evidence-driven, one surface at a time

No mechanical rename. For each candidate the slice MUST record: what the name claims, what the code does
(read, not grepped), and the rendered-component set before/after on **every** path including flag-off
(SC-10). Confirmed-misleading surfaces from the audit: `CartPlaceholder` (mounts live `CartPane` +
`CatalogueSalePane`), `SalesPlaceholder` (mounts live `FindSaleReceipt`), `CheckoutPlaceholder` (live
flag-off fallback rendered at `CheckoutRoute:47`), `voucher-authority/` (contains only HTTP clients).
Confirmed **correctly** named and therefore out of scope: `EmptyCartPlaceholder`,
`DiscountPlaceholderRow`, `InventoryPlaceholder` (state primitives only).

### AD-7 — Spec-dialect comment cleanup stays bounded

234 of 298 production files (79%) carry `T###`/`§A#`/`AD-#`/`R-RISK`/`FR-#` tokens. A repo-wide sweep is
not a reviewable slice (FR-12). Only **names** and **materially misleading claims** are in scope, and only
in files a slice already touches for another reason.

---

## Project Layout

Additive only. No existing file is moved by R1.

```text
src/main/
  app/                          ← NEW (S1–S3)
    bootstrap-workers.ts        ← S1: 3 handles, start wiring, stopAll() (ordered, idempotent)
    bootstrap-db.ts             ← S2: open + migrate + close mechanics (narrowed, per AD-5)
    bootstrap-window.ts         ← S3: createWindow + navigation/CSP/window-open policy (verbatim)
    __tests__/                  ← NEW executable tests (S1–S3)
  index.ts                      ← shrinks by delegation; remains the composition root
  …all other subsystem dirs unchanged…

docs/architecture/
  current.md                    ← NEW (S7) — internal POS responsibility map
  synchronization.md            ← EXISTING — cross-repo boundary only; one stale line corrected (S7)
specs/
  README.md                     ← NEW (S7) — status index; no spec directory moved or edited
```

---

## Slice sequence & dependencies

```text
S1 ──► S2 ──┐
  └──► S3 ──┴──► (R1 complete)

S4 ─────────────► independent of R1
S5 ─────────────► evidence-gated; may be dropped
S6 ─────────────► evidence-gated; may be dropped
S7 ─────────────► independent; may run in parallel with any R1 slice
```

| # | Slice | Depends on | Rationale |
|:--:|:--|:--|:--|
| **S1** | Extract background-worker lifecycle | — | Establishes `src/main/app/` + the first executable bootstrap test. Workers are *terminal* — created last, consumed only by shutdown — so this is the smallest safe cut. **Remains the recommended first slice.** |
| **S3** | Extract Electron/window bootstrap | S1 (dir + test pattern) | `createWindow()` is already a standalone function at `:202`; cleanest remaining extraction. **Promoted above S2** per AD-5. |
| **S2** | Narrowed DB bootstrap | S1, S3 | Lowest separability (AD-5). Deliberately last in R1 so the pattern is proven twice first. |
| **S4** | Evidence-based naming cleanup | — (R1-independent) | Renderer/route-scoped; disjoint from R1's main-process files. |
| **S5** | Sync structural ownership | — | **Evidence-gated.** `sync-outbox/` holds exactly one file; consolidation is a one-file move or is dropped. |
| **S6** | Diagnostics/operational labeling | — | **Evidence-gated + narrowed.** `CatalogueDiagnostics` is already routed separately (`router.tsx:205`, `inventory/diagnostics`) — this is labeling, not a leak. |
| **S7** | Documentation authority | — | Independent. May proceed in parallel. |

**R1 and R2 are never combined in one PR** (spec FR-6; brief's explicit instruction). S1–S3 are never
combined with each other.

---

## Per-slice design

### S1 — Extract background-worker lifecycle *(recommended first)*

- **Requirements:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-6 · SC-1, SC-2, SC-3, SC-9
- **Files likely touched:** `src/main/index.ts`; **new** `src/main/app/bootstrap-workers.ts`; **new**
  `src/main/app/__tests__/bootstrap-workers.test.ts`
- **Not touched:** any FSM, repository, migration, IPC, preload, or renderer file
- **Behavior invariants:**
  - Worker start order and gating unchanged — finalize behind the `saleFinalization` flag; read-down and
    sale-sync behind the paired-terminal branch
  - Stop order fixed: finalize → read-down → sale-sync
  - A throwing stop routine is logged, not propagated, and does **not** prevent remaining stops
  - `stopAll()` completes **before** `dbHandle.close()` at all three call sites (AD-2)
  - `stopAll()` is idempotent — second call is a no-op (AD-3)
  - Interval and backoff semantics byte-identical; no timer created, removed, or re-timed
- **Existing protection:** `bootstrap-wires-operator.test.ts` (verified **not** tripped); `sale-sync-engine`
  and `read-down-driver` suites cover worker-internal behavior
- **New tests (authored BEFORE extraction, Principle VI):** start order; stop order; throwing-stopper
  isolation; **twice-called `stopAll()` stops each worker exactly once** (AD-3); gating matrix
  (flag on/off × paired/unpaired)

### S3 — Extract Electron/window bootstrap

- **Requirements:** FR-1, FR-3, FR-5 · NFR-5 · SC-3, SC-9 · Constitution III/P8
- **Files likely touched:** `src/main/index.ts`; **new** `src/main/app/bootstrap-window.ts` + test
- **Behavior invariants:** `contextIsolation`/`nodeIntegration`/`sandbox`/`webSecurity` values verbatim;
  preload path unchanged; `will-navigate` origin allow-list unchanged; `setWindowOpenHandler` deny
  unchanged; **both** CSP layers (dev and prod strings) character-identical; dev vs packaged load path
  unchanged
- **New tests:** assert the `webPreferences` object and both CSP strings verbatim, so any weakening reds
- **AD-4 check:** confirm the static guard before merge

### S2 — Narrowed DB bootstrap

- **Requirements:** FR-1, FR-3 · FR-22 (no schema/migration change) · SC-4
- **Files likely touched:** `src/main/index.ts`; **new** `src/main/app/bootstrap-db.ts` + test
- **Explicitly NOT in scope:** repositories, transaction semantics, WAL/pragma settings, migration runner
  logic, append-only triggers, `migrations/`
- **Behavior invariants:** pragmas applied identically; migrations run at the same point in startup with
  the same failure semantics; startup failure still releases resources and exits with the same code;
  `dbHandle` still closed exactly once, after `stopAll()`
- **AD-4 check:** most likely slice to trip the static guard

### S4 — Evidence-based naming cleanup

- **Requirements:** FR-7, FR-8, FR-9, FR-10, FR-11, FR-12 · SC-5, SC-6, SC-10
- **Files likely touched:** individually selected renderer/route files + their coupled tests. **21 test
  files** reference `Placeholder`/`Skeleton` names; each rename updates its coupled tests in the **same**
  slice (FR-9)
- **Behavior invariants:** identical rendered-component set on every path incl. flag-off; no route path
  string changed; no feature-flag default changed; no exported cross-boundary contract changed
- **Sub-sliceable:** one surface (or one tight group) per PR

### S5 — Sync structural ownership *(evidence-gated)*

- **Requirements:** FR-13, FR-14 · SC-9
- **Evidence:** `sales-sync/` = 5 files; `sync-outbox/` = 1 repository file
- **Gate:** proceed only if ownership is demonstrably clearer afterward; otherwise **drop the slice**.
  Import contracts preserved; no runtime wiring change.

### S6 — Diagnostics/operational labeling *(evidence-gated, narrowed)*

- **Requirements:** FR-11 · SC-9
- **Evidence:** `CatalogueDiagnostics` already routed at `inventory/diagnostics` (`router.tsx:205`) —
  **not** leaking into the cashier flow. Scope is labeling/grouping clarity only.
- **Explicitly NOT:** redesigning diagnostics or any cashier UI

### S7 — Documentation authority

- **Requirements:** FR-15, FR-16, FR-17, FR-17a, FR-17b, FR-17c, FR-18, FR-18a · SC-7, SC-8, SC-8a, SC-8b
- **Deliverables:** create `docs/architecture/current.md` (internal responsibility map); create
  `specs/README.md` (Active / Implemented-Historical / Deferred / Superseded); correct the stale closing
  line of `docs/architecture/synchronization.md` that currently points at `specs/**` as the authority for
  current state (FR-17a)
- **Prohibited:** relocating or deleting any `specs/<id>/`; mass-editing historical specs; expanding
  `synchronization.md` into internal architecture; turning `current.md` into cross-repo program docs
- **Verification:** SC-8b — the diff adds two files and edits a small enumerated set; **no bulk edit
  across spec directories**

---

## Test Strategy

- **Framework:** Vitest only (constitution Principle VI). No new test dependency.
- **Order (normative):** for S1–S3, author the new bootstrap tests **first**, against current behavior, so
  they pass **before** extraction and must still pass after. A test written after extraction proves only
  that the new code does what the new code does.
- **Per slice:** targeted tests first (the slice's own suite + directly coupled suites), then the full
  gates: `npm run typecheck`, `npm run lint`, `npm test`.
- **Coverage:** MUST NOT regress (NFR-3). Extractions **add** tests; assertions are not relocated to
  create the appearance of coverage.
- **Prohibited:** deleting or skipping any test to make a slice pass (SC-3).
- **Static-guard handling:** each slice checks `bootstrap-wires-operator.test.ts` per AD-4.
- **Honesty constraint:** no slice may claim a gate result that was not actually executed. See
  "Validation prerequisite" — **no green baseline exists yet.**

---

## CI / Build / Package

**No change.** No workflow file, runner, gate, script, `package.json`, or lockfile is modified (FR-22,
NFR-4, brief item 9). Existing gates (typecheck, lint, tests, package dry-run) apply to every slice
unchanged.

---

## Phase 2 — Implementation Outline

Strategy only; task IDs are generated by `/speckit-tasks`.

0. **Prerequisite (environment):** `npm install`; capture the three gates green; record results. If not
   green, triage before any extraction.
1. **S1** — author worker-lifecycle tests → extract `bootstrap-workers.ts` → `closeDbHandle` becomes a
   thin composer (AD-2) → targeted then full validation.
2. **S3** — author window/security assertions → extract `bootstrap-window.ts` verbatim → validate → AD-4
   check.
3. **S2** — author DB-bootstrap tests → extract narrowed `bootstrap-db.ts` (AD-5) → validate → AD-4 check.
4. **S4** — per-surface, evidence-recorded renames with coupled-test updates in the same slice.
5. **S5 / S6** — evidence gate first; drop if the gate fails.
6. **S7** — `current.md` + `specs/README.md` + the one-line `synchronization.md` correction.

S7 may run in parallel with R1. R1 and R2 never share a PR.

---

## Constitution Check (Post-Design)

| Principle / Constraint | Status | Notes |
|:--|:--:|:--|
| III. Process-Boundary Discipline | **PASS** | AD-1/AD-2 keep extraction main-process-internal. S3 moves security policy **verbatim** and asserts it in tests. No IPC/preload change (SC-4). |
| V. Type Safety End-to-End | **PASS (gated)** | Per-slice typecheck; blocked on the validation prerequisite. |
| VI. Test-First, Coverage-Gated | **PASS** | Test-before-extraction is normative in Test Strategy; AD-4 converts a static guard toward executable coverage. |
| VII. Observability | **PASS** | Logger/Sentry init order preserved. |
| P13 / P16 | **PASS** | One slice per PR; R1≠R2; evidence-gated slices droppable. |
| All other rows | **PASS** | Unchanged from Initial; no design decision altered their basis. |

No VIOLATION. No WAIVED entry.

---

## Risks & Open Items

| # | Risk | Mitigation | Owner |
|:--:|:--|:--|:--|
| **R-1** | **Static bootstrap guard reds on extraction.** `bootstrap-wires-operator.test.ts` regex-asserts ~20 strings in `index.ts`; S2/S3 may relocate them. Looks like a regression in CI. | AD-4: each slice checks it and updates assertions *or* converts to an executable test **in the same slice**. Verified S1 does not trip it. | S2, S3 |
| **R-2** | **Double-stop on normal exit.** `window-all-closed` → `app.quit()` → `quit` reaches `closeDbHandle()` twice. An extracted `stopAll()` that does not null its handles double-invokes every stop routine. | AD-3 + the twice-called test in S1's suite. | S1 |
| **R-3** | **DB closed before workers stop** → mid-flight tick against a closed handle. | AD-2 makes the ordering invariant explicit and test-asserted; `closeDbHandle` keeps composing in the same order. | S1, S2 |
| **R-4** | **Startup-ordering regression** (logger → Sentry → DB/migrations → SecretStore → IPC → workers). | Tests assert order; extraction is delegation only — no step added, removed, or reordered (FR-5). | S1–S3 |
| **R-5** | **Leaked intervals/workers** if a stop path is dropped. | Stop-order + cleanup tests; `stopAll()` is the single owner of all three handles. | S1 |
| **R-6** | **Feature-gated behavior changes accidentally** (flag or paired/unpaired). | Gating matrix test (flag on/off × paired/unpaired); FR-5; flag defaults immutable (FR-22). | S1 |
| **R-7** | **Docs become a second conflicting source of truth.** | FR-18a scope split: `current.md` = internal, `synchronization.md` = cross-repo; FR-17a removes the stale `specs/**` pointer; exactly one canonical current reference (FR-18). | S7 |
| **R-8** | **Misleading rename changes imports/routes.** | AD-6: read runtime behavior per surface; SC-10 before/after render-set proof; coupled tests updated in-slice (FR-9); no route string change. | S4 |
| **R-9** | **Spec-dialect cleanup expands scope** to a 234-file sweep. | AD-7 + FR-12: names and materially misleading claims only, in files already in-slice. | S4 |
| **R-10** | **Accidental IPC/preload contract modification.** | SC-4 zero-diff check on channel names, bridge shapes, `migrations/`, FSM tables, flag defaults, verified per-slice diff. | all |
| **R-11** | **Unverified baseline.** `node_modules` absent; gates never executed at `69c19f4`. Refactoring onto an unknown baseline makes "behavior preserved" unprovable. | Prerequisite step 0; no green baseline claimed anywhere; spec NFR-1 corrected. | **before S1** |
| **R-12** | **S2 tempts a context-object refactor** through ~900 lines of threading. | AD-5 narrows S2 and records the rejected alternative; FR-6 forbids the giant refactor. | S2 |

### Open items

- **OI-1 (blocking implementation, not planning):** establish the green baseline (prerequisite step 0).
- **OI-2 (non-blocking):** per-spec status values for `specs/README.md` (which of 21 directories are
  Deferred vs Superseded) are assigned during S7 on evidence; "Superseded" is evidence-gated (FR-17b).

---

*This plan is the source for `/speckit-tasks`. Changes to scope or technical approach after task
generation MUST update this plan and re-run task generation.*
