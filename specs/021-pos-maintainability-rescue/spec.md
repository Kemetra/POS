# Feature Specification: POS Maintainability Rescue (R1 Composition Refactor · R2 Comprehension Cleanup)

**Feature ID:** 021-pos-maintainability-rescue
**Status:** Draft — `/speckit-specify` ✅ · `/speckit-clarify` ✅ (2026-09-18; 2 Q resolved, 0 open)
**Created:** 2026-09-18
**Last Updated:** 2026-09-18
**Owner:** Owner (Ahmed Shaaban)

> **SPEC-ONLY.** This artifact is the `/speckit-specify` + `/speckit-clarify` output. No implementation,
> no production-code edit, no migration, no branch, no commit. Implementation architecture (module
> boundaries, function signatures, file lists, extraction order) belongs to `/speckit-plan` and is
> deliberately absent here.

> **Constitution pin:** v1.5.1 (`.specify/memory/constitution.md`). Principles most load-bearing for this
> feature: **P13** (small scoped PRs), **P16** (feature scope discipline), **VI** (test-first,
> coverage-gated), **III / P8** (Electron process-boundary discipline), **P12** (Spec Kit artifacts are
> source of truth).

---

## Clarifications

### Session 2026-09-18

Both questions carried out of `/speckit-specify` are resolved by owner decision. No question is deferred.

- **Q: Where should the single current-architecture reference (FR-18) live?** → A: **A new canonical
  document at `docs/architecture/current.md`**, describing the CURRENT internal POS architecture and
  responsibility map. — Verified this session: `docs/architecture/` **already exists** and already holds
  `synchronization.md` plus a live-map pair (`pos-pulse-live-map.html` / `.json`). `current.md` is
  therefore a new sibling in an established directory, not a greenfield location. Historical feature
  specs are explicitly **not** the authority for current architecture.

- **Q: What is the scope boundary between `current.md` and the existing `synchronization.md`?**
  *(sub-question raised by the evidence above; decided in the same session)* → A: **Disjoint by
  concern.** `docs/architecture/current.md` owns the **internal** POS architecture and responsibility
  map (which subsystem owns what, where bootstrap/terminal/operator/catalogue/cart/checkout/sales/
  receipts/sync/hardware/db responsibilities live). `docs/architecture/synchronization.md` stays focused
  **only** on the cross-repo synchronization boundary `POS → Backend/Data-Pulse → ERPNext Connector →
  ERPNext`. — Recorded because the two files would otherwise drift into duplication; `synchronization.md`
  already correctly owns that boundary, so this is a preservation decision, not a change to it.

- **Q: What is the accepted mechanism for demoting historical specs (FR-17)?** → A: **A new lightweight
  status index at `specs/README.md`.** Existing `specs/<id>/` directories **remain in place** — implemented
  specs are NOT moved to `docs/history/` and are NOT deleted. The index MUST distinguish at minimum
  **Active**, **Implemented / Historical**, **Deferred**, and **Superseded** (the last only where evidence
  supports it). — Verified this session: `specs/README.md` does not currently exist. Historical specs
  remain traceability artifacts, not current architectural authority.

- **Q: May historical specs be mass-edited to carry status banners?** → A: **No.** Status is conveyed by
  the central `specs/README.md` index. Mass-editing every historical spec merely to add a label is
  excluded — it would be an unbounded, unreviewable diff across 21 spec directories, contradicting P13
  and this feature's own bounded-slice rule (FR-6, NFR-2).

**Evidence note (verified against `main` @ `69c19f4`, this session):** `docs/architecture/synchronization.md`
currently closes with *"See the repo's `specs/**` and `CLAUDE.md` for the authoritative implementation
state."* That pointer makes `specs/**` an authority for current state, which these decisions supersede.
Correcting that single line is in scope for the documentation-authority slice (see FR-17a); it is one line
in one existing file and does not constitute a mass edit.

---

## Overview

POS-Pulse is functionally healthy but expensive to understand. A read-only rescue audit against `main`
@ `69c19f4` found the application highly salvageable, its core responsibilities correctly located, and a
rewrite unjustified — while identifying two concentrated sources of maintenance risk: a composition root
that owns too many unrelated concerns, and implementation naming that no longer describes runtime
behavior.

This feature reduces cognitive complexity and maintenance risk **without changing any runtime behavior**.
It covers exactly two workstreams: **R1 — Composition Refactor** (reduce responsibility concentration in
the application composition root, with explicit, independently testable startup/shutdown ownership) and
**R2 — Comprehension Cleanup** (eliminate names and claims that contradict observable behavior, and
separate current architectural authority from historical implementation record).

The beneficiary is the engineer maintaining POS-Pulse. Success is measured by *where responsibility
lives* and *what is provably unchanged* — never by lines removed.

---

## User Scenarios & Testing

### Primary User Story

An engineer joins POS-Pulse and is asked to change how background sync workers shut down. Today they must
read a 1,393-line composition root in which database handles, Electron window creation, subsystem
construction, feature-gated worker startup, and shutdown ordering are interleaved, and in which four
process-lifetime mutable handles are declared at module scope. They must also decode identifiers and
comments written in spec dialect (`T094c`, `§A4`, `AD-7`, `R-RISK-2`) and reconcile file names that
contradict what the files do. After this feature, the same engineer locates worker lifecycle in one place
with explicit ownership, changes it, runs its dedicated tests covering start order and cleanup, and ships
— without reading unrelated bootstrap concerns and without consulting historical task IDs. Every cashier
behavior, offline guarantee, security boundary, payment semantic, and backend contract is byte-for-byte
unchanged.

### Acceptance Scenarios

1. **Engineer onboarding — locate responsibility without historical context**
   - **Given** an engineer with no knowledge of features 001–020 and no access to `specs/`
   - **When** they are asked where application bootstrap, terminal, operator, catalogue, cart,
     checkout/payments, sales, receipts, sync, hardware, and database responsibilities live
   - **Then** they identify each from `docs/architecture/current.md` and the source tree alone, without
     following task IDs, gate markers, or spec cross-references

2. **Safe maintenance — bounded subsystem change**
   - **Given** an engineer modifying background-worker lifecycle
   - **When** they make the change
   - **Then** they do not need to read or modify database bootstrap, Electron window creation, or
     unrelated subsystem construction, and the change is reviewable in isolation

3. **Behavior-preserving refactor — nothing observable changes**
   - **Given** any completed rescue slice
   - **When** the full verification suite is run (`npm run typecheck`, `npm run lint`, `npm test`)
   - **Then** all gates pass, and no cashier-visible behavior, offline behavior, security boundary,
     bridge contract, database schema, or payment/sale semantic differs from before the slice

4. **Historical traceability — the past is available but not authoritative**
   - **Given** an engineer reading a historical spec for features 001–020
   - **When** they consult it
   - **Then** it remains present and readable at its original `specs/<id>/` path, and its status
     (Active / Implemented-Historical / Deferred / Superseded) is unambiguously determinable from
     `specs/README.md` — without that spec having been edited to say so

5. **Operational clarity — surface classification is explicit**
   - **Given** any user-facing or developer-facing surface in the application
   - **When** an engineer inspects it
   - **Then** they can determine whether it is production, fallback, diagnostic, or demo without reading
     its implementation

6. **Gated is not missing — renames preserve flag behavior**
   - **Given** a surface whose name suggests it is unbuilt but which renders live functionality, or which
     serves as a feature-flag-off fallback
   - **When** it is renamed under R2
   - **Then** the component rendered on both the flag-on and flag-off paths is unchanged, and feature-flag
     defaults are untouched

7. **Startup failure — ordering and cleanup hold**
   - **Given** a bootstrap step that fails during application startup
   - **When** startup aborts
   - **Then** previously started resources are released in the correct order and the process exits with
     the same failure semantics as before the refactor

### Edge Cases

- **Worker startup failure.** A background worker fails to start. Remaining startup steps and the
  application's failure/exit behavior MUST be unchanged from current behavior.
- **Worker shutdown ordering.** Workers MUST stop in a defined order, and a worker whose stop routine
  throws MUST NOT prevent remaining workers from stopping (current behavior: failures are logged, not
  propagated).
- **Shutdown while background work is in flight.** Application quit during an active sync drain, catalogue
  read-down, or finalize pass MUST preserve current durability and resumption behavior.
- **Database close ordering.** The database handle MUST be closed exactly once, after all workers that use
  it have stopped. Extraction MUST NOT introduce a window where a stopped-but-draining worker can touch a
  closed handle.
- **Paired vs unpaired terminal startup.** Both startup paths MUST be preserved exactly; workers gated on
  the paired-terminal branch MUST remain gated identically.
- **Feature-gated behavior.** All feature flags MUST retain their current defaults and gating semantics.
  No flag is flipped, removed, added, or re-scoped by this feature.
- **Production vs dev/demo separation.** Dev-only and demo-only code paths MUST remain unreachable in
  packaged builds by the same mechanism they use today.
- **Renamed modules retaining contracts.** A rename MUST NOT change any IPC channel name, bridge API
  shape, exported contract consumed across the process boundary, or database identifier.
- **Historical names referenced by tests and docs.** Renames MUST update coupled tests within the same
  slice. At time of writing, 21 test files reference `Placeholder`/`Skeleton` identifiers; a rename that
  leaves tests referencing a dead name is incomplete, not deferrable.
- **Accidental scope creep.** Any change touching payments, sales, auth, contracts, schema, or Backend
  discovered mid-slice MUST be filed as a follow-up, never folded in (P13).

---

## Requirements

### Functional Requirements

**R1 — Composition Refactor**

- **FR-1.** Responsibility concentration in the application composition root MUST be reduced by extracting
  distinct bootstrap concerns into independently comprehensible units. Candidate concerns include
  background-worker lifecycle, database bootstrap, Electron/window bootstrap, application lifecycle
  wiring, and subsystem construction.
- **FR-2.** Process-lifetime mutable state MUST NOT remain declared directly in the composition root where
  extraction is justified. At time of writing the composition root declares four such handles
  (`dbHandle`, `finalizeListenerStop`, `readDownDriverStop`, `saleSyncIntervalStop`).
- **FR-3.** Startup ordering and shutdown ordering MUST be explicit and inspectable after extraction, not
  implied by statement order inside a single long procedure.
- **FR-4.** Each extracted bootstrap boundary MUST be independently testable, with tests asserting start
  ordering, stop ordering, and cleanup — including that a throwing stop routine does not prevent remaining
  cleanup.
- **FR-5.** Extraction MUST NOT introduce, remove, reorder, or re-gate any lifecycle step. Gating
  conditions (feature flags, paired-terminal branch) MUST be preserved exactly.
- **FR-6.** R1 MUST be delivered as multiple small slices. A single large composition rewrite is
  prohibited (P13).

**R2 — Comprehension Cleanup**

- **FR-7.** Production identifiers whose name contradicts observable runtime behavior MUST be renamed to
  describe what they do. Qualification MUST be established by reading runtime behavior case-by-case, never
  by pattern match alone.
- **FR-8.** Renaming MUST be behavior-preserving: no change to rendered components on any code path, no
  change to feature-flag gating or defaults, no change to exported cross-boundary contracts.
- **FR-9.** Each rename slice MUST update all coupled references — tests, imports, documentation — within
  the same slice.
- **FR-10.** Obsolete comments asserting a status that is no longer true (e.g. referencing a blocker,
  gate, or pending work that has since resolved) MUST be corrected or removed when encountered in a file
  already in slice scope.
- **FR-11.** Production, fallback, diagnostic, and demo surfaces MUST be distinguishable without reading
  their implementation.
- **FR-12.** R2 MUST NOT attempt wholesale removal of spec-dialect tokens from comments. At time of
  writing 234 of 298 production source files (79%) contain such tokens; a sweep of that size cannot be a
  bounded, reviewable slice and is explicitly excluded (see Out of Scope).

**R3 — Structural clarity (evidence-gated)**

- **FR-13.** Module boundaries MAY be clarified **only** where current structure demonstrably obscures
  ownership, and only with evidence cited in the plan. Moving modules to produce a tidier directory tree
  is prohibited.
- **FR-14.** Any structural move MUST preserve all import contracts and MUST NOT alter runtime wiring.

**R4 — Documentation authority**

- **FR-15.** Documentation MUST distinguish **CURRENT ARCHITECTURE** from **HISTORICAL IMPLEMENTATION
  RECORD**.
- **FR-16.** Historical specs for implemented features MUST be retained **in place** at their existing
  `specs/<id>/` paths. Deletion on grounds of "implementation complete" is prohibited, and implemented
  specs MUST NOT be relocated (e.g. to `docs/history/`).
- **FR-17.** Historical specs MUST be demoted from current architectural authority — readable and
  traceable, but not mistakable for current instruction. Demotion MUST be achieved via a central status
  index (FR-17b), **not** by editing each historical spec.
- **FR-17a.** Any existing document that currently points to `specs/**` as the authority for *current*
  architectural or implementation state MUST be corrected to point at the canonical current-architecture
  reference (FR-18). At time of writing this applies to the closing line of
  `docs/architecture/synchronization.md`.
- **FR-17b.** A lightweight spec-status index MUST exist at `specs/README.md`, classifying each spec
  directory as at minimum **Active**, **Implemented / Historical**, **Deferred**, or **Superseded**. The
  **Superseded** status MUST be applied only where evidence supports it.
- **FR-17c.** Historical specs MUST NOT be mass-edited solely to add status labels. Status is conveyed by
  the FR-17b index.
- **FR-18.** Exactly one canonical current-architecture reference MUST exist at
  `docs/architecture/current.md`, describing the current **internal** POS architecture and responsibility
  map, and sufficient to satisfy Acceptance Scenario 1 without historical spec context.
- **FR-18a.** `docs/architecture/synchronization.md` MUST remain scoped to the cross-repo synchronization
  boundary `POS → Backend/Data-Pulse → ERPNext Connector → ERPNext`. Internal responsibility mapping
  belongs to FR-18's `current.md`; the two documents MUST NOT duplicate each other's concern.

**R5 — Invariant preservation (applies to every slice)**

- **FR-19.** The platform direction `POS → Backend / Data-Pulse → ERPNext Connector → ERPNext` MUST be
  preserved. POS MUST NOT call ERPNext directly.
- **FR-20.** The following MUST remain unchanged: local checkout availability where designed, crash
  safety, offline operation, SQLite durability guarantees, idempotency, append-only and outbox guarantees,
  local hardware ownership, security and trust boundaries, and current backend authority boundaries.
- **FR-21.** Complexity that exists to guarantee local consistency, crash safety, or offline availability
  MUST NOT be removed in the name of simplification.
- **FR-22.** No slice may change public bridge/API contracts, database schema, migrations, payment or
  tender FSM semantics, sale finalization semantics, retry/backoff behavior, or feature-flag defaults.

### Non-Functional Requirements

- **NFR-1.** Every slice MUST leave `npm run typecheck`, `npm run lint`, and `npm test` green. Baseline at
  time of writing: 467 test files present in the tree. **Baseline gate status is UNVERIFIED** —
  `node_modules` is absent from this working copy, so `tsc`/`eslint`/`vitest` have not been executed
  against `69c19f4`. Establishing a green baseline (via `npm install`, an environment step, not a code
  change) is a prerequisite for the first implementation slice.
- **NFR-2.** Each slice MUST be independently reviewable with bounded file scope, and MUST stage only
  named files (P13).
- **NFR-3.** Test coverage MUST NOT regress. Extracted lifecycle units MUST add tests rather than relocate
  assertions (Principle VI).
- **NFR-4.** No new runtime dependencies may be introduced.
- **NFR-5.** Electron process-boundary discipline (`contextIsolation`, `sandbox`, `nodeIntegration: false`,
  typed preload bridge) MUST be preserved unchanged (Principle III / P8).

---

## Success Criteria

- **SC-1.** No process-lifetime mutable state is declared directly in the application composition root
  where extraction was justified; each such handle has a single named owning unit.
- **SC-2.** Every extracted bootstrap boundary has at least one test asserting start ordering, stop
  ordering, and cleanup-on-failure, and those tests fail if ordering is altered.
- **SC-3.** `npm run typecheck`, `npm run lint`, and `npm test` are green after every slice, with no test
  deleted or skipped to achieve it.
- **SC-4.** Zero diffs to: IPC channel names, bridge API shapes, `migrations/`, database schema, payment
  and tender FSM transition tables, sale finalization transaction semantics, and feature-flag default
  values — verifiable by inspecting each slice's diff.
- **SC-5.** No production identifier named `*Placeholder`, `*Skeleton`, or `*Demo` renders a live,
  production-reachable feature surface. (At time of writing this is violated by at least four surfaces,
  confirmed by behavioral inspection.)
- **SC-6.** No production directory or module name asserts an authority or capability the code does not
  hold. (At time of writing, `voucher-authority/` contains only HTTP clients to the backend; POS holds no
  voucher decision logic.)
- **SC-7.** An engineer with no `specs/` access can complete Acceptance Scenario 1 using
  `docs/architecture/current.md` plus the source tree.
- **SC-8.** Every spec directory present at `69c19f4` remains present, readable, and **at its original
  path**, and is classified in `specs/README.md` as Active, Implemented / Historical, Deferred, or
  Superseded.
- **SC-8a.** No document in the repository points at `specs/**` as the authority for *current*
  architecture or implementation state.
- **SC-8b.** The documentation-authority slice's diff adds `docs/architecture/current.md` and
  `specs/README.md` and edits at most a small, enumerated set of existing files; it contains no bulk edit
  across `specs/<id>/` directories.
- **SC-9.** Each merged slice's diff touches only files within its declared scope; no slice contains
  unrelated cleanup.
- **SC-10.** For every rename, the set of components rendered on each code path — including
  feature-flag-off fallback paths — is identical before and after, demonstrated by test.

> **Explicitly not a success metric:** reduction in lines of code. LOC delta MUST NOT be used to
> justify, size, or accept any slice.

---

## Key Entities

No persistent data entities are introduced, modified, or removed. No schema, no migration, no new table,
column, or index. The entities this feature *reasons about* are source-level only:

- **Composition root** — the single application bootstrap entry point that currently wires all subsystems
  and owns process-lifetime handles.
- **Bootstrap boundary** — an extracted unit owning one startup/shutdown concern with explicit ordering.
- **Surface classification** — the production / fallback / diagnostic / demo category of a user-facing or
  developer-facing surface.
- **Current-architecture reference** — the single authoritative document describing the system as it is.
- **Historical implementation record** — retained prior specs, demoted from current authority.

---

## Assumptions

- **A-1.** The rescue audit's findings are input hypotheses; each fact a slice relies on is re-verified
  against `main` at slice time. Facts cited in this spec were verified against `69c19f4`.
- **A-2.** "Behavior preservation" means observable behavior: cashier-visible outcomes, offline
  guarantees, security boundaries, persisted state, network contracts, and failure modes. Internal call
  structure may change; these may not.
- **A-3.** House Spec Kit practice is template-driven, not command-driven: no `/speckit-*` command files
  exist in this repository, and prior specs (e.g. 017) record that no feature branch is created at
  `specify` time. This spec follows `.specify/templates/spec-template.md` and creates no branch.
- **A-4.** `.specify/feature.json` is a stale pointer to the last implemented feature
  (`019-cashier-pin-provisioning`) and is intentionally left untouched by this spec.
- **A-5.** The conceptual target architecture (app · terminal · operator · catalogue · cart ·
  checkout/payments · sales · receipts · sync · hardware · db) is a comprehension goal, not a mandatory
  folder rewrite. The current tree already approximates it.
- **A-6.** Gated functionality is built functionality. Feature-flag-off state is never evidence that a
  surface is unimplemented, and is never grounds for deletion.
- **A-7.** `docs/architecture/` is an established directory (it already holds `synchronization.md` and a
  live-map pair). `current.md` joins it as a sibling; the live-map artifacts are untouched by this
  feature.
- **A-8.** `specs/README.md` is a new file; no spec-status index exists today. Its accuracy at authoring
  time is a point-in-time classification, maintained thereafter as specs change status.

---

## Out of Scope

Explicitly NOT delivered by this feature:

- Rewriting POS-Pulse, in whole or in part.
- Redesigning cart, checkout, payment or tender FSM semantics, or sale finalization semantics.
- Changing SQLite durability, outbox behavior, retry/backoff behavior, or idempotency guarantees.
- Weakening any Electron security or trust boundary.
- Replacing or altering local cashier PIN behavior.
- Changing voucher business authority or any backend authority boundary.
- Migrating POS responsibilities to Backend. Any such proposal requires separate evidence and its own
  spec.
- Modifying Data-Pulse / Backend, the ERPNext Connector, or integrating POS with ERPNext.
- Activating currently gated cashier features, or changing any feature-flag default.
- Implementing VAT/fiscal behavior; adding returns, refunds, shifts, or inventory features.
- Adding dependencies, redesigning UI, changing APIs/contracts, or performing database migrations.
- **Wholesale spec-dialect comment removal.** 234 of 298 production files carry such tokens; a repo-wide
  comment sweep is not a bounded slice and is excluded (FR-12). Only names, misleading claims, and
  comments in files already within a slice's scope are in scope.
- **Renaming correctly-named placeholders.** Identifiers that accurately describe a genuine empty,
  reserved, or unbuilt state are correct as-is and MUST NOT be renamed.
- **Relocating or deleting historical specs.** `specs/<id>/` directories stay where they are; no
  `docs/history/` migration, no deletion (FR-16).
- **Mass-editing historical specs to add status labels.** Excluded by FR-17c; status lives in
  `specs/README.md`.
- **Rewriting `docs/architecture/synchronization.md`.** It remains scoped to the cross-repo boundary
  (FR-18a). Only its stale authority pointer is corrected (FR-17a).
- **Expanding `current.md` into cross-repo, backend, or connector architecture.** It covers the internal
  POS responsibility map only.
- Production rollout, release, or deployment activity of any kind.

---

## Dependencies

- `.specify/memory/constitution.md` v1.5.1 — governing principles, pinned.
- `.specify/templates/spec-template.md` — house spec structure.
- Existing verification gates: `npm run typecheck`, `npm run lint`, `npm test`.
- The existing test suite (467 test files) is the primary safety net for behavior preservation; it is a
  dependency, not a deliverable, and MUST NOT be weakened to accommodate a slice.
- No external, cross-repo, or backend dependency. This feature is entirely POS-local.

---

## Sliceability

R1 and R2 MUST be delivered as small, independent, behavior-preserving slices. Candidate shape (to be
refined and ordered by `/speckit-plan`; these are candidates, not immutable requirements):

| Slice | Intent |
|:--|:--|
| **S1** | Extract background-worker lifecycle |
| **S2** | Extract database / bootstrap lifecycle |
| **S3** | Extract Electron / window bootstrap |
| **S4** | Remove misleading and spec-dialect implementation naming |
| **S5** | Clarify / consolidate sync ownership *(evidence-gated)* |
| **S6** | Separate operational diagnostics from cashier-facing surfaces *(evidence-gated)* |
| **S7** | Clarify current-vs-historical documentation authority — add `docs/architecture/current.md` (FR-18) + `specs/README.md` status index (FR-17b); correct the stale `specs/**` authority pointer in `docs/architecture/synchronization.md` (FR-17a). No spec relocation, no spec deletion, no bulk spec edit. |

Every slice MUST: preserve behavior; be independently reviewable; have bounded file scope; carry tests or
explicit validation; and avoid unrelated cleanup. Slices MAY be reordered, split, merged, or dropped by
`/speckit-plan` on evidence — except that no slice may grow into a single large composition rewrite
(FR-6), and evidence-gated slices MUST be dropped if the evidence does not hold.

---

## Open Questions

- (none)

Both questions raised at `/speckit-specify` were resolved by owner decision on 2026-09-18 and are recorded
in [Clarifications](#clarifications). No new blocking question was raised during clarification.

---

*Constitution alignment:* This spec is authored against `.specify/memory/constitution.md` **v1.5.1**. It
is bounded by **P13** (small scoped PRs, stage only named files), **P16** (feature scope discipline — this
feature touches no domain owned by another feature), **Principle VI** (test-first, coverage-gated),
**Principle III / P8** (Electron process-boundary discipline preserved), and **P12** (this artifact, not
the rescue audit, is the requirements source of truth). The explicit "Constitution Check" is performed by
`/speckit-plan` and `/speckit-tasks`.
