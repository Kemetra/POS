<!--
RT-440 (PK-2) — §A4 P8 bridge-security record for the Park v1 channels
(cart:park, cart:listParked, cart:previewResume, cart:resume) and the additive
shift-close refusal. Written with the implementation, before merge.
-->

# §A4 — P8 bridge-security review: Park v1 (RT-440)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-440 — PK-2, Park v1 main and bridge (spec 024 §3) |
| Gate | §A4 — P8 Electron security boundary (preload-bridge expansion) |
| Bridge surface | `api.cart.parked.{park, listParked, previewResume, resume}` over `cart:park`, `cart:listParked`, `cart:previewResume`, `cart:resume`. One additive refusal on `shiftCashup.close`: `parked_sales_present` with `parkedCount`. |
| Baseline | `origin/main` at `f9d3bb9` |
| Prepared by | The implementation agent (Claude Code), 2026-10-13. **Not an independent review.** Accepted under owner delegation pending the owner's own review. |
| Verdict | **Agent-assessed PASS (14/14).** Two scope extensions for the owner to note (§5). |

## 2. Code under review

| File | Role |
| :-- | :-- |
| `src/shared/cart/park-types.ts` | Request / response shapes, refusal reasons, limits. |
| `src/shared/cart/channels.ts` | `CART_PARK_IPC_CHANNELS` (all `cart:`). |
| `src/preload/cart.ts` | `cart.parked` — four `ipcRenderer.invoke` calls on constant channels. |
| `src/main/ipc/cart-park.ts` | Fresh-object validators and registration. |
| `src/main/cart/park/*` | Admission, owner key, park, list, preview, resume, store, diff, rules. |
| `src/main/cart/cart-bridge.ts`, `cart-store.ts` | `cart_parked` refusal on every other mutation; commit-time guard; `findDraftCartBySession` exclusion. |
| `src/main/cart/held-carts.ts`, `src/main/operator/lock-state-reader.ts` | K5 exclusions (and §5 extension). |
| `src/main/shift-cashup/*`, `src/shared/shift-cashup/types.ts` | The shift-close refusal. |
| `src/main/index.ts` | Registration on `guardedIpcMain`. |

## 3. Controls

| # | Control | Evidence | Result |
| :-- | :-- | :-- | :-- |
| P8-1 | **Typed bridge only.** | The preload exposes four functions that call `ipcRenderer.invoke` on constant channels. No Node API or IPC object reaches the renderer. `BrowserWindow` flags are unchanged. | PASS |
| P8-2 | **Sender origin is checked.** | `registerCartParkHandlers(guardedIpcMain, …)` in `index.ts`: the same sender-guarded chain as every `cart:*` handler. | PASS |
| LOCK-1 | **Refused while locked (spec §4.1).** | None of the four channels is in `LOCKED_ALLOWED_CHANNELS` (test). The service also refuses `session_locked` itself. | PASS |
| RM-1 | **Refused in recovery mode.** | `isRefusedInRecoveryMode` covers the `cart:` prefix (test). | PASS |
| SB-1 | **Sale-boundary re-check runs.** | `isSaleChannel` covers the `cart:` prefix (test), so a latched session's safe point is re-checked after each call. | PASS |
| INP-1 | **Closed request shapes.** | `asParkReq` / `asPreviewReq` / `asResumeReq` rebuild a fresh object with contract fields only. Ids match `^[A-Za-z0-9_-]{1,128}$`; the diff token must be lowercase hex ≤ 64; `accept_changes` must be a boolean; `current_cart` must be `park` or `keep`; the raw label is capped at 160 characters before main's own 40-character rule. Extra fields (owner, tenant, price) are dropped (test). A malformed request answers `no_session` and reaches nothing (test). | PASS |
| AUTH-1 | **Main derives identity, scope, prices and totals.** | The renderer names only a cart, a label, a token, a choice and a key. Owner, tenant, branch and terminal come from the session and the pairing row; prices come from the local catalogue read model; totals are recomputed in SQL. | PASS |
| OWN-1 | **Owner key for every role (K3).** | `isOwnCart` matches tenant, branch, terminal and `owning_operator_id === session.operator_id`. It does not use `requireOperatorSession`'s cart branch, which lets managers cross. A manager or admin cannot list, preview or resume another operator's parked sale (tests). `park` also requires `operator_session_id === session.id` (M4). | PASS |
| OWN-2 | **Replay is scoped too.** | A recorded key returns its outcome only when its cart passes the owner-key check; otherwise `wrong_owner` (test "never replays another operator's recorded park"). | PASS |
| IDEM-1 | **Durable idempotency (R-7).** | Each success writes one `cart_park_actions` row in the same transaction. Same key + same request → recorded outcome, nothing written (tests, including a delayed retry after resume and later edits). Different request, or a key the cart bridge used → `idempotency_payload_mismatch`; the reverse holds too: `CartStore.getOutboxRow` also answers for a park / resume key, so every cart handler refuses its reuse (test, from the Codex review on #662). Refusals write no row. | PASS |
| MUT-1 | **A parked cart changes only through resume (K5).** | `cart_parked` from `resolveMutableCart`, `void` and `handoff` covers add, update, remove, note, discount add/remove, undo, void and handoff (test). The add path's commit-time guard (`MUTABLE_CART_GUARD_SQL`) now also requires `parked_at IS NULL`, so a park that lands while the item lookup awaits cannot let a line in (test). | PASS |
| UNDO-1 | **No Undo across a park (R-3).** | Park and resume set `last_action_id` to the key, which is in no outbox row; resume's line writes use derived ids and `last_action_id` is set last. Undo of a pre-park line is refused after park (`cart_parked`) and after resume (`undo_not_available`), and so is Undo of a re-price row or the resume key (tests). | PASS |
| EXP-1 | **Responses and audit carry no label leak.** | `listParked` returns the label only to its owner. Audit payloads: `cart.parked` {cart_id, line_count, total_minor, has_label}, `cart.resumed` {cart_id, parked_for_ms, counts, current_cart}, `cart.park_refused` {reason}. Test: a sentinel label is absent from audit, logs, every outbox payload and `cart_park_actions`. The shift-close refusal carries `parkedCount` only, no owner, label or amount (test). | PASS |
| PAY-1 | **No tender row is touched.** | Park refuses a cart with a started attempt or live tender; resume refuses `checkout_in_progress` while the session has an unpaid handoff or a started attempt. Test: `payment_attempts` and `payment_tender_lines` are byte-identical before and after a park, a swap and an accepted resume with re-pricing and removal. | PASS |

## 4. Validation

- `tests/integration/main/cart/cart-park.test.ts` (29), `cart-resume.test.ts` (20), `tests/unit/main/ipc/cart-park-ipc.test.ts` (6), `src/main/cart/park/__tests__/park-units.test.ts`, `tests/integration/main/shift-cashup/shift-close-parked-sales.test.ts` (5), and the K5 additions to `held-carts.test.ts` and `lock-state-reader.test.ts`: green.
- `npm run typecheck`, `npm run lint`: clean. Full `test --coverage`: see the PR.

## 5. Findings for the owner

### F-1 — Two readers excluded beyond the K5 table

Spec 024 K5 names five read paths. Two more treated a parked cart as the session's live sale:

- `lock-state-reader.ts` summary: the lock screen would show a parked sale as the current one;
- `createSafePointProbe`: a latched session (RT-113 P2) with a parked sale would never reach its safe point.

Both now skip `parked_at IS NOT NULL` (tests). This is in the spirit of K5 ("read paths that would otherwise treat a parked cart as the operator's live or held draft") but is not in its table.

### F-2 — `cart.resume` refuses `authority_conflict` for a latched session

RT-113 P2: a session that lost its authority may not start a new sale. Resume brings a parked sale back, so a latched session is refused `authority_conflict`. Park stays allowed (it moves the session towards its safe point). Not named in spec 024 §3.4.

### Notes

- **Swap parks the current sale with no label** and audits it as `cart.parked`; the resume writes one `cart_park_actions` row, as §3.4 says.
- **Empty current carts are closed** with RT-352's mechanism (`session_ended`, `cart.discarded_on_session_end`), as R-6 says, so the closed cart's outbox row names its own session.
- **A shift-copy line** for `parked_sales_present` was added to keep the renderer's closed refusal map total. It shows no count; PK-3 (RT-445) owns the visible copy and the count.
- **Manager rows** (`recovery.listHeld` flag, `recovery.cancelHeldCart`) shipped in RT-441. This PR replaces its `PRAGMA table_info` probe with a direct read and adds the RT-441 test "a manager cancel through recovery unblocks the close".

## 6. Sign-off

| Role | Name | Date | Decision |
| :-- | :-- | :-- | :-- |
| Agent assessment | Claude Code | 2026-10-13 | PASS; F-1 and F-2 for the owner to note |
| Owner | | | *pending* |
