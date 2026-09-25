/**
 * Main-side eligibility check for `payments.start` (§A4 review, 2026-09-25).
 *
 * `payments.start` takes the envelope fields from the renderer. Main now
 * refuses unless the cart it names is really handed off in this session's
 * tenant and branch, the request matches that cart's persisted envelope, and
 * the cart has no settled payment. This is what stops a cancelled cart, or an
 * already-paid cart, from being paid through the bridge.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bindCartPaymentEligibility } from '../../../../src/main/payments/cart-payment-eligibility.js';
import { bindPaymentAttemptsRepository } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  for (const sql of MIGRATIONS) db.exec(sql);
});

const ENVELOPE = {
  envelope_version: 'v1',
  cart_id: 'cart-1',
  handoff_action_id: 'handoff-1',
  subtotal_minor: 5500,
};

function seedCart(state: string, envelope: object | null = ENVELOPE): void {
  db.run(
    `INSERT INTO carts (
       cart_id, tenant_id, branch_id, terminal_id, owning_operator_id, operator_session_id,
       state, cart_subtotal_minor, created_at, updated_at, frozen_at, cancelled_at,
       cancellation_reason, handoff_envelope_json, last_action_id
     ) VALUES ('cart-1', 'tenant-1', 'branch-1', 'terminal-1', 'op-1', 'sess-1', ?, 5500,
       '2026-09-25T09:00:00.000Z', '2026-09-25T09:00:00.000Z', NULL, NULL, NULL, ?, 'a-1')`,
    [state, envelope === null ? null : JSON.stringify(envelope)],
  );
}

function check(
  overrides: Partial<Parameters<ReturnType<typeof bindCartPaymentEligibility>>[0]> = {},
) {
  return bindCartPaymentEligibility(makeSqlJsHandle(db))({
    envelope_cart_id: 'cart-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_subtotal_minor: 5500,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    ...overrides,
  });
}

describe('bindCartPaymentEligibility', () => {
  it('admits a handed-off cart whose persisted envelope matches the request', () => {
    seedCart('frozen_handed_off');
    expect(check()).toEqual({ kind: 'ok' });
  });

  it.each(['cancelled', 'editing', 'empty', 'handing_off'])(
    'refuses cart_lost for a cart in state %s',
    (state) => {
      seedCart(state);
      expect(check()).toEqual({ kind: 'refused', reason: 'cart_lost' });
    },
  );

  it('refuses cart_lost for an unknown cart', () => {
    expect(check()).toEqual({ kind: 'refused', reason: 'cart_lost' });
  });

  it.each([
    ['another tenant', { tenant_id: 'tenant-2' }],
    ['another branch', { branch_id: 'branch-2' }],
  ])('refuses cart_lost for a cart in %s', (_label, overrides) => {
    seedCart('frozen_handed_off');
    expect(check(overrides)).toEqual({ kind: 'refused', reason: 'cart_lost' });
  });

  it.each([
    ['a different handoff action', { envelope_handoff_action_id: 'handoff-forged' }],
    ['a different subtotal', { envelope_subtotal_minor: 1 }],
  ])('refuses stale_handoff for %s', (_label, overrides) => {
    seedCart('frozen_handed_off');
    expect(check(overrides)).toEqual({ kind: 'refused', reason: 'stale_handoff' });
  });

  it('refuses stale_handoff when the persisted envelope is missing or corrupt', () => {
    seedCart('frozen_handed_off', null);
    expect(check()).toEqual({ kind: 'refused', reason: 'stale_handoff' });
    db.run(`UPDATE carts SET handoff_envelope_json = '{not json' WHERE cart_id = 'cart-1'`);
    expect(check()).toEqual({ kind: 'refused', reason: 'stale_handoff' });
  });

  it('refuses attempt_terminal for a cart that already has a settled payment', () => {
    seedCart('frozen_handed_off');
    const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
    repo.insert({
      payment_attempt_id: 'a1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      acting_operator_id: 'op-1',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-1',
      envelope_cart_id: 'cart-1',
      envelope_subtotal_minor: 5500,
      started_at: '2026-09-25T09:01:00.000Z',
      last_action_id: 'pa-action-1',
    });
    expect(check()).toEqual({ kind: 'ok' });
    repo.updateState({
      payment_attempt_id: 'a1',
      state: 'settled',
      timestamp: '2026-09-25T09:02:00.000Z',
      last_action_id: 'pa-action-2',
    });
    expect(check()).toEqual({ kind: 'refused', reason: 'attempt_terminal' });
  });
});
