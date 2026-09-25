# §A4 — P8 Bridge-Security Review: `cart.snapshot` (V5 active cart read)

| Field | Value |
| :--- | :--- |
| Feature | 023 POS UI clean room — V5 active cart read slice |
| Gate | §A4, P8 Electron security boundary (one additive preload-bridge method) |
| Bridge surface | `cart.snapshot` on channel `cart:snapshot`, one read method added to the existing 005-owned `cart.*` namespace |
| Review type | Post-implementation walk, then an independent adversarial review (2026-09-25, verdict REVISE), with every finding addressed on `fix/cart-payment-authority` |
| Base | Merged in #464 (`b59641f`); hardened on `fix/cart-payment-authority` |
| Prepared by | implementing agent (Claude Code), 2026-09-24; revised 2026-09-26. **Owner/reviewer sign-off still required.** |
| Verdict | **Controls observed in code and covered by tests; awaiting reviewer sign-off.** No new identity input, no write path, no secret material. A paid cart never comes back payable. |

## Why the channel exists

The legacy `CartPane` keeps its line projection in component state, and the renderer store holds only the cart id and state. When a cart started on `/app/cart` is reopened on the V5 Sale screen, nothing can rebuild its lines. `production-integration-plan.md` had said "do not add an IPC method in this migration" and treated the gap as a cutover blocker. This slice is the explicit owner authorisation for that one read contract.

## Required controls

| # | Control | Evidence |
| :-- | :-- | :-- |
| 1 | Session gate first | `CartBridgeHandlers.snapshot` calls `requireOperatorSession({ session, allowedRoles })` before any store access (`src/main/cart/cart-bridge.ts`, `snapshot`). Test: *refuses generically with no operator session* (`tests/unit/main/cart/cart-snapshot.test.ts`). |
| 2 | No renderer-supplied identity; bounded id | `asSnapshotReq` builds a new object holding only `cart_id`, which must match `^[A-Za-z0-9_-]{1,128}$` (`src/main/ipc/cart.ts`). Tests: *forwards only cart_id, dropping any renderer-supplied identity*; oversized, whitespace, path and markup ids refused without reaching the handler (`tests/unit/main/ipc/cart-ipc-id-bounds.test.ts`). |
| 3 | Ownership and tenant isolation | The same `requireOperatorSession({ cart })` gate as every cart handler. A cashier can read only their own session's cart; a manager or admin only within the same tenant and branch. Tests: wrong owner → `wrong_owner`; other branch → `tenant_isolation`; unknown id → `wrong_owner`. |
| 4 | Generic refusals | Malformed input collapses to `no_session` without echoing fields. Reasons come from the existing closed `CartRefusalReason` set. The renderer maps every refusal to one generic message. |
| 5 | Read-only | Only `getCart`, `getActiveLines`, `getDiscountPlaceholdersForCart` and the read-only payment-status SELECT are called. No outbox row, no audit event, no write. Test: the sql.js DB export is byte-identical before and after two reads. |
| 6 | Top-level projection is display-safe | `lines` (`line_id, display_name, quantity, unit_price_minor, line_subtotal_minor, note, version`) and `discount_placeholders` (`placeholder_id, line_id`) exclude `item_ref`, attribution and action ids. Test: exact key sets plus a wire scan (editing cart). |
| 7 | Envelope exposure, stated exactly | For an **unpaid** `frozen_handed_off` cart, `envelope` is the object `cart.handoff` already returned to this renderer. It carries `lines[].item_ref`, `lines[].last_action_id`, `handoff_action_id`, `owning_operator_id`, `operator_session_id`, and the tenant, branch and terminal ids. **Manager attribution (`discount_placeholders[].attribution_operator_id`) is removed** (FR-021), both here and in the `cart.handoff` response; the persisted envelope keeps it for audit and finalize. No data class reaches the renderer that `cart.handoff` did not already deliver. Tests: frozen-cart wire scan with a manager-attributed discount, handoff response scan, and a check that the persisted envelope keeps the attribution (`tests/unit/main/cart/cart-snapshot-payment-aware.test.ts`). **Owner decision:** accept the remaining envelope fields as listed. |
| 8 | A paid cart never comes back payable | A settled cart stays `frozen_handed_off`, so `snapshot` reads the payments record. `settled` returns `paid: true` and `envelope: null`, and V5 then shows the sale as paid (New sale; no Continue to payment, no Void). `started`/`force_failed`/`none` keep the envelope so an unpaid sale can continue. Without the payment-status dependency a frozen cart is refused `not_implemented` (fail closed); the production factory requires it. Tests: `cart-snapshot-payment-aware.test.ts`; V5 *reopening a sale main reports as paid* (`src/renderer/v5/__tests__/live-sale-post-handoff-cancel.test.tsx`). |
| 9 | Corrupt envelope | The persisted envelope is parsed defensively; an unreadable row refuses `not_implemented` and never surfaces parser text (which could quote note PII). Test: *refuses generically, without throwing, when the persisted envelope is corrupt*. |
| 10 | No secrets | No Clerk JWT, device token, attestation, PIN or credential is touched. Notes are free text but are never logged: the handler logs only `cart_id`. |
| 11 | Sender-origin guard | `registerCartHandlers` is registered on `guardedIpcMain` (`src/main/index.ts:409` builds it; `:666` registers the cart channels), so `cart:snapshot` inherits the #414 sender-origin guard. |
| 12 | Typed on both ends | `CartSnapshotRequest` and `CartSnapshotResponse` (with `paid`) live in `src/shared/cart/bridge-types.ts`, shared by the preload, the IPC registrar and the handler. The type comment now states the envelope exception. |

## Residuals

- `snapshot` is optional on the `CartBridgeAPI` **type**, following the `payments?` / `sales?` / `receipts?` precedent. The production preload always wires it, and the only caller treats its absence as a generic failure.
- Refusal reasons follow every existing cart handler: an unknown id and a foreign-session id both return `wrong_owner`, and a cross-branch id returns `tenant_isolation`. That distinguishes "exists in another branch" from "unknown", but cart ids are random UUIDs, so it is not a practical enumeration oracle. The renderer shows one generic message for all of them.
- A further minimisation — a renderer-specific envelope type without session scope ids, `item_ref` and action ids, for both `cart.handoff` and `cart.snapshot` — is a follow-up. It changes the payment store and checkout types.
- There is no channel-level test that the cart channels are registered only on `guardedIpcMain`; the wiring is a single call in `index.ts`.
- Renderer-restart cart discovery (no known `cart_id`) is out of scope, and this channel cannot perform it.
