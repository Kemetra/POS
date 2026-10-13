/* eslint-disable @typescript-eslint/unbound-method --
 * See bridge.payments-start.test.ts for rationale (passing the
 * fixture's `sessionSource.getCurrentSession` reference to the handler
 * deps is intentional — the helper closes over its own `null`/value
 * state and does not need `this`).
 */
/**
 * 006 T240 — `payments.forceFail` role gate test (Wave 5b RED).
 *
 * Asserts (FR-021 + plan AD-5 + Constitution §III):
 *
 *   The bridge handler refuses with `role_denied` when the current
 *   operator session's role is `cashier`. Manager and admin roles are
 *   permitted. The role gate is the LOAD-BEARING security control —
 *   the renderer's secondary route guard does NOT prevent a hostile
 *   renderer (e.g., devtools manipulation) from calling
 *   `window.api.payments.forceFail`, so the bridge MUST refuse on its
 *   own merits.
 *
 * The role gate also confirms that other refusal paths (no_session,
 * tenant_isolation, attempt_terminal) continue to fire correctly —
 * force-fail does NOT bypass the broader operator-session contract;
 * it only relaxes `wrong_owner` (managers intervene on someone else's
 * attempt, by design).
 *
 * **Wave 5b — TDD RED.** Forward-references the handler factory.
 */

import { describe, expect, it, vi } from 'vitest';

import { createPaymentsForceFailHandler } from '../../../../src/main/payments/handlers/payments-force-fail.js';

import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makePaymentAttemptFsmDouble,
  makeSession,
  makeSessionSource,
} from './__fixtures__/bridge-handler-deps.js';
import type { PaymentsForceFailRequest } from '../../../../src/shared/bridge-api.js';

function validRequest(overrides: Partial<PaymentsForceFailRequest> = {}): PaymentsForceFailRequest {
  return {
    payment_attempt_id: 'pa-1',
    idempotency_key: 'idem-ff-1',
    ...overrides,
  };
}

function setup(sessionRole: 'cashier' | 'manager' | 'admin') {
  const session = makeSession({
    role: sessionRole,
    operator_id: sessionRole === 'cashier' ? 'op-clerk-user-abc' : `op-${sessionRole}-user-xyz`,
  });
  const sessionSource = makeSessionSource(session);
  const row = makeAttemptRow();
  const attemptsRepo = makeAttemptsRepoDouble([row]);
  const fsm = makePaymentAttemptFsmDouble();
  const idempotency = makeIdempotencyHelperDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const clock = vi.fn<() => Date>(() => new Date('2026-05-25T11:30:00.000Z'));
  const handler = createPaymentsForceFailHandler({
    getCurrentSession: sessionSource.getCurrentSession,
    attemptsRepo,
    paymentAttemptFsm: fsm,
    idempotency,
    auditEmitter,
    clock,
  });
  return { session, attemptsRepo, fsm, idempotency, auditEmitter, clock, handler };
}

describe('T240 — payments.forceFail role gate', () => {
  it('cashier role: refused with role_denied; no FSM transition; no audit', async () => {
    const { fsm, auditEmitter, handler } = setup('cashier');
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'role_denied' });
    expect(fsm.forceFail).not.toHaveBeenCalled();
    expect(auditEmitter.captured).toHaveLength(0);
  });

  it('manager role: accepted; force-fail proceeds; audit emitted', async () => {
    const { fsm, auditEmitter, handler } = setup('manager');
    const result = await handler(validRequest());
    expect(result).toEqual({
      kind: 'ok',
      force_failed_at: '2026-05-25T11:30:00.000Z',
    });
    expect(fsm.forceFail).toHaveBeenCalledTimes(1);
    expect(auditEmitter.captured).toHaveLength(1);
    expect(auditEmitter.captured[0]?.action_category).toBe('payment.force_failed');
  });

  it('admin role: accepted (same authorization band as manager)', async () => {
    const { fsm, handler } = setup('admin');
    const result = await handler(validRequest());
    expect(result.kind).toBe('ok');
    expect(fsm.forceFail).toHaveBeenCalledTimes(1);
  });

  it('no session: refused with no_session; no FSM transition; no audit', async () => {
    const sessionSource = makeSessionSource(null);
    const handler = createPaymentsForceFailHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-25T11:30:00.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it('manager from different tenant: refused with tenant_isolation (not bypassed by force-fail)', async () => {
    const session = makeSession({
      role: 'manager',
      operator_id: 'op-manager-other-tenant',
      tenant_id: 'tenant-OTHER',
    });
    const sessionSource = makeSessionSource(session);
    const row = makeAttemptRow({ tenant_id: 'tenant-1' });
    const attemptsRepo = makeAttemptsRepoDouble([row]);
    const fsm = makePaymentAttemptFsmDouble();
    const handler = createPaymentsForceFailHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo,
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-25T11:30:00.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'tenant_isolation' });
    expect(fsm.forceFail).not.toHaveBeenCalled();
  });

  it('manager force-failing a different cashier`s attempt: ALLOWED (wrong_owner is the manager use case)', async () => {
    // The attempt was started by cashier op-clerk-user-abc.
    const row = makeAttemptRow({
      acting_operator_id: 'op-clerk-user-abc',
      operator_session_id: 'sess-cashier',
    });
    // The current session is a manager — different operator_session_id.
    const session = makeSession({
      role: 'manager',
      operator_id: 'op-manager-supervisor',
      operator_session_id: 'sess-manager',
    });
    const sessionSource = makeSessionSource(session);
    const attemptsRepo = makeAttemptsRepoDouble([row]);
    const fsm = makePaymentAttemptFsmDouble();
    const handler = createPaymentsForceFailHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo,
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-25T11:30:00.000Z'),
    });
    const result = await handler(validRequest());
    // The wrong_owner refusal is intentionally bypassed for the manager
    // path — that's the whole point of force-fail.
    expect(result.kind).toBe('ok');
    expect(fsm.forceFail).toHaveBeenCalledTimes(1);
  });
});

describe('RT-441 — payments.forceFail is restricted (RT-116 §5.2, M10)', () => {
  it('refuses recovery_required when the attempt holds live tender, and changes nothing', async () => {
    const { fsm, auditEmitter, attemptsRepo, idempotency, clock, session } = setup('manager');
    const handler = createPaymentsForceFailHandler({
      getCurrentSession: () => session,
      attemptsRepo,
      paymentAttemptFsm: fsm,
      idempotency,
      auditEmitter,
      clock,
      attemptHasLiveTender: () => true,
    });
    await expect(handler(validRequest())).resolves.toEqual({
      kind: 'refused',
      reason: 'recovery_required',
    });
    expect(fsm.forceFail).not.toHaveBeenCalled();
    expect(auditEmitter.captured).toHaveLength(0);
  });

  it('still force-fails an attempt with no live tender', async () => {
    const { fsm, attemptsRepo, idempotency, auditEmitter, clock, session } = setup('manager');
    const handler = createPaymentsForceFailHandler({
      getCurrentSession: () => session,
      attemptsRepo,
      paymentAttemptFsm: fsm,
      idempotency,
      auditEmitter,
      clock,
      attemptHasLiveTender: () => false,
    });
    await expect(handler(validRequest())).resolves.toMatchObject({ kind: 'ok' });
  });
});
