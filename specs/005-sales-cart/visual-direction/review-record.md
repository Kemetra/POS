# S0 Visual Direction — Review Record

**Feature:** 005-sales-cart
**Slice:** S0 (non-code)
**Reviewer:** Ahmed Shaaban
**Review date:** 2026-05-14
**Status:** Signed off
**Contact sheet:** `specs/005-sales-cart/visual-direction/contact-sheet.md`
**Constitution version pinned:** v1.5.1

> 🔁 **RT-28 amendment (2026-09-27):** the sign-off below predates the manager-only discount rule. Surface 6 now triggers for every positive manual discount and uses the manager's identifier + password (D1a); see `contact-sheet.md` Surface 6 and `../spec.md` FR-023 (revised). The generic-copy policy recorded here still stands.

---

## Review scope

This record covers the S0 visual-direction review of all 8 cart surfaces
defined in `contact-sheet.md`. The review validates the contact sheet
against each of the mandatory criteria listed in `plan.md §Phase 2 —
Visual Direction — Visual-direction review gate`.

---

## Review checklist

### 1. 003 design tokens (no fork; existing token set only)

**Result:** PASS

The contact sheet uses only tokens from `src/renderer/ui/tokens/`:

| Source file | Tokens referenced |
|:--|:--|
| `src/renderer/ui/tokens/colors.ts` | `--color-surface`, `--color-surface-elevated`, `--color-surface-sunken`, `--color-surface-muted`, `--color-text`, `--color-text-muted`, `--color-primary`, `--color-danger`, `--color-warning-soft`, `--color-success-soft`, `--color-neutral` |
| `src/renderer/ui/tokens/touch.ts` | `touchTarget.min = 44` (44 CSS px floor; enforced on all interactive elements) |
| `src/renderer/ui/tokens/density.ts` | `comfortable` density inherited; no new density values |
| `src/renderer/ui/tokens/shadow.ts` | `--shadow-overlay` for modal dialogs |
| `src/renderer/ui/tokens/radius.ts` | `--radius-card` for line-item row backgrounds |

No new tokens are introduced by 005. All colour, spacing, radius, shadow,
and typography values come from the existing inventory. No token fork.

### 2. 003 navigation-rail behaviour

**Result:** PASS

The cart pane fills 003's reserved cart slot at the `/app/*` route. It
is embedded in the shell layout, not a new top-level route. The nav rail
expansion behaviour (icon-only below 1280 px; label+icon at 1280 px+;
hidden below 1024 px) is unchanged — the cart pane does not alter any
nav-rail behaviour.

### 3. 003 connection-state visuals

**Result:** PASS

The contact sheet (§"Connection-state behaviour") explicitly states that
003's four states (`online`, `degraded`, `offline`, `syncing`) are
displayed via 003's existing `StatusBanner` and nav-rail indicator. The
cart pane does not emit any connection-state visual of its own. The
offline behaviour is described per state (drafts work offline; handoff
blocked; audit events queued in outbox). 005 introduces no new
connection-state visuals.

### 4. 004 role-indicator slot

**Result:** PASS

The cart pane occupies 003's reserved cart slot only. It does not
introduce any new surface that conflicts with 004's fixed role-indicator
slot. Role-conditional rendering within the cart pane (Void button
visibility, post-handoff affordances, manager-attribution prompt) is
gated on the bridge-side role check (004 AD-1 / `requireOperatorSession`),
not on a renderer-side role indicator change.

### 5. 44 px touch-target floor

**Result:** PASS

All interactive elements in the contact sheet specify ≥ 44 × 44 CSS px:

| Element | Hit-area specification |
|:--|:--|
| Quantity stepper (− button) | ≥ 44 × 44 CSS px |
| Quantity stepper (+ button) | ≥ 44 × 44 CSS px |
| Remove (×) button on line row | ≥ 44 × 44 CSS px |
| Remove (×) button on discount pill | ≥ 44 × 44 CSS px |
| Cancel button (Void confirm dialog) | ≥ 44 × 44 CSS px |
| "Void cart" confirm button | ≥ 44 × 44 CSS px |
| Cancel button (Manager-attribution prompt) | ≥ 44 × 44 CSS px |
| "Approve" button (Manager-attribution prompt) | ≥ 44 × 44 CSS px |
| "Void (post-handoff)" button (Surface 8) | ≥ 44 × 44 CSS px |
| "Hand off to payment" button | ≥ 44 × 44 CSS px (full-width footer) |
| "Void" header button | ≥ 44 × 44 CSS px |

The CI invariant test for touch-target enforcement (`touchTarget.min = 44`)
covers all of the above.

### 6. Cashier-forbidden information boundaries

**Result:** PASS — all forbidden items excluded

Per 004 S5's cashier-forbidden-information catalogue and
`specs/004-operator-session/contracts/role-visibility-matrix.md`:

| Forbidden item | Contact sheet treatment |
|:--|:--|
| Shift totals | Never appears on any cart pane surface |
| Drawer cash / drawer balance | Never appears on any cart pane surface |
| Expected total / variance | Never appears on any cart pane surface |
| Shortage / overage | Never appears on any cart pane surface |
| Reports / KPIs / analytics | Never appears on any cart pane surface |
| Manager review data / audit surfaces | Never appears on any cart pane surface |
| Discount magnitude / percentage value | Explicitly absent from discount pill (Surface 7); "Discount applied" pill only |
| Manager identity on attribution prompt | Locked to generic copy only (Surface 6); no display name, no role label, no identifying information shown to cashier |

The manager-attribution prompt policy is locked (not deferred): the
prompt shows generic copy only. No manager identity is disclosed to
the cashier at any point in the flow.

### 7. Role-conditional visibility (post-handoff void)

**Result:** PASS

- Cashier, post-handoff: void affordance is **hidden** (absent), not
  disabled (Surface 5 / Surface 8).
- Manager/admin, post-handoff: "Void (post-handoff)" button visible
  in Surface 8; triggers manager-attribution prompt (Surface 6).
- Pre-handoff: Void button visible to all roles (own cart, editing state).

This matches `specs/005-sales-cart/contracts/role-visibility-matrix-cart.md`
proposed rows and 004's finalised matrix.

### 8. Decrement-to-zero behaviour

**Result:** PASS — locked and unambiguous

The contact sheet (Surface 4) locks the following rule:

- **No note (null):** decrement from quantity 1 removes the line
  directly. No confirm dialog.
- **Note present (non-null):** decrement from quantity 1 shows a
  confirm dialog before removing. Protects cashier-entered intent.

This rule is recorded as locked in the contact sheet and must not be
changed without a revised S0 review.

### 9. Currency / amount formatting

**Result:** PASS (deferred, correctly scoped)

All amount displays (`unit_price_minor`, `line_subtotal_minor`,
`subtotal_minor`) use a placeholder formatter rendering integer minor
units. The exact locale, symbol, and separator format are owned by the
future payments feature. The contact sheet records this correctly; no
final formatting rule is invented in S0. This deferral is intentional
and within scope.

### 10. Keyboard operability

**Result:** PASS

The contact sheet (§"Keyboard and accessibility summary") specifies:
- Complete tab order (header → rows → footer).
- Per-row tab sequence (remove → decrement → increment → note trigger).
- Focus traps on all dialog surfaces with Escape = Cancel.
- `ArrowUp` / `ArrowDown` on QuantityStepper.
- All cashier-critical paths (add, void, handoff, discount, note)
  reachable by keyboard alone.

---

## Open issues at review time

None. All checklist items pass. No required changes to the contact sheet
were identified during review.

---

## Reviewer sign-off

| Field | Value |
|:--|:--|
| Reviewer | Ahmed Shaaban |
| Review date | 2026-05-14 |
| Contact sheet version reviewed | As committed 2026-05-14 |
| Constitution version | v1.5.1 |
| All 8 surfaces covered | Yes |
| Any required changes outstanding | No |
| **Sign-off** | **Approved** |

S0 visual direction is complete. Every S1+ implementation PR must cite
this review record in its description (FR-033 gate). Implementers must
not deviate from the contact sheet without a revised S0 review and
re-sign-off.

---

**End of review record.**
