<!--
RT-856 (RT-699 I3) — §A4 P8 bridge-security re-check for the frozen line
discount, the receipt discount rows and the sync hold. Docs only.
-->

# §A4 re-check: frozen discount, receipt rows and sync hold (RT-856)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-856, RT-699 slice I3. Main process and shared code only. No renderer change. |
| Contract | [`docs/design/vnext/28-rt699-manual-discount-contract.md`](../../design/vnext/28-rt699-manual-discount-contract.md) §3.3, §5, §6, §8, §11. |
| Parent record | [RT-854 §A4](../RT-854/a4-manual-discount-recheck.md). |
| Gate | §A4, the P8 Electron security boundary. |
| Baseline | `origin/main` at `9dfd7d97`. |
| Prepared by | The implementation agent (Claude Code), 2026-10-24. **This is not an independent review.** It needs the owner's sign-off. |
| Verdict | **No new channel, no new request field.** Two existing read-only responses gain one optional field each. Agent-assessed PASS. |

## 2. Changed bridge surface

| Channel | Change |
| :-- | :-- |
| `receipts:preview` (response) | Each `ReceiptPayload.lines[]` item may carry `discount: { kind, value, amount_minor }`. Only these three fields; the frozen attribution stays main-side. |
| `sales:syncStatus` (response) | Gains `held: { reason: 'discount_capture_unavailable', count } \| null`. A closed-set code and a count. |
| `sales:read` (sale detail) | No change. `projectSaleLines` still projects only the display fields, so the frozen `discount` does not cross. |

## 3. Bridge surface walk

| Control | Check | Result |
| :-- | :-- | :-- |
| CH-1 No new channel | No channel or preload method was added. The renderer gains no way to trigger, retry or release a held sale. | PASS |
| EXP-1 No attribution on the slip or the preview | `deriveReceiptPayload` copies only `kind`, `value` and `amount_minor`. A test smuggles `placeholder_id`, `reason_code`, `authority_source` and `approver_operator_id` into `lines_json` and asserts none of them reaches the payload, the HTML or the ESC/POS bytes. | PASS |
| INP-1 Frozen data is validated before print | A present `discount` that is not a canonical kind and value with a safe non-negative amount is a `ReceiptPayloadDerivationError`, the existing controlled failure that the bridge maps to a refusal. It is never printed as a guess (tests). | PASS |
| RSP-1 Closed status code | `held.reason` is a closed set of one value. The count is an integer. No sale id, cashier, amount or reason code crosses. The existing secret-scan test covers the new key. | PASS |
| AUD-1 Freeze is attributed or refused | The finalize dispatch freezes a discount only when the `cart.discount.manager_authorized` row matches tenant, branch, placeholder, cart, line and the recomputed `amount_minor`, and carries a closed reason and an approving supervisor. `approver_role` is copied only when the row recorded it, and only as `manager` or `admin`. Otherwise the dispatch refuses (tests). | PASS |
| SYNC-1 No premature send | While `SALE_DISCOUNT_CAPTURE_SUPPORTED` is `false` (a code constant, not an environment variable), the drain leaves every discounted sale out before routing: no POST, no state write, never dead-lettered (tests). | PASS |
| SEC-1 No secret or PII | No PIN, credential or customer data is added. The reason code stays in `lines_json` for the capture (RT-858) and is not logged. | PASS |

## 4. Residuals for the owner

- **R-1, terminal status shows a held sale as "sending".** The RT-601 terminal-status sync axis counts `pending`, which includes a held sale, and has no held field. While a discounted sale is held, the indicator shows it as being sent, and after 24 h it raises the attention banner. No discounted sale can exist until RT-855 ships the control, so this must be settled before RT-855: either RT-855 maps `held` in the status indicator (copy needed), or the hold is visible only on `sales:syncStatus`.
- **R-2, the cashier-path `approver_role`.** It is frozen only when the audit row has it. RT-861 adds it on the cashier path; until then a cashier-approved discount has no `approver_role` on the Sale. RT-858 needs it for the capture.
- **R-3, the refusal leaves a settled attempt unfinalized.** A discount the dispatch cannot attribute refuses the projection, so the settled payment stays without a Sale and the worker logs it. RT-614's handoff check makes this unreachable in practice.
