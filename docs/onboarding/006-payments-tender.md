# 006 Payments & Tender — Developer Onboarding (T305)

**Audience:** Developers new to the 006-payments-tender codebase. Assumes familiarity with the broader project stack (Electron + Vite + React + TypeScript + better-sqlite3 + Vitest). If not, start with `docs/onboarding/cart-workflow.md` and the constitution at `.specify/memory/constitution.md`.

---

## 1. Developer setup

### Branching off main

```bash
git checkout main && git pull --ff-only
git checkout -b <type>/006-<short-description>
```

Branch-name patterns established across Slices 1–4 (15 PRs):

| Prefix | Meaning |
|:--|:--|
| `feat/006-*` | feature work — new code or substantive behaviour change |
| `fix/006-*` | bug fix targeting a numbered finding (e.g. F-W5D-001) |
| `chore/006-*` | docs, spec, or coordination ledger only — no code change |
| `ci/006-*` | CI configuration |

### Running the suite

```bash
npm install
npm run codegen:verify           # OpenAPI types up to date (no drift)
npm run typecheck                 # all three tsconfigs (renderer, main, preload)
npm run lint                      # eslint + prettier --check
npx vitest run                    # full suite, ~50 seconds on a warm cache
npx vitest run --coverage --testTimeout=30000   # coverage; 30s timeout REQUIRED (see below)
```

**Why `--testTimeout=30000` for coverage runs.** v8 coverage instrumentation slows `scripts/__tests__/codegen.test.ts` (and a handful of others) enough that the default 5-second timeout fails them. Empirically derived in Wave 5d (Slice 4). Without the flag, the codegen tests time out and the coverage run reports phantom failures.

### The migration runner — and when to use the opt-out marker

The runner at [`src/main/db/migrate.ts`](../../src/main/db/migrate.ts) wraps each migration file in `db.transaction()` by default. For most migrations this is correct — DDL inside a transaction is what you want.

**Exception: SQLite table rebuilds for CHECK constraint changes.** SQLite cannot ALTER a CHECK constraint in place; the canonical recipe is `CREATE TABLE _new` / `INSERT...SELECT` / `DROP TABLE` / `ALTER TABLE ... RENAME`. The DROP step requires `PRAGMA foreign_keys = OFF` if any child table references the parent (regardless of whether the rebuild preserves every parent row first — empirical verification documented in Wave 5e).

`PRAGMA foreign_keys` is a documented no-op inside a transaction, so the migration cannot toggle FK enforcement from inside the runner's wrap. The runner supports an opt-out: put `-- @no-wrap-transaction` in the first 10 lines of the migration file. The runner detects this marker and runs the SQL directly (no transaction wrap). The migration is then responsible for its own `BEGIN`/`COMMIT` and any FK pragma toggling.

**Canonical example:** [`migrations/0019_extend_payment_failure_reason_enum.sql`](../../migrations/0019_extend_payment_failure_reason_enum.sql) (Wave 5e). Read the comment block at the top of that file before authoring any future schema-altering migration.

**When in doubt: default behaviour (no marker) is correct.** The opt-out is for the narrow set of migrations that genuinely need FK enforcement disabled mid-flight.

---

## 2. Dev fixture voucher authority stub

### Status

**No dedicated dev V-A stub exists at the time of Slice 5 sign-off.** The integration tests mock V-A inline via `vi.fn<(input: ValidateVoucherInput) => Promise<ValidateVoucherOutcome>>()` patterns. The mock seam is uniform across the codebase — every V-A consumer accepts `validateVoucher` / `redeemVoucher` / `reverseVoucher` as injected function parameters.

### Where the mocks live

- [`tests/unit/main/payments/__fixtures__/bridge-handler-deps.ts`](../../tests/unit/main/payments/__fixtures__/bridge-handler-deps.ts) — `makeValidateVoucherDouble()`, `makeRedeemVoucherDouble()`, `makeReverseVoucherDouble()` factories. Use these as the starting point for any new unit test.
- [`tests/unit/main/payments/bridge.payments-confirm.voucher.test.ts`](../../tests/unit/main/payments/bridge.payments-confirm.voucher.test.ts) — examples of the validate / redeem / reverse outcome shapes inline.
- [`tests/integration/payments/voucher-end-to-end.test.ts`](../../tests/integration/payments/voucher-end-to-end.test.ts) — the integration-level mocks for V-A wired together with real SQL.

### For local dev against the real Electron build

The bootstrap (`src/main/index.ts`) wires the V-A clients to a real HTTP fetch. To run the dev build against a mock V-A server, currently you would have to:

1. Run a local HTTP mock server (e.g. `mockoon` or a tiny Node script) that implements the V-A `validate` / `redeem` / `reverse` endpoints per `scripts/openapi-snapshot.json`.
2. Point the bootstrap at the mock URL via an env var or hardcoded constant.

**Slice 5 follow-up (recorded here):** Author a dedicated `docs/onboarding/006-voucher-authority-stub.md` that ships a Node script + step-by-step instructions for running the mock locally. Not blocking §A5 sign-off; quality-of-life improvement for new developers.

---

## 3. Restart-survival smoke test recipe

The Slice 3b integration test [`tests/integration/payments/restart-survival.test.ts`](../../tests/integration/payments/restart-survival.test.ts) proves the payment-attempt + tender-line + outbox lifecycle survives process restart. Reproducing this live against the real Electron build:

1. `npm run dev` — launches Electron pointed at a dev DB. Sign in as a cashier (or use the cart workflow happy path that auto-signs).
2. Drive a payment flow: `payments.start` → `tender.apply` (cash, $4.00) → **don't confirm yet**.
3. Verify state: open the dev SQLite DB (default location varies — check `app.getPath('userData')` output in the bootstrap logs). Tables `payment_attempts`, `payment_tender_lines`, `payment_action_outbox` should each have one row.
4. `Ctrl-C` the dev server. This simulates a process crash mid-attempt.
5. `npm run dev` again — same DB.
6. Sign in (or auto-sign). The payment surface should rehydrate from the existing `payment_attempts` row in `state='started'`. The applied tender line should still be present. Cashier can confirm and settle cleanly.

### Expected outcomes

- Attempt state: `started` (unchanged).
- Tender line state: `applied` (unchanged).
- Outbox rows: 2 (one for start, one for apply).
- After confirm: attempt → `settled`, outbox += 1 row.

If state is lost or any row vanished, that's a regression in either the migration runner (transactional integrity), the outbox append-only trigger (migration 0016), or the WAL mode config. Filed as a bug, not a known-limitation behaviour.

---

## 4. Test fixtures index

The 006 test surface is large. Where to look first by need:

| Need | File | Purpose |
|:--|:--|:--|
| Shared bridge-handler test doubles (session, FSM, repo, audit emitter, idempotency) | [`tests/unit/main/payments/__fixtures__/bridge-handler-deps.ts`](../../tests/unit/main/payments/__fixtures__/bridge-handler-deps.ts) | Every handler unit test imports these |
| sql.js DatabaseHandle adapter (so tests get the same `prepare/exec/transaction` shape as better-sqlite3) | [`tests/unit/main/cart/__helpers__/sql-js-handle.ts`](../../tests/unit/main/cart/__helpers__/sql-js-handle.ts) | Shared with the 005 cart tests; integration tests use it |
| Migration-by-migration assertions | [`tests/integration/payments/migrations.test.ts`](../../tests/integration/payments/migrations.test.ts) | Reference for what each migration adds to the schema; includes the CR-1 regression suite from Wave 5e |
| Slice 3 happy/sad path against real SQL | [`tests/integration/payments/end-to-end-lifecycle.test.ts`](../../tests/integration/payments/end-to-end-lifecycle.test.ts) | Cash + card lifecycle, LIFO reverse on cancel |
| Slice 4 voucher happy + failure + resolver hand-off | [`tests/integration/payments/voucher-end-to-end.test.ts`](../../tests/integration/payments/voucher-end-to-end.test.ts) | Voucher V-A round-trip; the resolver scenario uses a simulated network-restore signal |
| Slice 4 force-fail FR-021 + DOM check | [`tests/integration/payments/force-fail.test.ts`](../../tests/integration/payments/force-fail.test.ts) | Row dual-attribution; manager identity NEVER in cashier-visible DOM (FR-021 last clause) |
| Concurrent start race | [`tests/integration/payments/concurrent-start-race.test.ts`](../../tests/integration/payments/concurrent-start-race.test.ts) | Wave 6b T306 — partial unique index `payment_attempts_one_started_per_terminal` |
| Restart survival | [`tests/integration/payments/restart-survival.test.ts`](../../tests/integration/payments/restart-survival.test.ts) | The smoke-test reference; section 3 above describes how to reproduce live |
| Migration runner opt-out behaviour | [`src/main/db/__tests__/migrate.test.ts`](../../src/main/db/__tests__/migrate.test.ts) | Wave 5e tests for `-- @no-wrap-transaction` marker |
| V-A client unit tests | `tests/unit/main/payments/voucher-authority-client/` | Per-endpoint tests; reference for what each V-A response shape should look like |
| Renderer payment-surface tests | `tests/unit/renderer/payments/` | Cash entry, external card entry, voucher entry, force-fail surface |

---

## 5. Where to look first for any 006 question

| Question | First file to open |
|:--|:--|
| How does payment-attempt state work? | [`src/main/payments/fsm/payment-attempt-fsm.ts`](../../src/main/payments/fsm/payment-attempt-fsm.ts) — state machine and transitions documented at top of file |
| How does tender-line state work (including voucher reversal pending)? | [`src/main/payments/fsm/tender-line-fsm.ts`](../../src/main/payments/fsm/tender-line-fsm.ts) |
| What's the bridge surface? | [`src/shared/bridge-api.ts`](../../src/shared/bridge-api.ts) lines 740-779 — `PaymentsBridgeAPI`, `TenderBridgeAPI`, `VouchersBridgeAPI` |
| How do refusal reasons work? | [`src/main/payments/voucher-authority-client/refusal-mapping.ts`](../../src/main/payments/voucher-authority-client/refusal-mapping.ts) — closed-set mapping (§A4-B F-A4B-001) |
| How are audit events shaped? | [`src/main/payments/audit-emitter.ts`](../../src/main/payments/audit-emitter.ts) — every payment + tender audit emit lives here |
| What gets redacted in audit/log/breadcrumb sinks? | [`docs/runbook/006-payments-redaction-audit.md`](../runbook/006-payments-redaction-audit.md) — T301 evidence-based audit |
| How does the security model work? | [`docs/runbook/006-payments-security-review.md`](../runbook/006-payments-security-review.md) — T302 trust-boundary + FSM + idempotency + voucher + force-fail review packet |
| What's the cashier UX flow? | [`docs/runbook/006-payments-tender.md`](../runbook/006-payments-tender.md) — T304 cashier + manager runbook |
| What's the deferred-reversal resolver? | Same runbook, section 6 |
| Why is the `payment_attempts.failure_reason` CHECK constraint shaped this way? | [`migrations/0012_create_payment_attempts.sql`](../../migrations/0012_create_payment_attempts.sql) (original) + [`migrations/0019_extend_payment_failure_reason_enum.sql`](../../migrations/0019_extend_payment_failure_reason_enum.sql) (Wave 5e extension) |
| Is X gated by §A5? | Open [`specs/006-payments-tender/plan.md`](../../specs/006-payments-tender/plan.md) line 407 — that's the authoritative gate definition |
| What was the Slice 4 / Slice 5 ledger? | [`specs/006-payments-tender/coordination.md`](../../specs/006-payments-tender/coordination.md) — the wave-by-wave history with findings |

---

## 6. Common pitfalls (observed across Slices 1–5)

1. **Unit tests pass but integration tests fail.** Cause: mocking the repo or FSM means the SQL CHECK constraints, the FK semantics, and the outbox trigger aren't exercised. Always add an integration test for any new state-mutating code path. F-W5D-001 (`manager_force_failed` not in CHECK enum) was a perfect example — caught by integration, masked by unit mocks.
2. **Coverage runs report phantom failures.** Cause: v8 instrumentation slows codegen tests past their 5s default timeout. Use `--testTimeout=30000`.
3. **Migration changes a CHECK constraint and breaks.** Cause: SQLite can't ALTER CHECK; you need the table-rebuild pattern, which needs FK off, which needs the runner opt-out marker. See section 1.
4. **Voucher token leak via a new bridge response field.** Cause: someone added a field to a `*Response` type without checking whether the field could legitimately carry a token. Re-run the redaction audit (`docs/runbook/006-payments-redaction-audit.md` §"Re-run instructions") on any bridge-surface change.
5. **Cashier-visible DOM accidentally reveals manager identity.** Cause: a new field added to `PaymentsForceFailResponse` (or a related response type) leaked the `force_fail_attribution_operator_id`. The structural defence is the response type itself — keep it minimal (FR-021 last clause).
