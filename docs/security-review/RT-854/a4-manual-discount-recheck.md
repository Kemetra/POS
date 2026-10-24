<!--
RT-854 (RT-699 I1) — §A4 P8 bridge-security re-check for the manual line
discount made real in main. Docs only.
-->

# §A4 re-check: manual discount value, reason and totals (RT-854)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-854, RT-699 slice I1. Main process and shared code only. No UI. |
| Contract | [`docs/design/vnext/28-rt699-manual-discount-contract.md`](../../design/vnext/28-rt699-manual-discount-contract.md) §3, §4, §7, §8, §11. Spec 005 FR-022 / FR-024 / NFR-003 RT-699 amendments. |
| Parent records | [RT-608 §A4](../RT-608/a4-discount-approval-bridge-review.md), [RT-614 §A4](../RT-614/a4-discount-trust-recheck.md). |
| Gate | §A4, the P8 Electron security boundary. |
| Baseline | `origin/main` at `146673ba`. |
| Prepared by | The implementation agent (Claude Code), 2026-10-24. **This is not an independent review.** It needs the owner's sign-off. |
| Verdict | **No new channel.** One existing request type gains one optional string field (`reason_code`). Three closed refusal values are added. One existing response (the handoff envelope) gains two integer fields. Agent-assessed PASS. |

## 2. Changed bridge surface

| Channel | Change |
| :-- | :-- |
| `cart:discountPlaceholders:add` (request) | Gains an optional `reason_code: string`. The IPC parser forwards it only when it is a string, and refuses any other type generically. Main checks it against the closed list. |
| `cart:discountPlaceholders:add` (request) | `placeholder_kind` keeps its type (string). Main now accepts only the canonical tokens `manual_pct_<P>` / `manual_amt_<M>`. The renderer never sends an amount. |
| `cart:*` responses | `CartRefusalReason` gains `invalid_payload`, `discount_already_applied` and `line_discounted`. Each is a fixed string with no detail. |
| `cart:handoff` / `cart:snapshot` (envelope) | Gains `discount_total_minor` and `total_due_minor`. Both are integers that main computes. This is a v1 extension; `envelope_version` stays `'v1'`. |
| `approval:request` | No shape change. For `cart.discount.manual`, a `reason_code` outside the closed list is refused with the existing `invalid_input`. |
| `payments:start` | No shape change. `envelope_subtotal_minor` now has to equal the envelope's net `total_due_minor`. The field name is kept. Its meaning is now "the amount the payment covers". |

## 3. Bridge surface walk

| Control | Check | Result |
| :-- | :-- | :-- |
| CH-1 No new channel | No channel was added to `src/shared/cart/channels.ts`, `src/preload/*` or `MANAGER_APPROVAL_IPC_CHANNELS`. | PASS |
| REQ-1 Bounded request field | `reason_code` is a string or absent. A non-string is refused by the parser before main sees it (test). Main compares it with a closed `Set` of four codes. It is never logged, never interpolated and never used as a key. | PASS |
| REQ-2 No amount from the renderer | The token carries the value, and main parses it strictly: no leading zero, no sign, the percent within 1–100, the amount within the safe-integer range. Main computes the amount on the line gross it reads itself. The amount is never taken from the request. | PASS |
| AUTH-1 Authority unchanged | The RT-608 order is kept. The replay check runs first. A cashier with no `approval_id` is refused `manager_attribution_required`, whatever the token. A manager or admin is the approver. A renderer-supplied approver id is still dropped (C10). | PASS |
| AUTH-2 The approval binds the value | The approval subject now carries `amountMinor` = the computed discount, and the version includes it. MA-2 compares the subject ref exactly, so an approval for 10% cannot be spent on 20% (test). An approval granted under a different line version or amount is `approval_stale`. | PASS |
| AUTH-2b The applied amount stays the approved one | At handoff, the RT-614 trust predicate also requires the placeholder's amount on its live line now to equal the `amount_minor` its audit row recorded. A line whose gross moved after the approval (an accepted resume price change, `park-store.ts` `reprice`) is refused `unauthorized_discount` until the discount is removed and authorised again (test). | PASS |
| AUTH-3 The approval binds the reason | `approval.request` stores the reason only if it is on the closed list. A cashier add that restates a different reason is refused `approval_invalid` inside the transaction. Nothing is written and the approval is not consumed (test). | PASS |
| IDEM-1 Replay identity | The outbox payload now holds the token and the resolved reason. The replay check compares the token, and the reason when the retry states one, against that payload. A removed placeholder no longer widens a replay (test). | PASS |
| RSP-1 Closed refusals | The three new values are fixed strings. None names the approver, the amount or which rule failed beyond its own code. | PASS |
| EXP-1 No approver identity exposed | The audit payload holds `approver_role` only on the direct path, from the session's own role. The renderer envelope still nulls `attribution_operator_id`. The new envelope fields are totals only. | PASS |
| AUD-1 Audit payload closed set | `cart.discount.manager_authorized` adds `kind`, `value`, `amount_minor` and, on the direct path, `approver_role`. All of them are in Backend-Core's closed key set (`discount-audit-payload.ts` at Backend-Core `main@c1d6215f`, RT-740 DEP-2): `value` ≥ 1, a percent ≤ 100, and for an amount `value` = `amount_minor`. No `authority_source` key is sent, because it is not in that set; it can be derived from whether `approval_id` is present. | PASS |
| PAY-1 Eligibility fails closed | Eligibility reads the amount due from the **persisted** envelope only. A present but malformed `total_due_minor` refuses `stale_handoff`; it never falls back to the gross (test). A placeholder whose kind is not a canonical token refuses `unauthorized_discount`. | PASS |
| SEC-1 No secret or PII | No PIN, credential or customer data is added anywhere. The reason is a code, not free text. | PASS |

## 4. Residuals for the owner

- **R-1, `approver_role` on the cashier path is not recorded (GATED).** Main has no durable source for an approving manager's role today:
  - `manager_pin_records` and `manager_approvals` store no role;
  - `operator_sessions` is never written;
  - the `manager_credential.enrolled` audit row holds only a session id.

  The audit row therefore omits `approver_role` on the cashier path rather than guess. A guess of `manager` would be wrong for an admin approver. Recording it needs a migration, for example a `role` column on `manager_pin_records` set at enrolment and on each online sign-in, then carried onto the approval. That needs owner authorization (`[GATED migration]`). The direct path records the session's role.
- **R-2, renderer amount.** The renderer still sends `envelope.subtotal_minor` to `payments.start`. With no discount the two values are equal. Once RT-855 lets a cashier add a discount, it must send `total_due_minor`, or eligibility refuses `stale_handoff`.
- **R-3, sync of a discounted sale.** After I1, a discounted Sale's `subtotal_minor` is the net, while its `lines_json` still holds the gross line amounts. The capture would then carry totals that disagree. RT-855 must not ship before RT-856's hold.
