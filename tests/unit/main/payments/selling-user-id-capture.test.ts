/**
 * RT-224 step 2 (Option B, coordinator decision P3) — capture the cashier's
 * `users.id` per sale at confirm time.
 *
 * Backend-Core's device-path `captureSale` needs `operatorUserId`: the `users.id`
 * of the cashier admission the sale was made under (NOT the provider subject
 * `operator_id`). The sale row keeps only `operator_id`, and finalize runs
 * session-independently from the `payment.settled` audit payload. So confirm
 * writes `selling_user_id` into that payload — the append-only (0004) record of
 * the sale's own provenance — and the sale-sync engine reads it back per sale.
 *
 * Written ONLY when the confirming session is an admitted cashier session
 * (`user_id` set) AND it is the operator who started the attempt
 * (`session.operator_id === row.acting_operator_id`). Otherwise the key is
 * omitted — never guessed — and the sale keeps the envelope path.
 *
 * `users.id` is an internal, provider-neutral UUID, not PII: the
 * `operator.cashier_pin.provisioned` payload already carries it
 * (`target_cashier_id`), and `selling_user_id` is not a forbidden payload key.
 */
import { describe, expect, it } from 'vitest';

import { createPaymentAuditEmitter } from '../../../../src/main/payments/audit-emitter.js';
import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';
import { resolveSessionScope } from '../../../../src/main/operator/resolve-session-scope.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { FORBIDDEN_PAYLOAD_KEYS } from '../../../../src/shared/audit/forbidden-keys.js';
import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makeLineRow,
  makeLinesRepoDouble,
  makePaymentAttemptFsmDouble,
  makeSession,
  makeSessionSource,
} from './__fixtures__/bridge-handler-deps.js';

const USER = '0190a3c4-0000-7000-8000-00000000000a';

const SETTLED_BASE = {
  payment_attempt_id: 'pa-1',
  cart_id: 'cart-1',
  handoff_action_id: 'handoff-1',
  settled_at: '2026-05-22T10:00:05.000Z',
  attribution_operator_id: 'op-clerk-user-abc',
  selling_operator_display_name: 'Layla Hassan',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  originating_terminal_id: 'terminal-1',
  session_id: 'sess-1',
  tender_lines: [],
};

describe('RT-224 — the payment.settled payload carries selling_user_id when given', () => {
  it('includes it when the input has it', () => {
    const captured: Array<Record<string, unknown>> = [];
    const emitter = createPaymentAuditEmitter({ sink: { write: (e) => captured.push(e) } });
    emitter.emitPaymentSettled({ ...SETTLED_BASE, selling_user_id: USER });
    expect((captured[0]?.payload as Record<string, unknown>).selling_user_id).toBe(USER);
  });

  it('omits the key entirely when the input has none (manager/admin session)', () => {
    const captured: Array<Record<string, unknown>> = [];
    const emitter = createPaymentAuditEmitter({ sink: { write: (e) => captured.push(e) } });
    emitter.emitPaymentSettled(SETTLED_BASE);
    expect('selling_user_id' in (captured[0]?.payload as Record<string, unknown>)).toBe(false);
  });

  it('selling_user_id is not a forbidden audit payload key', () => {
    expect((FORBIDDEN_PAYLOAD_KEYS as readonly string[]).includes('selling_user_id')).toBe(false);
  });
});

function confirmWith(
  session: ReturnType<typeof makeSession>,
  actingOperator = 'op-clerk-user-abc',
) {
  const auditEmitter = makeAuditEmitterDouble();
  const handler = createPaymentsConfirmHandler({
    getCurrentSession: () => makeSessionSource(session).getCurrentSession(),
    attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow({ acting_operator_id: actingOperator })]),
    linesRepo: makeLinesRepoDouble([
      makeLineRow({ tender_line_id: 'tl-1', amount_applied_minor: 1500 }),
    ]),
    paymentAttemptFsm: makePaymentAttemptFsmDouble(),
    idempotency: makeIdempotencyHelperDouble(),
    auditEmitter,
    clock: () => new Date('2026-05-23T11:00:05.000Z'),
  });
  return { auditEmitter, handler };
}

function settledInput(
  auditEmitter: ReturnType<typeof makeAuditEmitterDouble>,
): Record<string, unknown> {
  const settled = auditEmitter.captured.find((e) => e.action_category === 'payment.settled');
  if (settled === undefined) throw new Error('payment.settled was not emitted');
  return settled.payload;
}

describe('RT-224 — payments.confirm writes selling_user_id only for the admitted cashier who started the attempt', () => {
  it('an admitted cashier confirming their own attempt → selling_user_id = their users.id', async () => {
    const { auditEmitter, handler } = confirmWith(makeSession({ user_id: USER }));
    expect(await handler({ payment_attempt_id: 'pa-1', idempotency_key: 'k' })).toMatchObject({
      kind: 'ok',
    });
    expect(settledInput(auditEmitter).selling_user_id).toBe(USER);
  });

  it('a session without user_id (manager/admin) → no selling_user_id', async () => {
    const { auditEmitter, handler } = confirmWith(makeSession({ role: 'manager' }));
    await handler({ payment_attempt_id: 'pa-1', idempotency_key: 'k' });
    expect('selling_user_id' in settledInput(auditEmitter)).toBe(false);
  });

  it('an empty user_id → no selling_user_id', async () => {
    const { auditEmitter, handler } = confirmWith(makeSession({ user_id: '' }));
    await handler({ payment_attempt_id: 'pa-1', idempotency_key: 'k' });
    expect('selling_user_id' in settledInput(auditEmitter)).toBe(false);
  });

  it('a confirming operator who is not the attempt’s acting operator → no selling_user_id (never guessed)', async () => {
    const { auditEmitter, handler } = confirmWith(
      makeSession({ user_id: USER }),
      'op-SOMEONE-ELSE',
    );
    await handler({ payment_attempt_id: 'pa-1', idempotency_key: 'k' });
    const input = settledInput(auditEmitter);
    expect('selling_user_id' in input).toBe(false);
    expect(input.attribution_operator_id).toBe('op-SOMEONE-ELSE');
  });
});

describe('RT-224 — resolveSessionScope carries the admitted cashier’s user_id', () => {
  const base = {
    id: 'sess-1',
    operator_id: 'op-1',
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    backend_session_id: '',
    started_at: '2026-06-14T00:00:00.000Z',
    last_activity_at: '2026-06-14T00:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
  } as unknown as OperatorSessionRecord;

  it('copies user_id when the session has one', () => {
    expect(resolveSessionScope({ ...base, user_id: USER }, 'term-1')?.user_id).toBe(USER);
  });

  it('has no user_id key when the session has none', () => {
    const scope = resolveSessionScope(base, 'term-1');
    expect(scope).not.toBeNull();
    expect(scope !== null && 'user_id' in scope).toBe(false);
  });
});
