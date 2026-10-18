<!--
RT-700 (P-26-1, OD-26-1 option A) — §A4 P8 bridge-security note for the
card-tender flag refusal at tender.apply. Docs only.
-->

# §A4 note: card-tender flag refusal at `tender.apply` (RT-700)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-700. Keep card out of the pilot: a card-tender flag, refused at `tender.apply` (P-26-1). |
| Source | `docs/design/vnext/26-rt536-cashier-feature-completeness.md` §7 P-26-1 and OD-26-1 (option A). |
| Gate | §A4, the P8 Electron security boundary. |
| Baseline | `origin/main` at `2d3cba07` (PR #760, RT-695). |
| Prepared by | The implementation agent (Claude Code), 2026-10-18. **This is not an independent review.** It needs the owner's sign-off. |
| Verdict | **No new channel and no new request field. The only bridge-surface change is a new closed refusal value on an existing response.** Agent-assessed PASS. |

## 2. What changed

- **Flag** `cardTender`, env var `POS_PULSE_FEATURE_CARD_TENDER`. Parsed in `src/main/app/feature-flags.ts` with the shared truthy parser, so it is off unless set to `1 | true | yes | on`. It reaches the renderer through the existing `app:config` response, like the other eight flags.
- **Main refusal** (`src/main/payments/handlers/tender-apply.ts`). A fresh `tender.apply` with `tender_type = external_card_terminal` is refused `card_tender_disabled` while `isCardTenderEnabled()` is false. The reader is read on every call. If it is not wired, the handler treats the flag as off (fail-closed). `index.ts` passes the reader to both handlers it builds: the cashier handler and the manager-recovery handler.
- **Order.** The flag check runs after these checks: session, amount, attempt lookup, attempt binding (`requireOperatorSession`), then idempotency mismatch and replay. It runs before the voucher branch and the FSM. As a result:
  - a request with no session, or for another tenant's attempt, gets the same refusal as before. The flag state is not disclosed to a caller without a session;
  - a same-key replay of a card line that was applied while the flag was on still answers the recorded line. It records no new tender;
  - a refused card apply writes no tender line and no outbox row.
- **Audit.** Every refusal emits `tender.refused` with `refusal_reason: 'card_tender_disabled'`, the tender type, the attempt and the operator, through the existing payment audit emitter. Its `FORBIDDEN_PAYLOAD_KEYS` check still applies. The `tender_line_id` is the id the line would have had; no row carries it. `external_reference` is not in the event.
- **Unchanged.** `payments.start` is tender-neutral and has no new check. Cash and voucher are unchanged.
- **Renderer.** `TenderPicker` does not render the «بطاقة» tile unless `cardEnabled`. `PaymentSurface` passes the flag, refuses a card selection, and mounts the card entry only when the flag is on. This is UX only; main is the check that holds.

## 3. Bridge surface walk

| Control | Check | Result |
| :-- | :-- | :-- |
| CH-1 No new channel | No new entry in `src/main/ipc/*`, `src/preload/*` or the `bridge-api.ts` channel list. `ipc/payments.ts` is unchanged. | PASS |
| REQ-1 No new request field | `TenderApplyRequest` is unchanged. The flag is read in main from `process.env`; the renderer cannot set it. | PASS |
| RSP-1 Closed refusal value | The payments `REFUSAL_REASONS` gains `card_tender_disabled`. It is a fixed string with no detail. | PASS |
| CFG-1 Config exposure | `AppConfig.features` gains the boolean `cardTender`. It is not sensitive, like the other flags. | PASS |
| AUTH-1 Gates not weakened | The session, role, tenant, branch, terminal and idempotency checks run before the flag check, unchanged. | PASS |
| AUD-1 Refusal audited | A `tender.refused` row is written for every refused card apply. No card data is in it. | PASS |
| BYP-1 Renderer bypass | A direct IPC `tender.apply` for card with the flag off is refused in main (test below). | PASS |

## 4. Tests (written first)

- `tests/unit/main/payments/card-tender-flag.real-stack.test.ts`. Real handlers, FSMs, repositories and idempotency helper on in-memory SQLite. Calls go through the registered `tender.apply` IPC channel.
  - **Flag off:** `payments.start` succeeds. A direct IPC card apply is refused `card_tender_disabled`, writes no line and no outbox row, and is audited as `tender.refused` with no reference. A same-key retry is refused again. With no session the answer is `no_session`. Cash applies and voucher applies. An unwired reader fails closed.
  - **Flag on:** a card apply succeeds and is audited `tender.applied`. A same-key replay still answers after the flag is turned off, and a new key is refused.
- `src/main/__tests__/bootstrap-card-tender-flag.test.ts`: both `createTenderApplyHandler` calls in `index.ts` receive the reader.
- `src/main/app/__tests__/feature-flags.test.ts`: env name, default off, parsing.
- `src/renderer/ui/payments/__tests__/card-tender-flag.test.tsx`: tile absent with the flag off and the three frozen tiles in order with it on; `PaymentSurface` in both states.

## 5. Residuals

- **Packaged check.** The flag-off checkout has not been checked in a packaged build on lab hardware. The tile not being rendered is shown by jsdom tests only.
- **Owner sign-off.** This note is the agent's own assessment. It is not an independent review.
