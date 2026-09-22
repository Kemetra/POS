# Implementation Plan: POS UI v4.0 — Rescue / Visual Convergence

**Feature ID:** 022-pos-ui-v4-rescue
**Spec:** [./spec.md](./spec.md)
**Plan Version:** 1.0
**Created:** 2026-09-18
**Last Updated:** 2026-09-18
**Constitution version pinned:** v1.5.1

---

## Technical Context

No new technology is introduced. Every choice below is either already pinned by the constitution or
is a value-level change inside an existing mechanism.

| Area | Choice | Source |
|:--|:--|:--|
| Stack | Electron 40 + React 19 + Vite 8 + TypeScript 5.6 (strict) + Tailwind 4 — unchanged | constitution v1.5.1 |
| Styling mechanism | Existing CSS custom-property token layer in `src/renderer/styles/tailwind.css`; components already resolve through `var(--color-*)` | source inspection |
| Theme mechanism | Existing `:root` (light base) + `:root[data-theme='dark']` override; flip which is default | `tailwind.css:3-250`, `theme-store.ts` |
| Typography | **Declared system font stack** (no package, no `@font-face`, no bundled file) | [research.md](./research.md) §1 |
| Routing | Existing `react-router-dom` route table; role-aware index redirect only | `router.tsx:175` |
| State | Existing Zustand stores (`theme-store`, `operator-session-store`); no new store | source inspection |
| Tests | Vitest + Testing Library + axe smoke, all existing | constitution VI |
| Visual acceptance | Manual screenshot capture from the running Electron app | spec §Screenshot Acceptance |
| New dependencies | **None.** No package, framework, or harness is added by this feature | spec Out of Scope |

**No NEEDS CLARIFICATION items remain.** Spec open questions: 0.

---

## Design-Authority Hierarchy

When two sources disagree, the higher row wins. This ordering is the spine of the whole feature.

| Rank | Authority | Governs |
|:--:|:--|:--|
| 1 | `.specify/memory/constitution.md` v1.5.1 | Everything. A VIOLATION blocks the feature |
| 2 | Current source code + backend contracts | **What the product can do** (functional truth) |
| 3 | [`spec.md`](./spec.md) (incl. Non-Capability Inventory) | This feature's scope and requirements |
| 4 | [`visual-references/`](./visual-references/) (5 approved images) | **How it should look** (visual truth only) |
| 4b | [`design-handoff/`](./design-handoff/) — approved Claude Design bundle (HTML mockup, designer spec, tokens) | **Supplementary** to rank 4, same authority and same limits. Read [`RECONCILIATION.md`](./design-handoff/RECONCILIATION.md) first: filenames shuffled (§D), tokens provenance-only (§C), Saudi/ZATCA/VAT/mada/unsupported tenders forbidden (§B) |
| 5 | `docs/design/pos-v3.5/**` | Structure, component inventory, copy patterns, honesty behaviour — **except** the three axes v4.0 supersedes |

**The load-bearing split:** rank 2 owns *capability*; rank 4 owns *appearance*. A reference image
never creates a feature. Where an image shows something the code cannot do, the Non-Capability
Inventory governs and the pixel is ignored.

---

## Constitution Check (Initial)

Both sets are walked, per the constitution's own instruction that a plan MUST walk Roman I–IX **and**
P1–P18.

### Core Principles (I–IX)

| Principle / Constraint | Status | Notes |
|:--|:--:|:--|
| I. Offline-First | **PASS** | No network behaviour touched. U5 improves the truthfulness of offline presentation |
| II. Financial Precision | **PASS** | No money arithmetic. U3/U4 restyle values already computed by the engine; FR-37 forbids displaying any non-engine-sourced number |
| III. Process-Boundary Discipline | **PASS** | Renderer-only. No `BrowserWindow` flag, no IPC, no preload change |
| IV. Hardware Loud, Not Silent | **PASS** | Existing printer/drawer failure banners are restyled, never suppressed or softened (U5) |
| V. Type Safety End-to-End | **PASS** | No contract or generated-type change; `npm run typecheck` is a gate on every slice |
| VI. Test-First, Coverage-Gated | **PASS** | Each slice adds/updates renderer tests before implementation; see §Test Strategy |
| VII. Observability | **PASS** | No logger or Sentry change; no new data reaches either |
| VIII. Terminal Identity ≠ User | **PASS** | No pairing or identity change. FR-46 forbids touching cashier authorization |
| IX. Reference, Not Inheritance | **PASS** | v4.0 is re-derived against production tokens. The vendored images are *visual* reference; no prototype code is pasted (v3.5 CLAUDE.md's own rule, retained) |
| Platform Integration | **PASS** | No backend, DP-2, Connector, or ERPNext change |
| Security | **PASS** | No secret, token, or PII path touched. Screenshots must not capture secrets — see §Screenshot Acceptance |
| Hardware Matrix | **PASS** | Windows 10/11 x64 desktop, touchscreen-first, ≥ 44 × 44 floor preserved (NFR-1) |
| Domain — Pharmacy POS | **PASS** | Egypt/product truth governs; no fiscal behaviour introduced (spec Decision E) |

### Cross-Feature POS Principles (P1–P18)

| Principle | Status | Notes |
|:--|:--:|:--|
| P1. Financial Correctness First | **PASS** | Visual polish explicitly subordinate; no correctness traded for appearance |
| P2. No Fake Success States | **PASS** — *load-bearing* | U4a asserts success only on the main-process-confirmed `settled_at` + finalized sale (NFR-6). No confetti, no optimistic completion |
| P3. No Silent Data Loss | **PASS** | No write path touched |
| P4. Auditability | **PASS** | No audit emit added, removed, or altered |
| P5. Idempotency | **PASS** | No retryable operation introduced |
| P6. No Raw Cardholder Data | **PASS** | No card data path; U3 restyles only tender *selection* and amounts |
| P7. Secrets Never Reach Renderer/Logs | **PASS** | No secret surfaced. Screenshot workflow carries an explicit redaction check |
| P8. Electron Security Boundary | **PASS** — *load-bearing* | `src/main/`, `src/preload/`, `src/shared/bridge-api.ts`, `migrations/` are out of scope (spec). **U4a consumes the existing `receipts.preview` channel through the existing `ReceiptPreview` component — a new *consumer* of an existing channel, not a surface change** |
| P9. Truthful Offline/Degraded/Sync | **PASS** | U5 keeps connection state a persistent banner (FR-25) and forbids fabricated status |
| P10. Operator Accountability | **PASS** | No sensitive action added; FR-17 increases separation of destructive actions |
| P11. Supportability Without Leakage | **PASS** | Refusal copy stays generic; no factor-distinguishing variants introduced |
| P12. Spec Kit Artifacts Are Source of Truth | **PASS** | This plan + spec govern; v3.5 reconciliation (U0-R) prevents a competing instruction source |
| P13. Small, Scoped PRs | **PASS** | 8 independently reviewable slices; U0 is token-values-only (~130 lines) |
| P14. Accessibility & Cashier Ergonomics | **PASS** | NFR-1/2/4 cite and extend P14; U6 is a dedicated convergence slice |
| P15. Production Readiness Gates | **PASS** | UI-only features are explicitly exempt ("e.g., 003-pos-ui-shell"). U4a sits adjacent to the receipt path — a readiness note is elected at U4a, not a full gate |
| P16. Feature Scope Discipline | **PASS** — *load-bearing* | Non-Capability Inventory (12 entries) is the enforcement artifact |
| P17. Privacy & Tenant Isolation | **PASS** | No tenant-scoped data path touched |
| P18. *(see constitution)* | **PASS** | No applicable surface |

**Result: 0 VIOLATION, 0 WAIVED.** Cleared to proceed to `/speckit-tasks` after this plan is accepted.

---

## Phase 0 — Research

See [./research.md](./research.md). Resolves: the Arabic typography strategy (and why it needs no
dependency), the light-default switch points, the dark-register disposition, and the U4a wiring
feasibility.

## Phase 1 — Design & Contracts

- **Data model:** *Not produced — no persisted entity, schema, or migration.* (Precedent: 007,
  the closest UI-only feature, produced no `data-model.md`.)
- **Contracts:** *Not produced — no IPC, bridge, or backend contract is added or changed (P8).*
- **Quickstart (developer path):** [./quickstart.md](./quickstart.md) — how to launch, reach each
  surface honestly, and capture acceptance screenshots.

---

## Project Layout

Files this feature expects to touch. **No file outside `src/renderer/**`, `docs/design/pos-v3.5/`
(banner only), and `specs/` is in scope.**

```
src/renderer/
  index.html                     # U0  — data-theme default
  styles/
    tailwind.css                 # U0  — :root token VALUES + dark register only
    __tests__/theme-contract.test.ts   # U0 — invert 3 dark-default assertions
  stores/theme-store.ts          # U0  — DEFAULT_THEME
  router.tsx                     # U1  — role-aware /app index redirect
  routes/sign-in.tsx             # U1
  routes/app/CartWorkspace.tsx   # U2
  ui/catalogue/**                # U2
  ui/cart/**                     # U2
  ui/payments/**                 # U3, U4a
  ui/receipts/**                 # U4a
  ui/states/**                   # U5
  ui/primitives/**               # U0 (button/input/chip treatment), U6
docs/design/pos-v3.5/
  CLAUDE.md, README.md           # U0-R — superseded banner ONLY (no rewrite)
specs/022-pos-ui-v4-rescue/
  screenshots/                   # acceptance evidence
specs/README.md                  # U0-R — status row refresh
```

---

## Proposed Slice Order

### Recommendation: **U4a first**, then U0, then U1 → U6

```
U4a ──► U0 ──┬──► U1 ──► U2 ──► U3 ──► U4 ──► U5 ──► U6
             │      (U1–U5 may parallelise after U0;
             └───►   U6 requires all of them)
       U0-R (authority reconciliation, rides with U0)
```

**Dependency graph**

| Slice | Depends on | Why |
|:--|:--|:--|
| **U4a** | — | Semantic-token-only; needs no new palette |
| **U0** | — | Foundational; defines the system U1–U6 consume |
| **U0-R** | — | Doc-authority only; bundled with U0 |
| **U1** | U0 | Consumes v4.0 tokens |
| **U2** | U0 | " |
| **U3** | U0 | " |
| **U4** | U0, U4a | Completes the completion surface U4a repaired |
| **U5** | U0 | " |
| **U6** | U1–U5 | Cross-cutting convergence check; needs the surfaces final |

### Why U4a before U0 — and the cost of doing so

U4a is recommended first because it repairs an **already-ratified** rule violation (Arabic-first)
plus a missing receipt on the completion path. Those are production-quality defects today, and
neither depends on the v4.0 palette.

The rework risk is genuinely low, and this was verified rather than assumed:

- Token **names** are stable; the repo's token tests assert names/structure, not hex values. CSS
  written against `var(--color-*)` survives U0's value flip untouched.
- U4a's content work — Arabic copy, mounting `ReceiptPreview`, totals hierarchy — is
  palette-independent.

**Two real costs, accepted deliberately:**

1. **U4a's "after" screenshot is captured in the pre-v4.0 (dark/navy) system** and will be
   superseded by U0. It must be **re-captured after U0** to serve as the final visual record. This
   is scheduled, not incidental.

   > **Premise correction (`/speckit-analyze` 2026-09-22).** This cost was **never actually
   > incurred**: T0A2's pre-v4.0 capture was never taken (`screenshots/` has only ever held
   > `README.md`), so there is no superseded artifact to replace or prune. T083 is therefore the
   > **first** valid v4.0 sale-success capture, not a re-capture. The paragraph above is retained as
   > the historical rationale for the U4a-before-U0 ordering, which still stands on its own merits;
   > only its *consequence* did not materialise. Every "re-capture" reference below reads the same
   > way.
2. **The first shipped slice of a visual-convergence feature will not yet look like v4.0.** This is
   acceptable because U4a's value is *honesty*, not appearance.

**Binding constraint that makes this order safe:** U4a MUST use semantic tokens only — **no colour
literals, no hex, no bespoke one-off values.** If U4a cannot be expressed in existing semantic
tokens, that is the signal to swap the order and do U0 first.

---

## Slice Plans

### U0 — Visual Foundation

**Objective.** Define the v4.0 system once, in tokens, so every downstream slice is a consumer
rather than a redesign.

**Architecture decision (load-bearing).** `tailwind.css` is 4627 lines: `:root` tokens at 3–133,
the dark register at 135–250, and `@layer components` from 329 onward (class families mapped 1:1
from the v3.5 kit). **U0 changes token VALUES in `:root` and the dark register only. It does NOT
edit `@layer components`.** Because every component already resolves through `var(--color-*)`, a
~130-line diff re-themes the entire terminal. This keeps U0 reviewable and structurally incapable
of becoming the forbidden "renderer rewrite".

**Light-default flip.** Structurally trivial: `:root` is *already* the light base and dark is the
opt-in override. Three switch points:

| Point | Current | Change |
|:--|:--|:--|
| `src/renderer/index.html:14` | `data-theme="dark"` | light default (flash-free static attribute retained) |
| `src/renderer/stores/theme-store.ts` | `DEFAULT_THEME: Theme = 'dark'` | `'light'` |
| `styles/__tests__/theme-contract.test.ts` | 3 hardcoded `'dark'` default assertions | invert to light |

`theme-store.test.ts` mostly asserts via the `DEFAULT_THEME` **symbol**, so it follows the flip
automatically — only genuinely hardcoded cases need review.

**Colour.** Extend/retune **existing semantic tokens**; introduce no screen-specific colour.

| Token family | v4.0 direction |
|:--|:--|
| `--color-background` / `--color-surface` | Light clinical surfaces (near-white, faint cool tint) |
| `--color-primary*` | **Pharmacy green-teal** — primary operational colour; may fill large primary actions (supersedes the One-Accent Rule) |
| `--color-text` / rail | Dark navy — text, structure, high-contrast information |
| `--color-info*` | Controlled blue — informational/selection only |
| `--color-warning*` | Orange — warnings only |
| `--color-danger*` | Red — destructive/error only |
| `--color-border*` | Neutral rules; separation by border + spacing, not shadow stacking |
| `--shadow-*` | Restrained; no glow, no stacked elevation |

**Explicit decision required at U0 (do not let this fall out implicitly): the dark register's
disposition.** Options: (a) retune the ~6 core dark tokens so dark is v4.0-consistent
(pharmacy teal adapted for dark surfaces), or (b) freeze the v3.5 Vault Dark values. **Plan
recommends (a)** — leaving it means shipping two visual identities in one product. Either way the
theme-contract guards for "dark register exists" and "token-overrides-only" are **preserved**.

**Typography.** See [research.md](./research.md) §1. Declared, ordered **system stack** — no
package, no `@font-face`, no bundled file, therefore **no approval gate**. The current defect is
that `'Inter Variable', Inter` resolve to nothing on the target, so Arabic silently lands on
whatever the OS picks. Naming an ordered stack *is* the intentional selection FR-10 requires.
`no-brand-font.test.ts` guards `@font-face` blocks only and is unaffected. **U0 acceptance includes
verifying Arabic rendering on target hardware** — this plan does not assert it from a dev machine.

**Spacing/size.** Keep the existing 4 px scale and the ≥ 44 × 44 floor; tighten density where the
references show a denser rhythm. No oversized decorative whitespace.

**Shared components.** Assign ownership so downstream slices restyle nothing locally:
`ui/primitives/Button` (primary/secondary/destructive), `Input` (incl. search/scan),
`Badge` (status chips), `Table` (cart/tender rows), `Card` (panels/surfaces), plus the global
`:focus-visible` rule. No component-library rewrite.

**Likely files.** `styles/tailwind.css`, `index.html`, `stores/theme-store.ts`,
`ui/tokens/*.ts` (only if a token name is genuinely missing), `ui/primitives/**`,
`styles/__tests__/theme-contract.test.ts`.

### U0-R — Historical v3.5 authority reconciliation (rides with U0)

**Problem.** `docs/design/pos-v3.5/CLAUDE.md` is a **directory-scoped agent-instruction file**. An
agent working in that directory auto-loads "dark theme is the default" and the One-Accent Rule —
both now superseded. Left alone, it actively instructs future agents to violate v4.0.

**Smallest auditable approach — a banner, not a rewrite:**

1. A short **SUPERSEDED-FOR-v4.0 banner** at the top of `docs/design/pos-v3.5/CLAUDE.md` naming the
   three superseded axes and pointing at `specs/022-pos-ui-v4-rescue/` + `visual-references/` as
   current visual authority.
2. Inline supersede markers at the two conflicting lines only: `README.md:59` (One-Accent Rule) and
   `README.md:64` (dark default).
3. Everything else in v3.5 stays **verbatim and valid** — it remains the authority for structure,
   components, copy patterns and honesty behaviour.

**Explicitly not done:** no wholesale rewrite, no deletion, no mass edit. Precedent: 017's artifacts
carry SUPERSEDED-IN-PART banners rather than being rewritten.

**Also in U0-R:** refresh the `specs/README.md` row for 022 (currently says "SPECIFY only", which is
already stale after CLARIFY).

### U1 — Sign-in + role-aware landing

**Objective.** Arabic-first sign-in presentation in the v4.0 system, plus the approved navigation
correction.

**Routing strategy (the approved FR-40 exception).**

| Aspect | Decision |
|:--|:--|
| Change point | `src/renderer/router.tsx:175` — the `/app` **index** redirect only |
| Behaviour | `cashier` → `/app/cart`; `manager`/`admin` → `/app/dashboard` |
| Role source | Existing `useOperatorSessionStore` — renderer-only state the route layer already reads |
| `DashboardRoute` | **Unchanged.** Its cashier rejection (`DashboardRoute.tsx:16-24`) stays; a cashier navigating *directly* to `/app/dashboard` still gets it (FR-45) |
| `OperatorRouteGuard` | **Unchanged**, not bypassed, not weakened |
| `/app/cart` guard | None needed — the route carries no `allow` list; the parent `/app` guard already covers it |
| Flags | Untouched. On a cart-gated build the cashier lands on the cart route's **honest gated state** — the intended outcome (FR-46) |
| P8 | No bridge/main change ⇒ SC-17 preserved (FR-47) |

**Honest limit (A9):** today that gated state is English-only, so FR-44 alone does **not** satisfy
Arabic-first; U2/U5 complete it.

**Not in scope:** shift-start capability. The reference image shows it; register **D-003** records
open-shift as deferred to Slice 12. U1 presents *existing* sign-in/session behaviour only.

**Likely files.** `router.tsx`, `routes/sign-in.tsx`, `ui/operator/**`,
`routes/__tests__/router.test.tsx`, `routes/__tests__/operator-route-guard.test.tsx`.

### U2 — Sale workspace / catalogue / cart

**Objective.** A strong two-region working layout: catalogue/search on one side, a highly legible
cart on the other, with the continuation action unmistakable.

Covers existing capability only — product search, barcode scan, confirm-add, cart lines, quantity,
totals, continuation. **Preserves the single cart mutation path** (005's `resolveItemRef` seam;
`CartPane`'s register-callback into `CatalogueSalePane`). No parallel cart mutation, no new
capability, no dashboard-style treatment.

Retains the honest VAT placeholder (`—` / tax-pending) exactly as-is — D-007, and the references'
15% VAT line is Non-Capability.

**Likely files.** `routes/app/CartWorkspace.tsx`, `ui/catalogue/**`, `ui/cart/**`.

### U3 — Checkout / tender

**Objective.** Amount due dominant; supported tender selection obvious; refusals honest.

**Only the three supported tenders** — `cash`, `external_card_terminal`, `internal_voucher`
(`TenderSelection.tsx:26`). Explicitly **not** planned: insurance, credit, mada, wallet, gift card
(register D-009 already rejected these from the prototype). **No client-side money arithmetic and no
client-side voucher authority** — both remain main-process concerns. The payment FSM and money
computation are byte-for-byte unchanged.

**Likely files.** `ui/payments/PaymentSurface.tsx`, `TenderSelection.tsx`, `CashEntry.tsx`,
`AmountPad.tsx`, `VoucherEntry.tsx`, `ExternalCardTerminalEntry.tsx`, `PaymentCartSummary.tsx`.

### U4a — Sale-success honesty  *(recommended first implementation slice)*

**Current defect (verified in source).** `PaymentSurface.tsx:392-431` renders the settled phase as
English-only text — `"Payment settled."`, `"Sale {n}"`, `"New sale"`, header `"Payment"` — on an
Arabic-first product. `ReceiptPreview` is **never mounted on the completion path**; its only
consumer is `FindSaleReceipt.tsx`. A cashier completes a sale and sees no receipt.

**Wiring feasibility — checked, and it clears.** `ReceiptPreview` needs a `saleId`.
`PaymentSurface` already polls `sales.subscribe({ topic: 'recent' })`, which returns
`RecentSaleSummary { sale_id, sale_number, finalized_at }` (`src/shared/sales/types.ts:165`). The
component currently keeps only `sale_number` and **discards `sale_id`** — the value U4a needs is
already in hand. Therefore:

- **No bridge field is added. No `bridge-api.ts` change. P8 clear.**
- `ReceiptPreview` calls the existing `receipts.preview` channel itself — U4a is a **new consumer of
  an existing channel**, not a surface expansion. (Called out so review does not misread it as P8.)

**Delivers.** Arabic-first completion copy; mount the existing `ReceiptPreview` for the finalized
sale; strengthen the settled-amount hierarchy; keep existing `onNewSale` behaviour intact.

**Honest degradation (P2 — mandatory).** Two states must stay truthful and must not be papered over:

| Condition | Required behaviour |
|:--|:--|
| `saleFinalization` flag off (default) | 008's finalize listener short-circuits ⇒ no receipt exists. U4a must say so honestly — **never** render a placeholder receipt |
| `settledSaleNumber` / `sale_id` null (poll failed or unmounted) | Today the block is simply omitted. U4a must preserve that omission — **no fabricated sale number**, no fake completion detail |

**Does not.** Alter the payment FSM, money math, or audit behaviour; add SMS/WhatsApp/email;
add confetti/celebration; add KPI tiles; fabricate fiscal information.

**Likely files.** `ui/payments/PaymentSurface.tsx` (settled branch), `ui/receipts/ReceiptPreview.tsx`
(consumer wiring; component itself likely unchanged), `routes/app/checkout/CheckoutRoute.tsx`,
plus their tests.

### U4 — Remaining completion/receipt convergence

Applies the v4.0 system to the completion surface U4a repaired, plus reprint/print-failure
affordances (`ReprintAffordance`, `PrinterFailureBanner`, `DrawerFailureBanner`) — restyled, never
suppressed (Constitution IV). Includes the **first** valid v4.0-palette capture of U4a's surface
(T083 — not a re-capture; T0A2's pre-v4.0 capture was never taken).

### U5 — Empty / loading / error / offline / gated states

Coherent v4.0 treatment for: loading, empty, validation error, backend unavailable, offline,
disabled action, gated feature, payment refusal, print/receipt failure. Every state honest and
actionable; connection state stays a **persistent banner, never a toast** (FR-25); no
colour-only communication (FR-26); a gated surface remains distinguishable from a failed one
(FR-27). Includes Arabic-first copy for the cart gated state that U1's landing correction now
routes cashiers to.

**Likely files.** `ui/states/**`, `ui/catalogue/CatalogueUnavailableState.tsx`, `NotFoundState.tsx`,
`ui/cart/EmptyCartPlaceholder.tsx`, `shell/regions/ConnectionIndicator.tsx`,
`routes/app/*Placeholder.tsx`.

### U6 — Keyboard / accessibility / final polish

Cross-cutting convergence check over U1–U5: keyboard traversal, logical focus order, visible focus,
RTL directional correctness, hit targets, WCAG AA contrast, mixed Arabic/LTR values, repetitive
high-throughput use, visual consistency, and removal of competing primary actions (FR-14/FR-38).
Motion stays minimal and reduced-motion-respecting (FR-39).

---

## Shared Token / Component Strategy

1. **Tokens are the only place colour changes.** U0 edits `:root` + dark register values. Downstream
   slices consume `var(--color-*)`; a slice that needs a new literal has found a missing token —
   the fix is to add the token in U0, not a local value. This is what prevents the "teal palette
   drift between screens" risk.
2. **`@layer components` stays structurally intact.** Class families already map to the shipped
   stylesheet; U0 re-themes them by value.
3. **Primitives own treatment.** Button/Input/Badge/Table/Card carry v4.0 styling once; feature
   surfaces do not restyle locally.
4. **Prefer existing semantic names.** New token names only when a genuine semantic gap exists
   (guarded by the token-name parity test).

---

## RTL / Arabic Strategy

- **Systemic, not per-leaf.** `dir="rtl"` + `lang="ar"` stay at the root (`index.html:14`); logical
  CSS properties throughout mean components flip without spot-fixes. Preserved by the existing
  theme-contract assertion.
- **LTR isolation for values.** Money, barcodes, SKUs, sale numbers and payment references remain
  `dir="ltr"` + mono/tabular inside the RTL composition (FR-21) — the pattern `CartPane` already
  uses.
- **Arabic-first copy.** Every operator-facing string leads Arabic (FR-19). U4a is the first
  repair; U2/U5 close the remaining English-only surfaces (notably the cart gated state).
- **Focus order follows RTL visual order** (FR-23), verified in U6.
- **Typeface.** Declared system stack (research §1); verified on target hardware at U0.

---

## Test Strategy

**Baseline to hold: 468 files / 5538 passed / 3 skipped / 0 failed.**

Per-slice gates, targeted first then wider:

```
1. targeted renderer tests for the slice        (fast feedback)
2. npm run typecheck
3. npm run lint
4. npm test                                     (full suite — no regression)
5. npm run build:renderer                       (slices touching CSS/tokens)
```

| Slice | Existing tests that must stay green | Tests to add/update |
|:--|:--|:--|
| U0 | `ui/tokens/__tests__/tokens.test.ts` (name parity), `no-brand-font.test.ts`, `reduced-motion.test.tsx`, `axe-smoke.test.tsx` | **Update** `theme-contract.test.ts` — invert the 3 dark-default assertions; **preserve** the dark-register-exists and token-overrides-only guards |
| U1 | `router.test.tsx`, `operator-route-guard.test.tsx`, `cashier-walling.test.tsx`, `sign-in-route.test.tsx` | **Add** role-aware landing tests: cashier → `/app/cart`; manager/admin → `/app/dashboard`; cashier direct-nav to `/app/dashboard` still rejected |
| U2 | `CartWorkspace.test.tsx`, `CartPane` suite, `catalogue/__tests__/**` (incl. `a11y.full`, `keyboard-walkthrough`) | Render-state + Arabic-copy assertions |
| U3 | `payments/__tests__/**`, `tender-surface-recompose.test.tsx`, `parse-currency-to-minor.test.ts` | Tender presentation; **no** money-math test changes |
| U4a | `SalesWorkspace`/checkout suites, `ReceiptPreview.test.tsx`, `FindSaleReceipt.test.tsx` | **Add** Arabic-copy assertion, receipt-mounted-on-success assertion, and **honest-degradation tests** for flag-off and null-`sale_id` |
| U5 | `states.test.tsx`, `state-variants.test.tsx`, `screen-too-small.test.tsx` | Per-state presentation assertions |
| U6 | `axe-smoke.test.tsx`, `axe-smoke-s5.test.tsx`, `a11y.full.test.tsx`, `keyboard-walkthrough.test.tsx`, `AppShell.*` | Contrast/focus/keyboard convergence |

**Test-change policy (explicit).** Tests are **not** weakened or deleted because a v3.5 assertion
conflicts with v4.0. A test is updated **only** when it encodes a design decision the owner has
superseded — currently the three dark-default assertions in `theme-contract.test.ts`. Every such
change is called out in its PR with the superseding decision named. Behavioural tests (payment,
cart, money, routing guards) must pass **unmodified**.

---

## Screenshot Acceptance Workflow

A UI slice **cannot** be called visually complete from source review. Manual capture is the
accepted mechanism; no harness is added.

**Procedure**

1. **Launch.** `npm run dev` with the verified dev env (see [quickstart.md](./quickstart.md)).
2. **Verify the bypass actually engaged — do not skip.** Confirm the `operator.dev_bypass.active` /
   `catalogue.dev_seed.active` warn lines in the main-process log *before* trusting the screen.
   (During the audit Electron launched but these lines never appeared, so the surface could not be
   confirmed — that failure mode is why this step is mandatory.)
3. **Reach the surface honestly.** Navigate as a cashier would. **Never edit source to manufacture a
   view.** Gated surfaces are reached via the `POS_PULSE_FEATURE_*` dev env vars, which are
   compiled out of packaged builds (`isPackaged` guard) — production defaults are untouched.
4. **Capture before** (where the surface pre-exists), then implement, then **capture after**.
5. **Compare** against the governing image in `visual-references/`, naming which one.
6. **Run the gates** (typecheck/lint/test/build) and the slice's a11y + keyboard checks.

**Evidence convention**

| Item | Rule |
|:--|:--|
| Location | `specs/022-pos-ui-v4-rescue/screenshots/` |
| Naming | `<slice>-<surface>-<before\|after>.png` — e.g. `u4a-sale-success-before.png` |
| Format | PNG, lossless, no scaling |
| Budget | ≤ ~400 KB each; prune superseded captures (the 5 references already add 6.4 MB) |
| Redaction | **No secrets, tokens, pairing codes or real PII in frame** (P7/P17). Dev fixture data only |
| Claim | A slice PR states which reference image it was compared against |

---

## Phase 2 — Implementation Outline

Tasks materialise in `/speckit-tasks`; this is the strategy they derive from.

| # | Slice | Shape |
|:--:|:--|:--|
| 1 | **U4a** | Semantic-token-only Arabic-first completion + receipt mount + honest degradation |
| 2 | **U0 + U0-R** | Token values, light default, typography stack, primitives; v3.5 banner + spec index row |
| 3 | **U1** | Sign-in presentation + role-aware landing (independently reviewable navigation change) |
| 4 | **U2** | Sale workspace/catalogue/cart |
| 5 | **U3** | Checkout/tender |
| 6 | **U4** | Completion convergence + the **first** valid v4.0 sale-success capture (T083 — not a re-capture; T0A2's was never taken, see §Two real costs) |
| 7 | **U5** | State surfaces |
| 8 | **U6** | Keyboard/a11y/consistency convergence |

Each is a separate PR. U1's routing change may be split into its own sub-PR if review prefers the
navigation correction isolated from the sign-in restyle.

---

## Constitution Check (Post-Design)

No design decision above changes any Initial-check verdict. Re-confirmed on the two load-bearing
rows:

| Principle | Status | Post-design note |
|:--|:--:|:--|
| P8. Electron Security Boundary | **PASS** | Confirmed by source: `RecentSaleSummary` already carries `sale_id`, so U4a needs **no** bridge field. No file under `src/main/`, `src/preload/`, `src/shared/bridge-api.ts`, `migrations/` is touched |
| P2. No Fake Success States | **PASS** | U4a's success assertion is bound to the confirmed `settled_at` + finalized sale; both degradation paths (flag-off, null id) are specified to stay honest |
| All other rows | **PASS** | Unchanged from Initial |

**0 VIOLATION, 0 WAIVED.**

---

## Risk Matrix

| # | Risk | Likelihood | Impact | Mitigation |
|:--:|:--|:--:|:--:|:--|
| R1 | Reference images become functional requirements | **High** | **High** | Non-Capability Inventory (12 entries); caveat block adjacent to the images; authority hierarchy ranks code above images; per-PR check |
| R2 | Feature flags hide redesigned surfaces (restyled but never seen) | High | Medium | Screenshot acceptance requires reaching each surface via the dev env path; flags unchanged; U5 makes gated states first-class |
| R3 | Cashier landing reaches an honest but gated cart state | **Certain** on default builds | Medium | Intended and documented (FR-46, A9); U5 gives that state Arabic-first v4.0 treatment |
| R4 | Arabic typography inconsistent across surfaces | Medium | High | One `--font-family-sans` value in U0; on-target-hardware verification in U0 acceptance |
| R5 | Mixed RTL/LTR money & code defects | Medium | **High** | FR-21 LTR isolation; follow `CartPane`'s existing pattern; U6 convergence check |
| R6 | Theme-contract tests encode superseded v3.5 policy | **Certain** | Low | Explicit, owner-sanctioned inversion of exactly 3 assertions; other guards preserved; policy in §Test Strategy |
| R7 | Teal palette drift between screens | Medium | Medium | Tokens are the only colour source; no literals downstream; a missing token is fixed in U0 |
| R8 | Broad CSS change causes visual regressions | **High** | **High** | U0 restricted to token values; `@layer components` untouched; per-slice screenshots; full suite each slice |
| R9 | Renderer change accidentally alters payment/cart behaviour | Medium | **Critical** | Behavioural tests must pass **unmodified**; no engine/FSM/money file in scope; U3/U4 restyle presentation only |
| R10 | Screenshot acceptance claimed without rendered evidence | Medium | High | Mandatory bypass-log verification step; PR states the compared reference; no source-only completion claim |
| R11 | v3.5 agent instructions override v4.0 decisions | **High** | **High** | U0-R superseded banner in the directory-scoped `CLAUDE.md` + 2 inline markers |
| R12 | U4a-before-U0 rework | Low | Low | Semantic-token-only constraint; capture scheduled in U4 (T083 — first capture, not a re-capture: T0A2's was never taken); swap order if U4a needs a literal |

---

## Risks & Open Items

- **No blockers.** Spec open questions: 0. U4a's wiring feasibility — the one item that could have
  blocked the recommended order — was verified in source and clears.
- **Decision owed at U0 (named, not deferred silently):** dark-register disposition — retune to
  v4.0 (recommended) vs. freeze v3.5 Vault Dark.
- **Verification owed at U0:** Arabic rendering on target hardware (Windows 10/11 x64). Dubai,
  Segoe UI, Tahoma and Arial are Windows-shipped Arabic-capable faces, so the system stack is
  expected to hold; this plan does not assert it from a development machine.

---

*This plan is the source for `/speckit-tasks`. Changes to scope or technical approach after task
generation MUST update this plan and re-run task generation.*
