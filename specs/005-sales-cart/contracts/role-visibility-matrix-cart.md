# Contract: Role-Visibility Matrix — Cart (PROPOSALS)

> 🔁 **RT-28 amendment (2026-09-27):** manual discounts are **manager-only** — the Q2 threshold and every "below/above threshold" rule in this file are SUPERSEDED. Canonical text: [`spec.md`](../spec.md) Amendment + FR-023 (revised). New audit category `cart.discount.manager_authorized`; `cart.discount.above_threshold` is historical only. Threshold references below are kept for audit trail. **Per 004 role-visibility-matrix Section 8, the canonical rows for the two discount bridge calls land in `specs/004-operator-session/contracts/role-visibility-matrix.md` together with their bridge enforcement and tests, in the RT-28 Implementation PR — not in this docs-only reconciliation.**


**Feature ID:** 005-sales-cart
**Plan:** [../plan.md](../plan.md)
**Spec:** [../spec.md](../spec.md)
**Canonical source of truth:**
[`specs/004-operator-session/contracts/role-visibility-matrix.md`](../../004-operator-session/contracts/role-visibility-matrix.md)
**Created:** 2026-05-14
**Status:** PROPOSAL — NOT canonical.

> 🚧 **PROPOSAL-ONLY.** Per spec NFR-009 and SC-008, this file does **NOT**
> contribute canonical visibility-matrix rows. It enumerates the proposed
> additions to 004's matrix for cart-related surfaces. The canonical
> rows MUST be reviewed and approved against the 004 S5
> Cashier-Forbidden Information catalogue **before any 005
> implementation slice merges**. Approval is recorded in 004's
> `role-visibility-matrix.md`, not here.

---

## Why this file exists

005 introduces cart surfaces (cart pane, line-item row, void
confirmation, manager-attribution prompt, handoff summary) that need
role-conditional visibility. The spec (NFR-009) requires 005 to:

- propose visibility rows to 004's canonical matrix,
- reference 004's matrix as the source of truth,
- NOT pre-write the canonical row.

This file is the proposal artifact. The 004 S5 review process examines
each row below against the Cashier-Forbidden Information catalogue and
decides which proposals become canonical rows in 004's matrix.

---

## Proposed rows

Format: `(surface, role) → visibility`. Visibility is one of:
- `visible` — the surface / control is reachable
- `visible_read_only` — the surface is reachable but cannot be mutated
- `hidden` — the surface is NOT reachable; routes / deep-links refused
- `prompt_required` — the surface is reachable but actions require a
  manager-attribution prompt (cashier initiates; manager approves)

### Surfaces

| Surface | cashier | manager | admin |
|:--|:--|:--|:--|
| Cart pane (top-level) | visible | visible | visible |
| Cart pane — own cart | visible | visible | visible |
| Cart pane — another cashier's open cart | hidden | visible_read_only *(?)* | visible_read_only *(?)* |
| Line-item row (own cart) | visible | visible | visible |
| Cart subtotal value | visible | visible | visible |
| Discount-placeholder pill on a line (own cart) | visible | visible | visible |
| Discount-placeholder magnitude value (the numeric percentage) | hidden *(? — 005 does NOT display this; payments feature owns)* | hidden *(? — 005 does NOT display this)* | hidden *(? — 005 does NOT display this)* |
| Void-cart button (own cart, pre-handoff) | visible | visible | visible |
| Void-cart button (own cart, post-handoff) | hidden | visible | visible |
| Void-cart button (another cashier's cart) | hidden | visible *(?)* | visible *(?)* |
| Handoff button (own cart) | visible | visible | visible |
| Handoff summary surface (own cart) | visible | visible | visible |
| Handoff envelope JSON (raw, support-bundle view) | hidden | hidden *(?)* | visible *(?)* |

Rows marked `*(?)*` are the rows whose canonical answer **MUST** come
from 004 S5's Cashier-Forbidden Information catalogue review — 005 has
no authority to decide them.

### Actions (bridge-side gates)

| Action | cashier | manager | admin |
|:--|:--|:--|:--|
| `cart.create` | allowed | allowed | allowed |
| `cart.lines.add` (own cart) | allowed | allowed | allowed |
| `cart.lines.update` (own cart) | allowed | allowed | allowed |
| `cart.lines.remove` (own cart) | allowed | allowed | allowed |
| `cart.lines.setNote` (own cart) | allowed | allowed | allowed |
| `cart.discountPlaceholders.add` any positive manual discount (own cart) — *RT-28* | prompt_required (manager re-enters identifier + password, verified main-side; refused offline — RT-28 D1a) | allowed (recorded as approver) | allowed (recorded as approver) |
| `cart.discountPlaceholders.remove` (own cart) — *RT-28 D4* | allowed (audited) | allowed (audited) | allowed (audited) |
| ~~`cart.discountPlaceholders.add` below / above threshold~~ | *superseded by RT-28 — no threshold* | | |
| `cart.void` (own cart, pre-handoff) | allowed | allowed | allowed |
| `cart.void` (own cart, post-handoff) | hidden + audit event on attempt | allowed | allowed |
| `cart.void` (another cashier's cart) | hidden + audit event on attempt | allowed *(?)* | allowed *(?)* |
| `cart.handoff` (own cart) | allowed | allowed | allowed |
| `cart.handoff` (another cashier's cart) | hidden | hidden *(?)* | hidden *(?)* |

Rows marked `*(?)*` are deferred to 004 S5 review.

---

## Cashier-Forbidden Information catalogue interactions

The following rules from 004's existing FR-014 / S5 catalogue intersect
with cart surfaces:

1. **Per-line discount magnitudes** — 005's cart layer does NOT display
   the numeric percentage or amount of any discount placeholder. The
   placeholder is shown as an opaque "discount applied" pill. The future
   payments feature decides how / whether to display the magnitude.
2. **Manager identity on the attribution prompt** — when a cashier
   initiates a manual discount (any positive discount, RT-28) or a post-handoff void, the
   manager-attribution prompt asks for the manager's identity. **Whether
   the prompt can name the manager's display name on the cashier's
   screen is a Cashier-Forbidden Information catalogue question**, not a
   cart-layer decision. 005's S0 (visual direction) MUST show the prompt
   in a way that allows either policy.
3. **Audit-event payloads** — cart-emitted audit events (FR-026) carry
   the cashier and (where applicable) the manager identity. Whether a
   cashier can read audit events for their own actions is a 004 matrix
   question; 005 does not pre-decide.

---

## Approval path

1. **005's `/speckit-plan` PR** (this file): proposals filed.
2. **004 S5 review** (already complete as of 2026-05-14): the
   role-visibility matrix's cart-related rows are reviewed by the 004
   reviewer using this proposal file as input. The `*(?)*` rows are
   answered explicitly.
3. **004's canonical matrix** is updated with the agreed rows. Any
   conflict with this proposal triggers a re-clarification of 005's
   spec (`/speckit-clarify`) per §A0 path 2.
4. **005's S1** cannot merge until the canonical rows are landed in
   004's matrix; the bridge-side role enforcement reads from 004's
   matrix at build time.

---

## Open questions returned to 004 S5

If 004's S5 review surfaces any of the following, 005 re-clarifies its
spec rather than mutating the canonical matrix from this side:

- Can a manager / admin observe another cashier's open cart? If yes, is
  the observation `visible` (full content) or `visible_read_only` (no
  edits)?
- Can a manager / admin void another cashier's cart from a non-cashier
  surface (e.g., a manager dashboard not designed by 005)?
- Are discount-placeholder magnitudes EVER displayed on a cart-layer
  surface (005 currently says no — needs explicit confirmation)?
- Are handoff envelope contents (the JSON copy) accessible to a manager
  / admin for support purposes, or restricted to admin only?

These questions are filed here so they survive the lifecycle of this
proposal. If they become normative after 004 S5 review, this file is
updated to record the answer.

---

**End of proposal.** This file is **NOT canonical**. The canonical
visibility rules for cart surfaces live in
[`specs/004-operator-session/contracts/role-visibility-matrix.md`](../../004-operator-session/contracts/role-visibility-matrix.md).
