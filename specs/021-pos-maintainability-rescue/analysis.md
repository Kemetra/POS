# Cross-Artifact Analysis — 021 POS Maintainability Rescue

**Feature:** 021-pos-maintainability-rescue
**Artifacts analyzed:** [spec.md](./spec.md) · [plan.md](./plan.md) · [research.md](./research.md) · [tasks.md](./tasks.md)
**Created:** 2026-09-18
**Constitution version pinned:** v1.5.1
**Repository state:** `Kemetra/POS` · `main` @ `69c19f4`

> `/speckit-analyze` output. Cross-artifact consistency, coverage, and constitutional validation.
> No production code inspected for change; all findings are artifact-level unless a code fact is cited.

---

## A. Verdict

| Metric | Result |
|:--|:--|
| CRITICAL issues | **0** |
| HIGH issues | **0** |
| MEDIUM issues | **2** (both resolved in-session, recorded below) |
| LOW / advisory | **3** |
| FR coverage by tasks | **100%** (26/26) |
| SC coverage by tasks | **100%** (12/12) |
| Constitution violations | **0** |
| Ready for `/speckit-implement` | **YES**, S1 only, after Phase-1 baseline gate (T003) |

---

## B. Requirement → Task coverage matrix

Every functional requirement maps to at least one task, and every task maps back to a requirement.

| Req | Covered by | Slice |
|:--|:--|:--|
| FR-1 composition extraction | T016, T034, T041 | S1, S3, S2 |
| FR-2 no module-scope lifetime state | T019, T042, T046, T080 | S1, S2 |
| FR-3 explicit start/shutdown ordering | T011, T012, T018, T040 | S1, S2 |
| FR-4 independently testable boundaries | T010, T030, T040 | S1, S3, S2 |
| FR-5 no lifecycle step added/removed/re-gated | T011, T015, T017, T034 | S1, S3 |
| FR-6 multiple small slices (no giant rewrite) | Phase structure; tasks.md standing constraints | all |
| FR-7 evidence-driven renames | T050–T053 | S4 |
| FR-8 renames behavior-preserving | T052, T055 | S4 |
| FR-9 coupled refs updated in-slice | T050, T051, T052 | S4 |
| FR-10 obsolete comments corrected in-scope | T050–T053 (in-file), T072 | S4, S7 |
| FR-11 surface classification | T054, T062, T063, T070 | S4, S6, S7 |
| FR-12 no repo-wide dialect sweep | T054 (guard), standing constraints | S4 |
| FR-13 structural moves evidence-gated | T060, T062 | S5, S6 |
| FR-14 structural moves preserve imports | T061 | S5 |
| FR-15 current vs historical distinction | T070, T071 | S7 |
| FR-16 specs retained in place | T073 | S7 |
| FR-17 demotion via index, not per-spec edits | T071, T073 | S7 |
| FR-17a stale authority pointers corrected | T072, T074 | S7 |
| FR-17b `specs/README.md` status index | T071 | S7 |
| FR-17c no mass-edit of historical specs | T073 | S7 |
| FR-18 canonical `docs/architecture/current.md` | T070 | S7 |
| FR-18a `synchronization.md` stays cross-repo | T072, T073 | S7 |
| FR-19 platform direction preserved | standing constraints; no cross-repo task exists | all |
| FR-20 invariants unchanged | T023, T037, T043, T082 | all |
| FR-21 local-consistency complexity retained | T043 (explicit non-scope), AD-2 | S1, S2 |
| FR-22 no schema/contract/flag change | T023, T037, T043, T055, T082 | all |
| NFR-1 gates green per slice | T002, T022, T036, T045, T056, T085 | all |
| NFR-2 bounded reviewable slices | T084; one-PR-per-slice rule | all |
| NFR-3 no coverage regression | T010, T030, T040 (tests added, not moved) | S1–S3 |
| NFR-4 no new dependencies | T001 (install only), standing constraints | all |
| NFR-5 Electron boundary preserved | T030–T033, T037 | S3 |

| Success criterion | Verified by |
|:--|:--|
| SC-1 no lifetime state in root | T019, T046, T080 |
| SC-2 ordering/cleanup tests exist and fail on change | T011–T014, T081 |
| SC-3 gates green, no test deleted/skipped | T022, T036, T045, T085 |
| SC-4 zero contract/schema/flag diffs | T023, T037, T043, T082 |
| SC-5 no `*Placeholder` renders live surface | T050–T052, T083 |
| SC-6 no name asserts absent authority | T053, T083 |
| SC-7 onboarding without `specs/` | T070 |
| SC-8 specs present at original paths + classified | T071, T073 |
| SC-8a no doc points at `specs/**` for current state | T074 |
| SC-8b S7 diff has no bulk spec edit | T073 |
| SC-9 slice diffs stay in scope | T084 |
| SC-10 render-set identical incl. flag-off | T052, T055 |

**No orphan tasks.** No task exists without a governing requirement.

---

## C. Findings

### MEDIUM-1 — Baseline was asserted before it was measured *(RESOLVED this session)*

**Detected:** spec NFR-1 originally read *"Baseline at time of writing: typecheck PASS, lint PASS, 467
test files."* That claim was inherited from an earlier audit session.

**Reality:** `node_modules` was absent from the working copy. `npm run typecheck` and `npm run lint` both
exited non-zero with `'tsc' is not recognized` / `'eslint' is not recognized`. The gates had never
executed against `69c19f4`; the earlier exit code was misread as a pass.

**Impact if unresolved:** every slice's acceptance depends on comparing against a green baseline. Starting
S1 against an unmeasured baseline would make "behavior preserved" unprovable — the core claim of the
entire feature.

**Resolution:** spec NFR-1 corrected to record the baseline as UNVERIFIED; plan added a "Validation
prerequisite" section and risk R-11; tasks added blocking Phase 1 (T001–T003) with an explicit STOP gate.
Dependencies were subsequently installed and gates re-run — see §E for measured results.

### MEDIUM-2 — Candidate slice order contradicted by code structure *(RESOLVED in plan)*

**Detected:** the requested sequence placed S2 (database bootstrap) second, implying a block extraction
comparable to S1.

**Reality:** `dbHandle` is opened at `index.ts:367` and consumed by subsystem constructors for ~900
subsequent lines (`bindAuditEventsStoreDb`, `createProductRepo`, `bindPaymentAttemptsRepository`, …).
Bootstrap is interleaved with subsystem construction, not a separable leading phase. Meanwhile
`createWindow()` at `:202` is already a standalone top-level function.

**Impact if unresolved:** S2-second would have invited either a stalled slice or a context-object refactor
threading ~900 lines — precisely the giant refactor FR-6 prohibits.

**Resolution:** plan AD-5 narrows S2 to open/migrate/close mechanics and reorders R1 to **S1 → S3 → S2**,
with alternatives recorded in research R0-3. The brief permits refinement on evidence.

### LOW-1 — Static bootstrap guard is a latent CI tripwire

`src/main/__tests__/bootstrap-wires-operator.test.ts` regex-asserts ~20 import strings in `index.ts`
because the file cannot be imported under Vitest (`app.whenReady()` at module load). S2/S3 may relocate
asserted imports and red the guard, making a behavior-preserving refactor look like a regression.
**Handled:** plan AD-4, risk R-1, tasks T020/T035/T044. **Verified:** S1 does not trip it — every
assertion targets operator/audit/pairing wiring.

### LOW-2 — Shutdown re-entrancy is load-bearing and undocumented in code

`closeDbHandle()` runs twice on a normal Windows exit (`window-all-closed` → `app.quit()` → `quit`).
Safety today rests on `runStopper` returning `null` and the `dbHandle !== null` guard — an implicit
contract with no test. **Handled:** plan AD-3, risk R-2, task T014 (twice-called test). This is the single
most likely silent regression in S1.

### LOW-3 — `data-model.md`, `contracts/`, `quickstart.md` intentionally absent

The plan template lists them. This feature has no data model, no contract change, and its developer-facing
output *is* S7's `current.md`. Producing stubs would add the ceremonial noise R2 exists to remove.
**Handled:** plan Phase 1 records each as N/A with justification (FR-22 + spec Key Entities). Recorded
here so a reviewer does not read absence as omission.

---

## D. Constitution check

| Principle / Constraint | Status | Note |
|:--|:--:|:--|
| I. Offline-First | PASS | No sync/offline/network path altered (FR-20/21) |
| II. Financial Precision | PASS | Not touched; FSM + finalization frozen (FR-22) |
| III. Process-Boundary Discipline | PASS | S3 moves security policy verbatim; T030–T033 assert it literally |
| IV. Hardware Loud, Not Silent | PASS | Printer/drawer untouched |
| V. Type Safety | PASS | Per-slice typecheck; measured green (§E) |
| VI. Test-First, Coverage-Gated | PASS | Tests precede extraction (T010/T030/T040); no test may be deleted (SC-3) |
| VII. Observability | PASS | Logger/Sentry init order preserved |
| VIII. Terminal Identity ≠ User | PASS | Pairing/operator untouched; gating preserved (T015) |
| IX. Reference, Not Inheritance | PASS | No `_reference/` use |
| Platform Integration | PASS | `POS → DP2 → Connector → ERPNext` preserved; no cross-repo task |
| Security | PASS | No secret/PIN/token path altered |
| Hardware Matrix · Domain | PASS | Not touched |
| P12 Spec Kit source of truth | PASS | This chain is the authority; audit was input only |
| P13 Small Scoped PRs | PASS | One slice per PR; stage only named files |
| P16 Feature Scope Discipline | PASS | No other feature's domain implemented |

**0 violations. 0 waivers.**

---

## E. Measured gate status

Executed this session against `main` @ `69c19f4` after `npm install` (T001–T002):

| Gate | Command | Result |
|:--|:--|:--|
| Typecheck | `npm run typecheck` | **PASS** — exit 0 (three tsconfig projects) |
| Lint | `npm run lint` | **PASS** — exit 0 (eslint + prettier) |
| Tests | `npm test` | See §F |

`package-lock.json` was modified by `npm install` (a pre-existing one-line `license` drift, MIT vs
UNLICENSED — unrelated to this feature) and was **reverted**; no tracked file is modified by this chain
(FR-22 / NFR-4).

---

## F. Ambiguities and residual risk

- **Open questions:** 0. Clarification closed 2026-09-18.
- **Residual implementation risk** is concentrated in two places, both test-guarded before code moves:
  shutdown **ordering** (AD-2 / T012) and shutdown **idempotency** (AD-3 / T014).
- **Evidence-gated slices** S5 and S6 may be dropped; dropping on evidence is a correct outcome (FR-13),
  not a shortfall.

## G. Recommendation

Proceed to `/speckit-implement` for **S1 only**, after the Phase-1 baseline gate (T003) passes.
S1 remains the correct first slice: it is the smallest safe cut, it does not trip the static bootstrap
guard, and it converts the composition root's only source-text guard into executable tests — the value
being **testability unlocked**, not code relocated.

Do not begin S2 or S3 in the same PR. Do not combine R1 with R2.
