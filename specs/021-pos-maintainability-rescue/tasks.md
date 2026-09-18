# Tasks: POS Maintainability Rescue (R1 Composition Refactor · R2 Comprehension Cleanup)

**Feature:** 021-pos-maintainability-rescue
**Plan:** [./plan.md](./plan.md)
**Spec:** [./spec.md](./spec.md)
**Created:** 2026-09-18
**Last Updated:** 2026-09-18

---

## Conventions

- **Format:** `- [ ] [TaskID] [P?] [Sn?] Description with file path`
- **`[P]`** marks parallelizable tasks (different files, no dependency on incomplete tasks).
- **`[Sn]`** maps the task to a rescue slice (S1–S7). Setup and Polish phases carry no slice label.
- File paths are repository-relative.
- **Every slice is its own PR.** R1 and R2 never share a PR (spec FR-6). S1–S3 never combine.

### Standing constraints (apply to EVERY task)

| Constraint | Source |
|:--|:--|
| No runtime behavior change | spec FR-5, FR-8, FR-20, FR-21 |
| No schema, migration, IPC, preload, or HTTP contract change | spec FR-22 · SC-4 |
| No new dependency; no `package.json` / lockfile / CI edit | spec NFR-4 · plan "CI / Build / Package" |
| No feature-flag default change | spec FR-22 |
| No test deleted or skipped to make a slice pass | spec SC-3 |
| Stage only named files; no `git add -A` / `git add .` | constitution P13 |
| Tests authored BEFORE extraction for S1–S3 | constitution Principle VI · plan Test Strategy |

---

## Phase 1 — Setup (Blocking Prerequisite)

> **This phase is an ENVIRONMENT action, not a code change.** It touches no tracked file.
> It exists because the baseline is currently UNVERIFIED (plan R-11 / research R0-5).

- [x] **T001** Run `npm install` to restore the toolchain (`node_modules` was absent; `tsc`, `eslint`,
      `vitest` were unresolvable). Do **not** modify `package.json` or `package-lock.json`.
      **DONE 2026-09-18.** Install exited 0. `npm install` rewrote one line of `package-lock.json`
      (`license`: UNLICENSED → MIT, a pre-existing drift vs `package.json`, unrelated to this feature) —
      **reverted** via `git checkout -- package-lock.json`. No tracked file modified by setup.
- [x] **T002** Capture the baseline. **DONE 2026-09-18 @ `69c19f4`:**
      `npm run typecheck` → **exit 0 PASS**; `npm run lint` → **exit 0 PASS**;
      `npm test` → **exit 0 PASS — 465 test files, 5,511 passed, 3 skipped (5,514)**, 94.99s.
- [x] **T003** **Gate.** **PASSED** — baseline fully green; no pre-existing failures to triage.
      Extraction authorized.

---

## Phase 2 — Foundational

No foundational scaffolding is required. The extraction directory `src/main/app/` is created by S1
(T010) as part of that slice; creating it earlier would be an empty commit.

---

## Phase 3 — S1: Extract background-worker lifecycle *(recommended first slice)*

**Goal:** the three process-lifetime worker handles, their stop routines, and their ordering leave the
composition root and become independently testable, with zero behavior change.
**Independent test:** new `bootstrap-workers` suite passes; full gates green; `closeDbHandle()` still
stops all workers before closing the DB at all three call sites.
**Requirements:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-6 · SC-1, SC-2, SC-3, SC-9

### S1a — Characterization tests FIRST (must pass BEFORE extraction)

- [x] **T010** [S1] Create `src/main/app/__tests__/` and author the worker-lifecycle suite against a
      small injected-dependency seam, asserting **current** behavior. **DONE** —
      `src/main/app/__tests__/bootstrap-workers.test.ts`, 9 tests. RED verified first (module absent),
      then GREEN.
- [x] **T011** [S1] Test: gating is preserved. **DONE — via registration semantics.** Worker
      construction and its gating branches were deliberately NOT moved (see T017), so the gate is
      encoded as *registration*: a worker that is never started is never registered. Covered by
      "skips workers that were never registered (gated off / unpaired)" and "no-op when nothing was
      registered".
- [x] **T012** [S1] Test: workers STOP in the fixed order **finalize → read-down → sale-sync**.
- [x] **T013** [S1] Test: a **throwing** stop routine is caught and logged, and does **NOT** prevent the
      remaining workers from stopping (current `runStopper` semantics).
- [x] **T014** [S1] Test: **`stopAll()` called twice stops each worker exactly once** (idempotency —
      plan AD-3 / R-2; `window-all-closed` → `app.quit()` → `quit` reaches shutdown twice on a normal
      Windows exit).
- [x] **T015** [S1] Test: gating matrix. **DONE** — the registered-subset cases cover flag-off
      (finalize absent) and unpaired (read-down + sale-sync absent), plus the empty case. Full
      construction-time gating remains asserted by the untouched branches in `index.ts` and by the
      existing `sale-sync-engine` / `read-down-driver` suites.

### S1b — Extraction

- [x] **T016** [S1] Create `src/main/app/bootstrap-workers.ts`. **DONE — `createWorkerRegistry({logger})`
      exposing `register(name, stop)` / `stopAll()` / `hasRegistered()`.** Implementation note: the three
      separate `let` handles + `runStopper` collapsed into one registry keyed by worker name, with
      `STOP_ORDER` (finalize → read-down → sale-sync) owned by the module rather than by call order at
      the root. Each callback is **cleared before invocation**, which preserves the previous
      null-on-stop re-entrancy safety even when a stopper throws.
- [x] **T017** [S1] Convert the three worker stop-assignment sites in `src/main/index.ts`
      (read-down, finalize, sale-sync) to `workerRegistry.register(...)`. **DONE — scope narrowed on
      implementation evidence:** all three stop routines were single-method closures, so only the
      *registration* needed to move. Worker **construction, gating branches, and logging stay in place**,
      which keeps the diff to 25 insertions / 38 deletions and touches no gating condition, interval, or
      backoff value. This is strictly smaller than the originally-planned "move the start sites".
- [x] **T018** [S1] Reduce `closeDbHandle()` in `src/main/index.ts` to a thin composer:
      `stopAll()` **then** close the DB (plan AD-2). `dbHandle` and `dbHandle.close()` **stay** in
      `index.ts` — they are S2's concern. All three call sites (`:1349`, `:1384`, `:1392`) keep working
      unchanged.
- [x] **T019** [S1] Remove the three now-unused module-scope worker handle declarations from
      `src/main/index.ts` (discharges FR-2 for workers; `dbHandle` remains until S2).

### S1c — Verification

- [x] **T020** [S1] Confirm `src/main/__tests__/bootstrap-wires-operator.test.ts` still passes.
      **DONE — PASSES.** The plan's AD-4 prediction held: S1 does not trip the static guard.
- [x] **T021** [S1] Run targeted suites. **DONE** — `bootstrap-workers` (9) +
      `bootstrap-wires-operator` (13) = **22 passed**.
- [x] **T022** [S1] Run full gates. **ALL GREEN.** `npm run typecheck` exit 0; `npx eslint .` exit 0 +
      prettier clean on all tracked sources; `npm test` exit 0 — **466 test files, 5,520 passed,
      3 skipped (5,523)**, 89.19s. Delta vs baseline: **+1 file / +9 tests (the new suite), 0
      regressions.**
- [x] **T023** [S1] Diff review against SC-4. **DONE — CLEAN.** Changed files: `src/main/index.ts`
      (only) + two new files under `src/main/app/`. Zero diffs to `migrations/`, `bridge-api.ts`,
      `preload/`, `api-types.ts`, `package.json`, or any flag default.

---

## Phase 4 — S3: Extract Electron/window bootstrap

> **Sequenced BEFORE S2 on planning evidence** (plan AD-5): `createWindow()` at `src/main/index.ts:202`
> is already a standalone top-level function, making it the cleanest remaining extraction. S2's target
> is the least separable and runs last in R1.

**Goal:** window creation and its security policy move out of the composition root, verbatim.
**Independent test:** new window-bootstrap suite asserts the security posture literally; full gates green.
**Requirements:** FR-1, FR-3, FR-5 · NFR-5 · SC-3, SC-9 · Constitution III / P8

- [x] **T030** [S3] Author `src/main/app/__tests__/bootstrap-window.test.ts` FIRST, asserting the
      **current** security posture verbatim: `contextIsolation: true`, `nodeIntegration: false`,
      `sandbox: true`, `webSecurity: true`, and the preload path.
- [x] **T031** [S3] Test: `will-navigate` denies any URL outside the resolved renderer origin.
- [x] **T032** [S3] Test: `setWindowOpenHandler` denies all new-window requests.
- [x] **T033** [S3] Test: **both** CSP strings (dev and production) are character-identical to current.
      Any weakening must red this test.
- [x] **T034** [S3] Create `src/main/app/bootstrap-window.ts` and move `createWindow()` (`:202–:262`)
      **verbatim**, including the navigation allow-list, window-open deny, both CSP layers, and the
      dev-vs-packaged load path.
- [x] **T035** [S3] **AD-4 check.** Verify `bootstrap-wires-operator.test.ts`; if the move relocated any
      asserted import string, update that assertion — or convert it to an executable assertion against
      the extracted module — **in this same slice** (plan R-1).
- [x] **T036** [S3] Run full gates. All green.
- [x] **T037** [S3] Diff review against SC-4 and NFR-5 (no security value altered).

---

## Phase 5 — S2: Narrowed database bootstrap

> **Narrowed by planning evidence** (plan AD-5 / research R0-3): `dbHandle` is threaded through ~900
> lines of subsystem construction. A block-extraction is NOT possible. Scope is **open + migrate +
> close mechanics only**; `dbHandle` continues to be threaded as a value exactly as today.

**Goal:** database open/migrate/close mechanics have a named owner without disturbing the threading.
**Independent test:** DB-bootstrap suite green; startup failure semantics unchanged; full gates green.
**Requirements:** FR-1, FR-3 · FR-22 · SC-4

- [x] **T040** [S2] Author `src/main/app/__tests__/bootstrap-db.test.ts` FIRST, asserting current
      behavior: pragmas applied identically (WAL, `foreign_keys = ON`), migrations run at the same point
      in startup, and startup-failure semantics are preserved (`closeDbHandle()` + `app.exit(1)`).
- [x] **T041** [S2] Create `src/main/app/bootstrap-db.ts` owning open + migrate + close mechanics only.
      **`dbHandle` remains threaded to subsystem constructors exactly as today** — no context object, no
      DI container, no constructor-signature changes (plan R-12).
- [x] **T042** [S2] Move the `dbHandle` declaration and its close block into the new module's ownership,
      preserving: closed exactly once, **after** `stopAll()` (plan AD-2), guarded against double-close.
- [x] **T043** [S2] **Explicitly NOT in scope** — verify the diff touches none of: repositories,
      transaction semantics, WAL/pragma values, migration runner logic, append-only triggers,
      `migrations/`.
- [x] **T044** [S2] **AD-4 check** on `bootstrap-wires-operator.test.ts` (most likely slice to trip it).
- [x] **T045** [S2] Run full gates. All green.
- [x] **T046** [S2] Confirm FR-2 fully discharged: **no** process-lifetime mutable state declared
      directly in `src/main/index.ts` (SC-1).

---

## Phase 6 — S4: Evidence-based misleading naming cleanup *(R2 — separate PRs from R1)*

**Goal:** production identifiers no longer contradict runtime behavior.
**Independent test:** rendered-component set identical before/after on every path incl. flag-off.
**Requirements:** FR-7, FR-8, FR-9, FR-10, FR-11, FR-12 · SC-5, SC-6, SC-10

> **Sub-sliceable: one surface (or one tight group) per PR.** Each rename records what the name claims,
> what the code does (read, not grepped), and the before/after render set.

- [x] **T050** [P] [S4] Rename `CartPlaceholder` → behavioral name. Evidence: mounts live `CartPane` +
      `CatalogueSalePane`. Update coupled tests **in this slice**.
- [x] **T051** [P] [S4] Rename `SalesPlaceholder` → behavioral name. Evidence: mounts live
      `FindSaleReceipt` (a real reprint feature). Update coupled tests in this slice.
- [x] **T052** [P] [S4] Rename `CheckoutPlaceholder` → behavioral name. Evidence: **live** — rendered at
      `CheckoutRoute:47` as the feature-flag-off fallback. **MUST NOT be deleted**; the flag-off path must
      render the identical component after rename (SC-10).
- [x] **T053** [S4] Rename `src/main/payments/voucher-authority/` → a client-accurate name. Evidence: it
      contains only HTTP clients to Data-Pulse-2 (`validate`/`redeem`/`reverse`); POS holds no voucher
      decision logic (SC-6). Import-only change; no behavior.
- [x] **T054** [S4] **Out of scope — do NOT rename:** `EmptyCartPlaceholder`, `DiscountPlaceholderRow`,
      `InventoryPlaceholder`. Verified correctly named (genuine empty/reserved/unbuilt states).
      This task is a documented no-op guarding against over-reach.
- [x] **T055** [S4] Verify no route path string, feature-flag default, or exported cross-boundary
      contract changed (FR-8).
- [x] **T056** [S4] Run full gates after each sub-slice.

---

## Phase 7 — S5 / S6: Evidence-gated structural clarity

> **Both slices are DROPPABLE.** If the evidence gate fails, close the slice with a recorded rationale
> rather than forcing a move (FR-13 forbids moving modules for a tidier tree).

- [x] **T060** [S5] **Evidence gate.** `sales-sync/` = 5 files; `sync-outbox/` = 1 repository file.
      Decide whether consolidating under a single `sync/` owner makes ownership demonstrably clearer.
      **If not — DROP the slice** and record why.
- [x] **T061** [S5] If the gate passes: move the single file, preserving all import contracts. No runtime
      wiring change. Full gates green.
- [x] **T062** [S6] **Evidence gate.** `CatalogueDiagnostics` is already routed separately at
      `inventory/diagnostics` (`src/renderer/router.tsx:205`) — it does **not** leak into the cashier
      flow. Scope is labeling/grouping clarity only. **If no clarity gain — DROP the slice.**
- [x] **T063** [S6] If the gate passes: clarify labeling/grouping only. **Do NOT** redesign diagnostics
      or any cashier UI.

---

## Phase 8 — S7: Documentation authority *(independent; may run in parallel with R1)*

**Goal:** exactly one canonical current-architecture reference exists; historical specs are traceable but
not authoritative.
**Requirements:** FR-15, FR-16, FR-17, FR-17a, FR-17b, FR-17c, FR-18, FR-18a · SC-7, SC-8, SC-8a, SC-8b

- [x] **T070** [P] [S7] Create `docs/architecture/current.md` — the internal POS architecture and
      responsibility map (app · terminal · operator · catalogue · cart · checkout/payments · sales ·
      receipts · sync · hardware · db). MUST be sufficient for an engineer with **no** `specs/` access to
      locate each responsibility (SC-7). **Do NOT** expand it into cross-repo program documentation.
- [x] **T071** [P] [S7] Create `specs/README.md` — a lightweight status index classifying every spec
      directory as **Active**, **Implemented / Historical**, **Deferred**, or **Superseded**
      ("Superseded" only where evidence supports it).
- [x] **T072** [S7] Correct the stale closing line of `docs/architecture/synchronization.md` that
      currently points at `specs/**` as the authority for current implementation state (FR-17a). Keep
      that file scoped to the cross-repo boundary `POS → Data-Pulse → Connector → ERPNext` (FR-18a).
- [x] **T073** [S7] **Prohibitions check.** Verify the diff: no `specs/<id>/` directory relocated or
      deleted (FR-16); **no bulk edit across spec directories** (FR-17c); `synchronization.md` not
      expanded into internal architecture; `current.md` not turned into cross-repo docs (SC-8b).
- [x] **T074** [S7] Verify SC-8a: no remaining document points at `specs/**` as the authority for
      *current* architecture or implementation state.

---

## Phase Final — Polish & Cross-Cutting

- [x] **T080** Confirm SC-1: no process-lifetime mutable state declared directly in the composition root.
- [x] **T081** Confirm SC-2: every extracted bootstrap boundary has tests asserting start order, stop
      order, and cleanup-on-failure — and those tests fail if ordering is altered.
- [x] **T082** Confirm SC-4 across the whole feature: zero diffs to IPC names, bridge shapes,
      `migrations/`, schema, FSM transition tables, finalization semantics, flag defaults.
- [x] **T083** Confirm SC-5 / SC-6: no `*Placeholder`/`*Skeleton`/`*Demo` identifier renders a live
      production-reachable surface; no module name asserts an authority the code lacks.
- [x] **T084** Confirm SC-9: each merged slice's diff touches only its declared scope; no unrelated
      cleanup rode along.
- [x] **T085** Final full-gate run: `npm run typecheck`, `npm run lint`, `npm test`.

---

## Dependency Graph

```text
T001─T003  Setup / baseline  ──► BLOCKS EVERYTHING BELOW
                │
                ├──► S1 (T010─T023)  ──┬──► S3 (T030─T037) ──► S2 (T040─T046)
                │                      │        (R1 complete)
                ├──► S4 (T050─T056)    │   independent of R1
                ├──► S5 (T060─T061)    │   evidence-gated · droppable
                ├──► S6 (T062─T063)    │   evidence-gated · droppable
                └──► S7 (T070─T074)    │   independent · parallel-safe
                                       └──► Polish (T080─T085)
```

- **S1 → S3 → S2** is the R1 order (S3 promoted above S2 per plan AD-5).
- **S4–S7** do not depend on R1 and may proceed independently.
- **Polish** runs after all attempted slices settle.

## Parallel Execution Examples

- **S7 alongside R1:** T070/T071 are `[P]` and touch only `docs/` and `specs/` — zero overlap with
  `src/main/`. Safe to run concurrently with S1.
- **Within S4:** T050/T051/T052 are `[P]` — distinct route files with distinct coupled tests. Still
  **separate PRs** (one surface per PR).
- **Never parallel:** S1/S2/S3 with each other — all three edit `src/main/index.ts`.

## Implementation Strategy

1. **Unblock (T001–T003).** No extraction begins on an unverified baseline.
2. **S1 first.** Smallest safe cut; converts the composition root's only (static, source-text) guard into
   real executable tests. Value is *testability unlocked*, not lines moved — LOC is barred as a metric.
3. **S3, then S2.** Proves the extraction pattern twice before meeting the least-separable target.
4. **R2 separately.** Never in an R1 PR.
5. **Drop S5/S6 freely** if their evidence gates fail. Dropping on evidence is a success, not a shortfall.
6. **Checkpoint after each slice:** full gates green + SC-4 zero-diff review before opening the next.

---

## Implementation Evidence (recorded at completion)

- **T030** — **DONE** — `bootstrap-window.test.ts`, 12 tests, RED verified before implementation.
- **T031** — **DONE** — 5 hostile URLs denied (https, file://, wrong port, about:blank, javascript:).
- **T032** — **DONE** — `setWindowOpenHandler` asserted to return `{action:'deny'}`.
- **T033** — **DONE** — both CSP strings asserted whole, AND verified **byte-identical** against `main` by programmatic comparison of all 10 directives.
- **T034** — **DONE** — `bootstrap-window.ts` + `createWindowFactory(deps)`. `resolveRendererOrigin` INJECTED (not moved) to stay the #370 single source of truth shared with the IPC sender guard.
- **T035** — **DONE (AD-4 fired)** — `bootstrap-wires-operator.test.ts` passes untouched. But a SECOND, unplanned static guard `src/tests/renderer-isolation.test.ts` redded; repointed at `bootstrap-window.ts`. **AD-4's tripwire inventory was incomplete.**
- **T036** — **DONE** — 467 files / 5532 passed / 3 skipped; typecheck 0, eslint 0.
- **T037** — **DONE — CLEAN.** Pure relocation; no security value altered. CodeScene 10.0, 0 findings.
- **T040** — **DONE** — `bootstrap-db.test.ts`, 6 tests, RED verified. Covers close-before-open and double/triple close.
- **T041** — **DONE** — `bootstrap-db.ts` `createDatabaseHolder({logger})`. Open + migrate stay at the root per AD-5.
- **T042** — **DONE** — module-scope `let dbHandle` replaced by the holder; all ~26 in-`whenReady()` consumers now use a local `const db`.
- **T043** — **DONE — VERIFIED.** No repository, FSM, outbox, migration, or contract touched. One hazard caught by typecheck: `:642` was ES6 shorthand, so the blanket rename hit the `CartHandlersDeps.dbHandle` contract property; restored.
- **T044** — **DONE** — guard passes. Swept ALL 16 `readFileSync` tests; only `bootstrap-wires-operator` reads `index.ts`, and it asserts no DB strings.
- **T045** — **DONE** — 468 files / 5538 passed / 3 skipped; typecheck 0, eslint 0.
- **T046** — **DONE — SC-1 DISCHARGED.** `grep -E '^let ' src/main/index.ts` → zero matches.
- **T050** — **DONE** — `CartPlaceholder` → `CartWorkspace` (mounts live `CartPane` + `CatalogueSalePane`). Private helper collision at `:72` renamed `SaleLayout`.
- **T051** — **DONE** — `SalesPlaceholder` → `SalesWorkspace` (mounts live `FindSaleReceipt`).
- **T052** — **DONE — NOT RENAMED (correct outcome).** `CheckoutPlaceholder`'s name is ACCURATE: it renders only `ReservedTenderRow`/`ReservedTotalsRow` and is the fail-closed flag-off fallback at `CheckoutRoute:47`. Renaming would make the code lie.
- **T053** — **DONE** — `voucher-authority/` → `voucher-authority-client/`. Evidence: every file is an HTTP client to DP2; the authority is in the backend.
- **T054** — **DONE — HONOURED.** `EmptyCartPlaceholder` (3 uses) and `DiscountPlaceholderRow` untouched via word-boundary matching.
- **T055** — **DONE — VERIFIED.** Route path strings `'cart'`/`'sales'` UNCHANGED; only component identifiers moved. No flag default, no exported contract, no IPC name altered.
- **T056** — **DONE** — 468 files / 5538 passed — identical to pre-S4, confirming the change is purely nominal.
- **T060** — **GATE FAILED — S5 DROPPED (FR-13, correct outcome).** `sync-outbox/` has 6 importers across two test trees; folding it would touch 6 files to move 1. Decisively: the outbox is written by 008's finalize transaction while `sales-sync/` is 011's drain engine — the enqueue/drain split is intentional. Merging would obscure the architecture.
- **T061** — **N/A** — gate did not pass.
- **T062** — **GATE FAILED — S6 DROPPED (FR-13, correct outcome).** `CatalogueDiagnostics` is already routed separately at `inventory/diagnostics` and already accurately named. Nothing to clarify.
- **T063** — **N/A** — gate did not pass.
- **T070** — **DONE** — `docs/architecture/current.md` created (canonical current internal architecture).
- **T071** — **DONE** — `specs/README.md` created; all 22 specs classified Active / Implemented / Deferred.
- **T072** — **DONE** — stale closing line in `synchronization.md` corrected; it no longer names `specs/**` as the authority for implementation state. CLAUDE.md's authority table also updated.
- **T073** — **DONE — PROHIBITIONS HONOURED.** `git status specs/` shows no directory relocated or deleted; `git diff --stat HEAD -- specs/` shows zero historical specs modified.
- **T074** — **DONE — SC-8a VERIFIED.** No remaining document points at `specs/**` as the authority for current architecture.
- **T081** — **DONE — SC-2 CONFIRMED.** Each extracted boundary has executable tests for its ordering/error paths: `bootstrap-workers` (9 — stop order, throw isolation, double-stop idempotency), `bootstrap-window` (12 — trust-boundary flags, allow-list, deny-all, both CSP strings), `bootstrap-db` (6 — close-before-open, triple close, throwing close).
- **T084** — **DONE — SC-9 CONFIRMED.** Per-slice file counts: S3=4, S2=3, S4=37 (all rename-coupled), S7=5. No unrelated file touched in any slice.
- **T085** — **DONE — FINAL GATES GREEN.** `npm test -- --coverage` (the gate CI runs): 468 files / 5538 passed / 3 skipped, **zero threshold violations**; 96.2% statements, 93.04% branches, 98.61% functions, 97.83% lines. typecheck 0; eslint 0. NFR-3 measured, not assumed.

> **Coverage note (NFR-3).** The directory rename in S4 was checked against `vitest.config.ts`:
> no per-glob coverage threshold keyed on `src/main/payments/**` or the renamed route files, so
> no threshold was silently orphaned by the move.
