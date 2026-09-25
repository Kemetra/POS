# §A4 — P8 Bridge-Security Review: `cart.cancelPostHandoff` (post-handoff cancel)

| Field | Value |
| :--- | :--- |
| Feature | 023 POS UI clean room, Slice G readiness: post-handoff void/cancel defect |
| Gate | §A4, P8 Electron security boundary (one additive preload-bridge method) |
| Bridge surface | `cart.cancelPostHandoff` on channel `cart:cancelPostHandoff`, one mutating method added to the existing 005-owned `cart.*` namespace |
| Review type | Post-implementation walk, then an independent adversarial review (2026-09-25, verdict REVISE), with every finding addressed on `fix/cart-payment-authority` |
| Base | Merged in #469 (`e4f1721`); hardened on `fix/cart-payment-authority` |
| Prepared by | implementing agent (Claude Code), 2026-09-25; revised 2026-09-26. **Owner/reviewer sign-off still required.** |
| Verdict | **Controls observed in code and covered by tests; awaiting reviewer sign-off.** Main is the authority for every claim below, including the money-side ones. |

## Why the channel exists

Managers were offered Void on a handed-off cart in both legacy `/app/cart` and V5. The shared controller called `cart.void`, which main correctly refuses with `frozen`. The canonical main operation, `CartBridge.cancelPostHandoff` (spec 005 FR-033), already existed, but nothing exposed it to the renderer. #469 exposed it; this revision closes the review's findings.

## Required controls

| # | Control | Evidence |
| :-- | :-- | :-- |
| 1 | Session gate first | `cancelPostHandoff` refuses `no_session` before anything else, then loads the cart and runs `requireOperatorSession({ session, allowedRoles, cart })` before any write (`src/main/cart/cart-bridge.ts`). The cart row is read before the ownership gate, as in every cart handler. |
| 2 | No renderer identity or attribution; bounded ids | `asCancelPostHandoffReq` builds a fresh object with only `cart_id`, `handoff_action_id` and `idempotency_key`, each matching `^[A-Za-z0-9_-]{1,128}$` (`src/main/ipc/cart.ts`). `attribution_operator_id`, tenant and session fields are dropped; a `__proto__` key is inert. Tests: `tests/unit/main/ipc/cart-cancel-post-handoff-ipc.test.ts`, `tests/unit/main/ipc/cart-ipc-id-bounds.test.ts`. |
| 3 | Cashier cannot gain manager authority | With attribution dropped at the IPC, a cashier always reaches main without it and is refused `manager_attribution_required`. Test: *refuses a cashier without attribution* (`tests/unit/main/cart/cart-cancel-post-handoff-payment-guard.test.ts`). |
| 4 | Ownership and tenant isolation | Tested for this handler: another branch and another tenant → `tenant_isolation`; another session's cashier and an unknown id → `wrong_owner`; each with no state, outbox or audit change (`tests/unit/main/cart/cart-cancel-post-handoff-hardening.test.ts`). |
| 5 | Handoff action verified | The renderer-supplied `handoff_action_id` must equal the cart's persisted handoff (`findLatestHandoffActionId`), otherwise `stale_version` and nothing is written. The audit record can no longer be mislabelled. Test: *refuses stale_version when the handoff action id does not match*. |
| 6 | Replay bound to cart and handoff | An idempotency replay returns `ok` only for the same `cart_id` and the recorded `handoff_action_id`; otherwise `idempotency_payload_mismatch`. A key reused for another cart can no longer report a cancel that did not happen. Tests: *refuses a key replayed against a different cart*; *refuses a replay whose handoff action differs*. |
| 7 | Paid, paying or force-failed sales cannot be cancelled | The payment status comes from `bindCartPaymentStatus` (`payment-attempts.repository.ts`). Anything other than `none` (`started`, `settled`, `force_failed`) refuses `closed`. `force_failed` blocks because tender may already have been taken; a manager resolves it first. Cancelled and failed attempts are history and do not block. Tests use the **real** repository and real rows (`cart-cancel-post-handoff-hardening.test.ts`, `payment-attempts.cart-status.test.ts`). |
| 8 | Fails closed without the payments record | If no payment-status source is wired, the handler refuses `not_implemented` and writes nothing. The production factory (`createCartBridgeHandlers`) requires the dependency. Test: *refuses not_implemented, writing nothing, when no payment-status source is wired*. |
| 9 | Check and cancel are one transaction | `cancelFrozenCartAndOutbox` re-reads the cart state and the payment status, writes the outbox row, then updates `WHERE cart_id = ? AND state = 'frozen_handed_off'`, all inside one `db.transaction`. If `changes !== 1` the whole transaction rolls back. The audit emit runs inside the same transaction. Test: *writes nothing when the cart stops being frozen before the update lands*. |
| 10 | A cancelled cart cannot be paid or finalized — enforced in main | `payments.start` now calls `bindCartPaymentEligibility` (`src/main/payments/cart-payment-eligibility.ts`) before any write. It refuses `cart_lost` unless the cart is `frozen_handed_off` in the session's tenant and branch, `stale_handoff` unless the request matches the persisted envelope (handoff action and subtotal), and `attempt_terminal` if the cart already has a settled payment. The check is required and runs synchronously right before the FSM start. `buildFinalizeInput` refuses a cart that is not `frozen_handed_off`. The renderer also drops the envelope after a confirmed cancel, but that is UX only. Tests: `tests/unit/main/payments/cart-payment-eligibility.test.ts`, `bridge.payments-start.cart-eligibility.test.ts`, `tests/unit/main/sales/finalize-dispatch.test.ts` (*a cancelled cart is never finalized*). |
| 11 | Generic refusals | Malformed input collapses to `no_session` without echoing fields. There are no new refusal reasons in either enum, and the renderer never names a reason. |
| 12 | Audit unchanged | Still the same `cart.cancel.post_handoff` audit event, now carrying a verified `handoff_action_id`, emitted atomically with the outbox row. |
| 13 | No secrets | No Clerk JWT, device token, attestation or PIN is touched. Nothing new is logged. `handoff_action_id` is already held by the renderer inside the frozen envelope. |
| 14 | Sender-origin guard | Registered through `registerCartHandlers` on `guardedIpcMain` (`src/main/index.ts:409`, `:666`), so the channel inherits the #414 sender-origin guard. |
| 15 | Typed on both ends | `CartCancelPostHandoffRequest` and `CartCancelPostHandoffResponse` live in `src/shared/cart/bridge-types.ts`, shared by the preload, the IPC registrar and the controller. |

## Residuals

- `cancelPostHandoff` is optional on the `CartBridgeAPI` **type** (the `snapshot?` precedent). The production preload always wires it, and the only caller fails closed when it is absent. It never falls back to `cart.void`.
- The main handler still accepts `attribution_operator_id` from a caller and trusts it without a credential check. No bridge can supply it today (the IPC drops it); any future channel that forwards it must add a manager credential check first.
- A manager may cancel another operator's handed-off cart within the same branch. That is the existing cart-gate rule for every handler, recorded here as a deliberate policy.
- A cart with a `force_failed` attempt cannot be cancelled through this path. Resolving a force-failed sale (refund or reversal) is a payments workflow outside this channel.
- If main cancels but the IPC reply is lost, the renderer keeps showing the frozen cart; a retry with a fresh key is refused `closed`. This fails safe; the next snapshot shows the true state.
- There is no channel-level test that the cart channels are registered only on `guardedIpcMain`; the wiring is a single call in `index.ts`.
