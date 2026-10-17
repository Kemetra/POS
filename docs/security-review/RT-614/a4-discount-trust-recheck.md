<!--
RT-614 (RT-608 item 6, option B) — §A4 P8 bridge-security re-check for the
runtime trust check on manual-discount placeholders. Docs only.
-->

# §A4 re-check: manual-discount trust check (RT-614)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-614. POS runtime trust check for manual-discount placeholders at handoff and payment eligibility (RT-608 item 6, option B). |
| Parent record | [`docs/security-review/RT-608/a4-discount-approval-bridge-review.md`](../RT-608/a4-discount-approval-bridge-review.md). This note closes its **F-2**. |
| Gate | §A4, the P8 Electron security boundary. |
| Baseline | `origin/main` at `37b0f64` (PR #723, RT-608). |
| Prepared by | The implementation agent (Claude Code), 2026-10-17. **This is not an independent review.** It needs the owner's sign-off. |
| Verdict | **No new channel and no new request field. The only bridge-surface change is a new closed refusal value on two existing responses.** Agent-assessed PASS. |

## 2. What changed

Envelope steps 3a and 3b are in spec 005 (`contracts/handoff-envelope.md`) and FR-023.

- **Trust predicate** (new: `src/main/cart/discount-trust.ts`). A placeholder is trusted only if a `cart.discount.manager_authorized` row in `audit_events` matches it on all of these:
  - `payload.placeholder_id`;
  - `payload.cart_id`;
  - `payload.cart_line_id`;
  - `tenant_id`;
  - `branch_id`.

  RT-608's add writes that row in the add's own transaction, and `audit_events` is append-only (update and delete triggers). The predicate ignores `attribution_operator_id`, so a renderer-asserted approver proves nothing. The predicate runs in main only. No schema or migration change.
- **3a, handoff** (`cart-bridge.ts`, `handoff`, step 5a). If any placeholder on the cart is untrusted, handoff refuses with `unauthorized_discount`. It checks the same set the envelope builder snapshots. The check runs after the replay, mutability and stale-version checks and before the envelope is built. Nothing is written on a refusal: no outbox row, no envelope, no state change and no audit row. From the check to the commit the path is synchronous, so the placeholder set cannot change in between.
- **3b, payment eligibility** (`cart-payment-eligibility.ts`). The same predicate runs over the placeholder ids in the **persisted** envelope (`carts.handoff_envelope_json`), never over renderer input. The check runs after `stale_handoff`. Tenant and branch come from the cart row, which has already been checked against the trusted session. The check fails closed: a `discount_placeholders` field that is not an array, or an entry without string ids, is untrusted. An envelope without the field has no placeholders. Recovery for a refused frozen cart is the existing manager post-handoff cancel (FR-033).

## 3. Bridge surface walk

| Control | Check | Result |
| :-- | :-- | :-- |
| CH-1 No new channel | No change to `src/main/ipc/*`, `src/preload/*` or the `bridge-api.ts` channel list. | PASS |
| REQ-1 No new request field | No request type changed. The predicate reads only main-side state: the cart row, its placeholder rows, the persisted envelope and `audit_events`. | PASS |
| RSP-1 Closed refusal value | `CartRefusalReason` and the payments `REFUSAL_REASONS` both gain `unauthorized_discount`. It is a fixed string with no detail: it does not name the placeholder, the approver, or which binding failed. The contract already listed it for handoff (`contracts/bridge-api.md`, RT-28). | PASS |
| EXP-1 No approver identity exposed | The refusal carries only the reason, and the predicate output never crosses the bridge. RT-608's EXP-1 still holds: renderer envelopes null `attribution_operator_id`. | PASS |
| AUD-1 Audit read-only | The predicate only runs `SELECT` on `audit_events`. Append-only is unchanged. | PASS |
| SCOPE-1 Tenant isolation | The predicate is scoped by `tenant_id` and `branch_id`, and both come from the main-side cart row. An audit row from another tenant or branch does not count (tests). | PASS |

## 4. Tests (written first)

- `tests/unit/main/cart/cart-discount-trust.test.ts`
  - **Predicate:** trusted; no audit row; another `placeholder_id`; another cart; another line; another tenant; another branch; another audit category.
  - **Handoff, trusted:** an RT-608 manager-authorised placeholder hands off.
  - **Handoff, refused:** each of these refuses with `unauthorized_discount` and writes nothing:
    - a legacy placeholder with a null approver;
    - a legacy placeholder with an asserted approver;
    - a mismatched `placeholder_id`;
    - an authorisation that belongs to another cart;
    - a mixed cart (one trusted placeholder, one untrusted).
  - **Handoff after removal:** the same cart hands off once the untrusted placeholder is removed.
- `tests/unit/main/payments/cart-payment-eligibility.test.ts`, step 3b:
  - **Admitted:** a trusted placeholder; an envelope with no placeholders.
  - **Refused `unauthorized_discount`:**
    - no audit row (a pre-upgrade frozen envelope);
    - a mismatched `placeholder_id`;
    - an authorisation for another cart;
    - one untrusted placeholder among trusted ones;
    - a malformed field;
    - an entry without ids.
- Three existing fixtures seeded placeholders with a direct SQL insert. They now also seed the authorising audit row through the new helper `tests/unit/main/cart/__helpers__/manager-authorized-discount.ts`, or wire the real audit emitter. Those fixtures are `cart-snapshot-payment-aware`, `cart-handoff-coverage` and `cart-resume`. They test other behaviour, and under RT-614 their placeholders would correctly be untrusted.

## 5. Residuals

- **The audit row is the provenance marker.** A main-process path that wrote a placeholder without RT-608's add would also have to forge an append-only audit row. Main code does that nowhere: the only writers are RT-608's add and the park and resume removal, and removal deletes rows.
- **F-1** (`mode`) stays deferred to MA-3. **F-3** (the `remove` owner check) was closed separately by RT-615 (#728). Neither is touched here.
