<!--
RT-608 (RT-28, spec 005 FR-023 revised) — §A4 P8 bridge-security record for
the new `approval_id` field on `cart.discountPlaceholders.add` and the newly
live manager-approval kind `cart.discount.manual`. Pre-merge walk against the
PR branch, with code-line evidence. Docs only.
-->

# §A4 — P8 bridge-security review: `cart.discountPlaceholders.add` + `cart.discount.manual` (RT-608)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-608 — POS: enforce manager-only manual discounts on the RT-114 Manager Approval PIN (RT-28) |
| Gate | §A4 — P8 Electron security boundary |
| Bridge surface | **No new channel.** One new optional request field, `approval_id`, on the existing `cart:discountPlaceholders:add`. One newly live approval kind, `cart.discount.manual`, on the existing `approval:request` / `approval:listApprovers` channels (RT-443). |
| Contract | spec 005 `spec.md` Amendment and FR-023; `contracts/bridge-api.md` § `cart.discountPlaceholders.add`; RT-114 C2, C5–C7, C10 and §3 (all on `origin/main`, PR #717 `26c47be`). |
| Baseline | `origin/main` at `fbe0a2e` |
| Review type | Pre-merge walk of the RT-608 PR branch. |
| Prepared by | The implementation agent (Claude Code), 2026-10-17. **Not an independent review.** It needs the owner's sign-off. |
| Verdict | **Agent-assessed PASS on the bridge controls (14/14).** Four findings for the owner (§5). None is a bridge-boundary break. |

## 2. Code under review

| File | Role |
| :-- | :-- |
| `src/shared/cart/bridge-types.ts` | `CartDiscountPlaceholdersAddRequest` gains `approval_id?: string`. No approver or credential field. |
| `src/shared/cart/discount-approval.ts` | **New.** `discountApprovalSubjectRef` / `parse…`: the `subject_ref` for kind `cart.discount.manual` is `<cart_id>_<line_id>_<placeholder_kind>`. |
| `src/main/cart/discount-approval.ts` | **New.** The `cart.discount.manual` subject (shared by the resolver and the consumption) and the resolver. |
| `src/main/ipc/cart.ts` (`asDiscountAddReq`) | Builds a fresh request: the contract fields, plus `approval_id` only when it is a bounded id. Drops `attribution_operator_id` and any other key. |
| `src/preload/cart.ts` | Unchanged. Forwards the typed request with `ipcRenderer.invoke` on the constant channel. |
| `src/main/cart/cart-bridge.ts` (`discountPlaceholdersAdd`, `authorizedDiscountWrite`, `discountAuthority`, `isSameDiscountAddReplay`) | Authority: no threshold, replay first, manager / admin direct (D2), cashier consumes the approval inside the add's transaction. |
| `src/main/cart/cart-store.ts` (`insertDiscountPlaceholderAndOutbox`) | Now takes a `build` callback that runs inside the transaction, so the consumed approver names the placeholder row. |
| `src/main/operator/manager-approval-service.ts` | `consume` also returns the approval's `reasonCode` for the action's audit. No other change. |
| `src/shared/audit/event-shape.ts`, `payload-schemas.ts` | New category `cart.discount.manager_authorized`; `cart.discount.above_threshold` kept, marked historical. |
| `src/main/index.ts` | Wires the `cart.discount.manual` resolver into the one approval service. |

## 3. Subject binding (the decision the contract left to this review)

`contracts/bridge-api.md` says the mapping of the discount intent onto MA-2's `subject_ref`, version and amount "is fixed by the RT-28 Implementation issue under a §A4 bridge-security review". This is it:

| MA-2 field | `cart.discount.manual` value | Why |
| :-- | :-- | :-- |
| `subject_ref` | `<cart_id>_<line_id>_<placeholder_kind>` | The ref names the cart, the line and the kind. `consume` compares it exactly, so an approval for one line or kind cannot be spent on another. It fits MA-2's bridge pattern `[A-Za-z0-9_-]{1,128}`; a kind outside that alphabet, or longer than 54 characters with UUID ids, cannot be approved, so the add fails closed. |
| `subject_version` | `discount\|tenant\|branch\|cart\|line\|kind\|v<line.version>` | Computed by main from its own rows, never from the renderer. A quantity change, note, undo or anything else that moves the line's version makes the approval `approval_stale`. The scope and the parsed ids are in the version as well, so an ambiguous ref can never resolve one subject at request time and another at consumption. |
| `amount_minor` | `null` | Owner decision O1: intent only, no invented amount, until discount math exists. |
| Approvable when | The requesting session's own cart (`operator_session_id`), same tenant and branch, state `editing`, not parked, and a live line (`removed_at IS NULL`) on that cart. | Matches RT-608 item 1: null for any other session, a frozen cart or a missing line. |

## 4. Controls

| # | Control | Evidence | Result |
| :-- | :-- | :-- | :-- |
| P8-1 | **The renderer reaches main only through the typed bridge.** | No new channel and no preload change. `cart.discountPlaceholders.add` still only calls `ipcRenderer.invoke(CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_ADD, req)`. `BrowserWindow` flags are untouched. Test: `tests/unit/preload/cart.test.ts` "RT-608: forwards a cashier approval_id". | PASS |
| P8-2 | **Sender origin and session lock are checked.** | `registerCartHandlers(guardedIpcMain, …)` (`src/main/index.ts:1430`). `guardedIpcMain` wraps the sender guard, the session-lock guard (no `cart:` channel is in `LOCKED_ALLOWED_CHANNELS`), the recovery-mode guard (refuses `cart:`) and the sale boundary (`index.ts:761-771`). `approval:request` keeps RT-443's own lock check (`session_locked`). | PASS |
| INP-1 | **Closed request shape, validated in main.** | `asDiscountAddReq` builds a fresh object from the four contract fields and adds `approval_id` only when it matches `^[A-Za-z0-9_-]{1,128}$`; any other value refuses the whole request before the handler, with the cart parser's generic refusal (`no_session`, `refuseInvalid`). Test: `cart-discount-add-no-renderer-supervisor.test.ts` "RT-608: forwards a bounded approval_id and refuses a malformed one" (number, empty, spaces, 129 chars, object). | PASS |
| C10-1 | **No renderer-supplied approver identity is trusted.** | The parser drops `attribution_operator_id` (test "IPC parser drops attribution_operator_id"). The handler never reads it: the approver is the session (manager / admin) or the consumed approval's `approver_user_id` (`discountAuthority`). Tests: e2e "a spoofed approver id is ignored" (cashier: still `manager_attribution_required`; manager: the session is recorded). | PASS |
| CRED-1 | **No credential crosses `cart.*`.** | The request type has no PIN or credential field. The PIN enters only through `approval:request` (RT-443) and is verified and discarded there. The e2e test dumps the audit events, the outbox and the placeholder rows and asserts the PIN is absent. | PASS |
| AUTH-1 | **Every positive discount needs manager authority; no threshold.** | The `percent_NN > 10` parse is gone. A cashier without `approval_id` (or without the approval service wired) is refused `manager_attribution_required` before anything is written. Tests: e2e "refuses ANY discount without an approval, even 1%" (`percent_1`, `percent_10`, `percent_50`, `fixed_note`); `cart-discount-add-below.test.ts` (`percent_5`, `percent_1`). | PASS |
| AUTH-2 | **A manager / admin applies directly and is the approver (D2, C6).** | `discountAuthority` returns `manager_user_id` (lower-cased) or else `operator_id`, the same rule as the merged `cancelPostHandoff`. `approval:request` answers `not_applicable` for a manager session (C6). Tests: e2e "a manager / admin applies directly and is recorded as the approver"; "a manager asks for nothing". | PASS |
| APR-1 | **A cashier's approval is bound to kind, subject, version, terminal and requester, and consumed once.** | `consume({ approvalId, actionKind: 'cart.discount.manual', subjectRef: discountApprovalSubjectRef(req), subject: manualDiscountApprovalSubject(cart, line, kind, session), session })`. One refusal test each: expired, already consumed, unknown id, wrong kind (a `cart.cancel_post_handoff` row on the same subject), wrong cart, wrong line, wrong `placeholder_kind`, stale line version, removed line, wrong requester. Four-eyes (approver == requester) is refused at request time (`approval_unavailable`). | PASS |
| APR-2 | **Consumption, placeholder, outbox and audit are one transaction.** | `insertDiscountPlaceholderAndOutbox(build)` runs `build` (which consumes) inside `db.transaction`, then the outbox and placeholder writes, then the audit emit. A refused approval throws `ApprovalRefused` and rolls everything back. Test: "a failing audit write rolls everything back, the approval unconsumed"; every refusal test asserts no placeholder, no outbox row, no audit row and `consumed_at IS NULL`. | PASS |
| IDEM-1 | **Replay is checked first and never re-consumes.** | The outbox lookup by `idempotency_key` runs before the authority check. An exact replay (same cart, line and, while the row exists, kind) returns the original `ok`, with or without the now-consumed `approval_id`. A key reused for another line or kind is `idempotency_payload_mismatch` (stricter than before, which matched on `action_kind` only). Tests: e2e "an exact replay returns the original outcome without re-consuming"; "a key reused for another line or kind". | PASS |
| OFF-1 | **Offline follows RT-114 C5 (O3).** | Nothing on this path calls the backend. The PIN is verified locally under MA-1's credential policy (24 h validity). Test: e2e "works offline inside the RT-114 window and not after it" (approves at +23 h; `approval_unavailable` at +25 h). | PASS |
| EXP-1 | **Responses carry no approver identity.** | The add answers `{ kind, placeholder_id, requires_manager_attribution: true }` or a closed refusal. `cart.snapshot` still strips attribution (`cart-snapshot.test.ts` "never exposes … attribution"). The envelope the renderer sees nulls `attribution_operator_id` (`rendererEnvelope`). | PASS |
| ERR-1 | **Refusals are generic.** | `manager_attribution_required`, `approval_invalid`, `approval_stale`, `wrong_owner`, `idempotency_payload_mismatch`: closed strings that do not name the manager or say which binding failed (RT-114 C3). | PASS |
| AUD-1 | **Audit is main-only, dual-attributed and credential-free.** | `cart.discount.manager_authorized`: `acting_operator_id` = the requester, `approving_supervisor_id` = the approver, payload `{ cart_id, cart_line_id, placeholder_id, approval_id?, reason_code? }`. `cart.discount.above_threshold` is never emitted (test). The payload type and a test forbid `pin`, `pin_hash`, `password`, `approver_ref`, `display_name`. | PASS |

## 5. Findings for the owner

### F-1 — `mode` (online / offline) is not on the audit record

RT-608 item 4 asks the audit to carry `mode`. MA-2 (RT-443) records no grant mode: `manager_approvals` has no `mode` column, and no consumer on `main` (post-handoff cancel, sale void, recovery) emits one. Recording it truthfully needs either a `manager_approvals` column (a schema change, excluded by D5 / item 7) or a main-process connectivity signal at grant time, which does not exist today. Inventing a value would be a false audit fact, so the field is **left out**. The approval is always PIN-verified locally (OFF-1), so nothing about authority depends on it. **Recommended:** add the grant mode for every approval kind under RT-114 MA-3 (C9 offline review needs it anyway), then add it to this payload.

### F-2 — Item 6 is not implemented: legacy placeholders still hand off

Envelope steps 3a (`unauthorized_discount` at handoff) and 3b (006 payment-eligibility refusal) are held for owner authorisation (see the PR body for options). Until then, a placeholder written before RT-608 is not refused at handoff or payment. This is the pre-existing state, not a regression: no shipped UI has ever called `add`, so none is expected in the field. RT-608 itself writes only authorised rows.

### F-3 — `discountPlaceholders.remove` does not scope the placeholder to the cart (pre-existing) — CLOSED by RT-615

`discountPlaceholdersRemove` gates on `req.cart_id`, then deletes by `placeholder_id` alone (`getDiscountPlaceholder` / `DELETE … WHERE placeholder_id = ?`). It never checks that the placeholder belongs to that cart. A caller who knows another cart's placeholder id could remove it through their own cart. The snapshot only shows a session its own placeholders, so the id is hard to learn. Removing a discount can only raise a total (D4). This is outside RT-608's scope and is **not changed here**. **Recommended:** a one-line follow-up that refuses `wrong_owner` when `placeholder.cart_id !== req.cart_id`.

**Closed (2026-10-17, RT-615).** `discountPlaceholdersRemove` now refuses `wrong_owner` when `placeholder.cart_id !== req.cart_id`, before any write, so the placeholder stays in place and no outbox row is written. Test: `tests/unit/main/cart/cart-discount-remove.test.ts` › "refuses wrong_owner and leaves the other cart’s placeholder in place".

### F-4 — A replay after the cart was frozen answers `frozen`, not `ok` (pre-existing)

The mutable-cart gate runs before the replay check, as it always has. A lost response retried after handoff therefore answers `frozen`. The discount was applied and is in the envelope; nothing is double-applied. The contract's "replay first" is satisfied relative to the approval check, which is what matters for single use.

### Item 5 (D4) — remove audit: no change needed

`main` writes a `cart_action_outbox` row (`cart.discount_placeholder.remove`, `acting_operator_id` = the session operator) and no `audit_events` row. The merged contract (`bridge-api.md` § `cart.discountPlaceholders.remove`, PR #717) defines exactly that as D4's audited, non-sensitive lifecycle record ("like `cart.void`, FR-031. No `audit_events` row."). D4 does not require more, so no audit record is added. Test: e2e "a cashier removes an approved discount with no manager; outbox only, no audit row".

## 6. Validation run for this record

See the PR body for the exact commands and counts (typecheck, lint, full `vitest --coverage`).

## 7. Sign-off

| Role | Name | Date | Decision |
| :-- | :-- | :-- | :-- |
| Agent assessment | Claude Code | 2026-10-17 | PASS on controls; F-1 to F-3 open for the owner |
| Owner | | | *pending* |
