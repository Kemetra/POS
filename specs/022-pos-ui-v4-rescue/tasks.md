# Tasks: POS UI v4.0 — Rescue / Visual Convergence

**Feature:** 022-pos-ui-v4-rescue
**Plan:** [./plan.md](./plan.md)
**Spec:** [./spec.md](./spec.md)
**Created:** 2026-09-18
**Last Updated:** 2026-09-18

---

## Conventions

- **Format:** `- [ ] [TaskID] [P?] [Story?] Description with file path`
- **`[P]`** = parallelizable (different files, no dependency on incomplete tasks).
- **`[USn]`** maps to a slice phase; Setup/Foundational/Polish carry no story label.
- **Test-first (Constitution VI):** every implementation task is preceded by its failing test
  (RED→GREEN). For *visual* work the RED/GREEN pair is a structural assertion (Arabic copy present,
  token used, exactly one primary action) — **not** a pixel diff.
- File paths are repository-relative.

## ⚠️ Standing constraints (apply to every task below)

| Constraint | Rule |
|:--|:--|
| **P8 boundary** | No task may touch `src/main/**`, `src/preload/**`, `src/shared/bridge-api.ts`, or `migrations/**`. Renderer-only. |
| **Raw literals** | No task introduces a raw **colour, spacing, radius, typography-size or shadow** literal in a component (FR-8, all five families). Those values change **only** in `:root` / dark register token values (U0). A needed literal = a missing token → add it in U0. Narrow structural exceptions (hairlines, breakpoints, component geometry) are the closed list in **T025a**. |
| **Behavioural tests** | Payment/cart/money/routing-guard tests must pass **unmodified**. Only tests encoding an owner-superseded *design decision* may change (T020–T022 only). |
| **Flags** | No task changes a production feature-flag default. Gated surfaces are restyled, never ungated. |
| **Images** | `visual-references/**` govern appearance only. Check the spec's Non-Capability Inventory before treating anything shown as a requirement. |
| **Design handoff** | [`design-handoff/`](./design-handoff/) is **supplementary visual authority** (HTML mockup + designer spec + tokens). It never authorises capability. Read [`design-handoff/RECONCILIATION.md`](./design-handoff/RECONCILIATION.md) first — its filenames are shuffled (§D), its tokens are provenance-only (§C), and its Saudi/ZATCA/VAT/mada/unsupported-tender content is forbidden (§B). |
| **Screenshots** | Every visual slice ends with a capture task. A slice is not complete on source review alone. |

---

## Phase 1 — Setup

- [x] T001 Create the screenshot evidence directory `specs/022-pos-ui-v4-rescue/screenshots/` with a
  `README.md` recording the naming convention (`<slice>-<surface>-<before|after>.png`), the ≤400 KB
  budget, and the P7/P17 redaction rule (no secrets/tokens/PII in frame).
- [x] T002 Verify the dev launch path end-to-end per [quickstart.md](./quickstart.md): run
  `npm run dev` with the dev env vars, then verify **both** of the following and record the results
  in the screenshots README.

  **(a) Operator bypass — the `operator.dev_bypass.active` warn line MUST appear.**
  This one is non-negotiable: without it the session is not the fixture operator, and no screenshot
  can be honestly attributed to a surface. *(This is the audit's observed failure mode — Electron
  launched cleanly and the line never appeared.)* **If it is absent, STOP.**

  **(b) Catalogue — EITHER of these is acceptable evidence:**
  - the `catalogue.dev_seed.active` warn line appears (fixtures were just inserted); **OR**
  - explicit verified evidence that the catalogue **already contains usable products** — e.g. a
    successful barcode/SKU lookup or a search returning results in the running app, or a direct
    row-count read of the dev DB. Record which check was used and its result.

  **Why (b) is a disjunction:** `applyDevSeedCatalogueIfRequested` **no-ops and returns `false` when
  the catalogue is already populated** (`dev-seed-catalogue.ts` — `if (alreadyPopulated(deps.db))
  return false`). On any re-run against an existing dev DB the seed line will legitimately never
  appear. Requiring it would fail a perfectly good environment; what actually matters is that
  **usable catalogue data is present**, not that it was inserted on this particular launch.
  An empty catalogue with no seed line is still a STOP.

## Phase 2 — Foundational (Blocking Prerequisites)

- [x] T003 Capture the **baseline** full-suite result (`npm test`) and record it in the screenshots
  README as the regression reference (expected: 468 files / 5538 passed / 3 skipped / 0 failed).

---

## Phase 3 — US4a: Sale-success honesty (P1) — **first implementation slice**

**Goal:** A cashier who completes a sale sees an Arabic-first completion state that truthfully says
the sale is recorded, shows the receipt the system already holds, and offers one obvious next action.
**Independent test:** settle a payment with `SALE_FINALIZATION=1` → completion surface renders Arabic
primary copy, the settled amount is the dominant numeric element, `ReceiptPreview` is mounted for the
finalized sale, and "new sale" still resets and returns to the cart. With the flag **off**, the
surface says honestly that no receipt exists and fabricates nothing.

> **Palette-independence constraint:** every style added here MUST use existing semantic tokens.
> If a literal is needed, STOP and reorder U0 ahead of this slice (plan §Proposed Slice Order).

### Retain the sale id (the enabling change)

- [x] T010 [US4a] RED: test asserting `PaymentSurface` retains `sale_id` (not only `sale_number`)
  from the `sales.subscribe({topic:'recent'})` poll once settled, in
  `src/renderer/ui/payments/__tests__/PaymentSurface.settled-receipt.test.tsx` (new).
- [x] T011 [US4a] GREEN: store the polled `sale_id` alongside `settledSaleNumber` in
  `src/renderer/ui/payments/PaymentSurface.tsx`. `RecentSaleSummary` already carries it
  (`src/shared/sales/types.ts:165`) — **no bridge change** (research.md §4). Make T010 pass.

### Arabic-first completion copy

- [x] T012 [US4a] RED: test asserting the settled branch renders Arabic primary copy for the success
  statement, the sale reference label, and the next action (no English-only operator string), in
  `PaymentSurface.settled-receipt.test.tsx`.
- [x] T013 [US4a] GREEN: replace the English-only settled strings (`PaymentSurface.tsx:392-431` —
  "Payment settled." / "Sale {n}" / "New sale" / header "Payment") with Arabic-first copy, keeping
  the sale number `dir="ltr"` mono (FR-21). Make T012 pass.

> ⚠️ **T013 MUST NOT make the success claim unconditional.** `setPhase('settled')` fires on
> `payments.confirm` alone (`PaymentSurface.tsx:359-364`) — **before** the sale is finalized; the
> finalized record arrives later via the recent-sale poll. Rendering "the sale is complete" on the
> settled phase alone would assert success without the finalized record NFR-6 requires. The
> two-state split in **T013a** is therefore part of T013's definition of done, not optional polish.

- [ ] T013a [US4a] **BLOCKED — collapsed to ONE state; see below.** RED+GREEN (**NFR-6 / P2 — load-bearing**): split the settled phase into **two
  truthful states**, keyed on whether the matching finalized sale record has arrived:
  - **(a) payment settled, sale not yet finalized** (`sale_id === null`) — say exactly that: the
    payment is taken, the sale record is still being written. **No "sale complete" claim, no
    receipt, no fabricated sale number.** This is also the resting state when `saleFinalization` is
    off (T018) or the poll fails/times out (T019).
  - **(b) sale finalized** (`sale_id` present, `finalized_at >= settled_at`) — the full Arabic-first
    success state with the receipt (T017) and the settled-amount hierarchy (T015).
  Both states are honest; neither is an error. The distinction is *what the system knows*, and the
  copy must not blur it.

  > **⛔ BLOCKED — the two-state split is unimplementable against the current wire contract
  > (external review round 2, P1). Collapsed to ONE honest state.**
  >
  > State (b) requires knowing the finalized record belongs to **this** payment. The terminal
  > cannot know that: `RecentSaleSummary` carries no attempt/handoff identifier and
  > `payments.confirm` returns only `settled_at`, so `finalized_at >= settled_at` is the only
  > available test — and a **prior** sale finalizing late satisfies it.
  >
  > Round 1 removed the receipt (T017) but **kept** an `isFinalized` branch rendering
  > "تم إتمام البيع" from that same uncorrelated row: the symptom was fixed and the assertion
  > left standing. A late-finalizing prior sale could still make the surface claim THIS sale
  > completed, and show that sale's number inside a success frame.
  >
  > **Resolution:** the settled phase renders the one state the terminal can support — the
  > payment was taken (`تم استلام المبلغ` + dominant amount + new sale). The sale number still
  > shows when the poll returns one, but **outside any completion frame**, exactly as `main` did
  > (006 invariant 13). So this is no worse than the surface it replaces while claiming strictly
  > less — which is the whole point of the slice.
  >
  > **T013a and T017 share one unblock condition:** an identifier on the `recent` projection (or
  > a sibling read) tying the finalized sale to this payment. 011 already derives a deterministic
  > one from `envelope_handoff_action_id`, so it exists main-side — a backend/contract task, not
  > a renderer one. NFR-6 as written depends on it.
  >
  > **Round 3 extended this to the SALE NUMBER itself.** Round 2 left the number visible on
  > "no worse than `main`" grounds, and simultaneously replaced the 10-attempt poll cap with an
  > uncapped backoff — which made that justification false: `main`'s exposure was bounded at ~2s,
  > the backoff's was unbounded, so *any* later-finalizing prior sale would be adopted. The number
  > rested on exactly the evidence that already disqualified the receipt and the completion claim.
  >
  > **The recent-sale poll is removed entirely**, along with `settledSaleNumber`, `settledSaleId`
  > and `settledAt`. The settled surface shows only `تم استلام المبلغ` + the envelope amount +
  > "new sale".
  >
  > **This CONTRADICTS 006 invariant 13**, which asserts the finalized sale number displays. That
  > is a deliberate reduction *below* `main`, accepted on safety grounds: a wrong cashier-quotable
  > reference is worse than none. The two 006 tests that encoded invariant 13 were converted into
  > explicit superseded markers rather than deleted, so the removal of a shipped behaviour stays
  > auditable in the suite. Invariant 13 reverts together with T013a and T017 when the projection
  > carries a correlating identifier.

### Totals hierarchy

- [x] T014 [US4a] RED: test asserting the settled amount is the dominant numeric element on the
  completion surface (FR-16) and is `dir="ltr"`-isolated.
- [x] T015 [US4a] GREEN: apply the settled-amount hierarchy in `PaymentSurface.tsx` using existing
  semantic tokens/classes only. Make T014 pass.

### Mount the existing receipt

- [x] T016 [US4a] RED: test asserting `ReceiptPreview` is mounted on the completion path for a
  finalized sale (passing the retained `sale_id`), in `PaymentSurface.settled-receipt.test.tsx`.
- [ ] T017 [US4a] **BLOCKED — the receipt is deliberately NOT mounted (see below).** GREEN: mount
  `ReceiptPreview` from `src/renderer/ui/receipts/ReceiptPreview.tsx` in the settled branch of
  `PaymentSurface.tsx`. It calls the existing `receipts.preview` channel itself — a **new consumer
  of an existing channel**, not a bridge-surface change (P8, plan Constitution Check).

  > **BLOCKED by an uncorrelatable `recent` projection (external review P1, verified in source).**
  >
  > `RecentSaleSummary` carries **no** payment, attempt or envelope identifier — only `sale_id`,
  > `sale_number`, `finalized_at` — and `payments.confirm` returns only `settled_at`. So
  > `finalized_at >= settled_at` is the ONLY discriminator available renderer-side, and a **prior**
  > sale finalizing late (a worker retry succeeding while this sale is delayed or refused)
  > satisfies it. Mounting a receipt on that `sale_id` would show **the previous customer's
  > receipt**.
  >
  > **The gap pre-dates this slice.** `main` already displayed `settledSaleNumber` from the same
  > unverified `recent` (006 invariant 13) — verified against `58acd5c`. What T017 added was a
  > *receipt document* for a sale the terminal cannot prove is this one, turning a wrong number
  > into a wrong receipt.
  >
  > **There is no renderer-only fix.** The correlating key does not exist on the wire, and adding
  > one is a bridge change, which 022 forbids (P8). A tighter time window or an amount-match would
  > be a heuristic dressed as a fix — precisely what this slice exists to refuse.
  >
  > **Decision: un-amplify.** The receipt is not mounted; the sale number still shows, exactly as
  > on `main` — no better, but no worse. The completion surface stays honest about what it knows.
  >
  > **Unblocks when** the `recent` projection (or a sibling read) carries an identifier tying the
  > finalized sale to *this* payment. 011 already derives a deterministic `externalId` from
  > `envelope_handoff_action_id`, so the identifier exists main-side — this is a backend/contract
  > task, not a renderer one.

### Honest degradation (P2 — mandatory, not optional polish)

- [x] T018 [US4a] RED: test asserting that when `saleFinalization` is **off** (fail-closed default,
  so 008's finalize listener short-circuits and no receipt exists) the surface states that honestly
  and renders **no** receipt placeholder.
- [x] T019 [US4a] RED+GREEN: test asserting that when `sale_id`/`sale_number` is `null` (poll failed,
  bridge absent, or unmounted) the completion detail block stays **omitted** — no fabricated sale
  number, no invented receipt. Preserve today's omission behaviour. Make T018+T019 pass.
- [x] T019a [US4a] RED+GREEN (**FR-30**): test asserting the existing **"new sale" behaviour is
  preserved** through the settled-branch rewrite — `onNewSale` still resets the payment store **and**
  the cart store and navigates to `/app/cart` (`CheckoutRoute.handleNewSale`). This is the button
  most easily broken by rewriting the branch that owns it, and losing it strands the cashier on a
  settled surface (the documented prior dead-end).

### US4a acceptance

- [x] T0A1 [US4a] Run targeted tests → `npm run typecheck` → `npm run lint` → `npm test` (no
  regression vs T003 baseline).
- [ ] T0A2 [US4a] Capture `u4a-sale-success-after.png`; compare against
  `visual-references/05-sale-success.png`; note in the PR which reference was used.
  **Before-capture:** take it from the **current `main` build before this branch diverges**. If that
  is not available, record `no before-capture available (first slice)` in the screenshots README —
  **do not fabricate or reconstruct one.** An honest absence is acceptable; a manufactured artifact
  is not (spec: "before screenshot *where possible*").
  **Record that the after-capture is pre-v4.0 palette and is superseded by T083 after U0.**

---

## Phase 4 — US0: Visual Foundation (P1)

**Goal:** One coherent v4.0 token system — light-first, pharmacy-teal primary, intentional Arabic
typography — that every downstream slice consumes without local restyling.
**Independent test:** launch with no stored theme → light v4.0 paints; every cashier surface resolves
colour through `var(--color-*)`; Arabic renders in the declared stack; full suite green.

### Token values (`:root` + dark register ONLY — no `@layer components` edits)

- [x] T020 [US0] RED: update `src/renderer/styles/__tests__/theme-contract.test.ts` — invert the
  **three** hardcoded dark-default assertions (index.html attribute, store default, default-theme
  expectations) to light. **Preserve** the structural guards: dark register exists, token-value
  overrides only (no forked components), RTL/`lang="ar"` systemic. This is the single
  owner-sanctioned test change (spec A2); name the superseding decision in the PR.
- [x] T021 [US0] GREEN: set the light default in `src/renderer/index.html` (line 14 `data-theme`),
  keeping `lang="ar" dir="rtl"` and the static flash-free attribute (meta CSP is `script-src 'self'`,
  so no inline pre-paint script).
- [x] T022 [US0] GREEN: set `DEFAULT_THEME: Theme = 'light'` in
  `src/renderer/stores/theme-store.ts`; review `stores/__tests__/theme-store.test.ts` for any
  genuinely hardcoded `'dark'` default (most assert via the `DEFAULT_THEME` symbol and follow
  automatically). Make T020 pass.
- [x] T023 [US0] Retune `:root` colour token **values** in `src/renderer/styles/tailwind.css`
  (lines 3–133) to v4.0: light clinical background/surface, **pharmacy green-teal**
  `--color-primary*`, navy `--color-text`/structure, controlled blue `--color-info*`, orange
  `--color-warning*`, red `--color-danger*`, neutral `--color-border*`, restrained `--shadow-*`.
  **No new token names unless a genuine semantic gap exists** (token-name parity test must stay green).
- [x] T024 [US0] **Owner decision + implementation:** dark-register disposition
  (`tailwind.css:135-250`) — (a) retune the ~6 core dark tokens to v4.0 (**recommended**, avoids
  shipping two visual identities) or (b) freeze v3.5 Vault Dark as accepted divergence. Record the
  choice in plan.md §U0; implement token values only.
- [x] T025 [US0] RED+GREEN: **token guard across all five FR-8 value families** — assert no
  cashier-journey surface introduces a raw literal for **colour**, **spacing**, **radius**,
  **typography size**, or **elevation/shadow**. FR-8 and SC-1 name all five; a colour-only guard
  would leave four families unprotected and let the system drift exactly where v3.5's density and
  rhythm decisions live. Extend or add a guard test under `src/renderer/styles/__tests__/`.

  **Detected families and their token sources:**

  | Family | Must resolve through |
  |:--|:--|
  | Colour | `--color-*` |
  | Spacing (margin/padding/gap) | `--space-*` |
  | Radius | `--radius-*` |
  | Typography size | `--font-size-*` / `--line-height-*` |
  | Elevation / shadow | `--shadow-*` |

- [x] T025a [US0] **Document the guard's narrow structural exception.** Some values are *structural*,
  not design-system values, and tokenizing them would be noise rather than consistency. The guard
  MUST allow, and the exception list MUST be written into the test file as a comment so it stays
  auditable:
  - **`0` and `100%`/`auto`/`inherit`** — not design values.
  - **`1px` hairline borders and outlines** — the rule *width* is structural; its **colour** is
    still token-bound (77 `1px solid` occurrences exist today).
  - **Media-query breakpoints** (`1023px`, `1279px`, `1280px`, `1180px`, …) — viewport-tier
    boundaries owned by `useViewportTier`, not spacing tokens.
  - **Component-intrinsic dimensions** (`width`/`height`/`flex-basis`/`grid-template`, e.g. the
    56px top bar, nav-rail widths) — layout geometry, not the spacing scale.
  - **The ≥44×44 touch floor** — a constitutional minimum (P14), asserted by its own invariant test.

  Anything **not** on this list is in scope for the guard. The exception is a closed list: adding to
  it is a deliberate, reviewed act, not a way to silence a failing assertion.

### Typography

- [x] T026 [US0] Set `--font-family-sans` to the declared Arabic-first system stack
  (`'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif`) in `tailwind.css`, replacing the
  currently-unresolvable `'Inter Variable', Inter` (research.md §1). **No package, no `@font-face`,
  no bundled file** — `no-brand-font.test.ts` guards `@font-face` only and stays green.
- [x] T027 [US0] Confirm money/identifier treatment: `--font-family-mono` + tabular numerals for
  money, barcodes, SKUs, sale numbers (FR-12), `dir="ltr"`-isolated (FR-21).
- [x] T028 [US0] **Verification on target hardware (Windows 10/11 x64):** render Arabic UI copy,
  mixed Arabic/Latin, dense cart rows and large totals; confirm the stack resolves to Dubai (or the
  intended fallback). **If quality fails, STOP and escalate** — bundling a webfont is an owner
  decision, not an in-slice fix (research.md §1 Gate).

  > **✅ PASS — verified by the owner on target Windows hardware, 2026-09-19.** Arabic renders
  > cleanly through the configured `'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif`
  > stack, against the running v4.0 build (the same launch that cleared T002).
  >
  > **Consequence — the typography approval gate is NOT triggered.** research.md §1 makes the
  > webfont question conditional: *"An approval gate is triggered **only if** U0's
  > on-target-hardware verification shows the system stack cannot meet FR-10/FR-11 quality."*
  > It met the bar, so bundling a webfont (Noto Kufi Arabic / Cairo / Tajawal) stays **rejected**
  > and no owner decision is owed. The system-stack approach needed no approval in the first place.
  >
  > This also closes the one open risk in T026: the stack previously led with `'Inter Variable',
  > Inter`, which resolves to nothing here, so Arabic fell through to uncontrolled OS fallback.
  > That defect is now both fixed and verified on the hardware it ships to — **no package, no
  > `@font-face`, no bundled file**, so `no-brand-font` stays green.

### Shared primitives

- [x] T029 [P] [US0] RED+GREEN: primary/secondary/**destructive** button treatment in
  `src/renderer/ui/primitives/Button/` — teal fill permitted for primary (FR-4), destructive visually
  separated and never carrying the primary treatment (FR-17).
- [x] T030 [P] [US0] RED+GREEN: input/search treatment in `src/renderer/ui/primitives/Input/`.
- [x] T031 [P] [US0] RED+GREEN: status-chip treatment in `src/renderer/ui/primitives/Badge/`
  (icon/text + colour, never colour alone — FR-26).
- [x] T032 [P] [US0] RED+GREEN: table/row treatment in `src/renderer/ui/primitives/Table/`; panel
  treatment in `Card/` (borders + spacing, not shadow stacking — FR-9/FR-33).
- [x] T033 [US0] Verify the global `:focus-visible` rule renders visibly against the new light
  surfaces (NFR-2) in `tailwind.css`.
- [x] T034 [US0] **NFR-5:** verify `src/renderer/shell/__tests__/AppShell.first-paint-perf.test.tsx`
  stays green after the token retune + default-theme flip. U0 changes the root stylesheet and the
  boot theme — the most plausible source of a first-paint regression in this feature.

### US0 acceptance

- [x] T0B1 [US0] Run `npm run typecheck` → `npm run lint` → `npm test` → `npm run build:renderer`.
- [ ] T0B2 [US0] Capture after-screenshots of every reachable cashier surface; compare against
  `visual-references/01-visual-system.png`.

## Phase 4b — US0-R: Historical v3.5 authority reconciliation (rides with U0)

**Goal:** No future coding agent is instructed by a superseded design rule.
**Independent test:** opening `docs/design/pos-v3.5/CLAUDE.md` shows the superseded banner and points
at spec 022; the rest of v3.5 is byte-identical.

- [x] T040 [US0-R] Add a short **SUPERSEDED-FOR-v4.0 banner** at the top of
  `docs/design/pos-v3.5/CLAUDE.md` naming the three superseded axes (dark default, navy primary,
  One-Accent Rule) and pointing at `specs/022-pos-ui-v4-rescue/` + `visual-references/` as current
  visual authority. **Banner only — no rewrite, no deletion** (precedent: 017's SUPERSEDED-IN-PART
  banners).
- [x] T041 [US0-R] Add inline supersede markers at exactly two lines:
  `docs/design/pos-v3.5/README.md:59` (One-Accent Rule) and `:64` (dark default). Everything else
  stays verbatim and valid.
- [x] T042 [US0-R] Update the `specs/README.md` row for 022 to reflect **implementation** progress.
  *(The spec-chain status was already corrected in the spec-chain PR; this task covers only the
  post-implementation status change.)*

---

## Phase 5 — US1: Sign-in + role-aware landing (P1)

**Goal:** Arabic-first sign-in in the v4.0 system, and a signed-in cashier lands on the till instead
of a role-rejection error.
**Independent test:** cashier signs in → first surface is `/app/cart` (or its honest gated state);
manager/admin still land on `/app/dashboard`; a cashier navigating directly to `/app/dashboard`
still receives the existing rejection.

### Routing correction (independently reviewable — may be its own PR)

- [x] T050 [US1] RED: router tests asserting role-aware `/app` index resolution — cashier →
  `/app/cart`, manager → `/app/dashboard`, admin → `/app/dashboard`, in
  `src/renderer/__tests__/router.test.tsx`.
- [x] T051 [US1] RED: test asserting a cashier navigating **directly** to `/app/dashboard` still gets
  the existing role-rejection state — `DashboardRoute`'s check is untouched (FR-45).
- [x] T052 [US1] GREEN: replace the static `{ index: true, element: <Navigate to="dashboard" /> }`
  at `src/renderer/router.tsx:175` with a role-aware redirect reading the existing
  `useOperatorSessionStore`. **Do not** modify `DashboardRoute.tsx`, `OperatorRouteGuard`, any
  `allow` list, or any flag. Renderer-only (FR-47 → SC-17). Make T050+T051 pass.
- [x] T053 [US1] Verify `src/renderer/__tests__/cashier-walling.test.tsx` and
  `routes/__tests__/operator-route-guard.test.tsx` pass **unmodified** (authorization unchanged).

### Sign-in presentation

- [x] T054 [US1] RED+GREEN: Arabic-first sign-in presentation in `src/renderer/routes/sign-in.tsx`
  and `src/renderer/ui/operator/**` (roster, PIN pad, badges) against v4.0 tokens.
  **Do NOT add shift-start capability** — the reference shows it, but register D-003 defers
  open-shift to Slice 12 (Non-Capability).

  > **✅ COMPLETE. The earlier T053 conflict note was WRONG and is corrected here.**
  >
  > **Correction of record:** an earlier note claimed `cashier-walling.test.tsx` and
  > `operator-route-guard.test.tsx` query by the English labels. **They do not.** Verified by
  > grep: the only match in `cashier-walling.test.tsx` is the phrase "PIN entry" inside a
  > *comment*, not an assertion. `operator-route-guard.test.tsx` has no label coupling at all.
  > The real coupling was confined to `ManagerAdminSignInForm.test.tsx` and
  > `sign-in-route.test.tsx`. The conflict was narrower than reported.
  >
  > **T053 evidence files: BYTE-FOR-BYTE UNCHANGED.**
  > `git diff --name-only origin/main...HEAD -- <both files>` returns empty, and so does
  > `git status --short` for them.
  >
  > **Labels translated** (visible text AND accessible names, kept aligned):
  > `Email or username` → `البريد الإلكتروني أو اسم المستخدم` · `Password` → `كلمة المرور` ·
  > `Sign in` → `تسجيل الدخول` · `Signing in…` → `جارٍ تسجيل الدخول…` ·
  > `← Back to cashier roster` → `← العودة إلى قائمة الكاشير` ·
  > `Cashier roster` → `قائمة الكاشير` (×3) · `PIN entry` → `إدخال الرقم السري` ·
  > `Delete` → `حذف` · `Enter` → `إدخال` · and the PIN progress live-region
  > `N of 6 entered` → `أُدخل N من 6` (found by the new a11y test, not by inspection).
  >
  > **No WCAG 2.5.3 mismatch was created.** The form labels are visible `<label for>` text, so
  > the accessible name follows the visible name automatically. The pin-pad keys render glyphs
  > (`⌫`, `↵`) with no visible word, so `aria-label` is their only name and 2.5.3 does not bind.
  > No English `aria-label` was left behind to keep old tests passing.
  >
  > **Tests re-pointed from copy to stable semantics** (owner-approved, narrow):
  > `ManagerAdminSignInForm.test.tsx` + `sign-in-route.test.tsx` — 28 `getByLabelText(/email or
  > username|^password$/i)` queries → `getByTestId('sign-in-identifier' | 'sign-in-password')`
  > (testids already existed; no markup was added for the tests). The submit-button assertion
  > moved from `/sign in/i` to "carries an Arabic label", which still catches an unlabelled
  > button. `PinPad.dot-only-guard.test.tsx` — the three `"N of 6 entered"` literal matches
  > became **count-based** assertions that additionally prove the label NEVER contains the PIN
  > value; that is *stronger* than the original and is the property the file exists to defend.
  > **No assertion was weakened.**
  >
  > **New coverage:** `ui/operator/__tests__/v4-sign-in-labels.test.tsx` (7 tests) renders the
  > real components and proves (1) labels are Arabic-first, (2) each field stays programmatically
  > associated with its `<label for>`, (3) accessible names stay aligned with visible text,
  > (4) no English-only operator label or `aria-label` survives the sign-in journey. Refusal-copy
  > genericness (5) remains covered in `v4-sign-in-presentation.test.ts`.
  >
  > Gates: 474 files / 5590 passed / 3 skipped / 0 failed; typecheck + lint clean;
  > `build:renderer` green; `git diff --check` clean.

### US1 acceptance

- [ ] T0C1 [US1] Gates + capture `u1-sign-in-after.png`; compare against
  `visual-references/02-sign-in.png`.
- [ ] T0C2 [US1] **Capture the cashier landing (`u1-landing-cashier-after.png`) via a genuine cashier
  session.** ⚠️ `POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN=1` cannot serve this: its fixture is hardcoded
  `role: 'manager'` (`src/main/operator/dev-skip-operator-signin.ts:40-47`) with **no role override**,
  so the bypass lands on the manager path and would prove nothing about FR-44's cashier branch.
  Use the **cashier PIN path**, which is local-only — no backend required
  (`sign-in-handler.ts:362` — `backend_session_id: ''`):
  1. leave `POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN` **unset**;
  2. provision a cashier PIN row for the dev tenant/branch/terminal (019's provisioning path);
  3. sign in at `/sign-in` as that cashier and capture the landing surface.

  > ⛔ **BLOCKED — EXTERNAL PREREQUISITE (`/speckit-analyze` 2026-09-22). Step 2 is not actionable
  > from inside 022.** Measured on the current dev DB: **`cashier_pin_records` = 0 rows** (the table
  > and its indexes exist from migration `0036`'s rebuild — they are simply empty). With the dev
  > bypass hardcoded to `manager`, **a genuine cashier session is currently unreachable by any
  > means** — this is NOT merely "awaiting a manual snip" like [#448](https://github.com/Kemetra/POS/issues/448),
  > nor impossible-by-geometry like the dropped narrow capture ([#450](https://github.com/Kemetra/POS/issues/450)).
  > It is a third class: **blocked on a product capability that does not yet exist.**
  >
  > POS-019 owns the secure main-process `operator.provisionCashierPin` write path, but **no shipped
  > renderer path invokes it**, so a manager cannot provision a cashier today. Building one is a
  > *capability addition* — squarely outside 022's visual-convergence scope (022 "adds **no** business
  > capability", CLAUDE.md §Active feature) and outside its renderer-only P8 boundary.
  >
  > **Owner ruling 2026-09-22 — do NOT unblock this from inside 022** by any of: a direct SQLite
  > `INSERT`, an auth fixture, a dev-only main-process bypass, `src/main/**` / `src/preload/**` /
  > IPC changes, migration changes, or leaking `user_id` to the renderer. **Do not invent a
  > capability merely to obtain a screenshot.**
  >
  > **Correct representation:** T0C2 stays **unchecked and blocked**, tracked as an external
  > prerequisite on 019's provisioning path. It does **not** gate US4/US5/US6, and it is the one
  > capture that a future capture session cannot clear. **Tracked as
  > [#457](https://github.com/Kemetra/POS/issues/457)**, labelled `status:blocked` rather than
  > `status:deferred` — "deferred" would wrongly imply it is reachable today.
  > **Unblocked by:** a shipped, manager-invocable cashier-PIN provisioning path (019's
  > `provisionCashierPin`). After that, T0C2 becomes an ordinary manual capture.
  Record the exact steps used in the screenshots README. **If a cashier session cannot be reached
  honestly, record that and leave the capture absent — do not substitute a manager screenshot**,
  which would not evidence the behaviour under acceptance.

---

## Phase 6 — US2: Sale workspace / catalogue / cart (P1)

**Goal:** A dense, legible two-region sale workspace where scan/search is instant and the cart plus
running total dominate.
**Independent test:** scan/search → confirm → line appears in cart; totals legible at a glance;
exactly one primary action; no decorative dashboard treatment.

- [x] T060 [US2] RED+GREEN: two-region sale layout in
  `src/renderer/routes/app/CartWorkspace.tsx` (catalogue ↔ cart), cart visually dominant (FR-15).
- [x] T061 [P] [US2] RED+GREEN: search/scan field prominence + focus behaviour in
  `src/renderer/ui/catalogue/ProductSearchInput.tsx`, `ScanCaptureField.tsx`.
- [x] T062 [P] [US2] RED+GREEN: result rows + confirm panel in
  `src/renderer/ui/catalogue/SearchResultRow.tsx`, `SearchResultList.tsx`, `ProductConfirmPanel.tsx`.
- [x] T063 [P] [US2] RED+GREEN: cart line rows, quantity stepper (≥44×44), totals block in
  `src/renderer/ui/cart/LineItemRow.tsx`, `QuantityStepper.tsx`, `CartPane.tsx`.
- [x] T064 [US2] Assert the honest VAT placeholder (`—` / `tax-pending`) is **preserved exactly**
  (D-007) and no 15% VAT line is introduced (Non-Capability).
- [x] T065 [US2] Assert the **single cart mutation path** is preserved — `CartPane`'s
  register-callback into `CatalogueSalePane` (005's `resolveItemRef` seam). No parallel mutation.
- [ ] T0D1 [US2] Gates + capture `u2-sale-workspace-before/after.png`; compare against
  `visual-references/03-sale-workspace.png`.
  > ⏸️ **DEFERRED 2026-09-20 → [#448](https://github.com/Kemetra/POS/issues/448).** Checkbox stays
  > **unticked**: the rest of U2 merged (PR #447, `2b4b8be`) but this capture did not happen, so
  > **FR-15 remains visually unverified** and U2 is not visually complete on source review alone.
  > Launch gates passed on the day (`operator.dev_bypass.active` observed; catalogue
  > 50 products / 49 barcodes) — a historical record only: **re-verify both gates on each capture
  > launch**, since #448 needs new launches (one from `e7390f9`) and the dev DB may be reset in
  > between. T060–T065 above are ticked; only this capture is outstanding. Blocked on two things by
  > design: capture is manual per spec §Screenshot Acceptance (no Playwright/Puppeteer without
  > separate approval), and an **empty cart cannot evidence FR-15** — no dev fixture seeds cart
  > lines, so a product must be search-and-confirm-added by hand first. #448 adds **one** capture
  > beyond this task's literal `before/after` — the **lone-cart** case (the PR #447 P1 fix, still
  > never rendered), so **3 captures in total**. A narrow-terminal capture was considered and
  > **dropped as impossible**: the workspace does not render below 1024px (`AppShell` returns
  > `ScreenTooSmall` instead of its `<Outlet />`), so the `@media (max-width: 1023px)` rule is
  > unreachable and no screenshot can contain it. That dead-rule question is
  > [#450](https://github.com/Kemetra/POS/issues/450), not #448.

---

## Phase 7 — US3: Checkout / tender (P1)

**Goal:** Amount due unmistakable, supported tender selection obvious, refusals honest, and the
whole working tender flow Arabic-first.
**Independent test:** cash/card/voucher selectable and settle correctly; amount due dominant;
refusal states readable; **zero English-only operator-facing strings anywhere in the working tender
flow**; payment FSM, money math and split tender untouched.

> **Arabic-first scope (FR-19).** US4a repairs only the *settled* branch. The **working** tender
> flow — everything before settlement — still carries English-only operator strings, verified in
> source: `PaymentSurface.tsx:484` renders `<h2>Payment</h2>` (with `aria-label="Payment"` on the
> `<main>` at `:482`), and `PaymentCartSummary.tsx:42,62` render `Order summary` / `Subtotal`.
> **Anchor correction (2026-09-20, PR #452):** this note previously cited `PaymentSurface.tsx:396`
> and `:437`. Those anchors went stale when US4a added the settled branch above the working surface
> — `:396` is now inside the **settled** `<main>` and `:402` is already Arabic (`الدفع`), so the old
> anchors send an implementer into the translated branch. `PaymentCartSummary`'s anchors are
> unchanged and were always correct. U3 closes that gap, so that
> after US4a + U3 the entire checkout journey is Arabic-first.

- [x] T070 [US3] RED+GREEN: amount-due hierarchy (dominant numeric, FR-16) in
  `src/renderer/ui/payments/PaymentSurface.tsx`, `PaymentCartSummary.tsx`.
- [x] T071 [P] [US3] RED+GREEN: tender-selection grid for **exactly the three supported tenders** —
  `cash`, `external_card_terminal`, `internal_voucher` (`TenderSelection.tsx:26`). **Do NOT** add
  insurance, credit, mada, wallet, or gift card (D-009 / Non-Capability).
- [x] T072 [P] [US3] RED+GREEN: amount entry + quick-amount treatment in `CashEntry.tsx`,
  `AmountPad.tsx`, `MoneyRoll.tsx` — presentation only. **No client-side money arithmetic.**
- [x] T073 [P] [US3] RED+GREEN: voucher entry presentation in `VoucherEntry.tsx` — **no client-side
  voucher authority**; authority stays main-process.
- [x] T074 [US3] Verify the **behavioural** payment tests — payment FSM, money math, tender
  application, voucher authority, routing guards — pass **unmodified**, and that the full suite is
  green. Named files: `parse-currency-to-minor.test.ts`,
  `PaymentSurface.money-safety-guards.test.tsx`, `CashEntry.no-overapply.test.tsx`,
  `CashEntry.currency-input.test.tsx`, `PaymentSurface.settled-receipt.test.tsx`, and the N1–N4
  negative guards in `tender-surface-recompose.test.tsx` (no insurance/credit label, no
  `method-grid--four`, no client-side voucher lookup, no client-side change computation).

  > **Reworded by `/speckit-analyze` 2026-09-22 — premise correction, scope unchanged in substance.**
  > This task previously read: *"Verify `payments/__tests__/**`, `parse-currency-to-minor.test.ts`,
  > and the FSM tests pass **unmodified**."* That wording scoped the rule by **path glob**, but the
  > governing rule in [plan.md](./plan.md) §Test-change policy scopes it by **category** —
  > *"Behavioural tests (payment, cart, money, routing guards) must pass unmodified"* — and the
  > Standing Constraint above says the same. **The two are not the same set**, and plan.md's own U3
  > row proves the glob was never the intended constraint: it lists
  > `tender-surface-recompose.test.tsx` under *"Existing tests that must stay green"* **and**
  > assigns *"Tender presentation"* updates in that same directory. A presentation test living under
  > `payments/__tests__/**` was anticipated by the plan; the old T074 text collapsed category into
  > path and over-reached.
  >
  > **The mismatch was in T074's premise, not in the merged implementation.** Verified 2026-09-22:
  > every behavioural file named above is byte-identical across the whole US3 arc
  > (`git diff 94e4864^..HEAD`), all four N1–N4 negative guards are untouched, and the suite is
  > green at **487 files / 5688 passed / 3 skipped / 0 failed**. The one modified file
  > (`tender-surface-recompose.test.tsx`) self-declares as a *"visual recompose"* test in its header
  > and asserts CSS class structure, not payment behaviour.
  >
  > **Nothing was waived.** The residual — SC-15's requirement that a superseded-visual-default test
  > change be *"explicitly owner-sanctioned"* — was NOT satisfied by this rewording, so it was
  > carried as its own task, **T074a** below, and has since been **ratified** (2026-09-22). FR-40,
  > the payment FSM, money math, tender application and voucher authority are preserved unchanged;
  > no test was weakened.
  >
  > **✅ TICKED 2026-09-22** — both conditions of the reworded task are met and evidenced: the named
  > behavioural files are byte-identical across `94e4864^..HEAD`, the N1–N4 negative guards are
  > untouched, and the suite is green at **487 files / 5688 passed / 3 skipped / 0 failed**. The
  > SC-15 residual that previously blocked this tick is closed by T074a.

- [x] T074a [US3] **SC-15 owner-sanction of the Phase C visual-default supersession** (suffix infill,
  `/speckit-analyze` 2026-09-22). SC-15 permits a test change only when it is *"limited to those
  encoding a superseded visual default **and explicitly owner-sanctioned**"*. The Phase C change to
  `tender-surface-recompose.test.tsx` meets the first clause and **not yet** the second: the four
  existing Modified-test ledger rows carry explicit owner approval (recorded for T054), this fifth
  row does not.

  **What needs sanctioning:** (a) three `.amount-due-card` **presence → absence** retargets in
  `CashEntry`, `ExternalCardTerminalEntry`, `VoucherEntry` — superseded by FR-16 making
  `PaymentSurface` the sole owner of the amount due, with the positive invariant replaced by a
  **stronger** global "exactly one amount-due presentation" count in `single-amount-due.test.tsx`;
  and (b) one voucher-refusal literal updated to the Arabic copy now in source
  (`VoucherEntry.tsx:51`) — the same class as the already-sanctioned T054 English-copy updates.

  **✅ RATIFIED under SC-15 — owner-delegated decision, 2026-09-22 (option (i)).**

  **Verified before ratifying** (`single-amount-due.test.tsx:142-205`): the replacement is
  **strictly stronger** than what it replaced, not merely equivalent.
  - *Old:* `expect(card).toBeInTheDocument()` — a **local presence** check inside one component's
    render. A regression reintroducing the duplicate card would still have PASSED it in 2 of 3
    components.
  - *New:* `querySelectorAll('.amount-due-card')).toHaveLength(0)` across the **whole tree** in the
    live mounted surface (all three tender phases, `it.each`), **plus** the superseded bilingual
    label `المطلوب دفعه` asserted absent from `document.body.textContent` anywhere, **plus** the
    positive `payment-surface-amount-due` asserted present, `dir="ltr"` and carrying the dominant
    class.
  - *And* a third block — *"the engine value is still rendered (no behaviour lost)"* — pins that the
    cleanup removed a duplicate **presentation**, never the number or any calculation.

  **Both halves qualify under SC-15** as *"encoding a superseded visual default"*: (a) the
  `.amount-due-card` ownership question is settled by FR-16 (`PaymentSurface` is the sole owner —
  a per-entry copy put the same value on screen twice at two sizes, defeating the hierarchy the
  slice exists to create); (b) the voucher-refusal literal is the same class as the already-
  sanctioned T054 English→Arabic copy updates, and still asserts the structured reason
  (`voucher_not_found`) NEVER reaches the DOM.

  **No test was weakened** — the explicit bar for this task. **FR-40, the payment FSM, money math,
  tender application and voucher authority are untouched**; all four N1–N4 negative guards in
  `tender-surface-recompose.test.tsx` remain byte-identical.

  **This ratification is narrow.** It covers exactly the two Phase C changes tabled in Modified-test
  ledger row 5 ([`screenshots/README.md`](./screenshots/README.md)). It does **not** broaden the
  T020–T022 grant, and it authorises no further test edits.
- [x] T075 [US3] **Preserve split tender (FR-40).** Multi-line tender is a **shipped capability**
  (006 T154): `handleLineApplied` returns to tender selection while the applied sum is below the
  subtotal (`PaymentSurface.tsx:282-313`). U3 restyles that surface, so assert the behaviour
  survives — a part-payment still reopens tender selection.
  **Do not treat split tender as a Non-Capability item** (spec Non-Capability Inventory, corrected
  row).
  > **Correction (2026-09-20, PR #452):** this task previously also said "and the applied-lines list
  > stays visible". **There is no such list to preserve** — `paymentSlice.tender_lines` is filtered
  > into `appliedLines` (`PaymentSurface.tsx:355`) and used only for arithmetic (`:356`, `:364`); it
  > never reaches JSX, so a partial payment reopens tender selection without showing the prior line.
  > What is shipped is the **control flow**, and that is what this task preserves. **Displaying the
  > applied lines is NEW work** — it must be added and tested explicitly (see
  > [`design-handoff/US3-HANDOFF.md`](./design-handoff/US3-HANDOFF.md) §3), not assumed into
  > existence by a preservation task, which would leave it with no test of its own.
### Arabic-first working tender flow (FR-19 / SC-4)

> ⚠️ **ANCHOR STATUS RE-VERIFIED (`/speckit-analyze` 2026-09-22) — T076–T079 are DONE; their
> "today is English" anchors are now HISTORICAL.** Re-grepped against the post-#455 tree: the line
> numbers still resolve, but the English strings they cite are **gone, as intended**.
> `PaymentSurface.tsx:482` is `aria-label="الدفع"` and `:484` is `<h2 …>الدفع</h2>`;
> `PaymentCartSummary.tsx:42` is `ملخص الطلب` and `:62` is `الإجمالي الفرعي`. The tasks below read
> as instructions to *change* copy that has already been changed — that is expected for completed
> tasks and is **not** a defect. Do not "restore" the English to make the wording literal. The
> live guard against regression is the T076 assertion suite, not these anchors.

- [x] T076 [US3] RED: test asserting **zero English-only operator-facing strings** across the
  working (pre-settlement) tender flow — `PaymentSurface` (tender-selection + entry + confirm
  phases), `PaymentCartSummary`, `TenderSelection`, `CashEntry`, `AmountPad`, `VoucherEntry`,
  `ExternalCardTerminalEntry`, `MoneyRoll`. Add to
  `src/renderer/ui/payments/__tests__/` as an Arabic-first coverage assertion over the rendered
  operator-visible text **and over operator-facing ATTRIBUTES** — `aria-label`,
  `aria-describedby`, `title`, `placeholder` — plus live-region text.
  > **Scope correction (2026-09-20, PR #452):** this task previously asked for an assertion over
  > "the rendered operator-visible text" alone. **That cannot satisfy its own requirement.** Two
  > classes of English string are invisible to a text-node scan: AT-only `aria-label`s
  > (`PaymentCartSummary.tsx:44,48`, `TenderSelection.tsx:45`, `CashEntry.tsx:142`,
  > `AmountPad.tsx:63,119`, `VoucherEntry.tsx:159,208`, `ExternalCardTerminalEntry.tsx:123`) and
  > **on-screen-but-attribute** placeholders (`ExternalCardTerminalEntry.tsx:231` `e.g. T1A2B3`,
  > `VoucherEntry.tsx:190` `VCH-000`). A test written literally to the old wording goes green while
  > a sighted operator still reads English. Full inventory + the format-token judgement call:
  > [`design-handoff/US3-HANDOFF.md`](./design-handoff/US3-HANDOFF.md) §5. Re-grep the anchors
  > before implementing.
- [x] T077 [US3] GREEN: give `PaymentSurface`'s working phases Arabic-first copy — the surface
  header (`PaymentSurface.tsx:484` — today `<h2>Payment</h2>`; also `aria-label="Payment"` at
  `:482`. **Not** `:396`/`:437` — stale, see the anchor correction above), the tender-state status
  line, the confirm action, and the refusal copy. Make the `PaymentSurface` half of T076 pass.
- [x] T078 [US3] GREEN: give `PaymentCartSummary` Arabic-first copy — today `Order summary`
  (`:42`) and `Subtotal` (`:62`) are English-only. Money values stay `dir="ltr"` mono (FR-21).
  Make the `PaymentCartSummary` half of T076 pass.
- [x] T079 [P] [US3] GREEN: audit and complete Arabic-first copy in the remaining entry surfaces
  (`CashEntry`, `AmountPad`, `VoucherEntry`, `ExternalCardTerminalEntry`, `MoneyRoll`), including
  labels, placeholders, `aria-label`s and validation/refusal messages. **Copy only** — no change to
  amount parsing, tender application, or any bridge call.

> ⚠️ **T077–T079 are copy + presentation changes only.** They must not alter the payment FSM,
> money math, tender application, voucher authority, or the split-tender return-to-selection
> behaviour (T075). Every payment test must still pass **unmodified** (T074).

- [ ] T0E1 [US3] Gates + capture `u3-checkout-before/after.png`; compare against
  `visual-references/04-checkout-tender.png`. Confirm no English-only operator string remains
  visible in the captured working flow.

---

## Phase 8 — US4: Completion convergence (P2)

**Goal:** The completion surface U4a repaired now renders in the v4.0 system, with print/reprint
affordances intact.

- [ ] T080 [US4] RED+GREEN: apply v4.0 tokens to the completion surface built in US4a.
- [ ] T081 [P] [US4] RED+GREEN: reprint/print-failure affordances in
  `src/renderer/ui/receipts/ReprintAffordance.tsx`, `PrinterFailureBanner.tsx`,
  `DrawerFailureBanner.tsx` — restyled, **never suppressed or softened** (Constitution IV).
- [ ] T082 [US4] Assert no SMS/WhatsApp/email dispatch, confetti/celebration, KPI tiles, or
  fabricated fiscal information were introduced (Non-Capability).
- [ ] T083 [US4] Capture `u4a-sale-success-after.png` in the v4.0 palette.
  > **Correction (2026-09-22):** this task previously read "**Re-capture** … superseding the
  > pre-v4.0 capture from T0A2; prune the superseded file." **There is no T0A2 capture to supersede
  > or prune** — `screenshots/` has never held anything but `README.md`, and T0A2 is still open.
  > Written as-was it sends an implementer looking for a file that does not exist, and the "prune"
  > step is a no-op that could be mistaken for a missed deliverable. This is the **first** capture
  > of the surface, taken directly in the v4.0 palette. If T0A2 is captured before US4 lands, the
  > original re-capture-and-prune wording applies again; if US4 lands first, T0A2 is satisfied by
  > this capture and should be closed as folded-in rather than left open.

---

## Phase 9 — US5: Empty / loading / error / offline / gated states (P2)

**Goal:** Every non-happy state is honest, actionable, and visually part of v4.0.
**Independent test:** each state reachable (dev `?state=` / `?conn=` params) renders distinctly;
gated ≠ failed; connection state is a persistent banner.

- [ ] T090 [P] [US5] RED+GREEN: loading/empty/error primitives in `src/renderer/ui/states/**`.
- [ ] T091 [P] [US5] RED+GREEN: catalogue-specific states —
  `ui/catalogue/CatalogueUnavailableState.tsx`, `NotFoundState.tsx`, `AmbiguousBarcodeState.tsx`
  (distinguish "no catalogue data yet" from "search found nothing").
- [ ] T092 [P] [US5] RED+GREEN: **Arabic-first gated-state copy** for the cart route that US1's
  landing correction now routes cashiers to (`CartWorkspace.tsx` — today's English-only
  "Cart functionality coming soon", spec A9), plus the other `routes/app/*Placeholder.tsx`.
- [ ] T094 [US5] RED+GREEN: connection state stays a **persistent banner, never a toast** (FR-25) in
  `shell/regions/ConnectionIndicator.tsx`; no colour-only communication (FR-26); gated
  distinguishable from failed (FR-27).
- [ ] T095 [US5] RED+GREEN: payment refusal + empty-cart states (`ui/cart/EmptyCartPlaceholder.tsx`)
  — state what the cashier can do next; never clear entered amounts silently.
- [ ] T0F1 [US5] Gates + capture one screenshot per state variant.

---

## Phase 10 — US6: Keyboard / accessibility / final polish (P2)

**Goal:** The whole journey is keyboard-operable, contrast-clean, RTL-correct, and visually
consistent under repetitive high-throughput use.

- [ ] T100 [US6] RED+GREEN: keyboard traversal of every cashier-critical path, logical RTL focus
  order (FR-23, NFR-2) — extend `ui/catalogue/__tests__/keyboard-walkthrough.test.tsx` to the full
  journey.
- [ ] T101 [P] [US6] RED+GREEN: axe smoke over every restyled default state variant (NFR-4) —
  `ui/primitives/__tests__/axe-smoke.test.tsx`, `ui/catalogue/__tests__/a11y.full.test.tsx`,
  `ui/operator/__tests__/axe-smoke-s5.test.tsx`.
- [ ] T102 [P] [US6] Verify WCAG AA contrast (≥4.5:1 body, ≥3:1 large/UI) on the light default
  (NFR-3) across all cashier surfaces.
- [ ] T103 [P] [US6] Verify ≥44×44 hit targets on every cashier-critical control (NFR-1) via the
  existing invariant test in `src/renderer/ui/`.
- [ ] T104 [US6] Verify **exactly one** primary-action treatment per surface (FR-14/FR-38) and RTL
  directional-icon correctness (FR-22) across US1–US5.
- [ ] T105 [US6] Verify motion stays minimal and reduced-motion-respecting (FR-39) —
  `ui/__tests__/reduced-motion.test.tsx`.
- [ ] T106 [US6] **Anti-pattern verification across every cashier surface (FR-33–FR-39).** Walk the
  journey and confirm the absence of: cards nested in cards without operational value (FR-33);
  decorative gradients, glow, or stacked shadows (FR-34); **marketing hero imagery, taglines or
  brand-promotional content (FR-35)**; decorative icon tiles with no operational meaning (FR-36);
  any displayed numeric business value not sourced from a system-computed field (FR-37); competing
  primary buttons (FR-38); excessive animation (FR-39).
  ⚠️ **FR-35 is the highest-risk item in this feature:** reference images 1, 2 and 5 all carry a
  marketing hero band and tagline. They are visual *reference*, and that chrome must never reach the
  working terminal. "It matched the reference" is not a defence.

---

## Phase Final — Polish & Cross-Cutting

- [ ] T110 Full gate run: `npm run typecheck` → `npm run lint` → `npm test` →
  `npm run build:renderer`. **No regression vs the T003 baseline.**
- [ ] T111 Verify no file under `src/main/**`, `src/preload/**`, `src/shared/bridge-api.ts`, or
  `migrations/**` was modified (SC-17, P8) — `git diff --stat` check.
- [ ] T112 Verify no production feature-flag default changed (FR-41) and no Non-Capability item
  appears in any shipped surface (FR-42/SC-16).
- [ ] T113 Verify every merged slice carries before/after screenshots + a named reference comparison
  (SC-14); prune superseded captures against the size budget.

---

## Dependency Graph

```
Setup (T001–T003)
   │
   ├──► US4a ──────────────────────────────┐   (palette-independent; ships first)
   │                                        │
   ├──► US0 ─┬──► US1 ──┐                   │
   │         ├──► US2 ──┤                   │
   │  US0-R ─┘   US3 ──┼──► US4 ◄───────────┘   (US4 needs US0 + US4a)
   │              US5 ──┤
   │                    └──► US6 ──► Polish
```

| Slice | Depends on | Rationale |
|:--|:--|:--|
| US4a | Setup | Semantic-token-only; needs no palette |
| US0 | Setup | Foundational token system |
| US0-R | Setup | Doc authority; bundled with US0 |
| US1/US2/US3/US5 | US0 | Consume v4.0 tokens |
| US4 | US0 + US4a | Converges the surface US4a repaired; takes the **first** valid v4.0 capture of it (T083 — T0A2's was never taken) |
| US6 | US1–US5 | Cross-cutting; needs surfaces final |

## Parallel Execution Examples

- **After US0 lands:** US1, US2, US3 and US5 are independent (different file trees) and may proceed
  concurrently.
- **Within US0:** T029–T032 (Button / Input / Badge / Table+Card) are `[P]` — separate primitive
  directories.
- **Within US5:** T090, T091, T092 are `[P]` — separate state files.
- **Never parallel:** T020→T021→T022 (theme flip is one coherent change); any task against
  `tailwind.css` (single file).

## Implementation Strategy

1. **Ship US4a first** — smallest, highest-integrity win; fixes an already-ratified Arabic-first
   violation and a missing receipt, with no bridge change and no palette dependency. Accept that its
   screenshot is pre-v4.0 and is re-captured at T083.
   > **Premise correction (`/speckit-analyze` 2026-09-22):** T0A2's pre-v4.0 capture was never
   > taken, so T083 is the **first** valid v4.0 capture of that surface rather than a re-capture.
   > The ordering rationale is unaffected.
2. **Then US0 + US0-R together** — the token system plus the authority banner that stops agents
   following superseded rules. This is the widest-blast-radius slice; keep it token-values-only.
3. **Then US1 → US2 → US3** (or parallel) — surface-by-surface convergence, each independently
   reviewable with its own screenshots.
4. **Then US4, US5** — completion convergence and state honesty.
5. **US6 last** — cross-cutting verification once surfaces are final.
6. **Checkpoint after each slice:** gates green + screenshots captured + reference named. If US4a
   cannot be expressed in existing semantic tokens, reorder US0 ahead of it (plan §Proposed Slice
   Order).

---

## Requirement → Task Traceability

Every FR, NFR and SC maps to at least one verifying task (analysis finding A2). **47/47 FR ·
7/7 NFR · 20/20 SC.**

### Functional requirements

| FR | Verified by | FR | Verified by |
|:--|:--|:--|:--|
| FR-1 light default | T020, T021, T022 | FR-25 banner not toast | T094 |
| FR-2 no dark dependency | T023, T024 | FR-26 no colour-only | T031, T094 |
| FR-3 pharmacy teal primary | T023 | FR-27 gated ≠ failed | T092, T094 |
| FR-4 teal fill permitted | T023, T029 | FR-28 Arabic completion | T012, T013 |
| FR-5 navy text/structure | T023 | FR-29 receipt presented | T016, T017 |
| FR-6 orange/red reserved | T023, T031 | FR-30 new-sale preserved | **T019a** |
| FR-7 blue informational | T023 | FR-31 no unconfirmed success | T018, T019, **T013a** |
| FR-8 tokens only | T023, **T025**, **T025a** | FR-32 no invented channel | T082 |
| FR-9 borders over shadows | T023, T032 | FR-33 no nested cards | **T106** |
| FR-10 intentional Arabic face | T026, T028 | FR-34 no gradients/glow | **T106** |
| FR-11 single type scale | T026 | FR-35 no marketing hero | **T106** |
| FR-12 tabular money | T027 | FR-36 no decorative tiles | **T106** |
| FR-13 mixed AR/Latin | T026, T027 | FR-37 no fabricated numbers | T019, T082, **T106** |
| FR-14 one primary action | T104 | FR-38 no competing primaries | T104, **T106** |
| FR-15 cart dominant | T060, T063 | FR-39 minimal motion | T105, **T106** |
| FR-16 amount hierarchy | T014, T015, T070 | FR-40 no behaviour change | T053, T065, T074, **T075**, T111 (U3 copy tasks T077–T079 are presentation-only) |
| FR-17 destructive separated | T029 | FR-41 no flag defaults | T112 |
| FR-18 quiet secondary text | T023, T102 | FR-42 no Non-Capability | T064, T071, T082, T112 |
| FR-19 Arabic-first strings | T012, T013, T054, T092, **T076–T079** | FR-43 restyle without ungating | T092, T112 |
| FR-20 RTL composition | T060, T104 | FR-44 role-aware landing | T050, T052 |
| FR-21 LTR isolation | T013, T027 | FR-45 DashboardRoute intact | T051, T053 |
| FR-22 directional icons | T104 | FR-46 no auth/flag change | T053, T112 |
| FR-23 RTL focus order | T100 | FR-47 renderer-only | T052, T111 |
| FR-24 honest states | T090–T095 | | |

### Non-functional requirements

| NFR | Verified by |
|:--|:--|
| NFR-1 ≥44×44 targets | T063, T103 |
| NFR-2 keyboard + visible focus | T033, T100 |
| NFR-3 WCAG AA contrast | T102 |
| NFR-4 axe smoke clean | T101 |
| NFR-5 first-paint budget | **T034** |
| NFR-6 confirmed-settlement only | **T013a**, T018, T019 |
| NFR-7 Windows desktop target | T028, T0B2 |

### Success criteria

| SC | Verified by | SC | Verified by |
|:--|:--|:--|:--|
| SC-1 tokens resolve | **T025**, **T025a** | SC-11 no fabricated values | T019, **T106** |
| SC-2 light paints | T020–T022 | SC-12 distinct states | T090–T095 |
| SC-3 one primary/surface | T104 | SC-13 truthful completion | T012–T019 (incl. **T013a**) |
| SC-4 Arabic-first strings | T012, T054, T092, **T076–T079** | SC-14 screenshots per slice | T0A2, T0B2, T0C1, **T0C2**, T0D1, T0E1, T0F1, T113 |
| SC-5 dominant amounts | T014, T070 | SC-15 suite green | T003, T110 |
| SC-6 LTR isolation | T013, T027 | SC-16 no Non-Capability | T112 |
| SC-7 44×44 | T103 | SC-17 no P8 paths touched | T111 |
| SC-8 keyboard complete | T100 | SC-18 v3.5 traceable | T040, T041 |
| SC-9 axe clean | T101 | SC-19 cashier landing | T050, T051, **T0C2** |
| SC-10 AA contrast | T102 | SC-20 references pixel-identical | T001 |

---

*Tasks derive from [plan.md](./plan.md). Scope or approach changes MUST update the plan and re-run
task generation.*
