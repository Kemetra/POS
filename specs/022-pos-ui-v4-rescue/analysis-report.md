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
| Duplicate task IDs | 0 |
| Constitution violations | 0 |
| Open questions | 0 |

**Cleared for implementation** after the fixes recorded below.

---

## Coverage

| Dimension | Before fixes | After fixes |
|:--|:--:|:--:|
| FR with a mapped task | 43 / 47 | **47 / 47** |
| NFR with a mapped task | 6 / 7 | **7 / 7** |
| SC with a verification task | 17 / 20 | **20 / 20** |
| Tasks | 73 | **76** (+T019a, T034, T106) |

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

*Analysis complete. 0 CRITICAL, 0 unresolved findings. Cleared for `/speckit-implement`.*
