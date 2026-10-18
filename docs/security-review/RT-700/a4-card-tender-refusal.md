<!--
RT-700 (RT-536 P-26-1, OD-26-1) — §A4 P8 bridge-security note for the card-tender
refusal path. Docs only.
-->

# §A4 note: card-tender flag and the `tender.apply` refusal (RT-700)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-700. Keep card out of the pilot: card-tender flag, refused at `tender.apply` (P-26-1). |
| Source | `docs/design/vnext/26-rt536-cashier-feature-completeness.md` §7 P-26-1 and OD-26-1 (option A, recommended, selected). |
| Gate | §A4, the P8 Electron security boundary. |
| Baseline | `origin/main` at `e63b68f` (PR #762, RT-591). |
| Prepared by | The implementation agent (Claude Code), 2026-10-18. **This is not an independent review.** It needs the owner's sign-off. |
| Electron review | Run on the diff with the `electron-security-reviewer` checklist. No `BrowserWindow`, preload or IPC registrar change, so sections 2 to 5 do not apply to this diff; the one handler change is step 5 (input validated before use: `tender_type` comes from the registrar's closed enum) and step 6 (no secret in the refusal or audit row). No Critical, Important or Later item. |
| Verdict | **No new channel and no new request field. The bridge-surface change is one new closed refusal value on `tender.apply`, and one new boolean in the existing `app:config` features map.** Agent-assessed PASS. |

## 2. What changed

- **Flag.** `cardTender`, env var `POS_PULSE_FEATURE_CARD_TENDER`, parsed in `src/main/app/feature-flags.ts` with the shared truthy parser. Unset or unrecognised is `false`: fail closed. It is **off by default**; the pilot value is `0`.
- **Main refusal (the load-bearing check).** In `createTenderApplyHandler`, a request with `tender_type = external_card_terminal` is refused with the new reason `card_tender_disabled` while the flag is off. The flag is read per call in main (`parseFeatureFlags(process.env)`), never taken from the request. The check sits after the session, role and attempt-ownership gate and **before** the idempotency reservation, so a refused call writes no outbox row, no tender line and makes no FSM call. The refusal is audited as `tender.refused` (reason, tender type, attempt, operator, tenant, branch, terminal, session). The audit row names no line: its `tender_line_id` is a fresh id that no line uses. The same handler factory serves manager recovery's `apply`, so recovery cannot apply card while the flag is off.
- **Renderer.** `TenderPicker` does not render the «بطاقة» tile when `cardEnabled` is false; `PaymentSurface` passes the store flag and also ignores a card selection while it is off. This is presentation only. The renderer store hydrates the flag from `app:config`, default `false`.
- **Unchanged.** `payments.start` stays tender-neutral (the tender type first crosses the bridge at `tender.apply`). Cash and voucher paths are untouched. With the flag on, behaviour and the frozen checkout drawing are as before.

## 3. Bridge surface walk

| Control | Check | Result |
| :-- | :-- | :-- |
| CH-1 No new channel | No change to `src/main/ipc/*`, `src/preload/*` or the channel lists. | PASS |
| REQ-1 No new request field | `TenderApplyRequest` is unchanged. The decision uses only `tender_type`, already validated by the IPC registrar's closed enum. | PASS |
| RSP-1 Closed refusal value | `REFUSAL_REASONS` gains `card_tender_disabled`. A fixed string; it carries no detail beyond the fact that card is off. | PASS |
| CFG-1 Config exposure | `AppConfig.features.cardTender` is a non-sensitive boolean, like the other seven. `app:config` carries no secret. | PASS |
| AUTH-1 Main is the authority | The renderer tile is not the control. A direct `tender.apply` on the channel with the flag off is refused (tested through `registerPaymentsHandlers`). | PASS |
| FC-1 Fail closed | Flag unset, empty or unrecognised means off. The handler dependency `isCardTenderEnabled` is required, so a caller that omits it does not compile. A replayed card idempotency key is also refused while off. | PASS |
| NOREC-1 Nothing recorded | The refusal precedes the idempotency reservation and the FSM; no row is written apart from the audit event. | PASS |
| RED-1 Redaction | The audit row carries no `external_reference`, no amount and no card data. The renderer never sends a card number; `external_reference` is the terminal's reference only. | PASS |
| ROLE-1 Order of gates | `no_session`, `role_denied` and ownership refusals still come first and write no audit row, as before. | PASS |

## 4. Residuals for the owner

- **Replay while off.** A card apply that succeeded while the flag was on, then replayed with its original key while the flag is off, is refused. This fails closed and does not affect money already recorded; a terminal is expected to flip the flag only between attempts.
- **Repeat refusals are not deduplicated.** Each refused call writes one audit row. A client that loops on the channel would write many; no new limit is added here.
- **Existing card lines.** A card line already applied on an open attempt is not reversed by turning the flag off. `tender.reverse` is unaffected, so recovery can still reverse it.

## 5. Tests

- `tests/unit/main/payments/idempotency-replay.real-stack.test.ts` (RT-700 block): the real stack (SQLite repositories, outbox, FSM) with the flag off: refused, one `tender.refused` row, no tender line, no outbox row; cash still applies.
- `tests/unit/main/payments/bridge.tender-apply.card-flag.test.ts`: flag off refuses and records nothing; one `tender.refused` audit row, without reference or amount; replayed key refused; session gate first; cash unchanged; voucher on its own path; flag on reaches the FSM; a direct call on the registered IPC channel in both states; the enum lists the reason once.
- `src/renderer/ui/payments/__tests__/voucher-pilot-restriction.test.tsx` (RT-700 block): tile absent with the flag off, cash still starts the payment; tile and card entry present with it on; picker order.
- `src/renderer/stores/__tests__/feature-flags-store.test.ts` and `src/main/app/__tests__/feature-flags.test.ts`: default off, explicit true only, env-var name, all 512 flag combinations.
