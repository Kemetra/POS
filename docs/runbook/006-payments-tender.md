# 006 Payments & Tender — Cashier + Manager Runbook (T304)

**Audience:** Cashiers (sections 1–4), managers (section 5), ops (section 6).
**Visual polish:** Deferred to spec 007 (`pos-visual-system`). Where this runbook references UI elements, expect the structural shape and behaviour — final colors, typography, animation, and micro-interactions are 007 territory.
**Spec source:** [`specs/006-payments-tender/spec.md`](../../specs/006-payments-tender/spec.md). FR-NNN references throughout refer to the spec.

---

## 1. Cashier walkthrough — cash tender

### Happy path

1. Cart handed off to the payment surface (cart UI calls `cart.handoff` per spec 005; the resulting envelope is bound to this attempt).
2. Renderer calls `payments.start` with the envelope. Main process inserts a `payment_attempts` row with `state='started'`. Status banner shows the cart subtotal and **Choose tender**.
3. Cashier taps **Cash** → renderer mounts `<CashEntry>`.
4. Cashier enters the amount received (minor units; e.g. 2000 for $20.00).
5. Cashier taps **Apply**. Renderer calls `tender.apply({ tender_type: 'cash', amount_applied_minor: 2000, ... })`.
6. Main process inserts a `payment_tender_lines` row with `state='applied'`. If `amount_applied_minor > remaining_balance_minor`, the row carries `change_due_minor = amount - remaining`; the response includes it.
7. Status banner updates: **Cash applied — change due $5.00**. Cashier hands change.
8. Settlement invariant: Σ(amount_applied_minor − change_due_minor) = envelope_subtotal_minor.
9. Cashier taps **Confirm**. Renderer calls `payments.confirm`. Attempt transitions to `settled`. `payment.settled` audit row written.

### Edge cases

- **Underpay.** Cashier applies less than the subtotal and taps Confirm. Refused as `tender_underpaid`. Status banner shows the generic copy `"Cannot finalise this payment yet."` Cashier applies more tender.
- **Overpay with change.** Cash is the ONLY tender that supports `change_due_minor`. Overpaying cash is normal — the change comes out of the drawer.
- **Stuck attempt.** If the cash drawer hardware freezes mid-confirm, the attempt stays in `state='started'` indefinitely. Cashier escalates to manager → manager runs force-fail (section 5).

### Implementation references

- Renderer: [`src/renderer/ui/payments/CashEntry.tsx`](../../src/renderer/ui/payments/CashEntry.tsx)
- Handler (cash branch): [`src/main/payments/handlers/tender-apply.ts`](../../src/main/payments/handlers/tender-apply.ts)
- FSM apply: [`src/main/payments/fsm/tender-line-fsm.ts`](../../src/main/payments/fsm/tender-line-fsm.ts) `apply()` — cash branch handles change calculation
- Integration test: [`tests/integration/payments/end-to-end-lifecycle.test.ts`](../../tests/integration/payments/end-to-end-lifecycle.test.ts)

---

## 2. Cashier walkthrough — external card terminal

### Happy path

1. As cash flow up to step 2 (attempt in `state='started'`).
2. Cashier taps **Card** → renderer mounts `<ExternalCardTerminalEntry>`.
3. Cashier swipes/inserts/taps on the standalone card terminal (out of band — this codebase does NOT integrate with payment processors directly).
4. Card terminal prints/displays a reference (e.g. `T1A2B3`). Cashier types it into the renderer. The TenderLine FSM enforces `^[A-Z0-9]{0,6}$` (uppercase alphanumeric, max 6 chars) — values outside that shape are refused.
5. Cashier enters amount applied. Taps **Apply**. Renderer calls `tender.apply({ tender_type: 'external_card_terminal', amount_applied_minor: N, external_reference: 'T1A2B3', ... })`.
6. Main process hashes the canonical payload (with `external_reference` redacted to `'*****'`) for the idempotency key. Persists the line with `state='applied'`.
7. Cashier confirms → settled.

### Hashing detail (security-relevant)

The `external_reference` is hashed at the FSM boundary before persistence. **It NEVER appears in plaintext** in:

- `payment_action_outbox.action_payload_hash` (SHA-256 only)
- `audit_events.payload` (literal `'*****'` per Constitution §P7)
- Any log line or Sentry breadcrumb (verified by `docs/runbook/006-payments-redaction-audit.md`)

The renderer holds the plaintext value during entry (it's keyboard input), but it doesn't round-trip back from main — the `PaymentAttemptRendererView` projection does not include `external_reference`.

### Edge cases

- **Empty reference.** Refused as `invalid_input` at the bridge boundary.
- **Lowercase or special chars.** Refused — uppercase alphanumeric is the convention.
- **Cashier mistypes reference.** Tap **Cancel** on the line (manual void) or proceed and rely on out-of-band reconciliation with the card terminal logs.

### Implementation references

- Renderer: [`src/renderer/ui/payments/ExternalCardTerminalEntry.tsx`](../../src/renderer/ui/payments/ExternalCardTerminalEntry.tsx)
- Handler (external_card_terminal branch): [`src/main/payments/handlers/tender-apply.ts`](../../src/main/payments/handlers/tender-apply.ts)
- Redaction: [`src/main/payments/idempotency.ts`](../../src/main/payments/idempotency.ts) `REDACT_KEYS` + [`src/main/payments/audit-emitter.ts`](../../src/main/payments/audit-emitter.ts)

---

## 3. Cashier walkthrough — voucher

### Happy path

1. As cash up to step 2.
2. Cashier taps **Voucher** → renderer mounts `<VoucherEntry>`.
3. Cashier types the voucher code (uppercase alphanumeric, dashes/underscores allowed) + the amount to apply.
4. Cashier taps **Apply**. Renderer calls `tender.apply({ tender_type: 'internal_voucher', voucher_code: 'XYZ123', amount_applied_minor: N, ... })`.
5. Main process calls Voucher Authority (V-A — `vouchers.validate`) with the code + amount.
6. **V-A validates**: returns `{ kind: 'validated', redemption_intent_token: '...', applied_amount_minor: N_actual }`. The intent token stays main-side. FSM persists the line with `state='applied'` and the token in `voucher_redemption_intent_token` column.
7. Renderer shows the applied line + remaining balance.
8. Cashier confirms → `payments.confirm`. Handler calls V-A `vouchers.redeem` with the intent token. V-A returns `{ kind: 'redeemed', redemption_id: 'red-XYZ' }`. Attempt transitions to `settled`.

### Authority refusal flow (F-A4B-003)

V-A may refuse for 8 distinct reasons (`voucher_not_found`, `voucher_expired`, `voucher_cancelled`, `voucher_already_redeemed`, `voucher_tenant_mismatch`, `voucher_branch_mismatch`, `non_cash_overpayment_refused`, `validation_failure`). **All 8 collapse to ONE cashier-visible copy:**

> "This voucher cannot be used right now."

The audit log distinguishes the actual reason; the cashier-visible copy does NOT. This prevents an attacker from probing codes against the POS surface to enumerate valid voucher numbers, expiry windows, redemption status, etc. (§A4-B reviewer decision F-A4B-003.)

### Authority unreachable flow

If V-A is unreachable (network/transport failure) during:

- `vouchers.validate` (apply time) → refused as `dependency_unavailable`. Cashier retries later.
- `vouchers.redeem` (confirm time) → attempt transitions to `failed` with `failure_reason='dependency_unavailable'`. Already-applied voucher lines go to `reversal_pending` (if a prior redeem succeeded for another line in a multi-voucher split). The deferred-reversal resolver picks up `reversal_pending` lines later (section 6).
- `vouchers.reverse` (cancel time on a voucher line) → line transitions to `reversal_pending`. Resolver handles eventual close.

### Edge cases

- **Voucher exceeds remaining balance.** Refused with the generic copy (one of the 8 reasons collapses to it).
- **Already-redeemed voucher.** Refused with the generic copy.
- **Cashier wants to remove a voucher line.** Tap **Reverse** on the line. Handler calls `tender.reverse` → V-A `vouchers.reverse` → if `reversed`, line → `reversed` state; if `authority_unreachable`, line → `reversal_pending` and the resolver retries on app start / network restore.

### Implementation references

- Renderer: [`src/renderer/ui/payments/VoucherEntry.tsx`](../../src/renderer/ui/payments/VoucherEntry.tsx)
- V-A client: [`src/main/payments/voucher-authority-client/`](../../src/main/payments/voucher-authority-client/) (`validate.ts`, `redeem.ts`, `reverse.ts`, `refusal-mapping.ts`, `error-body.ts`)
- Handler chain: [`tender-apply.ts`](../../src/main/payments/handlers/tender-apply.ts) → [`apply-voucher-line.ts`](../../src/main/payments/handlers/apply-voucher-line.ts) → V-A
- Generic refusal copy enforcement: [`tests/unit/renderer/payments/VoucherEntry.refusal-copy.test.tsx`](../../tests/unit/renderer/payments/VoucherEntry.refusal-copy.test.tsx)

---

## 4. Cashier walkthrough — split tender + cancel

### Split tender (multiple tenders per attempt)

A single `payment_attempts` row can have multiple applied `payment_tender_lines`. Cash + card, card + voucher, two vouchers — any combination is supported. Each `tender.apply` call appends a new line; the FSM tracks the running sum.

Example (subtotal 1000):

1. `tender.apply` cash 400 → line 1 `state=applied`, sum so far = 400.
2. `tender.apply` external_card_terminal 600 → line 2 `state=applied`, sum so far = 1000.
3. `payments.confirm` → settlement invariant holds (Σ = 1000 = subtotal), attempt → `settled`.

Outbox after settlement: 4 rows (1 start + 2 apply + 1 confirm), keyed by their respective `idempotency_key`s.

### Cancel mid-flight (LIFO reverse)

If the cashier (or system) cancels an attempt with applied lines, the FSM iterates **last-applied first** (LIFO) and reverses each. Voucher lines use V-A `vouchers.reverse`; cash + card lines reverse synchronously and locally.

If any voucher reverse returns `authority_unreachable`, that line moves to `reversal_pending` and the resolver completes it later. The attempt itself still transitions to `cancelled` — the application doesn't wait for V-A availability to close the cashier-facing flow.

### Edge cases

- **Mixed cash + voucher cancel.** Cash reverses synchronously; voucher reverses via V-A. If V-A unreachable, voucher line → `reversal_pending`; cash line is already `reversed`; attempt is `cancelled`.
- **Cancel a settled attempt.** Refused as `attempt_terminal` — settled attempts are immutable. Refunds/reversals go through a different (future) flow.

### Implementation references

- FSM cancel path: [`src/main/payments/fsm/payment-attempt-fsm.ts`](../../src/main/payments/fsm/payment-attempt-fsm.ts) `cancel()`
- LIFO ordering: tested by [`tests/integration/payments/end-to-end-lifecycle.test.ts`](../../tests/integration/payments/end-to-end-lifecycle.test.ts) "cancel reverses applied lines LIFO"

---

## 5. Manager incident response — force-fail (FR-021)

A cashier reports their attempt is stuck in `state='started'` (e.g. terminal hardware froze mid-confirm, or the renderer crashed and a stale attempt blocks the cash drawer). The manager intervenes via the **ForceFailSurface** route.

### Procedure

1. Manager signs in (manager Clerk account, not cashier PIN).
2. Manager opens the ForceFailSurface route. **Cashier role is refused at the IPC layer** (`payments.forceFail` requires manager / admin); the renderer route guard is secondary UX defence.
3. The surface lists eligible attempts for the manager's tenant + branch + terminal: any in `state='started'`.
4. Manager selects the stuck attempt. Surface confirms the action (one-tap-and-confirm UX to prevent slip).
5. Renderer calls `payments.forceFail({ payment_attempt_id, idempotency_key, ... })`.
6. Main process runs the FSM `forceFail` transition: attempt → `state='force_failed'`, with `failure_reason='manager_force_failed'` and `force_fail_attribution_operator_id` = manager's operator id. The audit row carries DUAL ATTRIBUTION (manager + cashier).

### Audit trail (dual attribution)

The `payment.force_failed` audit row records:

| Field | Value |
|:--|:--|
| `attribution_operator_id` (top-level) | manager |
| `session_id` (top-level) | manager's session |
| `created_at` | `force_failed_at` ISO |
| `payload.force_fail_attribution_operator_id` | manager |
| `payload.original_cashier_operator_id` | cashier (from `payment_attempts.acting_operator_id`, immutable since start) |
| `payload.force_failed_at` | ISO echo |

This is the durable record for ops / compliance review.

### What the cashier sees — FR-021 last clause

The bridge response carries **no manager identity**. The cashier-visible UI ONLY shows that the attempt is now terminal (`force_failed`). It cannot show WHO force-failed it — the field doesn't exist on the response type.

This is structural, not policy-based: even a programming mistake in the renderer can't leak the manager id, because the typed response shape lacks the field.

### Edge cases

- **Cashier tries to force-fail.** IPC handler refuses with `role_denied`. The route guard would also refuse on the renderer side, but the load-bearing check is the IPC role gate.
- **Force-fail an already-terminal attempt.** Refused as `attempt_terminal`. Idempotent on a `force_failed` attempt (returns prior `force_failed_at` without re-emitting audit).
- **Stuck reversal_pending voucher lines after force-fail.** Force-fail doesn't touch tender lines. If voucher lines were pending, the resolver still picks them up later. The attempt's terminal state doesn't block resolver runs.

### Implementation references

- Renderer: [`src/renderer/ui/payments/ForceFailSurface.tsx`](../../src/renderer/ui/payments/ForceFailSurface.tsx)
- Handler: [`src/main/payments/handlers/payments-force-fail.ts`](../../src/main/payments/handlers/payments-force-fail.ts)
- FSM transition: [`src/main/payments/fsm/payment-attempt-fsm.ts`](../../src/main/payments/fsm/payment-attempt-fsm.ts) `forceFail`
- Migration adding `'manager_force_failed'` to CHECK enum: [`migrations/0019_extend_payment_failure_reason_enum.sql`](../../migrations/0019_extend_payment_failure_reason_enum.sql) (Wave 5e canonical SQLite table-rebuild example using the `-- @no-wrap-transaction` opt-out)
- FR-021 row + DOM check tests: [`tests/integration/payments/force-fail.test.ts`](../../tests/integration/payments/force-fail.test.ts)

---

## 6. Ops — deferred-reversal resolver

The resolver retries `vouchers.reverse` for voucher lines stuck in `state='reversal_pending'`. It runs at three triggers:

- **App start** (every time the Electron main process boots): one full sweep.
- **Network-restore signal** (when 003's network monitor reports recovery): one sweep per signal.
- **Cashier-initiated retry** (`runOnce()` is exposed for a manual-retry bridge surface — to be wired in a future slice if needed).

### Outcomes per line

| V-A response | Action taken | Audit row |
|:--|:--|:--|
| `reversed` (success) | FSM transitions `reversal_pending` → `reversed`. | `tender.reversed` emitted with original `reversal_pending_since` for incident reconstruction (T231). |
| `authority_unreachable` | Line stays in `reversal_pending`. | None — the original `tender.reversal_pending` already narrates the state. |
| `refused` (e.g., `redemption_not_found`) | Line stays pending. | None — structured refusal reason logged at WARN level for ops triage. |

### Troubleshooting matrix

| Symptom | Likely cause | Action |
|:--|:--|:--|
| Lines stuck in `reversal_pending` for hours / days | V-A unreachable persistently | Check network. Run `resolver.runOnce()` manually (future bridge surface) or restart the app to retrigger. If V-A is permanently down, ops decides whether to mark lines `reversed` administratively or wait. |
| Lines transition to `reversed` on app start | Normal recovery from prior outage | Expected behaviour. No action. |
| WARN log `fsm_refused_transition` | Resolver raced another caller (e.g. a second resolver pass somehow fired concurrently). Idempotent — no harm done. | No action. |
| WARN log `missing_voucher_authority_redemption_id` | Corrupted row (defence-in-depth — the FSM is supposed to populate this column when transitioning to `reversal_pending`, but if a row lacks it, the resolver skips it). | Surface to ops; investigate manually. Check the migration history for any incomplete schema state. |
| WARN log `redemption_not_found` from V-A | The V-A side has lost the redemption record. | Ops triages: either V-A data loss (escalate) or the redemption was already reversed manually (mark line `reversed`). |

### Resolver behaviour during force-fail

Force-fail does not iterate or touch tender lines. If a force-failed attempt has voucher lines in `reversal_pending`, the resolver still completes them. The force-fail audit row is separate from any subsequent `tender.reversed` audit rows for those lines; the incident-reconstruction view stitches them by `payment_attempt_id`.

### Implementation references

- Resolver: [`src/main/payments/deferred-reversal-resolver.ts`](../../src/main/payments/deferred-reversal-resolver.ts)
- Triggers: app start (registered in `src/main/index.ts` bootstrap), network-restore signal (subscribed via 003's signal source), manual retry (`runOnce()` exported)
- Tests: [`tests/unit/main/payments/deferred-reversal-resolver.test.ts`](../../tests/unit/main/payments/deferred-reversal-resolver.test.ts) (unit) and the resolver hand-off scenario in [`tests/integration/payments/voucher-end-to-end.test.ts`](../../tests/integration/payments/voucher-end-to-end.test.ts)
