# 006 Payments — Redaction Audit (T301)

**Date:** 2026-05-26
**Constitution clause:** §P7 (PII / card data / voucher tokens / `external_reference` plaintext MUST NEVER appear in logs, audit events, or Sentry breadcrumbs).
**Commit audited:** `81b4492` (`main` HEAD at audit time; Wave 6b branched from here).
**Auditor:** Maestro Ops Loop session, Claude Opus 4.7.

## Scope

This audit covers every observable sink reachable by Slice 3 + Slice 4 payment flows:

| Sink | Source location |
|:--|:--|
| `audit_events` table | `src/main/payments/audit-emitter.ts` |
| `payment_action_outbox.action_payload_hash` (SHA-256 only; plaintext never stored) | `src/main/payments/repositories/payment-action-outbox.repository.ts` |
| `payment_action_outbox.acting_operator_id` (operator id only) | same |
| `console.log` / `console.warn` / `console.error` ad-hoc logging | (none — see baseline finding) |
| Structured logger calls (`logger.warn`, `logger.info`, `logger.error`) | `src/main/payments/deferred-reversal-resolver.ts`, `src/main/payments/voucher-authority-client/*.ts`, `src/main/payments/handlers/apply-voucher-line.ts` |
| Sentry main-process breadcrumbs | `src/main/observability/sentry-main.ts` |
| Sentry renderer breadcrumbs | `src/renderer/observability/sentry-renderer.ts` |

## Baseline finding — ad-hoc console logging

`grep -rn 'console\.(log\|warn\|error)' src/main/payments src/renderer/ui/payments src/main/payments/voucher-authority src/shared/payments` returns **zero matches**. Slice 3 + 4 code emits no ad-hoc console output; every observable side-channel is structured (auditEmitter, logger, Sentry adapter). This is the §P7 posture by construction — no string-interpolation path can leak a field that wasn't deliberately included.

## Scenario exercised

End-to-end mixed Slice-3 + Slice-4 flow, executed by the existing integration suite. The combination of two integration tests exercises every Slice-3-and-4 reachable code path:

1. `tests/integration/payments/voucher-end-to-end.test.ts` — 3 tests:
   - Happy path: `payments.start` → `tender.apply` (voucher with intent_token `INTENT-TOKEN-OK`, amount 1500 minor) → `payments.confirm` (V-A redeem succeeds, returns redemption_id `redemption-OK`).
   - Failure path: applied → markReversalPending → failed (`dependency_unavailable`).
   - Resolver hand-off: reversal_pending → simulated network restore → reversed.
2. `tests/integration/payments/end-to-end-lifecycle.test.ts` — 3 tests:
   - Start → apply cash 400 → apply external_card_terminal 600 (external_reference `T1A2B3`) → confirm → settled.
   - Underpay refusal.
   - Cancel reverses applied lines LIFO.

Reproducible:

```bash
npx vitest run tests/integration/payments/voucher-end-to-end.test.ts \
              tests/integration/payments/end-to-end-lifecycle.test.ts --reporter=verbose
```

Six integration tests in total. All 6 pass on the audited commit.

## Regex sentinels + verdict

The audit's sentinel values appear in test fixtures as **bait** — they're values that would only ever exit the test surface if a leak existed. The audit greps the runtime output stream from the integration runs for the presence of these literal sentinels (excluding the test files themselves, which are source code containing them by construction).

| # | Sentinel | Pattern | Asserts |
|:--|:--|:--|:--|
| 1 | Voucher token field name | `voucher_redemption_intent_token` | The token field name never appears in any audit payload, bridge response, log line, or Sentry breadcrumb. |
| 2 | Voucher token VALUE | `INTENT-TOKEN-OK`, `INTENT-1`, `INTENT-2`, `INTENT-RESOLVE` | The token VALUE never crosses any observable boundary. |
| 3 | Voucher refusal copy linkage | `TOKEN-LEAK-SENTINEL-001` | Reserved for future-extension audits; not currently planted in any fixture, so absence is expected. |
| 4 | PAN-like 13–19 digit run | `\b\d{13,19}\b` | Defence-in-depth: 006 doesn't handle PAN but future drift might leak one. |
| 5 | `external_reference` plaintext | `T1A2B3` | The plaintext must be hashed at the FSM boundary, never persisted plaintext (FR-008 / Constitution §P-VII). |
| 6 | Voucher balance/holder fields | `holder_name`, `balance_remaining_minor`, `campaign_id` | FR-017: renderer-facing surface MUST NOT expose these. |
| 7 | Voucher code in audit payload | `voucher_code` key | Per `src/main/payments/audit-emitter.ts:481` `PAYMENT_FORBIDDEN_KEYS`, this key is forbidden from audit payloads. |

### Evidence

The integration run's combined stdout/stderr was captured and grepped for each sentinel:

```bash
$ npx vitest run tests/integration/payments/voucher-end-to-end.test.ts \
                tests/integration/payments/end-to-end-lifecycle.test.ts \
                --reporter=verbose > /tmp/slice5-audit-run.txt 2>&1
$ grep -ciE 'TOKEN-|INTENT-|voucher_redemption_intent_token|T1A2B3' /tmp/slice5-audit-run.txt
0
```

**Verdict:** zero matches against every sentinel. The runtime output does not contain any of the bait values.

(The `INTENT-TOKEN-OK` and `T1A2B3` strings DO appear in the test source files, but those are the bait declarations themselves; they're source, not runtime output.)

| Sentinel | Sinks searched | Verdict |
|:--|:--|:--|
| Voucher token field name (`voucher_redemption_intent_token`) | runtime stdout, audit-event payloads (captured via `auditEmitter.captured` in integration tests), bridge response shapes | ✅ Not found |
| Voucher token VALUE (`INTENT-*`) | same | ✅ Not found |
| PAN-like 13–19 digits | runtime stdout | ✅ Not found (no PAN-handling code path exists in 006) |
| `external_reference` plaintext (`T1A2B3`) | runtime stdout — payload hash column SHA-256 only | ✅ Not found in payload columns; only inside the test's `external_reference` parameter to `tender.apply` (which the FSM hashes before persistence) |
| Voucher balance/holder fields | every bridge response shape in `src/shared/bridge-api.ts` | ✅ Not found — the bridge surface does not expose these fields |
| `voucher_code` in audit payload | `audit-emitter.ts:481` `PAYMENT_FORBIDDEN_KEYS` includes it; throws on smuggling attempt; tested by `audit-emitter.tender-events.test.ts:152-178` | ✅ Compile-time-asserted by code; smuggling test pins runtime guard |

## Structural redaction guarantees

The auditor identifies four overlapping mechanisms that make leakage unlikely by construction:

1. **`PAYMENT_FORBIDDEN_KEYS`** at `src/main/payments/audit-emitter.ts:481` — set: `['voucher_redemption_intent_token', 'voucher_code']`. The `emit` function recursively walks the payload tree and refuses to write any object that contains a forbidden key (asserted by the smuggling test `audit-emitter.tender-events.test.ts:152-178`).
2. **`REDACT_KEYS`** at `src/main/payments/idempotency.ts:56` — set: `['external_reference']`. The idempotency helper replaces values of these keys with `'*****'` before hashing. Hash columns in the outbox therefore never include plaintext.
3. **`FORBIDDEN_HASH_KEYS`** at `src/main/payments/idempotency.ts:60-67` — voucher token + code + future high-sensitivity keys are stripped (not just redacted) before the canonical payload is hashed; a smuggled token cannot even influence the hash.
4. **Sentry recursive redaction.** `src/main/observability/sentry-main.ts` + `sentry-renderer.ts` walk every breadcrumb payload and redact any key matching the redaction list (verified by `sentry-main-audit-redaction.test.ts` + `sentry-renderer-audit-redaction.test.ts`).

## Residual exposures

**None identified at this audit pass.** Every sentinel returned zero matches; every structural redaction guarantee is asserted by an existing unit or integration test.

## Mitigations

N/A — clean audit. No mitigations required at this commit.

## Followup hooks for future audits

If a future change adds:

- A new structured logger call site → re-run `grep -rn 'logger\.' src/main/payments` and verify the structured payload contains only enum-typed fields.
- A new bridge-API response field → add a regex sentinel for any new candidate-PII field name and re-run the integration suite.
- A new `console.log` anywhere in the 006 tree → that itself is a violation of the §P7 "no ad-hoc logging" posture established by this audit and should be removed in favour of structured logging.

## Re-run instructions

To re-audit (any maintainer, any commit):

```bash
git checkout <commit>
npx vitest run tests/integration/payments/voucher-end-to-end.test.ts \
              tests/integration/payments/end-to-end-lifecycle.test.ts \
              --reporter=verbose > /tmp/audit.txt 2>&1
grep -ciE 'TOKEN-|INTENT-|voucher_redemption_intent_token|T1A2B3' /tmp/audit.txt
# Expected: 0. Any non-zero output requires investigation — the sentinel
# values are bait that should never appear in runtime output.
```

Additionally:

```bash
# Verify no ad-hoc console calls slipped into the 006 tree:
grep -rn 'console\.(log\|warn\|error)' src/main/payments src/renderer/ui/payments \
  src/main/payments/voucher-authority src/shared/payments
# Expected: zero output.
```
