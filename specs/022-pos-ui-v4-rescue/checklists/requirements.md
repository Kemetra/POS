# Specification Quality Checklist: POS UI v4.0 — Rescue / Visual Convergence

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-18
**Last Updated**: 2026-09-18 (clarify session — 2 owner decisions recorded)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — typeface *selection* and token
      *values* are deliberately deferred to plan; FR-10 states the outcome, not the package
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — **cashier landing route resolved 2026-09-18**
      (owner Decision 1 → FR-44–FR-47); zero markers remain in spec.md
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable — each SC is countable, grep-able, measurable, or
      observable against the running application; no SC relies on subjective judgement
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined (10 scenarios, Given/When/Then)
- [x] Edge cases are identified (8 cases, incl. gated, offline, refusal, print failure)
- [x] Scope is clearly bounded — U0–U6 scope groups + Non-Capability Inventory + Out of Scope
- [x] Dependencies and assumptions identified (8 assumptions, 5 dependency entries)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Visual-feature-specific checks

- [x] Visual-reference authority recorded, with each reference's contribution named
- [x] Relationship to historical POS v3.5 stated, superseding axes enumerated with `file:line`
      evidence for the superseded position
- [x] Every capability shown in a reference but unsupported by code is classified
      `VISUAL REFERENCE ONLY — NOT CURRENT PRODUCT CAPABILITY` (12 entries)
- [x] Screenshot acceptance requirement recorded, with manual capture permitted and automated
      harness excluded
- [x] Approved reference set vendored in-repo under `visual-references/` with stable names,
      losslessly re-encoded and pixel-verified against the owner-supplied originals (SC-20)
- [x] Reference set cross-linked to the Non-Capability Inventory at the point of use, so a reader
      opening an image meets the caveat where they found it
- [x] Constitution P8 out-of-scope paths listed verbatim (`src/preload/`, `src/main/`,
      `src/shared/bridge-api.ts`, `migrations/`)
- [x] Constitution P2 truthfulness anchor named for the success state (NFR-6)
- [x] Constitution P14 cited and extended rather than restated (NFR-1/2/4)

## Notes

- **Owner decisions A–F recorded as resolved**, not asked again: new visual authority (A),
  light-first (B), pharmacy-teal primary (C), visual-not-functional authority (D), Egypt/product
  truth over mock imagery (E), screenshot acceptance without mandatory harness (F).
- **Clarify session 2026-09-18 — 2 owner decisions recorded; zero questions remain open.**
  - **Decision 1 (cashier landing route)** — the SPECIFY-phase open question is **closed**. A narrow
    role-aware `/app` landing correction is granted as an explicit exception to FR-40:
    `cashier` → `/app/cart`, `manager`/`admin` → `/app/dashboard`. Encoded as **FR-44–FR-47**,
    scenarios 9–10, **SC-19**, Assumption **A9**; assigned to slice **U1**. FR-40 amended to name
    the exception so the blanket preservation rule no longer contradicts it.
    - Scoped deliberately to the **index route** (`router.tsx:175`), **not** `DashboardRoute`'s role
      check (`DashboardRoute.tsx:16-24`) — FR-45 states the role check stays, so direct navigation
      to `/app/dashboard` by a cashier still yields the existing rejection. This prevents a
      plan-phase reading that would strip an authorization-adjacent check.
    - FR-47 keeps the change renderer-side, so **SC-17** (no `src/main/`, `src/preload/`,
      `bridge-api.ts`, `migrations/` changes) survives unchanged.
    - A9 records the honest limit: on a cart-gated build the cashier lands on an English-only gated
      state, so FR-19 is **not** satisfied by FR-44 alone — U2/U5 complete it.
  - **Decision 2 (visual references in-repo)** — the five approved images are vendored at
    `specs/022-pos-ui-v4-rescue/visual-references/` as `01-visual-system` … `05-sale-success`,
    PNG-re-encoded with `optimize=True` (no resize, no mode change) for a ~7–8% size reduction, each
    verified **pixel-identical** to its original before acceptance. Encoded as **SC-20** and
    Assumption **A1** (which previously stated the opposite and was corrected).
- **Follow-up recorded, deliberately not executed:** documentation-authority reconciliation for
  `docs/design/pos-v3.5/CLAUDE.md` (a directory-scoped agent-instruction file that will misinstruct
  once v4.0 governs), plus `README.md:59` and `README.md:64`. Decision A forbids mass-editing v3.5
  documents during SPECIFY.
- **Known existing-test impact recorded:** `theme-contract.test.ts:56` pins `data-theme="dark"`
  in `index.html`; A2 flags it for owner-sanctioned revision at implementation time.
- Counts after clarify: **47 functional requirements** (was 43; +FR-44–47), **7 non-functional
  requirements**, **20 success criteria** (was 18; +SC-19, SC-20), **10 acceptance scenarios**
  (was 8), **8 edge cases**. The edge case "cashier reaches a role-restricted surface" remains
  valid and is now reinforced by FR-45.
- Constitution alignment pinned at **v1.5.1**.
- **Known stale text, deliberately not edited:** the `specs/README.md` row for this feature says
  "SPECIFY only", which this clarify session supersedes. Editing `specs/README.md` was outside the
  scope granted for this phase; flagged for correction at the next permitted edit.
- Phase state: **specify + clarify + plan + tasks + analyze complete**. `/speckit-implement` has NOT
  been run — no production code is touched by this feature branch.
- **Tasks + analyze 2026-09-18** — [`tasks.md`](../tasks.md) (**76 tasks**, RED→GREEN test-first)
  and [`analysis-report.md`](../analysis-report.md). Analysis: **0 CRITICAL**, 3 HIGH + 3 MEDIUM +
  2 LOW, **all actioned** (7 fixed, 1 accepted with documented rationale). Coverage after fixes:
  **47/47 FR · 7/7 NFR · 20/20 SC**, recorded in a Requirement → Task traceability matrix.
  Highest-leverage find: FR-34/35/36 (no gradients / **no marketing hero** / no decorative icon
  tiles) had **no verification task** — the direct defence against the reference images' marketing
  chrome reaching the terminal; fixed as T106.
- **External review 2026-09-18 (Codex, PR #444)** — 3 findings, **all verified against source, all
  correct, all fixed** (→ **79 tasks**): **(P1)** success copy was not gated on the finalized sale
  record — `setPhase('settled')` fires on `payments.confirm` alone, so T013 would have asserted a
  completed sale without the record NFR-6/P2 require → **T013a** splits the settled phase into two
  truthful states. **(P2)** split tender was wrongly listed as a Non-Capability item though 006 T154
  ships it (`PaymentSurface.tsx:282-313`), which would have directed implementers to remove a working
  payment flow → row corrected + **T075** protects it. **(P2)** the documented capture path could not
  reach a cashier session (dev bypass is hardcoded `role: 'manager'`) → **T0C2** routes cashier
  capture through the local-only cashier PIN path; quickstart warns a manager screenshot is not a
  substitute.
- **Plan phase 2026-09-18** — [`plan.md`](../plan.md), [`research.md`](../research.md),
  [`quickstart.md`](../quickstart.md) authored. No `data-model.md` (no persisted entity) and no
  `contracts/` (no IPC/bridge/backend change, P8) — matching 007, the closest UI-only precedent.
  Constitution Check walks **both** sets (Roman I–IX **and** P1–P18) per the constitution's own
  instruction: **0 VIOLATION, 0 WAIVED**. Recommended order: **U4a → U0(+U0-R) → U1 → U2 → U3 →
  U4 → U5 → U6**. U4a's feasibility was verified in source rather than assumed —
  `RecentSaleSummary` already carries `sale_id` (`src/shared/sales/types.ts:165`), so mounting
  `ReceiptPreview` on the completion path needs **no bridge change**.
