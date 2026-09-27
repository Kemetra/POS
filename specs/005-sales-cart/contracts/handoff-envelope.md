# Contract: PaymentIntentEnvelope

**Feature ID:** 005-sales-cart
**Plan:** [../plan.md](../plan.md)
**Spec:** [../spec.md](../spec.md)
**Data model:** [../data-model.md](../data-model.md)
**Created:** 2026-05-14
**Constitution version pinned:** v1.5.1
**Ratification gate:** §A4 — ✅ **CLEARED 2026-05-17** (Ahmed Shaaban)

> **This is the single cross-feature contract surface 005 commits to.**
> The future payment / checkout feature consumes exactly this shape —
> not the live `carts` or `cart_lines` tables, not the bridge-side cart
> store. Once a cart hands off, the envelope is the only artifact that
> crosses the feature boundary.

---

## Purpose

When the cashier invokes handoff on a non-empty draft cart, the cart layer
constructs an **immutable** `PaymentIntentEnvelope`, persists a JSON copy
on `carts.handoff_envelope_json`, transitions the cart to
`frozen_handed_off`, and emits a `cart.handoff_to_payment` audit event
(FR-026, FR-034). The future payment / checkout feature reads the
envelope and is responsible for everything downstream — tender, totals
math, change, balance, receipt rendering, paid timestamps.

The envelope freezes the cart's view of the world at the moment of
handoff. The cart's lines, quantities, notes, and per-line subtotals MUST
NOT be mutated afterwards through any cart-layer surface (FR-035). Any
"edit cart" affordance during payment MUST cancel the handoff and re-open
the cart, which is itself a manager-attributed sensitive action
(`cart.cancel.post_handoff`; FR-033).

---

## Field shape (v1)

The envelope's field list is **normative**. The future payment / checkout
feature MAY add fields it owns but MUST NOT remove, rename, or rewrite
any of these (FR-036).

```text
PaymentIntentEnvelope (v1) {
  envelope_version: 'v1'                        // string literal
  cart_id: UUID v4                              // identifies the source cart
  operator_session_id: UUID / string            // 004 OperatorSession
  owning_operator_id: Clerk-backed identity     // the cashier
  tenant_id: UUID / string
  branch_id: UUID / string
  terminal_id: UUID / string
  lines: readonly Array<LineSnapshot>           // frozen at handoff
  discount_placeholders:                        // line-level only (R6)
    readonly Array<DiscountPlaceholderSnapshot>
  subtotal_minor: integer minor units           // Σ line_subtotal_minor
  created_at: UTC timestamp                     // == carts.frozen_at
  handoff_action_id: UUID v4                    // matches the audit row
}

LineSnapshot {
  line_id: UUID v4
  item_ref: string
  display_name: string                          // snapshot at add-time
  quantity: positive integer
  unit_price_minor: integer                     // snapshot at add-time
  line_subtotal_minor: integer                  // quantity × unit_price_minor
  note: string | null                           // ≤ 200 chars (Q1)
  version: monotonic integer
  last_action_id: UUID v4                       // FK → cart_action_outbox
}

DiscountPlaceholderSnapshot {
  placeholder_id: UUID v4
  line_id: UUID v4
  placeholder_kind: string                      // opaque token (FR-024)
  requires_manager_attribution: boolean
  attribution_operator_id: Clerk-backed identity | null
}
```

---

## Immutability guarantees

1. **TypeScript:** the envelope type is `Readonly<>` end-to-end —
   `lines`, `discount_placeholders`, and every nested snapshot are
   declared `readonly`. The TypeScript compiler refuses mutations at
   compile time.
2. **Runtime:** `Object.freeze` is applied **recursively** at the moment
   of construction, before the envelope is handed off across the bridge
   or persisted to JSON. Frozen arrays and objects throw on assignment
   in strict mode.
3. **Persistence:** the JSON copy on `carts.handoff_envelope_json` is
   immutable by definition. Reads return a fresh frozen value (the
   bridge handler re-applies `Object.freeze` on rehydration, since the
   JSON parse produces a plain object).
4. **Bridge surface:** no `cart.*` handler accepts a `PaymentIntentEnvelope`
   parameter — the envelope is **produced** by `cart.handoff`, never
   **consumed** by any cart-layer handler.

---

## Construction algorithm (descriptive)

The `cart.handoff` bridge handler, given a non-empty cart in state
`editing`:

1. Verifies `requireOperatorSession` (AD-1; FR-025).
2. Verifies the cart is non-empty (FR-037).
3. Verifies every line's `version` matches the client's last-known
   `version` for that line (US3-AS5).
3a. **RT-28:** verifies every discount placeholder on the cart is *trusted*,
    meaning written by RT-28 enforcement with a verified approver. A
    pre-RT-28 placeholder is untrusted even with a non-null
    `attribution_operator_id`. If any is untrusted, refuses with
    `unauthorized_discount`. No outbox row, no envelope, no state change and
    no audit row are written. Required tests: a legacy placeholder with a
    null approver refuses; a legacy placeholder with a non-null
    (renderer-asserted) approver refuses; the same cart hands off after
    removal; an RT-28-authorised placeholder hands off.
3b. **RT-28, carts already frozen before the upgrade:** step 3a only runs on a
    new handoff. An unpaid cart already in `frozen_handed_off` whose persisted
    envelope contains any untrusted (pre-RT-28) placeholder MUST NOT be
    payable. Payment eligibility (006, `cart-payment-eligibility.ts`) MUST
    refuse it. Because envelopes are immutable, the recovery is the existing
    manager-attributed post-handoff cancel (FR-033), then a new cart. Required
    test: a pre-upgrade frozen envelope with a legacy placeholder is refused
    by payment eligibility. This is a 005→006 consumer rule for the RT-28
    Implementation issue.
4. In a single transaction:
   a. Writes a `cart_action_outbox` row with `action_kind =
      cart.handoff_to_payment` and a fresh `action_id` (UUID v4).
   b. Constructs the `PaymentIntentEnvelope` in memory; applies
      `Object.freeze` recursively.
   c. Serialises the envelope to JSON; writes it to
      `carts.handoff_envelope_json`.
   d. Transitions `carts.state` to `frozen_handed_off`; sets
      `carts.frozen_at` to NOW; sets `carts.last_action_id` to the new
      `action_id`.
   e. Emits an `audit_events` row with `action_category =
      cart.handoff_to_payment` and the five mandatory attribution
      attributes (FR-026).
5. Returns the frozen envelope to the renderer.

If any step fails, the entire transaction rolls back; the cart remains
in `editing` and no envelope is constructed (US3-AS5).

---

## Ratification — §A4

The envelope shape is **ratified jointly with the future payment /
checkout feature owner before Slice S4 of 005 merges.**

**Ratification record:**

| Date | Decision | Reviewer | Reference |
|:--|:--|:--|:--|
| 2026-05-17 | ✅ Approved | Ahmed Shaaban | `specs/005-sales-cart/contracts/handoff-envelope.md` v1 field shape |

**Ratification conditions (all binding):**

1. `PaymentIntentEnvelope v1` field list is **locked** for 005-sales-cart S4.
2. Future payments work MAY add fields it owns, but MUST NOT remove,
   rename, or reinterpret any v1 field without bumping `envelope_version`
   and going through `/speckit-clarify` (FR-036).
3. v1 remains **unsigned** unless a future payments slice explicitly adds
   an extension field such as `envelope_signature`.
4. This ratification clears §A4 for S4 planning and implementation only.
5. This does NOT start S4 and does NOT approve production rollout (§A5
   remains a separate production-readiness gate).

**Forward-compatibility commitment:** Once ratified, the field list is
**locked at v1.** The future payment / checkout feature MAY add fields
it owns (extension) but MUST NOT remove, rename, or rewrite any field
in this contract (FR-036). Any reshaping is a Spec Kit feature update
that bumps the `envelope_version` and goes through `/speckit-clarify`.

**Signing (deferred per R5):** the v1 envelope is unsigned. If the
future payment / checkout feature requests an HMAC signature at §A4
ratification time, signing is added as an extension field
(`envelope_signature`) without changing the v1 field shape.

---

## Consumer guidance (informational)

The future payment / checkout feature SHOULD:

- Treat all v1 fields as immutable inputs.
- Use `handoff_action_id` to correlate its own audit trail with the
  cart's audit trail (one UUID covers both records).
- Compute its own totals (tender breakdown, change, balance, paid
  timestamps) from the envelope inputs — NOT by reaching back into
  `cart_lines` or `carts` directly. The cart layer's invariant is that
  the envelope is the complete and final view of the cart at handoff;
  reading the source tables risks racing the freeze rule.
- Handle the unsigned envelope as **trusted within the same terminal's
  process boundary** (Constitution Principle III). If cross-process
  forwarding is needed, the payments feature is responsible for adding
  signing at that boundary — not the cart layer.

---

**End of contract.** This shape is the load-bearing seam between 005 and
the future payment / checkout feature.
