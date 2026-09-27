# Feature Specification: Sales Cart

**Feature ID:** 005-sales-cart
**Feature Branch:** `005-sales-cart`
**Status:** **DRAFT — §A0 CLEARED. `/speckit-clarify` complete (2026-05-14). Ready for `/speckit-plan`.**
**Created:** 2026-05-09
**Owner:** POS-Pulse desktop team
**Input:** User description: "Define the behavioural rules for the operator-bound sales cart that follows operator/session (004), so a paired, signed-in operator can build a draft cart, mutate line items idempotently, and hand off to a future payment / checkout feature via a frozen `payment-intent envelope`. This spec MUST NOT design payments, money totals, receipts, inventory, reports, shift math, or UI; it locks behavioural rules and the handoff contract so the future payment feature has a stable upstream surface."

---

> ✅ **§A0 CLEARED — `/speckit-clarify` complete 2026-05-14.**
> Both blocking gates have landed:
> 1. **004-operator-session S4 closeout** — merged 2026-05-11 (PR #124).
> 2. **004-operator-session S5 visibility boundaries** — merged 2026-05-14 (T083–T093; main SHA `d247e8a`).
>
> Q1–Q5 clarification session ran 2026-05-14. All five markers resolved (see §"Clarifications"). **`/speckit-plan` is the next step.**

---

> 🔁 **AMENDMENT — RT-28 manager-only manual discount (2026-09-27, owner decision).**
> Every positive manual discount placeholder requires **manager authority**; there is no
> threshold and no cashier-only path. This supersedes the Q2 threshold and the threshold
> clauses of FR-023 / FR-026 / Key Entities / SC-005 below. Owner decisions D1–D5 (Jira
> RT-28, comment 10197): **D1** manager authority is a manager step-up authentication verified in the main process (credential source pending owner decision RT-28 D1a) — a renderer-supplied
> approver id is never sufficient. *Open (D1a):* POS has no manager PIN today (managers authenticate with identifier + password via Clerk, online only; PINs are cashier-only), so the step-up credential must be chosen before implementation; **D2** a manager or
> admin acting on their own session may apply a discount directly and is recorded as the
> approver; **D3** new audit category `cart.discount.manager_authorized`, with
> `cart.discount.above_threshold` retained as a historical category only (no new records);
> **D4** removing a discount placeholder is allowed for every role and is audited as a
> non-sensitive lifecycle action (it can only raise the total); **D5** no schema change —
> `requires_manager_attribution` stays and is always true for a positive discount. Historical
> Q2 text is kept below, marked SUPERSEDED. Implementation is a separate Jira item.

---

## Overview

POS-Pulse has shipped 001 (foundation), 002 (terminal pairing), and 003 (POS UI shell), and 004 (operator-session) is in progress. With 004's operator/session/visibility scaffold in place, a paired terminal will host an authenticated operator with a role-bound shell. **005-sales-cart** is the next behavioural layer: an operator-bound *draft cart* that the cashier builds line-by-line, with idempotent mutation, snapshot pricing, and a clean handoff to a future payment / checkout feature via an immutable `payment-intent envelope`.

This spec deliberately stops at the cart layer. It DOES NOT design payments, tender, money math beyond per-line subtotals, receipts, receipt printing, inventory mutation, FEFO logic, reports, KPIs, dashboards, shift drawer math, variance, or any backend / OpenAPI / IPC surface. Those are owned by other features — already-shipped (003 reserves the tender / totals / receipt-breakdown visual slots) or future (the payment / checkout feature, the inventory feature, the reports feature, the shift-management feature).

The single contract 005 commits to between cart and the future payment / checkout feature is the **`payment-intent envelope`**: an immutable snapshot the cart emits at handoff. Once a cart hands off, its lines and quantities are *frozen* — no further mutation through any cart-layer surface. The future payment / checkout feature consumes the envelope and owns finalisation, money math (totals, change, balance), tender, and receipt rendering.

This feature also inherits 003's lesson and 004's FR-033 rule: any UI-bearing portion that follows MUST schedule an *early visual direction* milestone after `/speckit-plan` and before the first implementation slice.

> ✅ **§A0 CLEARED** — 004's `Operator`, `OperatorSession`, and S5 visibility boundaries are all in place. **Do not implement until `/speckit-plan` + `/speckit-tasks` complete.**

## Clarifications

This spec was seeded with five `[NEEDS CLARIFICATION]` markers (Q1–Q5). All five are resolved in the session below. The §"Open Questions / NEEDS CLARIFICATION" section is updated to reflect the locked decisions.

### Session — 2026-05-14 (Q1–Q5)

**§A0 CLEARED**: 004 S4 closeout (PR #124, 2026-05-11) and 004 S5 visibility boundaries (T083–T093, main SHA `d247e8a`, 2026-05-14) both confirmed merged. Q1–Q5 resolved as follows:

- **Q1 — Item-note maximum length — LOCKED: 200 characters.** The existing placeholder value is adopted as the hard maximum. FR-010, FR-020, §Key Entities (CartLine, `note` field), and the §Edge Cases "note exceeds maximum" entry are all updated to reflect 200 chars as normative.

- **[SUPERSEDED by RT-28, 2026-09-27 — no threshold; see Amendment and FR-023]** **Q2 — Discount-attribution threshold — LOCKED: percentage of line subtotal, per-line scope; numeric value deferred to tenant-policy / operations input.** Units are locked as *percentage of `line_subtotal_minor`*, applied per-line (not per-cart, not in minor units, not a tier table). The specific numeric threshold (e.g., 10 %, 15 %) is NOT locked by this spec — it is a tenant-configurable parameter owned by the future payment / checkout feature's discount-catalogue. FR-023 and §Key Entities (DiscountPlaceholder) are updated to remove the raw `[NEEDS CLARIFICATION]` tags and surface the locked units/scope while deferring the value. Note for `/speckit-plan`: `plan.md` R2 is consistent with this decision; verify the DiscountPlaceholder storage schema reflects per-line scoping.

- **Q3 — Cart-stale-while-signed-out policy — LOCKED: option (a) discard immediately on session end.** Rationale confirmed: drafts carry no payment-bearing state; recovery creates a "ghost cart" visible to a subsequent cashier, violating 004's tenant / role-isolation discipline. FR-007, §Edge Cases ("Operator session ends mid-cart", "Takeover strands a cart"), and A9 references updated to remove `[NEEDS CLARIFICATION]` tags and state option (a) as normative. Note for `/speckit-plan`: `plan.md` R3 leans "preserved + re-opens for same operator" — this conflicts with the locked Q3 decision; R3 MUST be reconciled to option (a) during `/speckit-plan` before any implementation slice begins.

- **Q4 — Line-item merge rule on duplicate add — LOCKED: merge by `item_ref` (option (a)) is the default; the "force separate line" affordance is deferred to a future catalogue/UI feature.** FR-014 already uses merge as default; this decision closes Q4 without schema change. The "subject to Q4" parenthetical in US1-AS6 and the Q4 edge-case note in §Edge Cases are updated to reflect the locked default. Note for `/speckit-plan`: `plan.md` R1 leans "append separate line" — this conflicts with the locked Q4 decision; R1 MUST be reconciled to merge-default during `/speckit-plan`.

- **Q5 — Offline-cart audit event — LOCKED: separate event `cart.discarded_on_session_end`.** The event is a fourth addition to 004's §A3 audit catalogue, alongside the three enumerated in FR-026 (`cart.handoff_to_payment`, `cart.cancel.post_handoff`, `cart.discount.above_threshold`). FR-026 and §Key Entities (AuditEvent) updated to include this fourth category. The event fires when Q3 policy (a) discards a draft on session end; it carries the same five mandatory attribution attributes as the other sensitive-action categories.

A secondary clarification (Q4) that surfaced during drafting is now closed by the session above.

## User Scenarios & Testing *(mandatory)*

<!--
  User stories are PRIORITIZED. Each story is INDEPENDENTLY TESTABLE.
  P1 yields a viable cart MVP; P2 layers cancel/void attribution; P3 layers
  the handoff envelope. None of the stories require payment, receipt,
  inventory, or shift surfaces — those are out-of-scope here.
-->

### User Story 1 — Build a draft cart (Priority: P1)

A signed-in cashier (operator session active per 004) lands on the cart-bearing surface and starts adding line items. Each add is confirmed before any visual indication of success (P2 — no fake success states). Quantities can be incremented, decremented (decrement to zero removes the line), or set explicitly. Each mutating action is idempotent (carries a client-generated UUID v4). Per-line `unit_price_minor` is *snapshotted* at add time; subsequent catalogue price drift does not silently rewrite the line. The draft cart persists locally across app restart while the operator session is held; it is bound to that operator session and CANNOT mutate while no operator is signed in.

**Why this priority**: Without a working draft cart bound to an operator session, every later feature has nothing to attach to. P1 yields the smallest demonstrable cart capability — a cashier can build, edit, and persist a draft — and is the foundation the cancel/void rules (P2) and the handoff envelope (P3) layer onto.

**Independent Test**: A reviewer signs in via 004's Sign-In surface as a cashier, navigates to the cart-bearing surface, adds three line items (varying unit prices), increments and decrements quantities, removes a line via decrement-to-zero, restarts the app while still signed in, and confirms the draft is restored exactly. No payment, no receipt, no inventory mutation is required for this test.

**Acceptance Scenarios**:

1. **Given** a signed-in cashier on a cart-bearing surface and an empty cart, **When** they add a line item with `item_ref = "ITEM-A"`, `quantity = 2`, **Then** the cart persists exactly one line with `display_name`, `quantity = 2`, snapshotted `unit_price_minor`, and computed `line_subtotal_minor = quantity × unit_price_minor`; the line is visible only after persistence confirms success (no optimistic render of an unconfirmed line).
2. **Given** an open draft cart with one line of quantity 3, **When** the cashier issues a decrement-to-zero on that line carrying client UUID `U`, **Then** the line is removed and a replay of the same UUID `U` MUST be a no-op (no second removal, no error surfacing as success).
3. **Given** an open draft cart, **When** the operator explicitly sets quantity to a positive integer with a stale `version` token (the line was mutated since the operator last read it), **Then** the operation MUST be refused with a generic "this line was just updated — please review and try again" outcome and the line MUST NOT be silently overwritten.
4. **Given** a draft cart with two lines, **When** the application is restarted while the operator session is still held (session token still valid, no sign-out, no takeover), **Then** on relaunch the same operator on the same terminal sees the same two lines with identical contents and identical `version` tokens.
5. **Given** no operator is signed in, **When** any cart-mutating action is attempted (programmatic forced call, route restoration, deep-link), **Then** the cart MUST refuse the mutation with a generic outcome and MUST NOT persist any line; the cart-bearing surface itself MUST NOT be reachable per 004 FR-005.
6. **Given** a draft cart, **When** the cashier adds the same `item_ref` twice in succession, **Then** the two adds merge into a single line with summed `quantity` (merge-by-`item_ref` is the locked default per Q4; the "force separate line" affordance is deferred to a future catalogue/UI feature).
7. **Given** a draft cart, **When** the cashier adds a line and the catalogue's current `unit_price_minor` for that `item_ref` differs from the price snapshotted on that line, **Then** the line retains the snapshotted price; price drift does not retroactively rewrite the line (P3 — no silent data loss).

---

### User Story 2 — Cancel a cart with attribution (Priority: P2)

A cashier may freely cancel their own draft cart at any point *before* a finalisation handoff has begun. After a handoff has begun (state = `handed_off_to_payment`), the cart is frozen and any cancellation is a *sensitive action* requiring manager attribution under 004's audit-event scaffold (`audit_events`, append-only, FR-025-style attributes). The spec does NOT design the post-handoff cancel UI; it locks the rule.

**Why this priority**: Cancel discipline is the rule that prevents a cashier from silently undoing a started payment. Codifying it here, before the payment / checkout feature exists, prevents the rule from being eroded later under the pressure of "make cancel just work".

**Independent Test**: A reviewer signs in as a cashier, builds a draft cart, cancels it, confirms the cart is gone and no manager involvement was required. Builds a second cart, advances the cart to the `handed_off_to_payment` state via the handoff path, attempts to cancel as a cashier, confirms cancel is refused (or is gated behind a manager-attributable action) and that the audit-event placeholder is captured per 004 FR-025.

**Acceptance Scenarios**:

1. **Given** a signed-in cashier with their own draft cart in state `draft`, **When** they invoke cancel, **Then** the cart transitions to `cancelled`; no manager attribution is required; the action is recorded as a non-sensitive lifecycle event.
2. **Given** a draft cart that has emitted a `payment-intent envelope` (state `handed_off_to_payment`), **When** a cashier attempts to cancel from a cashier-reachable surface, **Then** the cancel MUST be refused with a generic "this cart is now in payment — ask a manager" outcome; no cart line MUST be reverted by the cashier alone.
3. **Given** a cart in state `handed_off_to_payment` and a manager attribution path is exercised under 004 FR-025 (acting operator + shift + originating terminal + timestamp + action category, plus the supervisor identity), **When** the cancel is approved, **Then** the cart transitions to `cancelled` and the audit record carries the cashier (as the requester) and the manager (as the approver).
4. **Given** a cart in `cancelled` state, **When** any further cart-layer mutation is attempted, **Then** the mutation MUST be refused with a generic "this cart is closed" outcome; `cancelled` is terminal.
5. **Given** any cancel (cashier-only or manager-attributed), **When** the audit record is later inspected, **Then** the record MUST satisfy 004 FR-025's five mandatory attribution attributes; partial records MUST NOT persist.

---

### User Story 3 — Hand off to the future payment / checkout feature (Priority: P3)

When the cashier is ready to take payment, the cart emits a **`payment-intent envelope`** — an immutable snapshot — and transitions to state `handed_off_to_payment`. From that point onward, no cart-layer surface MAY mutate the lines, quantities, notes, or per-line subtotals. The envelope is the *only* artifact the future payment / checkout feature consumes from cart. The future payment / checkout feature owns finalisation: totals math, change calculation, tender row design, receipt rendering, the eleven 003-reserved layout slots (`tender.cash`, `tender.card`, `tender.bank-transfer`, `tender.voucher`, `tender.insurance`, `tender.split`, `totals.amount-due`, `totals.amount-paid`, `totals.remaining`, `totals.change-due`, `receipt.breakdown`).

**Why this priority**: A clean, immutable envelope is the difference between a stable handoff and a "shared mutable cart" anti-pattern. Locking the envelope shape now prevents two ugly outcomes: (a) the future payment / checkout feature negotiating cart mutability post-hoc, and (b) audit drift between what was charged and what the cart "remembers".

**Independent Test**: A reviewer builds a non-empty draft cart, invokes handoff, inspects the envelope's shape (cart_id, operator_session_id, tenant_id, branch_id, terminal_id, line snapshots, subtotal_minor in integer minor units, created_at), then attempts to mutate the cart through every cart-layer affordance and confirms each is refused. The reviewer also confirms the envelope is sufficient for the future payment / checkout feature: it carries enough context to compute totals, attribute the sale to an operator and shift, and to drive the 003-reserved tender / totals / receipt-breakdown slots without further reach-back into the cart.

**Acceptance Scenarios**:

1. **Given** a draft cart with at least one line, **When** the cashier invokes handoff, **Then** the cart emits a `payment-intent envelope` carrying: `cart_id`, `operator_session_id` (per 004), `tenant_id`, `branch_id`, `terminal_id`, an immutable list of line snapshots (each line's `item_ref`, `display_name`, `quantity`, `unit_price_minor`, `line_subtotal_minor`, `note`, `version` at handoff), `subtotal_minor` (= sum of line subtotals, integer minor units only), and `created_at`; the cart transitions to state `handed_off_to_payment`.
2. **Given** an empty draft cart (zero lines), **When** the cashier invokes handoff, **Then** handoff MUST be refused; no envelope MUST be emitted; the cart remains in state `draft`.
3. **Given** a cart in state `handed_off_to_payment`, **When** any cart-layer surface attempts to add, remove, set quantity, edit a note, or attach a discount placeholder, **Then** the mutation MUST be refused with a generic "this cart is in payment" outcome; the envelope and the underlying lines MUST be unchanged.
4. **Given** a `payment-intent envelope`, **When** the future payment / checkout feature consumes it, **Then** it MUST treat the envelope's fields as immutable inputs; the future feature MAY add fields it owns (tender breakdown, totals, change, paid timestamps) but MUST NOT remove, rename, or rewrite any of the envelope's existing fields.
5. **Given** a handoff invocation with a stale cart `version` (the cart was mutated after the cashier last viewed it), **When** the system processes the handoff, **Then** the handoff MUST be refused with a generic "review the cart and try again" outcome and the cart MUST stay in state `draft`.
6. **Given** any handoff (success or refusal), **When** the audit record is inspected, **Then** the record MUST satisfy 004 FR-025's five mandatory attribution attributes; the action category is `cart.handoff_to_payment` and is appended to 004's audit catalogue (FR-026 extension).

---

### Edge Cases

- **Empty-cart handoff**: refused. An envelope MUST NOT be emitted with zero lines (US3-AS2). Generic "add at least one item before payment" outcome on the cashier surface.
- **Zero-quantity update**: a `set quantity = 0` operation is treated as a remove; the line is deleted. (Not a separate edge — same semantics as decrement-to-zero.)
- **Duplicate add of same `item_ref`**: merge-by-`item_ref` is the locked default (Q4 resolved 2026-05-14). The "force separate line" affordance is deferred to a future catalogue/UI feature.
- **Operator session ends mid-cart (sign-out, inactivity timeout per 004 FR-009, takeover per 004 FR-013)**: the draft cart MUST NOT survive the session end on a cashier-reachable surface. **Q3 locked (2026-05-14): discard immediately on session end (option (a)).** The draft MUST NOT become observable by a different cashier on the same terminal. A `cart.discarded_on_session_end` audit event MUST be emitted (Q5).
- **Takeover strands a cart**: if a takeover under 004 FR-013 force-signs-out a cashier holding an open draft cart, the draft MUST be discarded immediately per Q3 (option (a)). The cart layer MUST NOT silently transfer the draft to the new operator. Any audit event for cart loss is a separate record from the `operator.session.takeover` event (mirroring 004's FR-013 / FR-024 separation pattern).
- **Idempotency replay**: any cart-mutating action that arrives with a previously-seen client UUID MUST be a no-op; the response MUST match the original outcome (success / refusal). Replay-then-mutate (same UUID, different payload) MUST be refused — UUID identifies the *operation*, not the *line*.
- **Version-conflict on quantity update**: if the line's stored `version` has advanced since the cashier last read it, the update MUST be refused with a generic "this line was just updated — please review and try again" outcome. The cashier reads the line again (with the new `version`) and re-attempts.
- **Note exceeds maximum length**: refused at the cart-layer boundary with a generic "note too long" outcome; the line's existing note (if any) MUST NOT be partially overwritten. Maximum length is **200 characters** (Q1 locked 2026-05-14).
- **Note contains forbidden patterns (PII / card data)**: cart-layer redaction (P11) MUST refuse to persist any value that matches the project's existing forbidden-key / forbidden-pattern allowlist (mirrors 004 PR-1 / NFR-002). The refusal is generic — it MUST NOT echo back which pattern was matched.
- **Discount placeholder without manager authority** *(RT-28)*: refused. The cart layer recognises only a discount *placeholder* (US-aware "this line/cart has a pending discount" slot); **every** positive manual discount requires manager authority under 004 FR-025 / FR-026 before the placeholder may be considered "applied" — there is no threshold and no cashier-only path. The cart layer DOES NOT compute the discounted amount.
- **Cart state transition into `handed_off_to_payment` while offline**: the handoff MAY proceed locally (cart drafts are local-first, P18 — local durability before offline promises) but the audit record for `cart.handoff_to_payment` MUST be queued in the local outbox per 004 NFR-011; the cashier surface MUST surface the existing 003 connection-state visual (`offline` / `degraded`) and MUST NOT optimistically claim the payment surface succeeded (P2 — no fake success states). Note: payment finalisation itself is NOT promised offline by 005; that's the future payment / checkout feature's call.

## Requirements *(mandatory)*

### Functional Requirements

#### FR-Cart-Identity (cart binding to operator session)

- **FR-001**: A draft cart MUST be bound to exactly one active `OperatorSession` (per 004 Key Entities). A cart MUST NOT exist without an `operator_session_id`; an `operator_session_id` referring to a terminated session MUST NOT be valid for cart mutation.
- **FR-002**: Every cart MUST also carry, by reference: `tenant_id`, `branch_id`, `terminal_id`. These MUST match the values on the bound `OperatorSession`; mismatches MUST be refused (tenant isolation, P17).
- **FR-003**: A cart MUST NOT be reachable, mutable, or persistable from any surface where no operator is signed in. Forced reach (route restoration, deep-link, programmatic invocation) MUST be refused per 004 FR-005 / FR-016.

#### FR-Lifecycle (cart states & transitions)

- **FR-004**: The cart's lifecycle states are exactly three: `draft`, `cancelled`, `handed_off_to_payment`. No other states MAY be introduced by 005.
- **FR-005**: The legal state transitions are: `draft → cancelled` (cashier or manager-attributed), `draft → handed_off_to_payment` (handoff success), `handed_off_to_payment → cancelled` (manager-attributed only). No other transitions MAY occur.
- **FR-006**: `cancelled` and `handed_off_to_payment` are *terminal* with respect to cart-layer mutation. After either state is reached, no line MAY be added, removed, updated, or have its note edited via any cart-layer surface.
- **FR-007**: A cart in state `draft` MUST persist locally across app restart while the bound operator session is still active. On session end, the draft MUST be discarded immediately (Q3 locked 2026-05-14: option (a)) and a `cart.discarded_on_session_end` audit event MUST be queued in the local outbox (Q5).
- **FR-008**: A cart that has emitted a `payment-intent envelope` (FR-034) MUST stay in state `handed_off_to_payment` until either the future payment / checkout feature signals a terminal payment outcome (out of scope for 005) or a manager-attributed cancel returns it to `cancelled` (FR-033).
- **FR-009**: The cart's lifecycle state MUST be observable to the cashier on cashier-reachable surfaces *only* for their own cart. A cashier MUST NOT observe another cashier's cart state on any cashier surface (deferred to 004 S5 visibility-matrix review for the canonical row).

#### FR-LineItems (line-item structure & invariants)

- **FR-010**: A cart line MUST carry exactly the following behavioural fields: `id`, `cart_id`, `item_ref`, `display_name`, `quantity`, `unit_price_minor` (integer), `line_subtotal_minor` (integer), `note` (string ≤ 200 chars), `created_at`, `updated_at`, `version`.
- **FR-011**: `unit_price_minor` MUST be the snapshotted catalogue price *at add time*. Subsequent catalogue price changes MUST NOT silently rewrite the line (P3 — no silent data loss).
- **FR-012**: `line_subtotal_minor` MUST be computed as `quantity × unit_price_minor` in integer minor units only; no floating-point arithmetic at any point. (P1 — financial correctness; constitution Hard Rules.)
- **FR-013**: `display_name` MUST be set at add time from the catalogue resolution of `item_ref`; subsequent catalogue display-name changes MUST NOT silently rewrite the line (mirrors FR-011 rationale).
- **FR-014**: Adding the same `item_ref` to a non-empty cart that already contains a line for that `item_ref` MUST default to merging — the existing line's `quantity` is incremented by the add's quantity and `version` advances. Whether to expose a "force separate line" path is Q4.
- **FR-015**: A line's `version` MUST advance on every successful mutation of that line (quantity change, note edit). The `version` is the optimistic-concurrency token (FR-018).
- **FR-016**: A line that is removed (decrement-to-zero, explicit set quantity = 0, explicit remove) MUST be deleted; cart-layer surfaces MUST NOT retain a "soft-deleted" zero-quantity line. (Operational simplicity; reduces the footprint exposed to a future payment feature.)

#### FR-Quantity (quantity-change idempotency & invariants)

- **FR-017**: Quantity changes MUST support exactly three operations: `increment(delta)`, `decrement(delta)`, `set(absolute)`. `delta` MUST be a positive integer. `absolute` MUST be a non-negative integer; `set(0)` is equivalent to `remove`.
- **FR-018**: Every quantity-change operation MUST carry a client-generated UUID v4 (P5 — idempotency). Replay of the same UUID with the same payload MUST be a no-op and MUST return the original outcome. Replay of the same UUID with a *different* payload MUST be refused.
- **FR-019**: Every quantity-change operation MUST carry the line's last-known `version`; a stale `version` MUST refuse the operation per FR-015.

#### FR-Notes (free-text per line)

- **FR-020**: A cart line MAY carry a free-text `note` of length ≤ **200 characters** (Q1 locked 2026-05-14). A note exceeding the maximum MUST be refused at the cart-layer boundary; partial overwrite MUST NOT occur.
- **FR-021**: Cart-layer note redaction MUST refuse to persist values matching the project's existing forbidden-key / forbidden-pattern allowlist (PII, card data, credential fragments — mirrors 004 PR-1 / NFR-002 and the constitution's P11). The refusal MUST be generic; it MUST NOT echo back which pattern matched.

#### FR-Discount-Placeholder (discount actions are placeholders only)

- **FR-022**: 005 MUST NOT design discount math. The cart layer recognises only a **DiscountPlaceholder** entity (see §"Key Entities") that signals "this line / cart has a pending discount of kind K". The cart layer MUST NOT compute, store, or expose a discounted amount; that's the future payment / checkout feature's responsibility.
- **FR-023** *(revised by RT-28, owner decision 2026-09-27)*: Every manual discount placeholder with a positive magnitude MUST be a *sensitive action* requiring **manager authority** under 004 FR-025 / FR-026, regardless of percentage, amount or kind. There is **no cashier-only path and no threshold exception**. The placeholder MUST NOT be considered applied on the cart layer until manager authority is recorded. Manager authority MUST be established in the main process — for a cashier session, by a manager step-up authentication verified in the main process (credential source pending owner decision RT-28 D1a) (D1); a renderer-supplied approver identifier MUST NOT be accepted as authority on its own. A manager or admin acting on their own session MAY apply the discount directly and is recorded as the approver (D2). The audit record MUST carry the acting operator (requester) and the approving manager as separate attributes (004 FR-025(f)) and MUST NOT carry any credential material. Removing a discount placeholder is allowed for every role and is recorded as a non-sensitive lifecycle action (D4). This requirement governs *authority* only; discount kind, math and catalogue remain owned by the future payment / checkout feature (FR-022, FR-024). *Superseded text follows for audit trail:* ~~Any discount whose magnitude exceeds the Q2 threshold MUST be a *sensitive action* requiring manager attribution under 004 FR-025 / FR-026.~~ The discount placeholder MUST NOT be considered "applied" on the cart layer until manager attribution is recorded. **Q2 locked (2026-05-14): the threshold is a *percentage of `line_subtotal_minor`*, applied per-line. The specific numeric value is a tenant-configurable parameter owned by the future payment / checkout feature's discount-catalogue; this spec does not set that value.**
- **FR-024**: The discount-placeholder catalogue is owned by the future payment / checkout feature; 005 commits to the *attribution rule*, not to the catalogue contents. Future kinds (line discount, cart discount, percentage, fixed amount, voucher-tied, insurance-tied, loyalty-tied) MUST be added there, not here.

#### FR-Attribution (cart-mutating actions carry session id; sensitive actions emit audit-event placeholders)

- **FR-025**: Every cart-mutating action MUST carry the `operator_session_id` of the active session under which it executes; the cart layer MUST refuse any action whose `operator_session_id` does not match the cart's bound session.
- **FR-026**: The cart layer MUST emit an audit-event placeholder per 004 FR-025 / FR-026 for the following sensitive cart actions: `cart.handoff_to_payment`, `cart.cancel.post_handoff` (manager-attributed), `cart.discount.manager_authorized` (manager-authorized — every positive manual discount, RT-28 D3; the former `cart.discount.above_threshold` category is retained for historical records only and MUST NOT be emitted for new discounts), and `cart.discarded_on_session_end` (Q5 locked 2026-05-14 — fourth addition to 004's §A3 catalogue). The five mandatory attributes (acting operator, shift, originating terminal, timestamp, action category) MUST be present; partial records MUST NOT persist (mirrors 004 NFR-008).
- **FR-027**: Non-sensitive cart actions (add / remove / quantity-change / note-edit on a still-`draft` cart by the binding cashier) MUST NOT emit audit-event records. The audit-event scaffold is reserved for genuinely sensitive actions; everyday cart edits are not audited per-action (P11 — supportability without log bloat).

#### FR-Offline-Drafts (local-first persistence)

- **FR-028**: Draft carts MUST persist in the existing local SQLite store (per 001 + constitution Tech Stack). They MUST survive app restart while the bound operator session is active.
- **FR-029**: Draft carts MUST NOT carry payment-bearing state. No tender field, no totals math beyond per-line `line_subtotal_minor`, no balance, no change, no receipt-breakdown payload.
- **FR-030**: When the connection state surfaces `offline` or `degraded` per 003's four-state model and 004's NFR-011, cart drafts MUST continue to function locally for the binding cashier. Backend-dependent operations (catalogue refresh, audit-event sync) MUST queue per the existing local outbox pattern; 005 MUST NOT optimistically claim a queued audit event has been accepted (P2 — no fake success states).

#### FR-Void-Cancel (cancellation boundaries)

- **FR-031**: A cashier MAY freely cancel their own draft cart while the cart is in state `draft`; this transition is recorded as a non-sensitive lifecycle event and MUST NOT emit a 004-FR-025 audit record on its own.
- **FR-032**: A cancel attempt against a cart in state `handed_off_to_payment` from a cashier-reachable surface MUST be refused with a generic outcome; the cashier alone MUST NOT be able to revert a handoff.
- **FR-033**: A `handed_off_to_payment → cancelled` transition MUST be a manager-attributed sensitive action under 004 FR-025 / FR-026. The audit record MUST carry the cashier (as the requester) and the manager (as the approver) per 004 FR-025(f).

#### FR-Handoff (payment-intent envelope contract)

- **FR-034**: On successful handoff, the cart MUST emit a `payment-intent envelope` carrying the following fields: `cart_id`, `operator_session_id`, `tenant_id`, `branch_id`, `terminal_id`, an immutable list of line snapshots (each carrying `item_ref`, `display_name`, `quantity`, `unit_price_minor`, `line_subtotal_minor`, `note`, `version` at handoff), `subtotal_minor` (integer minor units, sum of line subtotals), and `created_at`. The envelope is the *only* artifact 005 commits to between cart and the future payment / checkout feature.
- **FR-035**: After the envelope is emitted, the cart's lines, quantities, notes, and per-line subtotals MUST be frozen — no cart-layer surface MAY mutate them. Reach-back from the future payment / checkout feature into cart-layer mutation MUST be refused; any "edit cart" affordance during payment MUST cancel the handoff and re-open the cart, which is itself a manager-attributed sensitive action under FR-033.
- **FR-036**: The future payment / checkout feature MAY add fields it owns to the envelope (tender breakdown, totals math, change due, paid timestamps, receipt-breakdown payload) but MUST NOT remove, rename, or rewrite any of the envelope fields enumerated in FR-034. Any such modification MUST be a Spec Kit feature update, not an in-flight schema mutation.
- **FR-037**: Handoff against an empty cart (zero lines) MUST be refused (US3-AS2). Handoff with a stale cart `version` MUST be refused (US3-AS5).

### Non-Functional Requirements

- **NFR-001 (security boundary preservation)**: This feature MUST NOT weaken any security boundary established by 001 (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no upward-of-bridge IPC, money-as-integer module). Any future implementation slice for 005 MUST preserve these. (Constitution Core Principle II.)
- **NFR-002 (no money floats — P1)**: All cart-layer arithmetic involving money MUST be in integer minor units. `line_subtotal_minor = quantity × unit_price_minor` in integer arithmetic only. Floating-point representations of money MUST NOT appear at any cart-layer boundary, including the `payment-intent envelope`. (Constitution Hard Rules; project CLAUDE.md.)
- **NFR-003 (no totals math at the cart layer)**: 005 commits to per-line `line_subtotal_minor` and an envelope-level `subtotal_minor` (sum of line subtotals). No totals beyond that — no tax, no discount math, no tender breakdown, no change, no balance — MAY be computed by the cart layer. Those are the future payment / checkout feature's responsibility.
- **NFR-004 (cart mutation latency)**: Cart-mutating operations (add, remove, quantity change, note edit) MUST complete in under 100 ms p95 on the constitution's standard hardware matrix, with the cart-bearing surface visibly reflecting the change within the same threshold.
- **NFR-005 (touch-target floor)**: Cart affordances (add, increment, decrement, remove, note-edit, cancel, handoff) MUST honour the 44 × 44 CSS-pixel minimum touch target inherited from 003 NFR-5 / constitution Hardware Matrix.
- **NFR-006 (no PII in logs / cart-payload allowlist)**: Cart-layer logs, support bundles, crash reports, and any operator-attributable diagnostic surface MUST NOT contain note free-text, customer references, payment-instrument data, or any credential fragment. The cart-layer payload allowlist MUST refuse to forward forbidden keys across the preload bridge (mirrors 004 PR-1 / NFR-002 and the constitution's P11).
- **NFR-007 (cart drafts at rest — plain SQLite, rationale recorded)**: Cart drafts are NOT secrets. They MAY live in the existing local SQLite store in plain form, alongside other operational data per 001's storage pattern. Sensitive credential material referenced indirectly by the cart (e.g., the bound operator's credential factor) is owned by 001's `safeStorage`/DPAPI module and MUST NOT cross into the cart payload (FR-031 of 004 / NFR-006 here). This NFR exists to record the rationale: "drafts are not secrets; therefore plain SQLite is sufficient" — so a future reviewer does not silently re-classify drafts as secrets and break the existing pattern.
- **NFR-008 (no offline-payment promise)**: 005 MAY operate cart drafts offline (P18 — local durability before offline promises) but MUST NOT promise offline payment finalisation. Payment finalisation is not part of 005; the future payment / checkout feature decides its own offline behaviour. The cart layer MUST surface 003's `offline` / `degraded` connection state during a handoff invoked offline rather than optimistically claim the payment surface succeeded (P2 — no fake success states).
- **NFR-009 (deterministic role boundary — defers to 004 S5)**: Given an operator role, the set of cart-related reachable surfaces and the set of returnable cart-related information MUST be deterministic and not influenced by client-side state (theme, density, viewport, feature flags). The canonical role-visibility-matrix rows for cart surfaces are deferred to 004 S5 review — 005 MUST NOT pre-write the canonical matrix; it MUST propose rows and reference `specs/004-operator-session/contracts/role-visibility-matrix.md` as the source of truth (mirrors 004 NFR-004).

### Key Entities *(behavioural; not implementation)*

- **Cart**: A draft container of line items bound to exactly one `OperatorSession`. Carries: `id`, `operator_session_id`, `tenant_id`, `branch_id`, `terminal_id`, `lifecycle_state` ∈ {`draft`, `cancelled`, `handed_off_to_payment`}, `created_at`, `updated_at`. A cart MUST NOT carry totals-bearing fields beyond the per-line `line_subtotal_minor` it derives from its lines.
- **CartLine**: A single line item on a cart. Carries: `id`, `cart_id`, `item_ref`, `display_name`, `quantity` (positive integer), `unit_price_minor` (integer minor units, snapshotted at add time per FR-011), `line_subtotal_minor` (integer minor units, computed per FR-012), `note` (string ≤ **200 chars**, Q1 locked 2026-05-14), `created_at`, `updated_at`, `version` (optimistic-concurrency token per FR-015).
- **DiscountPlaceholder**: A placeholder marker that signals "this line / cart has a pending discount of kind K". Carries (behaviourally, not as a designed schema): a reference to the `cart_id` (cart-level discount) or `line_id` (line-level discount), a `placeholder_kind` (catalogue owned by the future payment / checkout feature, NOT 005), and a `requires_manager_attribution` flag (RT-28: always true for a positive manual discount; formerly true only above the Q2 threshold). The cart layer MUST NOT compute the discounted amount; the placeholder is *informational* until the future payment / checkout feature applies the discount math.
- **PaymentIntentEnvelope**: The single contract 005 commits to between cart and the future payment / checkout feature. Carries: `cart_id`, `operator_session_id`, `tenant_id`, `branch_id`, `terminal_id`, an immutable list of line snapshots (each line's `item_ref`, `display_name`, `quantity`, `unit_price_minor`, `line_subtotal_minor`, `note`, `version` at handoff), `subtotal_minor` (integer minor units, = sum of line subtotals), `created_at`. **The future payment / checkout feature MAY add fields it owns (tender breakdown, totals math beyond `subtotal_minor`, change, paid timestamps, receipt-breakdown payload) but MUST NOT remove, rename, or rewrite any of the envelope fields enumerated here (FR-036).** This is the boundary contract — treat it as load-bearing.
- **Operator** *(re-stated dependency on 004)*: The human user authorised to operate POS-Pulse. Carries: stable identity, display name, role (`cashier` | `manager` | `admin`), tenant, authorised branch set, account-enabled flag. **005 MUST NOT redefine this entity; it consumes 004's definition.**
- **OperatorSession** *(re-stated dependency on 004)*: The bound link between an `Operator` and a paired `TerminalSession`. Carries: operator identity, role, tenant, branch, originating terminal, start timestamp, end timestamp, end-cause. **005 MUST NOT redefine this entity; it consumes 004's definition.**
- **AuditEvent** *(re-stated dependency on 004)*: The append-only sensitive-action record. Carries the five mandatory attribution attributes (acting operator, shift, originating terminal, timestamp, action category) and optional approving supervisor. **005 MUST NOT redefine this entity; it consumes 004's definition (FR-025 / FR-028).** New action categories introduced by 005 extend 004's catalogue per 004 FR-026 ("Future features MAY extend the catalogue but MUST NOT shrink it"): `cart.handoff_to_payment`, `cart.cancel.post_handoff`, `cart.discount.manager_authorized` (RT-28; `cart.discount.above_threshold` is retained as a historical category, never emitted for new discounts, so the catalogue does not shrink), and `cart.discarded_on_session_end` (Q5 locked 2026-05-14 — fires when Q3 policy (a) discards a draft on session end).

## Success Criteria *(mandatory)*

> ✅ **§A0 CLEARED** — 004 S4 / S5 both merged. These criteria become testable once `/speckit-plan` + `/speckit-tasks` complete and implementation slices begin.

### Measurable Outcomes

- **SC-001 (cart-add latency)**: 95 % of `add line` operations complete in under 100 ms end-to-end on the standard hardware matrix (NFR-004). Worst-case observed latency during acceptance review under 250 ms.
- **SC-002 (idempotency replay = 0 duplicate lines)**: Across at least 50 simulated quantity-change replays (same UUID, same payload), zero duplicate line states are produced; the cart's final state is identical to a single-execution baseline (FR-018).
- **SC-003 (version-conflict resolution)**: Across at least 20 simulated stale-`version` quantity-change attempts, 100 % are refused with a generic "review and try again" outcome; zero are silently overwritten (FR-019).
- **SC-004 (handoff immutability invariant)**: For each of at least 10 attempted post-handoff mutation paths (add, remove, increment, decrement, set, note-edit, attach discount placeholder, programmatic forced call, route restoration, deep-link), the mutation is refused; zero post-handoff mutations succeed (FR-035).
- **SC-005 (audit-emission completeness for cart sensitive actions)**: For each of the four cart-introduced sensitive-action categories (`cart.handoff_to_payment`, `cart.cancel.post_handoff`, `cart.discount.manager_authorized` *(RT-28; formerly `cart.discount.above_threshold`)*, `cart.discarded_on_session_end`), a tabletop review confirms every audit record carries 004 FR-025's five mandatory attribution attributes; zero categories are missing any attribute (FR-026).
- **SC-006 (no money float)**: A code-and-spec walkthrough confirms zero floating-point money arithmetic at any cart-layer boundary; per-line subtotal arithmetic is in integer minor units only; the `payment-intent envelope`'s `subtotal_minor` is integer minor units only (NFR-002, FR-012, FR-034).
- **SC-007 (tenant isolation walkthrough)**: A reviewer signed in as a cashier in tenant T1 / branch B1 cannot reach, mutate, or observe any cart bound to a different tenant or branch across at least 10 attempted access paths (forced session id, forced cart id, route restoration, deep-link); zero leakages (FR-002).
- **SC-008 (role-boundary deferral to 004 S5)**: The 005 spec contributes zero canonical visibility-matrix rows; every cart-related visibility decision is filed as a proposal against `specs/004-operator-session/contracts/role-visibility-matrix.md` for 004 S5 review (NFR-009). A 004 S5 review record explicitly approves the proposed cart-related rows before any 005 implementation slice begins.
- **SC-009 (note-redaction completeness)**: Across at least 25 simulated note-edit attempts that match the project's forbidden-key / forbidden-pattern allowlist (PII, card data, credential fragments), 100 % are refused at the cart-layer boundary with a generic "note rejected" outcome; zero forbidden patterns are persisted (FR-021, NFR-006).
- **SC-010 (no implementation drift)**: Acceptance review of the 005 spec confirms that this feature contributes zero source files, zero migrations, zero OpenAPI changes, zero IPC channels, and zero new packages. The spec's sole artifacts are `specs/005-sales-cart/spec.md` and (later) its checklist.

## Out of Scope *(this feature)*

The following are explicitly out of scope for **005-sales-cart** and MUST NOT be introduced by this feature's spec, plan, tasks, or implementation slices. They are deferred to other features (already-shipped or future).

- Payments, tender, money math at the cart layer (any totals math beyond per-line subtotal = `quantity × unit_price_minor` and the envelope's `subtotal_minor` = sum of line subtotals).
- Receipts, receipt rendering, printed-receipt content, print queue, print driver communication.
- Inventory mutation, stock movement, FEFO, batch / lot logic.
- Reports, KPIs, dashboards, analytics surfaces.
- Shift financial calculations, drawer math, expected total, variance, shortage, overage. (Owned by 004's audit-attribution scaffold and the future shift-management feature.)
- Backend / API implementation. **No OpenAPI changes by `/speckit-plan` for 005.**
- Database migrations (no schema changes).
- Codegen (no `npm run codegen:api` invocation tied to 005).
- UI implementation. **005 is the spec phase only.** Any UI-bearing 005 slice MUST schedule the FR-033 visual-direction milestone (inherited from 004) before any UI code is written.
- Data-Pulse-2 changes.
- Card-terminal integration, payment provider SDK, device pairing for payment instruments.
- **Printed-receipt rendering and tender-row design — owned by the future payment / checkout feature, with layout slots already reserved by 003**: `tender.cash`, `tender.card`, `tender.bank-transfer`, `tender.voucher`, `tender.insurance`, `tender.split`, `totals.amount-due`, `totals.amount-paid`, `totals.remaining`, `totals.change-due`, `receipt.breakdown`. **The cart layer DOES NOT own these slots.**
- Discount math, threshold computation, tax math.
- Cashier-self-service price overrides.
- Customer profiles, loyalty programs, customer-tied discounts.
- Catalogue surfaces (item-search affordances, item-detail pages). 005 assumes catalogue resolution exists but does NOT design it (Assumption A4).
- Stock validation at the cart layer (a future inventory feature owns this; 005 MAY emit a stock-check call as a future bridge surface but DOES NOT design it — Assumption A3).
- Any change to 004's role catalogue, audit-event scaffold, or operator-session lifecycle.
- Any weakening of the existing logging, redaction, or security boundaries from 001 / 002 / 003 / 004.

## Assumptions

- **A1 (004 S4 + S5 are merged before 005 implementation)**: **§A0 CLEARED (2026-05-14).** 004 S4 closeout merged 2026-05-11 (PR #124); 004 S5 visibility boundaries merged 2026-05-14 (T083–T093; main SHA `d247e8a`). `/speckit-clarify` ran 2026-05-14 (Q1–Q5 resolved). `/speckit-plan` and `/speckit-tasks` are now unblocked. Implementation of any 005 slice MUST NOT begin until `/speckit-plan` + `/speckit-tasks` complete. (See §"Dependencies".)
- **A2 (the future payment / checkout feature owns money math)**: 005 commits only to per-line `line_subtotal_minor` (integer minor units) and the envelope's `subtotal_minor` (sum of line subtotals, integer minor units). Tax, discount math, change, balance, tender breakdown, and any totals beyond `subtotal_minor` are the future payment / checkout feature's exclusive territory.
- **A3 (the future inventory feature owns stock validation)**: 005 MAY emit a stock-check call against a future inventory feature's surface as a *bridge*, but DOES NOT design that surface. Adding a line for an out-of-stock `item_ref` is therefore not refused at the cart layer in 005; whether a future inventory feature blocks it (and where) is the inventory feature's design call, not 005's.
- **A4 (catalogue resolution exists but is not designed here)**: 005 assumes `item_ref` resolves to a `display_name` and a `unit_price_minor` at add time via an existing or future catalogue surface. Price drift after add is handled by the snapshot rule (FR-011); display-name drift is handled symmetrically (FR-013). Catalogue search, browse, and detail surfaces are out of scope.
- **A5 (cart drafts are NOT covered by 004 S5's "Cashier-Forbidden Information catalogue")**: A cashier CAN see their own draft cart (it's their working surface). Whether managers / admins SHOULD see other cashiers' open carts via a future surface is deferred to 004 S5 review (NFR-009). 005 MUST NOT pre-write the canonical matrix row.
- **A6 (test toolchain inheritance)**: Vitest is the only test runner (constitution Tech Stack; project CLAUDE.md). 005 inherits Vitest, Testing Library, and `expectNoAxeViolations` from 001 / 003 / 004; it does NOT introduce new test infrastructure.
- **A7 (visual direction discipline is default)**: After 003's lesson and 004 FR-033, every UI-bearing 005 slice assumes the early-visual-direction milestone as default behaviour, not a special opt-in. The first UI-bearing 005 slice MUST NOT merge before the visual-direction artifacts are reviewed against 003's POS UI Shell decisions.
- **A8 (handoff is one-way unless manager-attributed)**: A `draft → handed_off_to_payment` transition is committed-forward by default. The only path back to `draft` is a manager-attributed cancel under FR-033, and even that does not "unfreeze" the original cart; it terminates the cart in `cancelled` state. A new draft cart is needed to retry the sale.
- **A9 (operator-bound, not terminal-bound)**: A draft cart belongs to the binding *operator session* (per 004), not to the terminal. On session end the draft is discarded immediately (Q3 locked: option (a)); terminal continuity does not preserve a draft across operator sessions.

## Constitutional Alignment

Each principle below either constrains 005 directly or is preserved by 005's behaviour. This section is informational for `/speckit-plan` and the Constitution Check.

| Principle | Status | One-sentence rationale |
|:--|:--|:--|
| **P1 (financial correctness — money as integer minor units)** | PASS | NFR-002, FR-012, FR-034: per-line `line_subtotal_minor` and envelope `subtotal_minor` are integer minor units; no floats anywhere at the cart layer. |
| **P2 (no fake success states)** | PASS | US1-AS1, NFR-008, FR-030: cart adds confirmed before render; offline handoff surfaces 003's `offline` / `degraded` connection state rather than optimistically claim payment success. |
| **P3 (no silent data loss)** | PASS | FR-011, FR-013, FR-018: snapshotted price/display name; idempotency-keyed mutations; replay is no-op. |
| **P4 (auditability, non-destructive correction)** | PASS-with-deferral | FR-026, FR-033: cart sensitive actions (`cart.handoff_to_payment`, post-handoff cancel, manager-authorized discount — RT-28) extend 004's append-only `audit_events`. Catalogue extension is normative; the audit-event scaffold itself is 004's. |
| **P5 (idempotency)** | PASS | FR-018: every line-item mutation carries a client UUID v4; replay is a no-op; UUID-with-different-payload is refused. |
| **P10 (operator accountability)** | PASS | FR-025, FR-026: every cart-mutating action carries `operator_session_id`; sensitive cart actions emit audit-event placeholders satisfying 004 FR-025's five mandatory attributes. |
| **P11 (privacy / log redaction)** | PASS | FR-021, NFR-006: notes refuse forbidden patterns; cart-layer payload allowlist refuses forbidden keys across the preload bridge. |
| **P13 (small scoped PRs)** | PASS-with-deferral | A4, A7: 005 expects per-slice PRs after the visual-direction milestone; final polish slice will be small. Slicing is finalised at `/speckit-plan` time. |
| **P15 (production readiness gates)** | PASS-with-deferral | A1: 005 implementation is gated behind 004 S4 + S5; production rollout of any 005 slice inherits 004's production-readiness gates (004 §A5) plus its own at `/speckit-plan` time. |
| **P16 (feature scope discipline)** | PASS | §"Out of Scope": payments, receipts, inventory, reports, shift math, backend, migrations, UI implementation are all explicitly out of scope. |
| **P17 (privacy and tenant isolation)** | PASS | FR-002, SC-007: cart MUST carry tenant + branch + terminal + operator session refs; mismatches refused; tenant-isolation walkthrough is a success criterion. |
| **P18 (local durability before offline promises)** | PASS | FR-028, FR-030, NFR-008: cart drafts are local-first and durable across restart; offline payment finalisation is NOT promised by 005. |
| **Core Principle II (Electron security boundary)** | PASS | NFR-001, NFR-006: `contextIsolation`, `nodeIntegration: false`, `sandbox: true`, no upward-of-bridge IPC are preserved; cart-layer payload allowlist refuses forbidden keys at the bridge. |
| **Core Principle VIII (Clerk-only IdP — terminal identity ≠ user identity)** | PASS | FR-001, FR-025: cart binds to `operator_session_id` (a user identity, per 004), not to the terminal; the terminal is a *context* on the cart, not the cart's identity. |

## Dependencies

> ✅ **§A0 CLEARED** — 004 S4 + S5 both merged. Implementation still requires `/speckit-plan` + `/speckit-tasks` to complete before any slice begins.

- **001-foundation** — money-as-integer-minor-units rule, secrets module (`safeStorage` / DPAPI), log redaction, baseline Electron security posture, local SQLite store, custom transactional migration runner.
- **002-terminal-pairing** — terminal session, device token, paired-state precondition. The cart-bearing surface is itself a post-pairing, post-sign-in surface.
- **003-pos-ui-shell** — design tokens (`comfortable` density), navigation rail, role-indicator slot, status-bar location, four-state connection visual, touch-target floor (44 × 44 CSS-pixel), and the **eleven reserved tender / totals / receipt-breakdown layout slots** (`tender.cash`, `tender.card`, `tender.bank-transfer`, `tender.voucher`, `tender.insurance`, `tender.split`, `totals.amount-due`, `totals.amount-paid`, `totals.remaining`, `totals.change-due`, `receipt.breakdown`). **The cart layer DOES NOT own these slots; the future payment / checkout feature does.**
- **004-operator-session** — operator identity, operator session lifecycle, role catalogue (`cashier` / `manager` / `admin`), takeover flow, audit-event scaffold (`audit_events`, append-only, five mandatory attributes), Cashier-Forbidden Information catalogue, FR-033 visual-direction discipline. **§A0 CLEARED (2026-05-14) — S4 merged 2026-05-11, S5 merged 2026-05-14. 005 implementation is now gated on `/speckit-plan` + `/speckit-tasks` completing.**
- **Future payment / checkout feature** — owns: payment-intent finalisation, totals math beyond per-line `line_subtotal_minor` and envelope `subtotal_minor`, tender row design, change calculation, balance, receipt rendering, the eleven 003-reserved layout slots. **005 commits to the `payment-intent envelope` shape (FR-034); the future payment / checkout feature MAY extend it (FR-036) but MUST NOT remove, rename, or rewrite its existing fields.**
- **Future inventory feature** — owns: stock validation, decrement on sale completion, FEFO logic, batch / lot logic. **005 MAY emit a stock-check bridge call but DOES NOT design that surface (Assumption A3).**

## Open Questions / NEEDS CLARIFICATION

All five questions resolved in the 2026-05-14 clarification session (see §"Clarifications"). Entries below are preserved for traceability and show the locked decision.

1. **Q1 — Item-note maximum length** — **LOCKED: 200 characters** (2026-05-14). The existing placeholder is adopted as the hard maximum. Reflected in FR-010, FR-020, §Key Entities (CartLine), and §Edge Cases.

2. **[SUPERSEDED by RT-28, 2026-09-27]** **Q2 — Discount-attribution threshold** — **LOCKED: percentage of `line_subtotal_minor`, per-line scope** (2026-05-14). Units and scope are normative; the specific numeric value is a tenant-configurable parameter owned by the future payment / checkout feature's discount-catalogue. Reflected in FR-023 and §Key Entities (DiscountPlaceholder). Note for `/speckit-plan`: confirm DiscountPlaceholder storage schema reflects per-line scoping.

3. **Q3 — Cart-stale-while-signed-out policy** — **LOCKED: option (a) discard immediately on session end** (2026-05-14). Reflected in FR-007, §Edge Cases, A9. Note for `/speckit-plan`: `plan.md` R3 ("preserved + re-opens for same operator") conflicts with this decision and MUST be reconciled to option (a).

4. **Q4 — Line-item merge rule on duplicate add** — **LOCKED: merge by `item_ref` (option (a)) is the default; "force separate line" deferred to a future catalogue/UI feature** (2026-05-14). Reflected in FR-014, US1-AS6, §Edge Cases. Note for `/speckit-plan`: `plan.md` R1 ("append separate line") conflicts with this decision and MUST be reconciled to merge-default.

5. **Q5 — Offline-cart audit event** — **LOCKED: separate event `cart.discarded_on_session_end`** (2026-05-14). Fourth addition to 004's §A3 audit catalogue alongside the three in FR-026. Fires when Q3 policy (a) discards a draft on session end; queued in the local outbox when offline. Reflected in FR-026, FR-007, §Key Entities (AuditEvent), and SC-005.

---

> ✅ **§A0 CLEARED — `/speckit-clarify` complete 2026-05-14.**
>
> **End of specification.** This spec is **DRAFT — §A0 CLEARED**. Q1–Q5 resolved. **`/speckit-plan` is the next step.**
