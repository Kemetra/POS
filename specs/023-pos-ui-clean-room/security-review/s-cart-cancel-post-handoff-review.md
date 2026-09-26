# §A4 — P8 Bridge-Security Review: `cart.cancelPostHandoff` (post-handoff cancel)

| Field | Value |
| :--- | :--- |
| Feature | 023 POS UI clean room, Slice G readiness: post-handoff void/cancel defect |
| Gate | §A4, P8 Electron security boundary (one additive preload-bridge method) |
| Bridge surface | `cart.cancelPostHandoff` on channel `cart:cancelPostHandoff`, one mutating method added to the existing 005-owned `cart.*` namespace |
| Review type | Post-implementation walk, then an independent adversarial review (2026-09-25, verdict REVISE), with every finding addressed on `fix/cart-payment-authority` |
| Base | Merged in #469 (`e4f1721`); hardened on `fix/cart-payment-authority` |
| Prepared by | implementing agent (Claude Code), 2026-09-25; revised 2026-09-26. **Sign-off (2026-09-26): accepted under owner delegation.** The owner delegated this decision to the implementing agent ("handle it you are the captain"); it did not personally review the record. Accepted on the basis of the independent re-review (APPROVE-WITH-NOTES, no CRITICAL/HIGH) and the #472 fixes for both MEDIUM findings. The owner may revoke this. |
| Verdict | **Controls observed in code and covered by tests; accepted under owner delegation (2026-09-26).** Main is the authority for every claim below, including the money-side ones. |

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
| 10 | A cancelled cart cannot be paid or finalized — enforced in main | `payments.start` now calls `bindCartPaymentEligibility` (`src/main/payments/cart-payment-eligibility.ts`) before any write. It refuses `cart_lost` unless the cart is `frozen_handed_off` in the session's tenant and branch, `stale_handoff` unless the request matches the persisted envelope (handoff action and subtotal), and `attempt_terminal` if the cart already has a settled payment or a force-failed attempt that still holds live tender (re-review MEDIUM-1). The check is required and runs synchronously right before the FSM start. `buildFinalizeInput` refuses a cart that is not `frozen_handed_off`. The renderer also drops the envelope after a confirmed cancel, but that is UX only. Tests: `tests/unit/main/payments/cart-payment-eligibility.test.ts`, `bridge.payments-start.cart-eligibility.test.ts`, `tests/unit/main/sales/finalize-dispatch.test.ts` (*a cancelled cart is never finalized*). |
| 11 | Generic refusals | Malformed input collapses to `no_session` without echoing fields. There are no new refusal reasons in either enum, and the renderer never names a reason. |
| 12 | Audit unchanged | Still the same `cart.cancel.post_handoff` audit event, now carrying a verified `handoff_action_id`, emitted atomically with the outbox row. |
| 13 | No secrets | No Clerk JWT, device token, attestation or PIN is touched. Nothing new is logged. `handoff_action_id` is already held by the renderer inside the frozen envelope. |
| 14 | Sender-origin guard | Registered through `registerCartHandlers` on `guardedIpcMain` (`src/main/index.ts:409`, `:666`), so the channel inherits the #414 sender-origin guard. |
| 15 | Typed on both ends | `CartCancelPostHandoffRequest` and `CartCancelPostHandoffResponse` live in `src/shared/cart/bridge-types.ts`, shared by the preload, the IPC registrar and the controller. |

## Independent re-review (2026-09-26)

An independent adversarial reviewer (not the implementer) re-read this record and the #469/#470 diffs against the code, and ran 130 relevant tests (all passing). **Verdict: APPROVE-WITH-NOTES.** Every numbered control above was verified in code. No CRITICAL or HIGH finding.

Findings and disposition (`fix/payment-money-guards`):

| Finding | Disposition |
| --- | --- |
| MEDIUM-1 — a `force_failed` cart could be paid again. Force-fail changes only the attempt state and does not reverse tender, so a second attempt could charge twice. | **Fixed.** `bindCartPaymentEligibility` refuses `attempt_terminal` when the cart has a `force_failed` attempt that still holds live tender (`applying`, `applied` or `reversal_pending`; `bindCartHasForceFailedLiveTender`). A force-failed attempt with no live tender moved no money and does not block. Tests: `tests/unit/main/payments/cart-payment-eligibility.test.ts` (real sql.js DB, production migrations). |
| MEDIUM-2 — the stale-attempt discard in `payments.start` cancelled another cart's `started` attempt and recorded its tender as reversed, with nothing confirming the money was handed back. | **Fixed.** The discard now runs only for an orphan with no live tender (`bindAttemptHasLiveTender`). Otherwise `payments.start` refuses `attempt_already_started_on_terminal` and writes nothing. Tests: `payments-start.stale-attempt.test.ts`, `tests/unit/main/payments/attempt-live-tender.test.ts` (real DB). |
| LOW-1 — `payments.start` IPC ids were only type-checked. | **Fixed.** `envelope_handoff_action_id`, `envelope_cart_id` and `idempotency_key` must match `^[A-Za-z0-9_-]{1,128}$`, as on the cart channels. Test: `tests/unit/main/ipc/payments.test.ts`. |
| LOW-2 — eligibility does not bind the cart's owning session or terminal. | Residual (below). |
| LOW-3 — `cart.void` replays a reused key from another cart as `ok`. | Residual (below). No money moves. |
| LOW-4 — `discount*` and `void` still forward a renderer-supplied `attribution_operator_id`. | Residual (below). |
| LOW-5 — the handoff replay path parses the persisted envelope without a guard. | Residual (below). |
| Test note — the `payments.start` handler test mocks eligibility; no single test runs a cancelled cart through the real eligibility check and the real FSM. | Residual (below). The eligibility check itself is tested against a real DB. |

## Residuals

- `cancelPostHandoff` is optional on the `CartBridgeAPI` **type** (the `snapshot?` precedent). The production preload always wires it, and the only caller fails closed when it is absent. It never falls back to `cart.void`.
- The main handler still accepts `attribution_operator_id` from a caller and trusts it without a credential check. No bridge can supply it today (the IPC drops it); any future channel that forwards it must add a manager credential check first.
- A manager may cancel another operator's handed-off cart within the same branch. That is the existing cart-gate rule for every handler, recorded here as a deliberate policy.
- A cart with a `force_failed` attempt cannot be cancelled through this path. Resolving a force-failed sale (refund or reversal) is a payments workflow outside this channel.
- If main cancels but the IPC reply is lost, the renderer keeps showing the frozen cart; a retry with a fresh key is refused `closed`. This fails safe; the next snapshot shows the true state.
- There is no channel-level test that the cart channels are registered only on `guardedIpcMain`; the wiring is a single call in `index.ts`.
- Payment eligibility checks tenant, branch, handoff action and subtotal, but not the cart's owning session or terminal (re-review LOW-2). Paying another operator's handed-off cart on the same terminal needs its `handoff_action_id` and subtotal.
- `cart.void` still replays a reused idempotency key from another cart as `ok` with no state change (re-review LOW-3; the flaw fixed here for `cancelPostHandoff`). It moves no money.
- `discount*` and `void` still forward a renderer-supplied `attribution_operator_id` (re-review LOW-4), so the "cashier borrows manager authority" residual above applies to those channels today, not only to future ones.
- The `cart.handoff` replay path parses the persisted envelope without a guard (re-review LOW-5); a corrupt row throws instead of refusing.
- No single test runs a cancelled cart through the real eligibility check and the real payment FSM together; each half is tested on its own.
