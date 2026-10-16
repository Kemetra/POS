<!--
RT-541 (RT-534 S5) — §A4 P8 bridge-security record for the new sales:list
channel and the `lines` field added to the sale detail. Written with the
implementation, before merge.
-->

# §A4 — P8 bridge-security review: `sales.list` and sale lines (RT-541)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-541 — RT-534 S5, local sales history read + main-side role gate |
| Gate | §A4 — P8 Electron security boundary (preload-bridge expansion) |
| Bridge surface | `api.sales.list` over `sales:list` (new, read-only). `sales.read` / `sales.findByNumber` gain `lines`. |
| Baseline | `origin/main` at `e9caa3e` |
| Prepared by | The implementation agent (Claude Code), 2026-10-16, with an agent security review. **Not an independent human review.** |
| Verdict | **Agent-assessed PASS.** No CRITICAL or HIGH finding. The two MEDIUM hardening items were fixed before merge (§4). |

## 2. Code under review

| File | Role |
| :-- | :-- |
| `src/shared/sales/channels.ts` | `SALES_IPC_CHANNELS.LIST = 'sales:list'`. |
| `src/preload/sales.ts` | `sales.list`: one `ipcRenderer.invoke` on the constant channel. |
| `src/main/ipc/sales.ts` | Refuses anything but a plain object as `invalid_request`; registered on `guardedIpcMain` (sender, lock, recovery and sale-boundary guards). |
| `src/main/sales/sales-bridge.ts` | `list`: forbidden-key scan → RT-546 `admitSession('sales.list')` → `planSalesList` → session-scoped read. |
| `src/main/sales/sales-list.ts` | Request validation, cursor codec, page assembly. |
| `src/main/sales/sale-access-policy.ts` | RT-546 gate, reused; one fail-closed addition (§4). |
| `src/main/sales/repositories/sales.repository.ts` | `listByFinalizedRange`: bound parameters only. |
| `src/main/sales/sale-lines.ts` | `lines` projection, never throws. |
| `src/shared/time/business-day.ts` | `businessDayBounds` (bisection over `businessDayOf`). |

## 3. Controls

| # | Control | Evidence | Result |
| :-- | :-- | :-- | :-- |
| A4-1 | **Typed, constant channel; no generic invoke.** | Preload exposes one function on `SALES_IPC_CHANNELS.LIST`. | PASS |
| A4-2 | **Main is the trust boundary.** | The RT-546 gate runs in main before any read; no renderer authorization is load-bearing. | PASS |
| A4-3 | **OD-534-1 role matrix.** | A cashier lists only their own sales (`ownerFilter`); manager/admin list the terminal scope; an unknown role is `role_denied` and audited (`sale.access.refused`, action `sales.list`); no session or a locked session is `no_session`. Tests in `bridge.sales-list.test.ts`. | PASS |
| A4-4 | **Scope only from the session.** | Tenant, branch, terminal and operator come from the session. A request key outside `from_day`, `to_day`, `page_size`, `cursor` (e.g. `tenant_id`, `selling_operator_id`, an own `__proto__`) is `invalid_request`. | PASS |
| A4-5 | **The cursor cannot widen access.** | Parsed strictly (`toISOString` instant + `[\w-]{1,64}` id, at most 100 characters); it only adds AND-ed narrowing predicates inside the window and scope (test: a cashier's forged cursor still returns only their sales). | PASS |
| A4-6 | **Bounded work.** | At most 31 inclusive days (wider is `range_too_wide`, never truncated); page size 1-100 (default 50); bisection is about 27 steps per bound. | PASS |
| A4-7 | **No injection.** | Every value is a bound `?`, including `LIMIT`. | PASS |
| A4-8 | **Data minimisation.** | List rows are a strict `Pick`: sale id and number, day, time, terminal label, operator display name, subtotal, tax. No main-only fields, no `selling_operator_id`, no lines. `lines` carries display fields only (no line_id/version/last_action_id). | PASS |
| A4-9 | **No exception across IPC.** | Malformed input maps to closed refusals; a `BusinessDayError` never escapes; a malformed stored time gives `business_day: null`; a malformed line snapshot is `unreadable`. | PASS |
| A4-10 | **List and detail agree.** | Both use the session's tenant/branch/terminal and the same owner rule, so every listed sale opens. | PASS |
| A4-11 | **Honest coverage.** | Every ok answer carries `coverage: 'this_device_only'`; the Arabic notice is in `sales-copy.ts` for RT-542. | PASS |

## 4. Findings and their disposition

| Severity | Finding | Disposition |
| :-- | :-- | :-- |
| MEDIUM | `(? IS NULL OR selling_operator_id = ?)` reads a missing operator id as "no filter": a cashier session without an operator id would list every sale. | **Fixed.** `admitSession` now refuses a session without a non-empty operator id as `no_session` for every sales/receipts action (fail closed). Tests for an empty and a null id. |
| MEDIUM | `businessDayOf` on a stored row could throw across IPC and fail the page. | **Fixed.** Caught per row; `business_day` is null for that row (test). |
| LOW | No overall cursor length cap. | **Fixed.** 100 characters. |
| LOW | A locked session never reaches the bridge: the lock guard rejects the invoke (`session_locked`) first. The bridge's `no_session` is the backstop. | Accepted: same as every other sales channel; fails closed. |
| LOW | Validation refusals (`invalid_request`, `range_too_wide`) are not audited. | Accepted: malformed input, no data returned. |

## 5. Out of scope, reported only

- OD-534-7 detail-open auditing belongs to the store-wide view (RT-542).
- `sale-void:lookup` and `returns:lookup` are not role-gated (noted in the RT-546 hand-over).

## 6. Sign-off

| Role | Name | Date | Decision |
| :-- | :-- | :-- | :-- |
