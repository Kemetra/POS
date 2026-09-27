# Research: Sales Cart (Phase 0)

> 🔁 **RT-28 amendment (2026-09-27):** manual discounts are **manager-only** — the Q2 threshold and every "below/above threshold" rule in this file are SUPERSEDED. Canonical text: [`spec.md`](spec.md) Amendment + FR-023 (revised). New audit category `cart.discount.manager_authorized`; `cart.discount.above_threshold` is historical only. Threshold references below are kept for audit trail.


**Feature ID:** 005-sales-cart
**Plan:** [./plan.md](./plan.md)
**Spec:** [./spec.md](./spec.md)
**Created:** 2026-05-14
**Constitution version pinned:** v1.5.1

This document is the Phase 0 output of `/speckit-plan` for 005-sales-cart.
Each research item has a **chosen approach**, the **rejected alternatives**,
and the **rationale** that decides between them. R1 and R3 are also bound
by spec clarifications (Q4 and Q3 respectively, LOCKED 2026-05-14) and the
choices below are the reconciled positions; the older plan-draft leanings
("append separate line" for R1, "preserved + re-opens" for R3) are
**superseded** by Q4/Q3.

---

## R1 — Line-merge-by-`item_ref` vs separate-line policy

**Chosen approach.** **Merge by `item_ref` (Q4 LOCKED 2026-05-14).** When
the cashier adds the same `item_ref` to a cart that already contains a
non-removed line for that `item_ref`, the existing line's `quantity` is
incremented by the add's quantity and `version` advances by one. The
merging operation carries its own idempotency-key (UUID v4) so the same
add cannot apply twice; on replay the bridge sees the prior outbox row
and the action is a no-op (P5).

**Alternatives rejected.**

- **Append separate line (the earlier plan-draft leaning).** Rejected by
  Q4. Pharmacy POS workflows usually expect the cashier to see a single
  consolidated line for each scanned SKU — appending separate lines
  inflates the cart-pane height and makes per-line subtotal math harder
  for the cashier to verify. Spec FR-014 makes this the normative rule.
- **Cashier-chooses-per-add via an explicit toggle.** Rejected by Q4 for
  MVP — adds UI complexity that the deferred "force separate line"
  affordance can introduce later, on top of the merge default, without
  re-litigating the rule.
- **Catalogue-driven (some items merge, some always separate).**
  Rejected by Q4 for MVP — couples the cart layer to catalogue metadata
  (the catalogue is itself a future feature, AD-5).

**Rationale.** Q4 is normative. The deferred "force separate line"
affordance lives in a future catalogue / UI feature; the cart layer in
005 implements the merge default exclusively.

**Implications.**

- `cart.lines.add` bridge handler MUST detect an existing non-removed
  line with the same `item_ref` and perform the merge in the same
  transaction as the outbox write (action_kind = `cart.line.merge`).
- Per-line notes and per-line discount placeholders attach to the
  surviving merged line; if a line had a note and a re-add merges with
  it, the note is preserved (the merge does not edit the note).
- Soft-removed lines (`removed_at IS NOT NULL`) do NOT participate in
  the merge — a later non-removed re-add for the same `item_ref` is a
  fresh line with a new `line_id`. This preserves audit continuity for
  the removed line.

---

## R2 — Optimistic-concurrency token format for `cart_lines.version`

**Chosen approach.** **Monotonic integer scoped per `(cart_id, line_id)`,
incremented on each successful mutation of that line.** Every successful
quantity change, note edit, or merge increment advances `version` by
exactly one. The cashier-issued client request carries the line's
last-known `version`; a mismatch is a generic "this line was just
updated — please review and try again" refusal (spec FR-015, FR-019,
US1-AS3).

**Alternatives rejected.**

- **Content hash (SHA-256 of canonical serialisation of the line).**
  Rejected: more expensive on the hot path; collision semantics are
  harder to reason about; the cashier UX doesn't need content-derived
  identity — it needs a stale-token refusal, which an integer provides
  trivially.
- **Wall-clock timestamp.** Rejected: clock skew (especially during DST
  or NTP adjustment) introduces subtle bugs; not monotonic.
- **Global version per cart.** Rejected: every line-edit invalidates
  every other line's last-known version unnecessarily — collisions
  amplify under multi-row UI re-renders.

**Rationale.** Integer compare-and-swap is the smallest, fastest, most
debuggable primitive for the optimistic-concurrency rule the spec
requires. The cart layer reads and writes lines through a single
transactional path (the bridge handler); a single-line monotonic
integer cannot race with itself.

---

## R3 — Cart-stale policy on operator-session end

**Chosen approach.** **Discard immediately on session end (Q3 LOCKED
2026-05-14 — option (a)).** When the operator session ends — for any
reason — the bound draft cart is discarded immediately. The cart row
transitions to `cancelled` with `cancellation_reason = 'session_ended'`.
A `cart.discarded_on_session_end` audit event is emitted (Q5; queued in
the local outbox when offline). The cart is never observable by a
subsequent cashier on the same terminal.

**Session-end triggers that fire this rule** (all from 004):

- Explicit sign-out from the operator menu.
- Inactivity timeout per 004 FR-009.
- Takeover supersession per 004 FR-013.
- Forced-close by manager per 004 FR-024.

**Alternatives rejected.**

- **Preserved + re-opens for the same operator (the earlier plan-draft
  leaning).** Rejected by Q3. A draft that survives session-end
  introduces a "ghost cart" surface that a different cashier could
  observe at the same terminal — violating 004's tenant / role-isolation
  discipline. Recovery also costs auditability: a draft that survives an
  inactivity timeout and is "resumed" later masks the gap.
- **Hand off to a manager-recovery surface.** Rejected by Q3. Adds a new
  surface 005 doesn't need; a void on session-end is operationally
  cheaper than a recovery flow.

**Rationale.** Drafts carry no payment-bearing state — there is nothing
of value to preserve. Cashiers rebuild the cart on next sign-in in the
small minority of cases where they actually need to.

**Implications.**

- The session-end transition is a bridge-side action triggered by the
  operator-session emitter from 004; the cart layer subscribes to
  session-end events and writes the discard in the same transaction
  as the audit-event outbox row.
- The `cart.discarded_on_session_end` audit event is emitted even when
  offline (queued in the local outbox per FR-030 / NFR-008); the
  emission cannot block the session-end itself.

---

## R4 — Idempotency-key persistence shape

**Chosen approach.** **Outbox owns the key; `cart_lines` carries a cached
pointer.** Every cart-mutating action writes a row to
`cart_action_outbox` keyed by a client-generated UUID v4. The row is the
durable, append-only record of "what action happened, with what
payload, at what time, by which operator, attributed to which manager
if sensitive." `cart_lines.last_action_id` is a foreign-key pointer to
the outbox row that produced the line's current state, so a bridge
handler answering "what was the last action on this line?" can look it
up without scanning. Read-after-write verification reads both: the
outbox for the action shape, the line for the materialised state.

**Alternatives rejected.**

- **Idempotency key duplicated into both tables.** Rejected — adds a
  consistency burden (the duplicated keys could disagree) without
  buying anything; the FK pointer is sufficient.
- **Idempotency key on `cart_lines` only.** Rejected — `cart_action_outbox`
  is the audit trail (P4); the line is the materialised projection.
  Without the outbox carrying the key, a line update has no replayable
  shape.
- **In-memory idempotency cache only.** Rejected — does not survive
  restart; cashier loses their replay protection across crashes.

**Rationale.** Append-only outbox + monotonic line `version` + cached
last-action pointer is the smallest pattern that satisfies P3 (no silent
data loss), P4 (append-only audit), and P5 (idempotency for retried
operations) simultaneously.

---

## R5 — Handoff envelope serialisation

**Chosen approach.** **In-process struct + persisted JSON copy;
unsigned.** The `PaymentIntentEnvelope` is constructed in-memory as a
`Readonly<>` TypeScript object inside `src/main/cart/`; `Object.freeze`
is applied to the envelope (and recursively to its `lines[]` array) at
the moment of construction. A JSON serialisation is also written to
`carts.handoff_envelope_json` so support-bundle exports include the
envelope after a restart. Signing (HMAC with a per-terminal key from
`safeStorage`) is **deferred to §A4 ratification with the future
payments feature owner**.

**Alternatives rejected.**

- **In-process struct only (no persisted JSON).** Rejected — support
  bundles from a terminal that crashed post-handoff would not include
  the envelope, breaking incident-response triage.
- **Persisted JSON only (no in-process struct).** Rejected — every
  read of the envelope would re-parse JSON; expensive on the hot
  cart-pane re-render path.
- **Signed envelope (HMAC) at 005 ship time.** Rejected for MVP — the
  cart and future payments features run in the same trust line within
  a single terminal; cross-process tampering is not the threat model
  005 owns. If the future payments feature requests signing at §A4,
  005 will add it without breaking the field shape.

**Rationale.** P18 (local durability) requires that the envelope survives
restart for support purposes; P8 (Electron security boundary) requires
that the in-memory shape is the authoritative one within the main
process. The unsigned default keeps the MVP small; the signing decision
is forward-compatible because adding a signature field is a non-breaking
extension under FR-036.

---

## R6 — Discount-placeholder schema

**Chosen approach.** **Line-level only.** `cart_line_discount_placeholders`
is a separate table referenced by `(cart_id, line_id)`; zero-or-more
placeholders per line. Each placeholder row carries a `placeholder_kind`
(opaque token whose catalogue is owned by the future payment / checkout
feature) and a `requires_manager_attribution` flag set true when the
placeholder's magnitude exceeds the Q2-locked tenant-configured
percentage threshold (percentage of `line_subtotal_minor`, applied
per-line). Cart-level discounts are deferred to a future feature.

**Alternatives rejected.**

- **Cart-level slot.** Rejected because Q2's per-line scope locks the
  attribution threshold to a per-line decision; cart-level discount math
  belongs to the future payments feature and is out of scope per the
  spec's §"Out of Scope".
- **Both cart-level and line-level.** Rejected for MVP — adds surface
  area without a use case the spec demands. The future payments feature
  may add cart-level mechanics on top of the envelope without changes
  to the cart layer.

**Rationale.** Q2's per-line locking is normative; line-level only is
the smallest shape that satisfies it. The discount-placeholder is
*informational* on the cart layer (the cart MUST NOT compute the
discounted amount); the placeholder catalogue is owned by the future
payments feature per FR-024.

---

## R7 — Item-catalogue resolution seam

**Chosen approach.** **Stub seam with fixture-only resolver; production
refuses generically when no real catalogue is available** (AD-5 from
plan.md). The bridge exposes:

```
bridge.cart.resolveItemRef(item_ref: string)
  → { display_name: string, unit_price_minor: number, version: string }
    | { kind: 'refused', reason: 'unknown_item' | 'disabled'
                                | 'no_connection' | 'generic' }
```

For Phase 0 + Phase 1, this seam is contract-only. Tests inject a
fixture resolver that returns a small known SKU set; production code
paths refuse generically when no real catalogue is available. The seam
is documented in [`contracts/bridge-api.md`](./contracts/bridge-api.md).

**Alternatives rejected.**

- **005 ships a minimal SKU table.** Rejected per Constitution P16
  (Feature Scope Discipline) — the item-catalogue feature has its own
  scope, schema, sync semantics (server-of-truth for prices), and audit
  rules (price changes are themselves sensitive). A "minimal" catalogue
  grows by feature creep.
- **Hard-code the seam as a Vitest fixture in production code.**
  Rejected — production code paths MUST NOT depend on test fixtures.

**Rationale.** The cart layer needs `display_name` and
`unit_price_minor` at add time (FR-011, FR-013) but does not own
catalogue semantics. A typed stub seam is the smallest contract that
lets the cart layer ship without pre-empting the catalogue feature.

---

**End of research.** All seven items are resolved. The two spec-locked
items (R1↔Q4, R3↔Q3) take their normative form from the spec; the other
five items are 005-plan decisions whose rationale lives here. Open items
discovered during `/speckit-tasks` or Phase 2 implementation MUST be
filed as `[NEEDS CLARIFICATION]` against the spec and routed through
`/speckit-clarify` rather than amended here silently.
