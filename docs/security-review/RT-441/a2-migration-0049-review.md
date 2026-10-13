<!--
RT-441 (RT-116 S6) — §A2 migration-safety record for
migrations/0049_carts_manager_cancelled_held.sql. Post-merge walk against
origin/main; the migration shipped in PR #655 (db5337f). Docs only.
-->

# §A2 — Migration review: `0049_carts_manager_cancelled_held`

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-441 — RT-116 S6, manager recovery |
| Gate | §A2 — migration safety (`[GATED]`) |
| Migration | `migrations/0049_carts_manager_cancelled_held.sql` |
| Shipped in | PR #655, merge commit `db5337f` |
| Reviewed against | `origin/main` at `df37c57` |
| `[GATED]` approval | The owner approved the MA-1, MA-2, PK-2 and S6 migrations on 2026-10-12 ("approve all"; recorded in the migration header and in PR #655). |
| Review type | Post-merge walk. The migration is already on `main`; this record checks it against the schema it replaces and the runner it runs under. |
| Prepared by | The implementation agent (Claude Code), 2026-10-13. **Not an independent review.** It needs the owner's sign-off. |
| Verdict | **Agent-assessed PASS.** No finding re-opens the migration. One note on rollback (§6). |

## 2. What the migration does

It adds one value, `manager_cancelled_held`, to the `carts.cancellation_reason` CHECK. That is the reason recorded when a manager cancels another operator's held draft through recovery (RT-116 §5.2 / §7.1). A handed-off cart keeps the existing `manager_voided_post_handoff`.

SQLite cannot alter a CHECK in place, so this is the canonical table rebuild (the 0019 pattern): create `carts_new`, copy every row, drop `carts`, rename `carts_new`, re-create the indexes.

The contract named this migration 0038. That number was taken; 0049 is the next free one after 0048 (`manager_approvals`, MA-2).

## 3. Checks

| # | Check | Evidence | Result |
| :-- | :-- | :-- | :-- |
| A2-1 | **Schema identical except the one CHECK.** No column, type, default or other constraint drifts. | A `diff` of the `CREATE TABLE` bodies of `0008_carts.sql` and `0049` (comments stripped, table name normalised) shows a single hunk: the `cancellation_reason` CHECK gains `'manager_cancelled_held'`. No migration between 0008 and 0048 altered `carts`' columns (`grep` over `migrations/*.sql`: only 0046 touches `carts`, and it adds an index). | PASS |
| A2-2 | **Every row survives.** | `INSERT INTO carts_new (…15 columns…) SELECT …15 columns… FROM carts`. The column list is explicit on both sides, so a column added to `carts` later and not mirrored here fails loudly instead of being dropped. Test: `0049-carts-manager-cancelled-held.test.ts` "keeps every row through a rebuild". | PASS |
| A2-3 | **Every index re-created.** | 0008's three (`idx_carts_tenant_branch`, `idx_carts_owning_operator`, `idx_carts_state`) and 0046's partial `idx_carts_owner_key … WHERE state <> 'cancelled'` are re-created with identical definitions. The test asserts all four exist after the rebuild. | PASS |
| A2-4 | **No dependent objects broken.** | No `REFERENCES carts` anywhere in `migrations/`. No trigger or view is defined `ON carts`; the append-only triggers belong to `cart_action_outbox` (0009/0037/0045) and are untouched. `DROP TABLE carts` therefore breaks nothing, and `foreign_keys = OFF` is not needed. | PASS |
| A2-5 | **Atomic.** | The file has no `-- @no-wrap-transaction` marker, so `src/main/db/migrate.ts` runs it inside `db.transaction(...)`. A failure rolls back the whole rebuild and rethrows; `carts` is never left half-built. | PASS |
| A2-6 | **The new value is accepted and an unknown one is still refused.** | Test "accepts the new reason and still refuses an unknown one" (`CHECK constraint failed`). | PASS |
| A2-7 | **Numbering.** | Test "takes the number right after 0048, and only it does". `ls migrations` ends at 0049; no other `0049_` file. | PASS |
| A2-8 | **Writers use only the CHECK values.** | `src/main/cart/cart-store.ts:150` adds the reason to the store's union. The only writer of the new value is `heldCancellation()` in `src/main/recovery/manager-recovery.ts`, which writes `manager_cancelled_held` for a draft and `manager_voided_post_handoff` for a handed-off cart. | PASS |
| A2-9 | **No PII or secret in the migration.** | Schema only; no data literals. | PASS |
| A2-10 | **Rollback documented.** | The header documents it: rebuild again with 0008's CHECK, after rewriting any `manager_cancelled_held` rows. See §6. | PASS (note) |

## 4. Validation run for this record

Run on `origin/main@df37c57`, Linux, `npm ci --ignore-scripts`:

- `npx vitest run src/main/migrations/__tests__/0049-carts-manager-cancelled-held.test.ts` plus the RT-441 recovery, IPC and forceFail tests: **6 files, 79 tests passed.**
- `npm run typecheck`: clean.

A packaged upgrade over a real pre-0049 terminal database was **not** run here; that is RT-446 (packaged verification).

## 5. Residuals

None that block. The rebuild runs once per terminal at upgrade, over `carts` only. On a pilot-sized table this is a single short transaction.

## 6. Rollback note (for the owner)

The documented rollback is not lossless. Rows cancelled `manager_cancelled_held` must be rewritten (the header suggests `cashier_voided`) or deleted before the 0008 CHECK can be restored. Rewriting them loses the manager-cancel cause from `carts`. The `cart.held_cancelled_by_manager` audit event and the `cart_action_outbox` row (with `attribution_operator_id` and `recovery: true` in its payload) still record what happened. If a rollback is ever needed, the runbook should say which rewrite to use.

## 7. Sign-off

| Role | Name | Date | Decision |
| :-- | :-- | :-- | :-- |
| Agent assessment | Claude Code | 2026-10-13 | PASS |
| Owner | | | *pending* |
