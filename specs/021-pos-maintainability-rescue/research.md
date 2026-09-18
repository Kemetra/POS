# Research — 021 POS Maintainability Rescue (Phase 0)

**Feature ID:** 021-pos-maintainability-rescue
**Plan:** [./plan.md](./plan.md)
**Created:** 2026-09-18
**Constitution version pinned:** v1.5.1

Phase 0 records the non-trivial technique decisions behind the plan, with alternatives and rationale.
All evidence was verified against `main` @ `69c19f4` during the plan session.

There are **no open `NEEDS CLARIFICATION` items**; spec clarification closed on 2026-09-18 with 0 open
questions.

---

## R0-1 — Where does the worker/DB shutdown boundary fall? (drives AD-2)

### Finding

`closeDbHandle()` (`src/main/index.ts:1365`) is **not** a database function. It is the combined shutdown
orchestrator: it stops all three background workers in a fixed order and only then closes the SQLite
handle. Its own comment gives the reason — *"so a mid-flight background tick cannot run against a closed
handle."*

It is reachable from **three** call sites: `:1349` (startup `.catch`), `:1384` (`window-all-closed`), and
`:1392` (`quit`).

### Options considered

| Option | Description | Verdict |
|:--|:--|:--|
| **A** | Move workers *and* DB-close into one `bootstrap-lifecycle.ts` | **Rejected** — merges S1 and S2 into one slice, contradicting FR-6 and the brief's "do not combine S1–S3" |
| **B** | Move workers only; leave `closeDbHandle` untouched, calling into the new module | **Rejected** — leaves the three ordered `runStopper` calls in `index.ts`, so the stop-ordering invariant stays split across two files; S1 would not actually remove the mutable handles (FR-2) |
| **C** *(chosen)* | Move handles + `runStopper` + ordered stops into `bootstrap-workers.ts` as `stopAll()`; `closeDbHandle` remains in `index.ts` reduced to `stopAll()` → close DB | **Chosen** |

### Rationale for C

Keeps one atomic invariant in one place (worker stop ordering) while leaving DB-close where S2 will find
it. `closeDbHandle` survives as a two-line composer, so all three call sites keep working unchanged and
the ordering guarantee remains readable at the composition root. S1 genuinely discharges FR-2 (zero
worker handles left at module scope) without reaching into DB concerns.

### Invariant this pins

> `stopAll()` completes before `dbHandle.close()`, at every one of the three call sites, in the order
> finalize → read-down → sale-sync.

---

## R0-2 — Shutdown idempotency (drives AD-3)

### Finding

On a normal Windows exit, `closeDbHandle()` runs **twice**: `window-all-closed` calls it, then calls
`app.quit()`, whose `quit` handler calls it again. This is safe today only because `runStopper` returns
`null` — nulling each handle as it stops — and the DB close is guarded by `dbHandle !== null`.

### Consequence

An extracted `stopAll()` that keeps its handles non-null after stopping would **double-invoke every worker
stop routine on every normal exit**. Depending on each worker's stop implementation, that ranges from a
harmless no-op to a double `clearInterval` or a double-close error path.

### Decision

S1 MUST preserve null-out-on-stop semantics, and MUST prove it with an explicit test:

> *"calling `stopAll()` twice stops each worker exactly once."*

Rejected alternative: relying on each worker's own stop routine being internally idempotent. Rejected
because that is an **unverified assumption about three independently-authored workers**, and the current
design deliberately centralizes the guarantee in `runStopper` rather than distributing it.

---

## R0-3 — Can database bootstrap be lifted out as a phase? (drives AD-5)

### Finding

**No.** `dbHandle` is opened at `:367` and then consumed continuously by subsystem constructors for
roughly 900 subsequent lines — `bindAuditEventsStoreDb` (:279 rel.), `createProductRepo`,
`createCatalogueSyncStateRepo`, `bindPaymentAttemptsRepository`, `bindPaymentTenderLinesRepository`,
`bindPaymentActionOutboxRepository`, and others. Bootstrap is **interleaved with** subsystem construction,
not a separable leading phase.

This directly contradicts the shape implied by the candidate slice sequence, in which S2 reads as a
block-extraction comparable to S1.

### Options considered

| Option | Description | Verdict |
|:--|:--|:--|
| **A** | Thread a `deps`/context object through every constructor so DB bootstrap can own the handle | **Rejected** — touches ~900 lines and every subsystem at once; this is exactly the giant refactor FR-6 prohibits and the brief forbids |
| **B** | Defer S2 indefinitely | **Rejected** — open/migrate/close mechanics *are* genuinely extractable and carry real value; deferring forfeits it without cause |
| **C** *(chosen)* | Narrow S2 to open + migrate + close mechanics behind a small module; `dbHandle` continues to be threaded as a value exactly as today | **Chosen** |
| **D** | Introduce a DI container | **Rejected** — new dependency (NFR-4) and an architecture change far beyond a maintainability rescue |

### Consequence for sequencing

S2 is lower-value and higher-friction than S3, whose target (`createWindow()` at `:202`) is *already* a
standalone top-level function. The plan therefore **reorders R1 to S1 → S3 → S2**, which the brief permits
("refine only if evidence requires it"). S2 runs last in R1 so the extraction pattern is proven twice
before it meets the least-separable target.

---

## R0-4 — Why is composition-root test coverage one static file? (drives AD-4)

### Finding

`src/main/__tests__/bootstrap-wires-operator.test.ts` (101 LOC) is the **only** test covering the
composition root. It `readFileSync`s `index.ts` and regex-asserts ~20 import/call strings. Its docstring
states the reason: `index.ts` invokes `app.whenReady()` at module load, requiring Electron globals
unavailable in Vitest's `node`/`happy-dom` environments — so the file **cannot be imported** for runtime
testing.

### Two consequences

1. **It is a tripwire for S2/S3.** Every assertion targets operator, audit, or pairing wiring. Verified:
   **S1 does not trip it.** S2/S3 may, if they relocate an asserted import. Each slice must check it and
   update or convert it *in the same slice*, or CI will read a behavior-preserving refactor as a
   regression.

2. **It is the strongest argument for S1-first.** The guard is static *because the composition root is
   untestable by construction*. An extracted `bootstrap-workers.ts` taking injected dependencies **is**
   importable under Vitest. The value S1 delivers is **testability unlocked** — converting a source-text
   guard into executable assertions about ordering, idempotency, and gating.

This is the framing the plan uses, and it satisfies the spec's prohibition on LOC as a success metric.

---

## R0-5 — Baseline verification state

### Finding

`npm run typecheck` and `npm run lint` were executed this session and both exited non-zero:

```text
'tsc' is not recognized as an internal or external command
'eslint' is not recognized as an internal or external command
```

Root cause: **`node_modules` is not present** in this working copy. The toolchain is unresolvable; the
gates have not actually executed against `69c19f4`.

### Decision

- **No green baseline is asserted** anywhere in the plan or spec. Spec NFR-1 was corrected to record the
  baseline as UNVERIFIED rather than PASS.
- `npm install` + capturing the three gates is a **prerequisite** (plan step 0), not a plan deliverable.
  It is an environment action touching no tracked file; it does not authorize any `package.json` or
  lockfile edit (FR-22, NFR-4).
- If the baseline is not green after install, failures are triaged **before** any extraction —
  refactoring onto an unknown baseline makes "behavior preserved" unprovable.

### Note on prior reporting

An earlier audit session reported these gates as PASS at this same HEAD. That reading was incorrect:
with `node_modules` absent the underlying tools cannot have run. Recorded here so no downstream artifact
inherits the stale claim.

---

## R0-6 — Rename candidate qualification method (drives AD-6)

### Finding

A mechanical filter is not sound. Testing a grep-based proxy ("does the file import from `ui/`?") against
the 13 `*Placeholder`/`*Skeleton`/`*Demo` files mis-sorted real cases in both directions:

| Surface | Mechanical signal | Actual behavior | Correct verdict |
|:--|:--|:--|:--|
| `CartPlaceholder` | 3 ui imports | Mounts live `CartPane` + `CatalogueSalePane` | **Misleading — rename** |
| `SalesPlaceholder` | 2 ui imports | Mounts live `FindSaleReceipt` (real reprint feature) | **Misleading — rename** |
| `CheckoutPlaceholder` | 0 ui imports | **Live** — rendered at `CheckoutRoute:47` as the flag-off fallback | **Misleading — rename; must NOT be deleted** |
| `InventoryPlaceholder` | 1 ui import | Imports state primitives only; genuinely a placeholder | **Correctly named — out of scope** |
| `EmptyCartPlaceholder` | 0 | Genuine empty state | **Correctly named — out of scope** |
| `DiscountPlaceholderRow` | 0 | Genuine reserved row | **Correctly named — out of scope** |

`voucher-authority/` is a separate confirmed case: the directory name asserts an authority POS does not
hold — it contains only HTTP clients to Data-Pulse-2 (`validate`/`redeem`/`reverse`).

### Decision

Qualification is **behavioral, verified per surface by reading the code** — never by pattern match
(FR-7). Each rename records: what the name claims, what the code does, and the before/after rendered
component set on every path including flag-off (SC-10). Coupled tests (21 files reference these names)
are updated in the same slice (FR-9).

---

## R0-7 — Evidence gates for S5 and S6

| Slice | Evidence found | Gate |
|:--|:--|:--|
| **S5** sync consolidation | `sales-sync/` = 5 files; `sync-outbox/` = 1 repository file | Proceed only if ownership is demonstrably clearer afterward. A one-file move is legitimate; a "sync ownership redesign" is not. **Drop if the gate fails.** |
| **S6** diagnostics labeling | `CatalogueDiagnostics` already routed at `inventory/diagnostics` (`router.tsx:205`) — **not** leaking into the cashier flow | Scope is labeling/grouping clarity only. Not a redesign of diagnostics or cashier UI. **Drop if the gate fails.** |

Both slices are explicitly droppable; FR-13 forbids moving modules merely for a tidier tree.
