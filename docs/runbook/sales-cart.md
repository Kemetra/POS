# Sales Cart — Runbook

> Support reference for cancellation and attribution troubleshooting.
> Spec: `specs/005-sales-cart`. Security contract: S0 contact sheet.

---

## Cart cancellation (void)

### Pre-handoff void (cashier or manager)

**Trigger:** Operator clicks "Void" in the cart header while the cart is in `editing` state.

**Normal flow:**
1. VoidConfirmation dialog opens with generic copy.
2. Operator confirms → `cart.void` IPC call → bridge transitions cart to `cancelled`.
3. CartPane updates local state; active cart is cleared.

**Refused — `frozen` reason:**
- Cart is in `frozen_handed_off` state and the calling session is a cashier.
- Resolution: A manager must perform the post-handoff cancel (`cart.cancelPostHandoff`, T068).
- Do NOT expose manager identity to the cashier UI.

**Refused — `closed` reason:**
- Cart is already `cancelled` or in a terminal state.
- Resolution: Cart is already closed. No action needed.

---

### Post-handoff cancel (manager only)

**Trigger:** Cart has been handed off to the payment terminal and must be recalled.

**Requirement:** Manager or admin session. The renderer bridge (`cart:cancelPostHandoff`) forwards
only `cart_id`, `handoff_action_id` and `idempotency_key`; `attribution_operator_id` is dropped at
the IPC boundary, so a cashier session cannot borrow manager authority from the renderer.

**Normal flow:**
1. Manager confirms Void on the frozen cart. The shared Sale cart controller (legacy `/app/cart`
   and V5) calls `cart.cancelPostHandoff` with the frozen envelope's `handoff_action_id`. It never
   calls `cart.void` on a frozen cart and never falls back to it.
2. Bridge verifies the session, cart ownership, `frozen_handed_off` state, and that the cart has
   no `started` or `settled` payment attempt.
3. Cart transitions to `cancelled`; audit event `cart.cancel.post_handoff` emitted.

**Refused — `manager_attribution_required`:**
- Caller is a cashier session. The renderer never offers post-handoff Void to a cashier.

**Refused — `closed`:**
- The cart is no longer `frozen_handed_off`, or a payment for it is in progress (`started`) or
  complete (`settled`). A paid sale is never cancelled through this path.
- Resolution: The cart stays frozen and the confirmation stays open with generic copy. Complete
  or cancel the payment first, or refetch cart state if it changed.

---

## Discount placeholder attribution

### Adding a discount placeholder

**Trigger:** Cashier attempts to add a discount above the threshold.

**Normal flow (no attribution required):**
1. `cart.discountPlaceholders.add` returns `{ kind: 'ok', requires_manager_attribution: false }`.
2. DiscountPlaceholderRow is rendered with "Discount applied" label (no magnitude).

**Requires manager attribution:**
1. Bridge returns `{ kind: 'ok', requires_manager_attribution: true }`.
2. CartStore transitions to `discount_pending_attribution`.
3. ManagerAttributionPrompt opens — cashier enters Manager ID (no manager name displayed).
4. Retry `discountPlaceholders.add` with `attribution_operator_id`.

**Refused — `manager_attribution_required`:**
- Attribution was missing or provided by the same-role operator.
- Resolution: Re-open ManagerAttributionPrompt with a valid manager ID.

### Removing a discount placeholder

**Normal flow:** `discountPlaceholders.remove` succeeds, row is removed from CartPane.

**Refused — `manager_attribution_required`:**
- The placeholder was originally added with manager attribution; removal also requires it.
- Resolution: ManagerAttributionPrompt → retry with `attribution_operator_id`.

---

## Session-end cart discard

**Trigger:** Operator session ends (sign-out, inactivity timeout, or session takeover).

**Policy (Q3a — LOCKED 2026-05-14):**
- Draft carts (`empty` or `editing`) are discarded automatically → state `cancelled`.
- `frozen_handed_off` carts are NOT discarded on session end (payment flow in progress).

**Audit:** `cart.discarded_on_session_end` event emitted with `discard_cause`.

**Discard causes:**
- `signed_out` — operator signed out normally.
- `inactivity_timeout` — session expired due to inactivity.
- `superseded_by_takeover` — another operator took over the terminal.

---

## Cart handoff to payment (T086)

### Normal handoff flow

**Trigger:** Cashier clicks "Hand off to payment terminal" while cart is in `editing` state.

**Preconditions:**
- Active operator session (cashier, manager, or admin).
- At least one non-removed line in the cart.
- All `per_line_versions` match current line versions (staleness guard).

**Normal flow:**
1. `cart.handoff` IPC call received by bridge.
2. Session gate + ownership check passes.
3. Per-line version staleness check passes.
4. `buildPaymentIntentEnvelope` computes `subtotal_minor` from active lines and freezes the envelope.
5. Atomic SQLite transaction: outbox row (`cart.handoff_to_payment`), `carts` row updated to `frozen_handed_off` + `handoff_envelope_json`, audit event emitted.
6. Frozen `PaymentIntentEnvelope v1` returned to renderer.
7. Renderer displays handoff confirmation — does NOT claim payment succeeded.

---

### Handoff failure paths

**Refused — `no_session`:**
- No active operator session.
- Resolution: Operator must sign in before initiating handoff.

**Refused — `wrong_owner`:**
- Cart does not exist or belongs to a different session/tenant.
- Resolution: Verify `cart_id` is correct for the current session.

**Refused — `empty_cart`:**
- Cart has no non-removed lines at handoff time.
- Cause: All lines were removed before handoff, or cart was never populated.
- Resolution: Add at least one item before handing off.

**Refused — `stale_version`:**
- A `per_line_versions` entry does not match the current line version in the DB.
- Cause: A concurrent modification (add/update/remove) occurred between the UI snapshot and the handoff call.
- Resolution: Renderer must refetch cart state and retry with fresh versions.

**Refused — `frozen`:**
- Cart is in `frozen_handed_off` or `handing_off` state.
- Cause: Handoff already in progress or complete; or defence-in-depth `handing_off` guard fired.
- Resolution: Do not retry handoff. If payment must be cancelled, use `cart.cancelPostHandoff`.

**Refused — `closed`:**
- Cart is `cancelled`.
- Resolution: Cart is already closed; no handoff possible.

**Refused — `idempotency_payload_mismatch`:**
- The `idempotency_key` was previously used for a different action kind.
- Cause: Key reuse across unrelated operations.
- Resolution: Generate a fresh UUID v4 for each distinct handoff attempt.

---

### Idempotency replay

If the same `idempotency_key` is submitted after a successful handoff, the bridge returns the
original frozen `PaymentIntentEnvelope v1` read from `carts.handoff_envelope_json` — no second
write occurs. This ensures at-most-once semantics even if the renderer retries after a crash.

---

### Envelope security invariants

- The envelope contains **no** session credentials, PINs, PIN hashes, passwords, device tokens,
  or raw sensitive payloads.
- The envelope must **not** include `payment_status`, `paid_at`, `tender_amount`,
  `change_amount`, or `payment_confirmed` — these belong to the future payments feature.
- `subtotal_minor` is recomputed fresh from active lines; it is **not** read from the
  `carts.cart_subtotal_minor` running total (avoids race conditions).
- `Number.isSafeInteger` is asserted on `subtotal_minor` before the envelope is constructed.
- The returned envelope is `Object.freeze`d recursively (envelope, lines array, each line,
  discount_placeholders array, each placeholder).

---

## Security reminders

- Never display shift totals, expected drawer cash, overages, or shortages on any cart surface.
- Manager identity must not be shown to cashier at any point (FR-033 generic copy mandate).
- Discount magnitudes must not appear in the cart UI (no numeric values on DiscountPlaceholderRow).
- No cart IDs, session IDs, or UUIDs should appear in user-facing copy.

---

## Cashier reports cart vanished after restart

**Symptom:** A cashier signs back in after the terminal restarted (planned or unplanned)
and the draft cart they were building is no longer visible in the cart pane.

**Audience:** Maintainer / support engineer triaging from local diagnostics. Do NOT relay the
cause categories below directly to the cashier — operator-facing copy stays generic.

### Generic causes to consider

1. **App was force-killed before the bridge confirmed the last line.** The cart pane only
   renders lines after the bridge confirms persistence (no optimistic add). If the process was
   killed mid-write, the in-progress line never reached `cart_lines`; the outbox row for the
   pending action may or may not be present depending on when the kill occurred.
2. **Operator session ended (sign-out, lock, inactivity timeout, takeover).** Per Q3 (LOCKED
   2026-05-14), draft carts (`empty` / `editing`) are discarded at session end and an
   audit row `cart.discarded_on_session_end` is written with `discard_cause` set to
   `signed_out`, `inactivity_timeout`, or `superseded_by_takeover`. The cart will not return
   when the same cashier signs back in.
3. **Tenant or branch mismatch.** The operator signed back in under a different tenant or
   branch than the one that owned the cart. Cart isolation (FR-002) refuses access from any
   other tenant/branch pairing; from the cashier's view the cart appears to have vanished.
4. **Cart was voided pre-handoff.** The cart's state is `cancelled` with
   `cancellation_reason = 'cashier_voided'` (no audit event — non-sensitive lifecycle event
   per FR-031). Closed carts do not reappear in the editing surface.
5. **Cart was handed off and is now frozen.** State is `frozen_handed_off`. Frozen carts do
   NOT appear in the editing view; they appear in the read-only handoff summary surface
   only. The cashier may have missed the confirmation banner before the restart.

### Outbox inspection steps (maintainer-only)

Use this procedure only on the user's local machine with their consent; never copy raw
outbox rows or audit payloads off the device.

1. Locate the user's local SQLite store using the 001 storage convention (per-user data dir);
   do NOT hardcode or share the path.
2. Query `cart_action_outbox` filtered by the suspected `operator_session_id` and `cart_id`,
   ordered by `created_at`. Note the latest `action_kind` and whether a corresponding row
   exists in `carts`. Use placeholders in any working notes — refer to identifiers as
   `<cart-id>`, `<session-id>`, `<operator-id>`.
3. Cross-reference `audit_events` for terminal action categories on the same `<cart-id>`:
   `cart.cancel.post_handoff`, `cart.handoff_to_payment`, or `cart.discarded_on_session_end`.
   The presence of one of these confirms category (2), (4), or (5) above.
4. If no terminal audit row exists and the cart is absent from `carts`, suspect category (1)
   (force-kill before commit). The outbox row, if present, is sufficient to characterise the
   state without replaying any action.
5. Do NOT print, screenshot, or paste `payload_json` contents into tickets, support
   bundles, or chat. Summarise the row by `action_kind` and timestamps only.

### Resolution

- Categories (2), (4), (5): no action — the cart is correctly closed or frozen. Confirm to
  the cashier with generic copy ("the previous cart has been closed; please start a new
  cart").
- Category (3): verify the cashier signed back in under the same tenant + branch.
- Category (1): start a new cart. Do NOT attempt to replay outbox entries by hand — the
  outbox is owned by the bridge and any manual mutation risks the FSM invariants.

---

## Cart frozen but payments feature unavailable

**Symptom:** A cart is in `frozen_handed_off` state, but the downstream payments feature is
disabled, rolled back, or not yet rolled out on this terminal. The cashier sees the
"Cart sent to payment" banner but cannot complete the transaction.

**Audience:** Maintainer / support engineer. 005 owns cart handoff; the payments feature is
a separate downstream surface that may roll out (or roll back) independently.

### Rollback coupling

- A `frozen_handed_off` cart stays frozen regardless of payments-feature availability. The
  FR-035 freeze rule explicitly forbids cart-layer mutation after the envelope is emitted;
  the rule is unconditional and does not loosen when payments are unavailable.
- The persisted envelope on `carts.handoff_envelope_json` remains readable and consistent.
  Restart does not "unfreeze" the cart.

### Resolution paths (in order of preference)

1. **Wait for the payments feature to be re-enabled or shipped.** When payments returns, the
   existing frozen envelope is still consumable; the cart can be completed normally. This is
   the only path that preserves the original sale.
2. **Manager-attributed void of the frozen cart.** A manager invokes `cart.cancelPostHandoff`
   with their attribution; the cart transitions to `cancelled` with
   `cancellation_reason = 'manager_voided_post_handoff'` and a `cart.cancel.post_handoff`
   audit event is emitted. A new draft cart is then needed to retry the sale (A8: handoff is
   one-way; a cancel does not unfreeze the original).

### What NOT to do

- Do NOT force-mutate `carts.state` or `carts.handoff_envelope_json` directly. The FSM
  invariants and the envelope freeze (FR-035, A8) are load-bearing for audit and idempotency.
- Do NOT expose envelope contents, audit payloads, manager identity, or refusal-code
  identifiers to the cashier. Operator-facing copy stays generic per FR-033.
- Do NOT re-issue handoff for the same cart — the bridge refuses with `frozen` and the
  refusal is correct.

