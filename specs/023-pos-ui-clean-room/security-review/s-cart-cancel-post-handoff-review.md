# §A4 — P8 Bridge-Security Review: `cart.cancelPostHandoff` (post-handoff cancel)

| Field | Value |
| :--- | :--- |
| Feature | 023 POS UI clean room, Slice G readiness: post-handoff void/cancel defect |
| Gate | §A4, P8 Electron security boundary (one additive preload-bridge method) |
| Bridge surface | `cart.cancelPostHandoff` on channel `cart:cancelPostHandoff`, one mutating method added to the existing 005-owned `cart.*` namespace |
| Review type | Post-implementation walk: the handler exposure, IPC wiring, preload, main payment guard and tests are written and green |
| Base / branch | `main` @ `da0c67c` → `fix/v5-post-handoff-void` |
| Prepared by | implementing agent (Claude Code), 2026-09-25. **Owner/reviewer sign-off still required.** |
| Verdict | **Controls observed in code; awaiting reviewer sign-off.** No new identity input and no new data class. Main-process authority and the existing audited transaction are unchanged. |

## Why the channel exists

Managers were offered Void on a handed-off cart in both legacy `/app/cart` and V5. The shared controller called `cart.void`, which main correctly refuses with `frozen`. The canonical main operation, `CartBridge.cancelPostHandoff` (spec 005 FR-033), already existed, but nothing exposed it to the renderer. This slice exposes it and does not re-implement it.

## Required controls

| # | Control | Evidence |
| :-- | :-- | :-- |
| 1 | Session gate first | `cancelPostHandoff` still calls `getCurrentSession` and `requireOperatorSession({ session, allowedRoles, cart })` before any mutation (`src/main/cart/cart-bridge.ts`). This code is unchanged. |
| 2 | No renderer-supplied identity or attribution | `asCancelPostHandoffReq` builds a new object holding only non-empty `cart_id`, `handoff_action_id` and `idempotency_key` (`src/main/ipc/cart.ts`). `attribution_operator_id`, tenant and session fields are dropped. Test: *forwards only the three request fields, dropping attribution and identity*. |
| 3 | Cashier cannot gain manager authority | Because attribution is dropped, a cashier session always reaches main without it and is refused `manager_attribution_required`. Test (production factory): *refuses a cashier without attribution*. The UI also hides the action from cashiers, but that is presentation only. |
| 4 | Ownership and tenant isolation | The same `requireOperatorSession({ cart })` gate as every cart handler, unchanged. |
| 5 | Paid or paying sales cannot be cancelled | New, owner-approved. A cart stays `frozen_handed_off` after settlement. `bindCartPaymentGuard` (`payment-attempts.repository.ts`) is a read-only `SELECT` for a `started` or `settled` attempt, and `cancelPostHandoff` refuses `closed` when one exists. It is a required dependency on the production factory and wired in `src/main/index.ts`. Tests: the repository guard, and *refuses closed, and writes nothing, when the cart has a started or settled payment*. |
| 6 | Cancelled cart cannot reach checkout | After a confirmed cancel, the shared controller drops this cart's envelope, locally and in the payment store. `payments.start` does not re-read cart state. Test: *drops the mounted payment envelope for this cart once main confirms the cancel*. |
| 7 | Generic refusals | Malformed input collapses to `no_session` without echoing fields (11 payload cases). There are no new refusal reasons, and the renderer never names a reason. |
| 8 | Audit and atomicity unchanged | Still the same `cart.cancel.post_handoff` audit event, emitted atomically with the outbox row. Idempotent replay still succeeds after the cancel (test). |
| 9 | No secrets | No Clerk JWT, device token, attestation or PIN is touched. `handoff_action_id` is already held by the renderer inside the frozen envelope, so no new data class crosses the bridge. |
| 10 | Sender-origin guard | Registered through `registerCartHandlers` on `guardedIpcMain`, so the channel inherits the #414 sender-origin guard. |
| 11 | Typed on both ends | `CartCancelPostHandoffRequest` and `CartCancelPostHandoffResponse` live in `src/shared/cart/bridge-types.ts`, shared by the preload, the IPC registrar and the controller. |

## Residuals

- `cancelPostHandoff` is optional on the `CartBridgeAPI` **type** (the `snapshot?` precedent). The production preload always wires it, and the only caller fails closed when it is absent. It never falls back to `cart.void`.
- **Unverified `handoff_action_id`:** main records the renderer-supplied value in the audit payload but does not check it against the persisted envelope. It grants no authority, but it can mislabel the audit record. Follow-up; existing main tests use synthetic ids.
- **Abandoned payment attempts:** a handed-off cart with an abandoned `started` attempt cannot be cancelled until that attempt is cancelled (`payments.cancel` or the session-end discard).
- **Out of scope:** `payments.start` does not refuse a cart that already has a settled attempt. That belongs to the payments area and is a follow-up.
