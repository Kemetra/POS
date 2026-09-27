# S0 Visual Direction — Contact Sheet

**Feature:** 005-sales-cart
**Slice:** S0 (non-code; must be reviewed before any S1+ UI work begins)
**Reviewer:** Ahmed Shaaban
**Review date:** 2026-05-14
**Status:** Signed off — see `review-record.md`

> 🔁 **RT-28 amendment (2026-09-27):** Surface 6 now triggers for **every positive manual discount** (no threshold), and its credential is the manager's **identifier + password** (D1a), verified main-side by an authentication-only seam that creates no session. Offline the approval cannot complete, so the discount is refused. See `../spec.md` Amendment + FR-023 (revised). The generic-copy / no-manager-identity policy is unchanged.

**Constitution version pinned:** v1.5.1
**Impeccable brief confirmed:** 2026-05-14 (shape brief approved; corrections OQ-1/OQ-4 locked)

> This file describes the layout and role-conditional behaviour of every
> cart surface. It is a **textual contact sheet**, not a screenshot or
> generated artefact. Implementers read this before writing any UI code.
> No JSX, HTML, CSS, or images are committed here.
>
> Every surface inherits 003's `comfortable` density and the 44 CSS px
> touch-target floor (`src/renderer/ui/tokens/touch.ts → touchTarget.min`).
> No new design tokens are introduced; all colour, spacing, radius, shadow,
> and typography values come from the existing
> `src/renderer/ui/tokens/` inventory.
>
> Design anchors: `PRODUCT.md` ("The Accountable Instrument" north star) and
> `DESIGN.md` (Restrained color strategy; navy primary; single Inter Variable
> typeface). Register: product (app UI, not brand surface).

---

## Token palette (reference — no fork)

All surfaces use the existing 003 token set verbatim. No new tokens are
introduced by 005.

| Token | Use in cart surfaces |
|:--|:--|
| `--color-surface` | CartPane background (fills 003's reserved cart slot) |
| `--color-surface-elevated` | Line-item row background; dialog overlay surface |
| `--color-surface-sunken` | Empty-state background tint |
| `--color-surface-muted` | Disabled / placeholder text regions |
| `--color-text` | Primary labels: item name, quantity, subtotal value |
| `--color-text-muted` | Secondary labels: unit price, note text, empty-state copy |
| `--color-primary` | Positive affordances: "Hand off to payment" button |
| `--color-danger` | Destructive affordances: "Void" button, "Void cart" confirm |
| `--color-warning-soft` | Discount-placeholder pill background |
| `--color-success-soft` | Handoff-frozen state banner background |
| `--color-neutral` | Quantity stepper border and stepper button fill |

---

## Layout strategy (all surfaces)

The cart pane occupies a narrow fixed-width column (003's reserved cart
slot, approximately 320–380 px wide). Every surface uses the same
three-region vertical stack:

1. **Header strip** — pane label + contextual action button (Void).
2. **Scrollable content area** — line-item rows or empty state; fills
   remaining height.
3. **Footer strip** — pinned to bottom; subtotal label + value;
   primary action button.

Line-item rows use `--color-surface-elevated` background with
`--radius-card` rounding to separate them visually from the pane
background without nesting cards. No nested card components.

Typography hierarchy per DESIGN.md:
- Pane header label: Title weight (600, 18 px)
- Line `display_name`: Body (400, 16 px), `--color-text`
- Unit price / subtotal: Mono (400, 14 px) — amounts use monospace for
  column alignment
- Note / secondary labels: Label (600, 12 px), `--color-text-muted`
- Empty-state body: Body (400, 16 px), `--color-text-muted`

---

## Surface 1 — Empty cart pane

**Route context:** embedded in 003's reserved cart slot at `/app/*`
(no dedicated route; pane is always visible to signed-in cashier /
manager / admin per 004 role-visibility-matrix row "Cart surface").

**Layout:**
```
┌────────────────────────────────────────────┐
│  Cart                                      │  ← header; Void hidden (cart empty)
│                                            │
│          [empty-state illustration]        │  ← --color-surface-sunken tint
│          "Add items to begin"              │  ← --color-text-muted; centered
│                                            │
│  ────────────────────────────────────────  │
│  Subtotal:  —                              │  ← dash placeholder; NOT "0" or ¤0
│                                            │
│  [Hand off to payment — disabled]          │  ← disabled; cart must be non-empty
└────────────────────────────────────────────┘
```

**Role-conditional visibility:**
- Void button: **hidden** in empty state — rendered absent, not disabled.
  Rationale: avoids "void what?" confusion; no meaningful target exists.
- Hand-off button: **disabled** (empty cart; FR-037 / US3-AS2).
- Cashier-forbidden (must never appear on this pane for any role):
  no shift totals, no drawer cash, no expected total, no shortage/overage,
  no reports, no KPIs, no manager review data, no audit surfaces.

---

## Surface 2 — Populated cart pane (editing state)

**Layout:**
```
┌────────────────────────────────────────────┐
│  Cart                              [Void]  │  ← header; Void visible pre-handoff
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ ITEM-A  Display Name            [×]  │  │  ← line-item row (see Surface 3)
│  │ [−] 2 [+]        ¤ 1,200    ¤ 2,400 │  │  ← stepper + unit + subtotal
│  │ "Note text…"                         │  │  ← shown only if note non-null
│  │ [Discount applied] [×]               │  │  ← shown only if placeholder exists
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │ ITEM-B  Another Item            [×]  │  │
│  │ [−] 1 [+]          ¤ 800     ¤ 800  │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  ────────────────────────────────────────  │
│  Subtotal:  ¤ 3,200                        │  ← integer minor units; placeholder
│                                            │    formatter (see Currency note below)
│  [Hand off to payment]                     │  ← enabled; primary; non-empty cart
└────────────────────────────────────────────┘
```

**Currency note:** The `¤` symbol is a placeholder. Final currency
formatting (locale, symbol, separator style) is owned by the future
payments feature. 005 uses a placeholder formatter that renders integer
minor units as a readable amount; the exact format stabilises when the
payments feature ships.

**Role-conditional visibility (cashier vs manager/admin):**
- Void button: **visible** pre-handoff for all roles.
- Line-item rows: **visible** for all roles (own cart).
- Subtotal: **visible** for all roles. Cart-layer subtotal only
  (sum of `line_subtotal_minor`). Tax and tender are the payments
  feature's responsibility — not shown here.
- **Cashier-forbidden (must never appear on this pane):**
  no shift totals, no drawer balance, no shortage/overage, no reports,
  no KPI widgets, no manager review data.

---

## Surface 3 — Line-item row

**Dimensions:** fills CartPane width; minimum height ≥ 44 CSS px
(enforced by `touchTarget.min`). Background: `--color-surface-elevated`.

**Layout:**
```
┌──────────────────────────────────────────────┐
│ [display_name]                          [×]  │  ← remove button; ≥44×44 hit area
│ [−] [qty] [+]        ¤ unit    ¤ subtotal    │  ← stepper (see Surface 4); mono type
│ "note text"   (only if note ≠ null)          │  ← --color-text-muted; truncated 40ch
│ [Discount applied] [×]  (only if placeholder)│  ← --color-warning-soft pill
└──────────────────────────────────────────────┘
```

**Content rules:**
- `display_name`: snapshotted at add-time; not live-fetched after add.
- `unit_price_minor`: snapshotted at add-time; formatted with placeholder
  currency formatter. Subsequent price drift MUST NOT silently rewrite
  the displayed value (FR-011).
- `line_subtotal_minor`: computed `quantity × unit_price_minor` in
  integer minor units; no floating-point arithmetic or display (FR-012).
- Note: visible only when `note !== null`; rendered in `--color-text-muted`.
  Truncated at 40 chars with ellipsis in the row; full text accessible via
  popover (LineNotePopover component; focus-trap + Escape to close).
- Discount pill: opaque "Discount applied" label on `--color-warning-soft`
  background. The numeric percentage or amount is **not displayed** —
  magnitude is the payments feature's responsibility (FR-024).

**Role-conditional:**
- Remove (×) button: visible for all roles on own cart pre-handoff.
- Post-handoff: row is read-only; remove button and quantity stepper absent.

---

## Surface 4 — Quantity stepper

**Minimum hit target:** ≥ 44 × 44 CSS px per button (decrement + increment).
Border: `--color-neutral`. Fill: ghost-style (transparent resting state).

**Layout:**
```
[  −  ]  [  qty  ]  [  +  ]
 44×44    read-only   44×44
```

**Behaviour rules (all locked; no open questions):**

- **Increment:** `quantity + 1`. No hard cap at the UI layer; bridge
  rejects overflow via `Number.isSafeInteger` guard.
- **Decrement to 1 (quantity > 1):** `quantity − 1`. Direct; no confirm.
- **Decrement to 0 — line has no note (quantity = 1, note is null):**
  Removes the line **directly** (no confirm dialog). Proceeds to
  `cart.lines.remove`.
- **Decrement to 0 — line has a note (quantity = 1, note is non-null):**
  Shows a confirm dialog: "Remove this line?" with Cancel and Remove
  buttons (both ≥ 44 × 44 px). On confirm → `cart.lines.remove`.
  On cancel → quantity stays at 1; note is preserved.
- **Keyboard:** `ArrowUp` = increment, `ArrowDown` = decrement.
  Both keys are intercepted only when the stepper has focus.
- **Quantity field:** display-only; no direct text entry in 005.

**Rationale for note-conditional confirm:** A note represents additional
cashier intent that is not visible at a glance. Silently removing a line
that carries a note risks losing that intent without acknowledgement.
Lines without notes have no hidden state — direct removal is faster
and less disruptive.

---

## Surface 5 — Void confirmation dialog

**Trigger:** cashier taps "Void" on their own cart in `editing` state.
Rendered as a modal overlay with `--shadow-overlay` elevation.

**Layout:**
```
┌─────────────────────────────────────────┐
│  Void this cart?                        │
│                                         │
│  This action cannot be undone.          │  ← generic copy; no cart ID shown
│  All items will be removed.             │
│                                         │
│  [Cancel]          [Void cart]          │
│                 ← both buttons ≥44×44 px │
└─────────────────────────────────────────┘
```

**Focus behaviour:** Dialog traps focus on open. Tab cycles between
Cancel and "Void cart". Escape = Cancel. "Void cart" is the destructive
button (uses `--color-danger` fill per DESIGN.md button-destructive).

**Role-conditional:**
- Cashier, own cart, pre-handoff: this dialog is shown. On confirm →
  `cart.void`; `cancellation_reason = 'cashier_voided'`; no audit event
  emitted (non-sensitive lifecycle event per FR-031).
- Cashier, post-handoff: **void affordance is hidden** — the button itself
  is absent from the cart pane. Attempting programmatically → generic
  refusal.
- Manager/admin, post-handoff: triggers Surface 6 (manager-attribution
  prompt), not this dialog.

**Copy rules:**
- No cart ID, session ID, or any technical identifier in user-facing copy.
- No mention of which cashier originally created the cart.
- No mention of which items are in the cart.

---

## Surface 6 — Manager-attribution prompt

**Trigger:** cashier initiates **any positive manual discount** (RT-28 —
formerly above-threshold only) or a post-handoff void. A manager must
credential in to approve.

> **Policy (locked in S0):** The manager-attribution prompt shows
> **generic copy only**. The manager's display name, identity, role
> label, or any other operator-identifying information MUST NOT appear
> on the cashier screen at any point in this flow. The layout reserves
> no space for manager identity disclosure. This is a locked cashier-
> forbidden-information rule for 005 — it does not depend on 004 S5
> deciding the policy; 005 has already locked to "generic only" (see
> `contracts/role-visibility-matrix-cart.md` §"Cashier-Forbidden
> Information catalogue interactions" item 2).

**Layout:**
```
┌─────────────────────────────────────────┐
│  Manager approval required              │
│                                         │
│  This action needs a manager.           │  ← generic copy; no factor detail
│                                         │
│  Manager ID:  [___________________]     │  ← opaque identifier input
│  Credential:  [___________________]     │  ← manager password (RT-28 D1a;
│                                         │    masked, never echoed or logged)
│  [Cancel]          [Approve]            │
│           ← both buttons ≥44×44 px      │
└─────────────────────────────────────────┘
```

**Role-conditional:**
- Only shown when a cashier initiates a manager-attributable action.
- Manager identity is **never displayed on the cashier screen** —
  not the display name, not the role, not any identifying label.
  The prompt is generically worded regardless of which manager signs in.
- The credential is the manager's **identifier + password** (RT-28 D1a).
  It is verified main-side by an authentication-only seam that creates no
  backend or local session and leaves the cashier session unchanged.
  Offline the approval cannot complete; the prompt shows a generic
  "approval unavailable" outcome and the discount is not applied.
- On cancel: action is abandoned; no placeholder applied, no audit event.
- On approve: manager attribution is recorded by the bridge; the audit
  record carries both the cashier (requester) and the manager (approver)
  per 004 FR-025(f).

**Focus behaviour:** Focus trap on open. Escape = Cancel. "Approve" is
the primary confirm button (uses `--color-primary` fill).

---

## Surface 7 — Discount-placeholder row

**Appears within:** line-item row, below the note line.

**Layout:**
```
│  [Discount applied]                [×]  │
│   --color-warning-soft pill      ≥44×44 │
```

**Content rules:**
- Pill label: "Discount applied" — generic, no numeric value.
- **No numeric percentage or amount displayed.** The magnitude is the
  payments feature's responsibility (FR-024). 005 shows only
  presence/absence of the placeholder.
- Remove (×) button: visible pre-handoff; ≥ 44 × 44 px.
- **RT-28 (D4):** removing a discount needs **no** manager approval for any
  role; the remove tap removes the placeholder directly and never triggers
  Surface 6. ~~If the placeholder required manager attribution to apply:
  removing it also requires manager attribution. The remove tap triggers
  Surface 6.~~
  Post-handoff: row is read-only; remove button absent.

---

## Surface 8 — Handoff summary (frozen state)

**Trigger:** cashier taps "Hand off to payment"; bridge constructs the
`PaymentIntentEnvelope`; cart transitions to `frozen_handed_off`.

**Layout:**
```
┌────────────────────────────────────────────┐
│  [check] Cart sent to payment              │  ← --color-success-soft banner
│                                            │    full-width; persistent
│  [line-item rows — read only]              │  ← same layout as Surface 3,
│                                            │    but stepper and [×] absent
│  ────────────────────────────────────────  │
│  Subtotal:  ¤ 3,200                        │  ← frozen value from
│                                            │    PaymentIntentEnvelope.subtotal_minor
│  [Void (post-handoff)]                     │  ← visible to manager/admin only;
│                                            │    hidden for cashier (FR-032)
└────────────────────────────────────────────┘
```

**Content rules:**
- Banner: `--color-success-soft` background; "Cart sent to payment" copy;
  no cart ID, no payment system reference, no tender details.
- Line rows: read-only. Quantity stepper and remove button are absent.
  Note and discount pill remain visible (read-only) if present.
- Subtotal: frozen integer minor units from the envelope's
  `subtotal_minor`. Uses placeholder formatter (same as Surface 2).
- **Cashier role:** "Void (post-handoff)" affordance is **hidden**, not
  disabled. Cashier sees no mechanism to appeal the handoff decision.
- **Manager/admin role:** "Void (post-handoff)" button is visible.
  Tapping it triggers Surface 6 (manager-attribution prompt). On
  manager approval: cart transitions to `cancelled`; audit event
  `cart.cancel.post_handoff` emitted.
- No payment status, tender breakdown, change, receipt, or KPI shown —
  those are the payments feature's responsibility.

---

## Connection-state behaviour (all surfaces)

003's four connection states (`online`, `degraded`, `offline`, `syncing`)
are displayed via 003's existing `StatusBanner` and nav-rail indicator.
Cart pane surfaces behave as follows:

| Connection state | Cart pane behaviour |
|:--|:--|
| `online` | Normal; all bridge calls proceed. |
| `degraded` | Cart drafts work (local SQLite); `StatusBanner` shows degraded. Handoff: if payments feature requires network, refusal toast shown. |
| `offline` | Cart drafts work; `StatusBanner` shows offline. Handoff blocked (payments feature owns the online-only gate). Audit events queued in local outbox. |
| `syncing` | Transient banner; no cart-pane behaviour change. |

005 introduces no new connection-state visuals. 003 owns that surface.

---

## Keyboard and accessibility summary (all surfaces)

- Tab order: header controls → scrollable line list (each row
  tab-navigable as a group) → footer controls.
- Within each row: remove button → decrement → quantity display
  (read-only, skipped in tab order) → increment → note popover trigger
  (if note present).
- Dialog surfaces (Void confirm, Manager-attribution prompt,
  Decrement-to-zero confirm): full focus trap; Escape = Cancel.
- QuantityStepper: `ArrowUp` / `ArrowDown` intercepted on stepper focus.
- Every interactive element: ≥ 44 × 44 CSS px hit area (enforced by
  `touchTarget.min`; CI invariant test).
- Color is never the sole differentiator for any state: all status
  changes are accompanied by copy changes or icon changes.
- Reduced-motion: no bounce or elastic easing on any cart surface.

---

**End of contact sheet.** All 8 required surfaces are described above.
Implementers must not deviate from this surface description without a
revised S0 review. Re-sign-off is required before the relevant
implementation task merges (FR-033 gate).
