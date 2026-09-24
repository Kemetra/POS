# §A4 — P8 Bridge-Security Review: `cart.snapshot` (V5 active cart read)

| Field | Value |
| :--- | :--- |
| Feature | 023 POS UI clean room — V5 active cart read slice |
| Gate | §A4, P8 Electron security boundary (one additive preload-bridge method) |
| Bridge surface | `cart.snapshot` on channel `cart:snapshot`, one read method added to the existing 005-owned `cart.*` namespace |
| Review type | Post-implementation walk: the handler, IPC wiring, preload and tests are written and green |
| Base / branch | `main` @ `b903d4d` → `feat/v5-active-cart-read` (uncommitted) |
| Prepared by | implementing agent (Claude Code), 2026-09-24. **Owner/reviewer sign-off still required.** |
| Verdict | **Controls observed in code; awaiting reviewer sign-off.** No new identity input, no write path, no secret material. |

## Why the channel exists

The legacy `CartPane` keeps its line projection in component state, and the renderer store holds only the cart id and state. When a cart started on `/app/cart` is reopened on the V5 Sale screen, nothing can rebuild its lines. `production-integration-plan.md` had said "do not add an IPC method in this migration" and treated the gap as a cutover blocker. This slice is the explicit owner authorisation for that one read contract.

## Required controls

| # | Control | Evidence |
| :-- | :-- | :-- |
| 1 | Session gate first | `CartBridgeHandlers.snapshot` calls `requireOperatorSession({ session, allowedRoles })` before any store access (`src/main/cart/cart-bridge.ts`, `snapshot`). Test: *refuses generically with no operator session*. |
| 2 | No renderer-supplied identity | `asSnapshotReq` builds a new object holding only `cart_id` (`src/main/ipc/cart.ts`). Tenant, branch, terminal and operator scope come only from the main-process session. Test: *forwards only cart_id, dropping any renderer-supplied identity*. |
| 3 | Ownership and tenant isolation | Uses the same `requireOperatorSession({ cart })` gate as every cart handler. A cashier can read only their own session's cart; a manager or admin only within the same tenant and branch. Tests: wrong owner → `wrong_owner`; other branch → `tenant_isolation`; unknown id → generic refusal. |
| 4 | Generic refusals | Malformed input collapses to `no_session` without echoing fields. Reasons come from the existing closed `CartRefusalReason` set; no new reason was added. The renderer maps every refusal to one generic message. |
| 5 | Read-only | Only `getCart`, `getActiveLines` and `getDiscountPlaceholdersForCart` are called, all existing SELECT helpers. No outbox row, no audit event, no write. Test: the sql.js DB export is byte-identical before and after two reads. Real Electron: the outbox count was unchanged (8 → 8) across the V5 mount. |
| 6 | Display-safe projection | Returns `cart_id`, `state`, lines (`line_id, display_name, quantity, unit_price_minor, line_subtotal_minor, note, version`), discount placeholder refs (`placeholder_id, line_id` only) and `envelope`. It excludes `item_ref`, attribution and action ids, and for every non-frozen cart it also excludes session, tenant and terminal ids. Test: exact key sets, plus a wire scan for identity strings (on an editing cart). |
| 7 | Envelope exposure | `envelope` is non-null only for `frozen_handed_off`: it is the persisted object `cart.handoff` already returned to this renderer, and it **does** carry tenant, branch, terminal, operator and session ids. No new data class crosses the bridge, but this is an **owner decision**. The alternative is to omit the envelope and show a recoverable frozen state. |
| 8 | No secrets | No Clerk JWT, device token, attestation, PIN or credential is touched. The bridge carries notes, which are free text, but they are never logged: the handler logs only `cart_id`. |
| 9 | Sender-origin guard | `registerCartHandlers` is registered on `guardedIpcMain` (`src/main/index.ts:660`), so `cart:snapshot` inherits the #414 sender-origin guard. |
| 10 | Typed on both ends | `CartSnapshotRequest` and `CartSnapshotResponse` live in `src/shared/cart/bridge-types.ts`, shared by the preload, the IPC registrar and the handler. |

## Residuals

- `snapshot` is optional on the `CartBridgeAPI` **type**, following the `payments?` / `sales?` / `receipts?` precedent, so that existing fake bridges in the legacy suites compile unchanged. The production preload always wires it, and the only caller treats its absence as a generic failure.
- Refusal reasons follow every existing cart handler: an unknown id and a foreign-session id both return `wrong_owner`, and a cross-tenant id returns `tenant_isolation`. Cart ids are random UUIDs, so this is not a practical enumeration oracle. The renderer shows one generic message for all of them.
- Renderer-restart cart discovery (no known `cart_id`) is out of scope, and this channel cannot perform it: it reads only a cart id the renderer already holds.
