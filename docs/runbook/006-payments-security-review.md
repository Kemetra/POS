# 006 Payments — Security Review Packet (T302)

**Date:** 2026-05-26
**Constitution clause:** §P8 (security-review handoff before production rollout).
**Commit reviewed:** `81b4492` (`main` HEAD at Wave 6b branch time).
**Authored by:** Maestro Ops Loop session, Claude Opus 4.7.

**Reviewer sign-off (to be filled by human security reviewer):**

> Reviewed by: __________________________________________________
> Date: __________
> Disposition: ☐ Approved   ☐ Approved with conditions   ☐ Rejected
> Conditions / findings (if any): _____________________________________

---

## (a) Trust-boundary map — `payments.*` / `tender.*` / `vouchers.*` IPC

The renderer reaches the main process EXCLUSIVELY through the typed preload bridge defined in `src/shared/bridge-api.ts`. No upward-of-bridge IPC paths exist (Constitution Principle II). Every method below is registered in `src/main/index.ts` against a handler factory in `src/main/payments/handlers/`.

### `payments.*` — 6 methods (`src/shared/bridge-api.ts:740-758`)

| Method | Request type | Response type | Role gate | Validation site |
|:--|:--|:--|:--|:--|
| `start` | `PaymentsStartRequest` | `PaymentsStartResponse` | cashier / manager / admin | `src/main/payments/handlers/payments-start.ts` (boundary: `requireOperatorSession` + envelope_version + envelope_subtotal_minor `Number.isSafeInteger`) |
| `confirm` | `PaymentsConfirmRequest` | `PaymentsConfirmResponse` | cashier / manager / admin | `src/main/payments/handlers/payments-confirm.ts` (boundary: session, idempotency, FSM gate) |
| `cancel` | `PaymentsCancelRequest` | `PaymentsCancelResponse` | cashier / manager / admin | `src/main/payments/handlers/payments-cancel.ts` |
| `subscribe` | `PaymentsSubscribeRequest` | `PaymentsSubscribeResponse` | cashier / manager / admin | `src/main/payments/handlers/payments-subscribe.ts` |
| `read` | `PaymentsReadRequest` | `PaymentsReadResponse` | cashier / manager / admin | `src/main/payments/handlers/payments-read.ts` |
| **`forceFail`** | `PaymentsForceFailRequest` | `PaymentsForceFailResponse` | **manager / admin only** (FR-021) | `src/main/payments/handlers/payments-force-fail.ts` (boundary: `allowedRoles: ['manager', 'admin']` — cashier role refused with `role_denied`) |

### `tender.*` — 3 methods (`src/shared/bridge-api.ts:760-767`)

| Method | Request type | Response type | Role gate | Validation site |
|:--|:--|:--|:--|:--|
| `apply` | `TenderApplyRequest` | `TenderApplyResponse` | cashier / manager / admin | `src/main/payments/handlers/tender-apply.ts` (boundary: `Number.isSafeInteger(amount_applied_minor)`, non-negative; per-tender shape) |
| `reverse` | `TenderReverseRequest` | `TenderReverseResponse` | cashier / manager / admin | `src/main/payments/handlers/tender-reverse.ts` |
| `read` | `TenderReadRequest` | `TenderReadResponse` | cashier / manager / admin | `src/main/payments/handlers/tender-read.ts` |

### `vouchers.*` — 1 method (`src/shared/bridge-api.ts:776-779`)

| Method | Request type | Response type | Role gate | Validation site |
|:--|:--|:--|:--|:--|
| `validate` | `VouchersValidateRequest` | `VouchersValidateResponse` | cashier / manager / admin | `src/main/payments/handlers/vouchers-validate.ts` (delegates to `apply-voucher-line.ts` helper which calls V-A) |

**Deliberately absent from the renderer-facing surface:** `vouchers.redeem` and `vouchers.reverse`. These are server-side flows invoked inside `payments.confirm` (redeem) and `tender.reverse` (reverse). Per FR-017 + AD-3, the renderer cannot unilaterally redeem or reverse a voucher — the only renderer-reachable voucher operation is `validate` (which lands the voucher line in `applied` state).

### Refusal envelope (closed-set)

Every bridge method's response carries `{ kind: 'ok', ... } | { kind: 'refused', reason: RefusalReason }`. `RefusalReason` is a closed string union defined in `src/shared/payments/types.ts`. The renderer can therefore exhaustively switch on the reason; no free-text refusal strings cross the bridge. §A4-B finding **F-A4B-001** pinned this via `mapRefusalCode` in `src/main/payments/voucher-authority-client/refusal-mapping.ts`.

---

## (b) FSM transitions + idempotency-replay protections

### PaymentAttempt FSM (`src/main/payments/fsm/payment-attempt-fsm.ts`)

States: `started → settled | cancelled | failed | force_failed`. Once in a terminal state, ALL further transitions refused with `attempt_terminal`.

**Transition table (legal):**

| From | To | Method | Authorisation |
|:--|:--|:--|:--|
| (none) | `started` | `start()` | insertion only; gated by `payment_attempts_one_started_per_terminal` partial unique index (migration 0013) |
| `started` | `settled` | `confirm()` | settlement invariant: Σ(amount − change) = envelope_subtotal_minor must hold |
| `started` | `cancelled` | `cancel()` | iterates applied lines LIFO, reverses each via `tenderLineFsm` |
| `started` | `failed` | `fail()` | with one of 14 closed `failure_reason` values |
| `started` | `force_failed` | `forceFail()` | **manager-only** (FR-021); dual attribution recorded |

All other transitions refused as `attempt_terminal`. The FSM enforces this in TypeScript via `isLegalPaymentAttemptTransition`; SQLite enforces it independently via the `state` CHECK constraint.

### TenderLine FSM (`src/main/payments/fsm/tender-line-fsm.ts`)

**Transition table (legal):**

| From | To | Method | Notes |
|:--|:--|:--|:--|
| (none) | `applied` | `apply()` | per-tender-type validation; voucher branch threads V-A outcome |
| `applied` | `reversed` | `reverse()` | synchronous; cash + external_card_terminal complete locally |
| `applied` | `reversal_pending` | `markReversalPending()` | voucher path only — fired when V-A `vouchers.reverse` returns `authority_unreachable` |
| `applied` | `refused` | `apply()` failure-path | V-A refused branch |
| `reversal_pending` | `reversed` | `confirmReversed()` | driven by the deferred-reversal resolver after V-A becomes reachable |

### Idempotency-replay (`src/main/payments/idempotency.ts`)

Per Constitution §P5: every state-mutating action carries an `idempotency_key` (UUID v4 generated by the renderer). The handler hashes the redacted canonical payload (see §(c) below) and reserves a slot in `payment_action_outbox` keyed by `action_id = idempotency_key`. The outbox enforces `UNIQUE(action_id)` so a duplicate retry:

- **Same key, same redacted payload** → `{ kind: 'replay' }` — handler returns the prior outcome without re-applying.
- **Same key, different redacted payload** → `{ kind: 'refused', reason: 'idempotency_payload_mismatch' }`.
- **New key** → `{ kind: 'fresh' }` — handler proceeds; commits the outbox row at the same transaction as the state change.

The outbox is **append-only** (migration `0016_payment_action_outbox_append_only_trigger.sql` enforces via a BEFORE-UPDATE / BEFORE-DELETE trigger that RAISES). This is the audit-trail load-bearing surface — a row once written cannot be rewritten or deleted.

### CR-3 defence-in-depth (Wave 4)

Multi-voucher partial-redemption rollback is the most complex transition path in the FSM. If `redeemVoucher` succeeds for line A and returns `authority_unreachable` for line B mid-sweep:

1. Compensating-reverse: V-A `vouchers.reverse` is called for line A.
2. If V-A reverse succeeds → line A transitions to `reversed`.
3. If V-A reverse ALSO returns `authority_unreachable` → line A transitions to `reversal_pending`; the deferred-reversal resolver picks it up later.
4. Line B (never redeemed) stays `applied` with no V-A side effect.
5. The attempt itself transitions to `failed` with `failure_reason: 'dependency_unavailable'`.

This is the only path in the FSM that can leave a `reversal_pending` line on a `failed` attempt — the resolver's purpose is to eventually close it. The integration test `tests/integration/payments/voucher-end-to-end.test.ts` "resolver hand-off" covers the eventual close.

---

## (c) `external_reference` validation + redaction chain

| Stage | What happens | Source location |
|:--|:--|:--|
| Boundary (FSM) | `external_reference` accepted as opaque uppercase alphanumeric string. Hard regex gate `^[A-Z0-9]{0,6}$` (length 0–6, A–Z + 0–9 only) — non-matching values cause the FSM to refuse the apply. The bridge handler forwards the raw value to the FSM without separately validating its shape (regex check lives at the FSM layer per `src/main/payments/fsm/tender-line-fsm.ts:40` `EXTERNAL_REFERENCE_REGEX`). | `src/main/payments/fsm/tender-line-fsm.ts` (`EXTERNAL_REFERENCE_REGEX` + the regex test in the external_card_terminal apply branch) |
| Idempotency hash | Before hashing the canonical payload, `external_reference`'s VALUE is replaced with `'*****'` (REDACT). The hash therefore encodes only the presence/shape, not the plaintext. | `src/main/payments/idempotency.ts:56` `REDACT_KEYS` |
| Outbox storage | The outbox row's `action_payload_hash` is the SHA-256 of the redacted canonical payload. Plaintext NEVER touches the column. | `src/main/payments/repositories/payment-action-outbox.repository.ts` `computeActionPayloadHash` |
| Audit emission | The audit-emitter writes `external_reference: '*****'` literally into the payload (data-model §"Extension to 004's audit_events"). Plaintext NEVER enters `audit_events.payload`. | `src/main/payments/audit-emitter.ts` (tender.applied emit; external_reference is redacted before encode) |
| Renderer | The plaintext value is the operator's keyboard input. It does NOT round-trip back from main — the renderer projection (`PaymentAttemptRendererView`) does not include `external_reference`. | `src/main/payments/handlers/projection.ts` (intentional minimisation) |

**Defence-in-depth pin:** the existing test `tests/unit/main/payments/audit-emitter.tender-events.test.ts` "T094 — tender.applied per-line event" asserts the `external_reference` field is `'*****'` in the captured payload even when the test passes a real-looking value at the boundary.

---

## (d) Voucher token lifecycle

The voucher intent token (`voucher_redemption_intent_token`) is the most sensitive value in the 006 surface. **It MUST never leave the main process** (FR-017 + §A4-B finding F-A4B-004).

| Stage | Token state | Source location |
|:--|:--|:--|
| 1. Renderer enters voucher code | No token yet — only the cashier-visible code string | `src/renderer/ui/payments/VoucherEntry.tsx` |
| 2. `tender.apply` → `vouchers.validate` (V-A) | V-A returns `{ kind: 'validated', redemption_intent_token: '...' }` | `src/main/payments/voucher-authority-client/validate.ts` |
| 3. FSM `apply(voucher_outcome)` | Token persisted in `payment_tender_lines.voucher_redemption_intent_token` (main-side database column only) | `src/main/payments/fsm/tender-line-fsm.ts` apply branch |
| 4. `tender.apply` response | Response shape: `{ kind: 'ok', tender_line_id: string, applied_at: string }` — **no token field** | `src/shared/bridge-api.ts` `TenderApplyResponse` |
| 5. `payments.confirm` → `vouchers.redeem` (V-A) | Handler reads token from lines repo, passes to `redeemVoucher`, V-A returns `redemption_id` | `src/main/payments/handlers/payments-confirm.ts` voucher branch |
| 6. Settled | `voucher_authority_redemption_id` (opaque) MAY appear in audit payload + repo. Token NEVER returned in `payments.confirm` response or `payment.settled` audit. | `src/main/payments/audit-emitter.ts` `emitPaymentSettled` |
| 7. Compensating reverse (CR-3) | `redemption_id` (opaque) is passed to `reverseVoucher`. Token is never re-used. | `src/main/payments/voucher-authority-client/reverse.ts` |

### §A4-B reviewer decisions (closed)

Recorded in `specs/006-payments-tender/reviews/a4b-vouchers-bridge-brief.md`:

| Finding | Decision |
|:--|:--|
| **F-A4B-001** | Closed-set refusal mapping via `mapRefusalCode` in `refusal-mapping.ts`. No free-text refusal codes cross the bridge. |
| **F-A4B-002** | No admin `Voucher*` schema imports in any 006 module. Grep-verified at audit time. |
| **F-A4B-003** | All 8 voucher refusal reasons collapse to ONE generic renderer copy: `"This voucher cannot be used right now."` An attacker cannot enumerate voucher validity, balance, or holder existence by probing codes against the POS surface. |
| **F-A4B-004** | Voucher token NEVER serialised into any bridge response, audit payload, log line, or Sentry breadcrumb. The audit-emitter's `PAYMENT_FORBIDDEN_KEYS` set + idempotency helper's `FORBIDDEN_HASH_KEYS` set provide the compile/runtime guards. |

The complete redaction sweep is documented in `docs/runbook/006-payments-redaction-audit.md` (T301).

---

## (e) Force-fail dual attribution (FR-021)

### Row schema (`payment_attempts` table)

| Column | Set at | Mutability | Identity |
|:--|:--|:--|:--|
| `acting_operator_id` | `payments.start` | **IMMUTABLE** | Always the original cashier who started the attempt |
| `force_fail_attribution_operator_id` | `forceFail()` | NULL except in state `force_failed` | The manager who authorised the force-fail |

### Audit emission (`payment.force_failed`)

Per `src/main/payments/audit-emitter.ts`, the `payment.force_failed` row carries:

| Field | Value | Source |
|:--|:--|:--|
| `action_category` | `'payment.force_failed'` | constant |
| `attribution_operator_id` (top-level) | **manager** | `session.operator_id` at handler call time |
| `session_id` (top-level) | manager's session | `session.operator_session_id` |
| `created_at` (top-level) | `force_failed_at` ISO timestamp | handler clock |
| `payload.force_fail_attribution_operator_id` | **manager** | duplicated structural |
| `payload.original_cashier_operator_id` | **cashier** | read from immutable `payment_attempts.acting_operator_id` |
| `payload.force_failed_at` | ISO timestamp | echoes `created_at` |

Both identities are durable in the audit row, allowing incident reconstruction without database snapshots.

### FR-021 last clause — cashier-visible DOM

The bridge response shape `PaymentsForceFailResponse` is:

```typescript
{ kind: 'ok', force_failed_at: string } | { kind: 'refused', reason: RefusalReason }
```

**The manager identity is structurally absent.** The renderer receiving this response cannot — even by a programming mistake — render the manager's identity, because the field does not exist on the response type.

**Defence-in-depth test pins:**
- `tests/integration/payments/force-fail.test.ts` "FR-021 — FSM bridge-response shape does NOT echo manager identity" — `JSON.stringify(result)` against the success outcome asserts no manager_id appears in the serialised string (covers any future leak via toJSON / structuredClone path).
- `tests/unit/renderer/payments/ForceFailSurface.manager-only.test.tsx` — renderer route gate refuses cashier role at render time (secondary UX defence; the load-bearing role check is at IPC layer per `forceFail` handler line ~70).

---

## Risk summary at audit time

| Risk | Severity | Mitigation present | Test pin |
|:--|:--|:--|:--|
| Voucher token leak to renderer | Critical | `PAYMENT_FORBIDDEN_KEYS` + `TenderApplyResponse` shape | `audit-emitter.tender-events.test.ts:152-178` (smuggling test) |
| `external_reference` plaintext in audit | High | `REDACT_KEYS` in `idempotency.ts` + audit-emitter redaction | `audit-emitter.tender-events.test.ts` T094 |
| Manager identity in cashier DOM | High | Response shape lacks the field | `force-fail.test.ts` FR-021 |
| FSM state corruption via concurrent start | High | `payment_attempts_one_started_per_terminal` partial unique index | `concurrent-start-race.test.ts` (T306) |
| Outbox tampering | High | Append-only trigger (migration 0016) | `payment-action-outbox` direct-update tests |
| Idempotency replay (double-charge) | High | Outbox `UNIQUE(action_id)` + payload-hash mismatch refusal | `idempotency-replay.identical.test.ts` + `idempotency-replay.payload-mismatch.test.ts` |
| V-A authority unreachable → silent failure | Medium | `dependency_unavailable` refusal + deferred-reversal resolver | `deferred-reversal-resolver.test.ts` + `voucher-end-to-end.test.ts` resolver-hand-off |
| Voucher enumeration via refusal copy | Medium | 8 reasons collapse to 1 copy (F-A4B-003) | `VoucherEntry.refusal-copy.test.tsx` |

## Open items for reviewer

None known by the authoring auditor. All known §A4-B findings are closed (recorded in `specs/006-payments-tender/reviews/a4b-vouchers-bridge-brief.md`).

---

## Sign-off (reviewer fills below)

> Reviewed by: __________________________________________________
> Date: __________
> Disposition: ☐ Approved   ☐ Approved with conditions   ☐ Rejected
> Conditions / findings (if any):
>
> ___________________________________________________________________
> ___________________________________________________________________
> ___________________________________________________________________
