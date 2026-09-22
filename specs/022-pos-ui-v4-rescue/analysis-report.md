# Cross-Artifact Analysis — POS UI v4.0 Rescue

**Feature:** 022-pos-ui-v4-rescue
**Analyzed:** 2026-09-18
**Artifacts:** [spec.md](./spec.md) · [plan.md](./plan.md) · [research.md](./research.md) ·
[tasks.md](./tasks.md) · [quickstart.md](./quickstart.md) · [checklists/requirements.md](./checklists/requirements.md)
**Constitution:** v1.5.1

---

## Verdict

| Metric | Result |
|:--|:--|
| CRITICAL findings | **0** |
| HIGH findings | **3** (all fixed in this pass) |
| MEDIUM findings | **3** (all fixed in this pass) |
| LOW findings | **2** (1 fixed, 1 accepted) |
| External review findings | **6** — 1 × P1, 5 × P2 (3 on PR #444 + 3 follow-ups), **all verified against source, all correct, all fixed** (see Addendum) |
| Duplicate task IDs | 0 |
| Constitution violations | 0 |
| Open questions | 0 |

**Cleared for implementation** after the fixes recorded below and in the Addendum.

---

## Coverage

| Dimension | Before fixes | After fixes |
|:--|:--:|:--:|
| FR with a mapped task | 43 / 47 | **47 / 47** |
| NFR with a mapped task | 6 / 7 | **7 / 7** |
| SC with a verification task | 17 / 20 | **20 / 20** |
| Tasks | 73 | **76** (+T019a, T034, T106) → **79** (R1–R3) → **84** (R4–R6) |

*Traceability note:* many requirements were **covered in substance but not cited by ID**, which made
coverage unverifiable by inspection. Finding A2 addresses this.

---

## Findings

### A1 — [HIGH] Three anti-pattern prohibitions had no verification task ✅ FIXED

**FR-34** (no decorative gradients/glow/shadow-stacking), **FR-35** (no marketing hero/tagline
content) and **FR-36** (no decorative icon tiles) are prohibitions the spec treats as load-bearing —
they are the defence against the reference images' marketing chrome bleeding into the terminal. No
task asserted any of them.

This is the single highest-leverage gap: reference images 1, 2 and 5 all contain a marketing hero
band and tagline, exactly the content FR-35 forbids. Without an explicit check, "it looked like the
reference" is the failure path.

**Fix:** added **T106** (US6) — a cross-surface anti-pattern verification covering FR-33–FR-39.

### A2 — [HIGH] Requirement traceability not verifiable by inspection ✅ FIXED

26 FRs and 17 SCs lacked an explicit ID citation in `tasks.md`. Most were genuinely covered
(FR-1/2/3 by T021/T022/T023, for example), but coverage could not be *confirmed* without re-deriving
intent — precisely what `/speckit-analyze` exists to prevent, and what makes later drift invisible.

**Fix:** added a **Requirement → Task traceability matrix** to `tasks.md` mapping every FR, NFR and
SC to its verifying task.

### A3 — [HIGH] `onNewSale` preservation asserted in prose only ✅ FIXED

**FR-30** requires the completion surface to retain existing "new sale" behaviour. US4a's
*Independent test* narrative mentions it, but no task asserted it. US4a rewrites the settled branch
that owns that button — the exact place where a working reset/navigate is most easily dropped.

`CheckoutRoute.handleNewSale` resets the payment **and** cart stores then navigates to `/app/cart`;
losing it would strand the cashier on a settled surface (the documented prior dead-end).

**Fix:** added **T019a** (US4a) — RED+GREEN asserting `onNewSale` still resets both stores and
returns to the cart after the settled-branch rewrite.

### A4 — [MEDIUM] NFR-5 (first-paint performance) uncovered ✅ FIXED

NFR-5 forbids regressing first-paint beyond the existing shell budget. U0 changes the root
stylesheet and the default theme — the most plausible source of such a regression — and no task
checked it. `AppShell.first-paint-perf.test.tsx` already exists.

**Fix:** added **T034** (US0) asserting the existing first-paint perf test stays green after the
token/theme change.

### A5 — [MEDIUM] Task ID collision across phases ✅ FIXED

**T093** was defined in Phase 8 (US4) while the `09x` block belongs to Phase 9 (US5, T090–T092).
Same-decade IDs spanning two phases invite mis-sequencing during execution.

**Fix:** renumbered to **T083** within Phase 8's block; the forward reference in T0A2 updated.

### A6 — [MEDIUM] U4a "before" screenshot not reliably capturable ✅ FIXED

T0A2 asked for a before-screenshot "from an earlier run or git stash of the built app". Since US4a
ships **first**, no prior v4.0-era build exists, and stashing to rebuild is brittle. The spec's
screenshot workflow says "before screenshot **where possible**" — the task overstated it.

**Fix:** T0A2 reworded — capture the before-state from the **current `main` build before the branch
diverges**, and if unavailable, record "no before-capture available (first slice)" explicitly rather
than fabricating one. Honest absence beats a manufactured artifact.

### A7 — [LOW] Screenshot storage vs. repository size ✅ ACCEPTED, documented

`visual-references/` already adds 6.4 MB. Roughly 14 screenshots across 8 slices at ≤400 KB each
adds up to ~5 MB more.

**Resolution:** accepted. The ≤400 KB budget and the prune-superseded rule (T113, T083) are already
in place; T001 records both. Owner may revisit if the repository grows uncomfortable.

### A8 — [LOW] `specs/README.md` row stale ✅ ALREADY TRACKED

The 022 row still says "SPECIFY only". Already assigned to **T042** (US0-R). No new action.

---

## Consistency Checks

| Check | Result |
|:--|:--:|
| Spec ↔ plan slice structure (U0–U6 + U4a + U0-R) | **PASS** |
| Plan ↔ tasks slice ordering (U4a → U0 → U1–U6) | **PASS** |
| Research decisions reflected in tasks (font stack T026, light flip T020–T022, dark register T024, U4a wiring T011) | **PASS** |
| Quickstart ↔ tasks dev-path (bypass-log verification) | **PASS** — T002 mirrors quickstart §3 |
| Duplicate task IDs | **PASS** — none |
| Terminology (v4.0 / v3.5 / Non-Capability) | **PASS** — consistent |
| Spec Open Questions vs. tasks | **PASS** — 0 open, none re-raised |
| Non-Capability Inventory enforced in tasks | **PASS** — T064 (VAT), T071 (tenders), T054 (shift-start), T082 (dispatch/confetti/KPI), T112 (global) |

---

## Constitution Re-Check (post-tasks)

Both sets re-walked. No task introduces a violation.

| Principle | Status | Evidence in tasks |
|:--|:--:|:--|
| II. Financial Precision | **PASS** | T072/T073 forbid client-side money arithmetic and voucher authority; T074 requires money tests unmodified |
| III. Process-Boundary | **PASS** | Standing constraint + T111 verifies no `src/main`/`src/preload`/`bridge-api`/`migrations` diff |
| IV. Hardware Loud | **PASS** | T081 restyles printer/drawer banners, never suppresses |
| VI. Test-First | **PASS** | Every implementation task has a RED predecessor |
| IX. Reference, Not Inheritance | **PASS** | v4.0 re-derived against production tokens; no prototype code pasted |
| P2. No Fake Success | **PASS** | T018/T019 mandate honest degradation; T082 forbids confetti/fabricated fiscal data |
| P8. Security Boundary | **PASS** | Standing constraint; T017 notes `ReceiptPreview` is a *new consumer of an existing channel*, not a surface change |
| P13. Small Scoped PRs | **PASS** | 8 independently reviewable slices; U0 token-values-only |
| P14. Accessibility | **PASS** | T100–T105 dedicated slice |
| P16. Scope Discipline | **PASS** | Non-Capability enforcement tasks listed above |

**0 VIOLATION · 0 WAIVED.**

---

## Residual Risks (carried, not blocking)

| # | Risk | Carried mitigation |
|:--:|:--|:--|
| 1 | U0's token retune causes visual regressions across many surfaces | Token-values-only; `@layer components` untouched; per-slice screenshots; full suite each slice (plan R8) |
| 2 | Arabic system stack underperforms on target hardware | T028 verification with an explicit STOP-and-escalate; webfont remains an owner decision (research §1 Gate) |
| 3 | U4a's pre-v4.0 screenshot mistaken for final visual record | Explicitly labelled in T0A2; superseded and pruned at T083 |
| 4 | Dark register left as v3.5 → two visual identities | T024 forces an explicit owner decision rather than a silent default |

---

## Addendum — External review (Codex, PR #444, 2026-09-18)

Findings raised on the spec chain by review. **Every one was verified against source before acting,
and every one was correct.** All are fixed. R1–R3 came from the PR #444 review; R4–R6 are the
follow-up findings (Arabic checkout coverage, token-guard completeness, catalogue launch
verification).

### R1 — [P1] Success copy not gated on the finalized sale record ✅ FIXED

**The finding was right, and it exposed a hole in my own NFR-6 enforcement.**
`setPhase('settled')` fires on `payments.confirm` alone (`PaymentSurface.tsx:359-364`) — **before**
the sale is finalized; the finalized record arrives later via the recent-sale poll. T013 as written
would have replaced the settled-phase message with unconditional Arabic *success* copy, asserting a
completed sale without the finalized record NFR-6 and constitution **P2** require. T018/T019 only
omitted the *detail block*; the success claim itself was left unconditional.

**Fix:** **T013a** splits the settled phase into two truthful states — (a) *payment settled, sale not
yet finalized* (no success claim, no receipt, no fabricated number; also the resting state when
`saleFinalization` is off or the poll fails) and (b) *sale finalized* (full success + receipt). A
warning block ties T013's definition of done to T013a so the split cannot be skipped.

### R2 — [P2] Split tender wrongly listed as a non-capability ✅ FIXED

**Correct, and materially so.** Split/multi-tender **is shipped** (006 T154):
`PaymentSurface.handleLineApplied` returns the cashier to tender selection while the applied-line sum
is below the subtotal (`PaymentSurface.tsx:282-313`). Listing it as a Non-Capability item would have
directed implementers — via FR-42 / SC-16 / T112 — to reject or remove a working payment flow, in
direct conflict with FR-40's preservation requirement.

**Fix:** the Non-Capability row is corrected in place (struck through, with the shipping evidence and
a pointer that unsupported tender *types* remain non-capability), and **T075** added to U3 asserting
split tender survives the restyle of that exact surface.

### R3 — [P2] Documented capture path cannot reach a cashier session ✅ FIXED

**Correct.** `POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN=1` seeds a fixture hardcoded to `role: 'manager'`
(`dev-skip-operator-signin.ts:40-47`) with no role override, so the quickstart path cannot evidence
FR-44's **cashier** landing — the very behaviour T0C1 accepted.

**Fix:** **T0C2** added, routing cashier capture through the **cashier PIN path**, which is
local-only and needs no backend (`sign-in-handler.ts:362` — `backend_session_id: ''`): leave the
bypass unset, provision a cashier PIN row, sign in at `/sign-in`. Both the task and
`quickstart.md` now warn that the bypass is manager-only and that **a manager screenshot is not an
acceptable substitute** for a cashier-role acceptance capture. Where a cashier session cannot be
reached honestly, the capture is recorded as absent rather than substituted.

### R4 — [P2] Arabic-first coverage stopped at the settled branch ✅ FIXED

US4a repairs the *settled* surface, but the **working** tender flow retains English-only operator
strings — verified in source: `PaymentSurface.tsx:396` and `:437` render `<h2>Payment</h2>`, and
`PaymentCartSummary.tsx:42,62` render `Order summary` / `Subtotal`. FR-19 and SC-4 demand
Arabic-first across the cashier journey, so checkout would have shipped half-converted.

**Fix:** **T076** (RED — zero English-only operator strings across the whole working tender flow),
**T077** (`PaymentSurface` working phases), **T078** (`PaymentCartSummary`), **T079** (remaining
entry surfaces incl. labels, placeholders, `aria-label`s and validation copy). A warning block marks
T077–T079 **copy/presentation only** — no FSM, money-math, tender-application or voucher-authority
change — and T074/T075 still require every payment test to pass unmodified and split tender to
survive.

### R5 — [P2] Token guard covered only one of FR-8's five value families ✅ FIXED

T025 guarded raw **colour** literals alone, while FR-8 and SC-1 require spacing, radius, typography
size and elevation to resolve through tokens too. Four families were unprotected — precisely where
density and rhythm drift.

**Fix:** T025 extended to all five families with a table naming each family's token source, plus
**T025a** documenting a **closed** structural exception list (`0`/`auto`/`100%`; `1px` hairlines —
width structural, colour still token-bound; media-query breakpoints owned by `useViewportTier`;
component-intrinsic geometry; the constitutional 44×44 floor). The exception is explicitly *not* a
way to silence a failing assertion. The standing-constraints table was widened from "Colour
literals" to "Raw literals" to match.

### R6 — [P2] T002 required a log line that correctly never appears ✅ FIXED

T002 demanded the `catalogue.dev_seed.active` warn line, but
`applyDevSeedCatalogueIfRequested` **no-ops and returns `false` when the catalogue is already
populated** (`dev-seed-catalogue.ts` — `if (alreadyPopulated(deps.db)) return false`). On any re-run
against an existing dev DB the line legitimately never appears, so the task would have failed a
perfectly good environment.

**Fix:** T002 split into two checks with different pass conditions — **(a)** the operator bypass line
remains **mandatory** (its absence means the session is not the fixture operator: STOP), while
**(b)** catalogue readiness accepts **either** the seed line **or** verified evidence that usable
products are present (a successful lookup/search, or a row-count read). An *empty* catalogue with no
seed line remains a STOP. `quickstart.md` §3 restructured to match.

### Post-review totals

| Metric | After external review |
|:--|:--:|
| Tasks | **84** (+T013a, T075, T0C2, then +T025a, T076–T079) |
| FR / NFR / SC coverage | **47/47 · 7/7 · 20/20** (machine-verified) |
| Duplicate task IDs | 0 |
| Matrix references to nonexistent tasks | 0 |

**Reflection:** R1 and R2 are the kind of error this spec exists to prevent — one would have shipped
a fake success state (P2), the other would have deleted a working payment flow (FR-40). Both came
from reasoning about the code at one remove instead of reading the settle/apply paths directly. The
Non-Capability Inventory in particular must be built from source verification per row, not from what
a reference image appears to show.

---

*Analysis complete. 0 CRITICAL, 0 unresolved findings (8 internal + 6 external, all actioned).
Cleared for `/speckit-implement`.*

---

# Reconciliation Pass — 2026-09-22 (post-Stage-0 `50c0cf1`)

**Scope:** post-implementation reconciliation after US4a/US0/US1/US2/US3 merged (PRs #447, #452,
#453, #454, #455). Docs/spec only — no `src/**`, `tests/**`, `migrations/**` or `.specify/**` touched.
**Constitution:** v1.5.1 (verified in `.specify/memory/constitution.md`).

## Verdict

| Metric | Result |
|:--|:--|
| CRITICAL | **0** |
| HIGH | **1** (F-1, reconciled) |
| MEDIUM | **3** (F-2, F-3, F-4 — reconciled) |
| LOW | **2** (F-5 reconciled; F-6 flagged, unfixable in scope) |
| Task IDs renumbered | **0** |
| Suffix IDs added | **1** (T074a) |
| Requirements weakened | **0** |
| Tests modified by this pass | **0** |

---

## F-1 (HIGH) — T074's premise contradicts its own governing rule

**Artifacts:** `tasks.md` T074 · Standing Constraints "Behavioural tests" · `plan.md` §Test-change
policy (`:460-461`) + U3 test-matrix row · merged history of PRs #453/#455.

**Finding.** T074 scoped "must pass unmodified" by **path glob** (`payments/__tests__/**`); the rule
it implements scopes it by **category** — *"Behavioural tests (payment, cart, money, routing
guards)"*. These are different sets. plan.md's **own U3 row** lists
`tender-surface-recompose.test.tsx` under *"Existing tests that must stay green"* while assigning
*"Tender presentation"* updates in that same directory — so a presentation test under the payments
path was anticipated by the plan. The glob was never the intended constraint.

**Evidence (git, not test-run — "unmodified" is a git claim).** Across `94e4864^..HEAD`:
behavioural files byte-identical (`parse-currency-to-minor.test.ts`,
`PaymentSurface.money-safety-guards.test.tsx`, `CashEntry.no-overapply.test.tsx`,
`CashEntry.currency-input.test.tsx`, `PaymentSurface.settled-receipt.test.tsx`); four changed files
are **new additions** mandated by T070/T071/T075/T076; the single modified file self-declares as a
*"visual recompose"* test in its header and asserts CSS class structure. **All four N1–N4 negative
behavioural guards untouched** (no insurance/credit label, no `method-grid--four`, no client-side
voucher lookup, no client-side change computation). Suite green: 487 files / 5688 passed / 3 skipped.

**Reconciliation.** T074 **reworded** to the category scope with the behavioural files named
explicitly (premise correction — the mismatch was in the task text, not the implementation).
FR-40, payment FSM, money math, tender application and voucher authority preserved; no test weakened.

**Residual, deliberately not waived.** SC-15 permits such a change only when *"explicitly
owner-sanctioned"* — unsatisfied at the time of writing (the four T054 ledger rows carry sanction;
this fifth did not). Carried as **T074a** (suffix infill).

**✅ RESOLVED same pass (owner-delegated, 2026-09-22): T074a RATIFIED under SC-15, option (i).**
Verified before ratifying that the replacement invariant is **strictly stronger**, not equivalent:
the old `toBeInTheDocument()` was a *local presence* check that a regression would still have passed
in 2 of 3 components; the new one asserts `.amount-due-card` absence **tree-wide across all three
tender phases**, the superseded label `المطلوب دفعه` absent from `document.body` anywhere, and the
positive surface-owned panel present with `dir="ltr"` — plus a third block pinning that the engine
value and every calculation survive. **No test weakened.** Ratification is narrow: it covers exactly
the two changes in ledger row 5 and broadens no grant. **T074 and T074a both now ticked.**

## F-2 (MEDIUM) — "re-capture" premise false in 6 places

`plan.md:189`, `:379`, `:508`, `:547` and `tasks.md` §Dependencies + §Implementation Strategy all
assume T0A2's pre-v4.0 capture exists to be superseded and pruned. **It was never taken** —
`screenshots/` has only ever held `README.md`. **Reconciled:** all six annotated; T083 is the
**first** valid v4.0 sale-success capture. The U4a-before-U0 *ordering rationale* is unaffected and
retained; only its consequence never materialised. No screenshot fabricated.

## F-3 (MEDIUM) — T0C2 misclassified as capturable

T0C2 step 2 ("provision a cashier PIN row") reads as actionable. Measured: **`cashier_pin_records`
= 0 rows**, dev bypass hardcoded `role: 'manager'`. POS-019 owns `provisionCashierPin` but **no
shipped renderer path invokes it**. **Reconciled:** reclassified as a **blocked external
prerequisite** — a third class distinct from #448 (deferred/reachable) and #450
(impossible/dropped). Explicitly walled against the six forbidden unblock routes. **Tracked as
[#457](https://github.com/Kemetra/POS/issues/457)** (`status:blocked`), created 2026-09-22 under
owner delegation.

## F-4 (MEDIUM) — historical T002 vs per-capture gate conflated

T002 completed 2026-09-19 reads as standing clearance; the gate is **per-capture**. Today's two
launches (`08:38:54Z`, `08:40:12Z`) booted healthily but showed **no `operator.dev_bypass.active`** —
plain `npm run dev` without the dev env vars. Catalogue verified PASS (products=50,
product_barcodes=49). **Reconciled** in `screenshots/README.md`: T002 stays historically completed;
every new capture launch must independently re-observe the bypass line **in the rotating log file**.

## F-5 (LOW) — T076–T079 anchors historical post-merge

Anchors still resolve, but the English strings they cite are **gone as intended**
(`PaymentSurface.tsx:482/484` = `الدفع`; `PaymentCartSummary.tsx:42/62` = `ملخص الطلب` /
`الإجمالي الفرعي`). **Reconciled** with a status banner: completed tasks reading as change-instructions
is expected, not a defect; do **not** restore English to make the wording literal.

## F-6 (LOW) — stale Constitution version in project `CLAUDE.md` — **FLAGGED, NOT FIXED**

`CLAUDE.md` cites the constitution as **v1.3.0**; the actual file is **v1.5.1** (this report's
original header was correct). `CLAUDE.md` is outside this pass's allowed edit scope, so it is
flagged for owner action rather than fixed.

## Coverage after reconciliation

| Dimension | Result |
|:--|:--|
| FR | **47/47** — unchanged; no FR added, removed or reworded |
| NFR | **7/7** — unchanged |
| SC | **20/20** — unchanged. SC-15's owner-sanction clause now has an explicit owner in T074a (previously unowned) |
| Tasks | **85** (84 + T074a); T074 + T074a both ticked |
| Duplicate task IDs | 0 |
| Renumbered IDs | 0 |

**Unresolved owner decisions after delegation: 0 blocking.** T074a was ratified in this pass
(above). **F-6 remains flagged-not-fixed** — the stale Constitution version in `CLAUDE.md` is
outside every allowed edit scope and needs an owner edit; it blocks nothing.

*Reconciliation complete. 0 CRITICAL. Phase 8 / US4 not started; Maestro preflight not run.*
