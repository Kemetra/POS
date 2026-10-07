/* eslint-disable @typescript-eslint/unbound-method --
 * See bridge.payments-start.test.ts for rationale.
 */
/**
 * T105 — `tender.apply` bridge handler test (RED).
 *
 * Asserts (contracts/bridge-api.md §"tender.apply"):
 *
 *   1. Session gate (no_session / role_denied).
 *   2. Attempt-binding gate: tenant_isolation / wrong_owner / attempt_terminal
 *      via requireOperatorSession with the attempt projection.
 *   3. Idempotency: identical retry returns the prior outcome reconstructed
 *      from the persisted line row (`tender_line_id`, `applied_at`,
 *      `change_due_minor` if cash overpay); mismatch refuses with
 *      `idempotency_payload_mismatch`.
 *   4. Tender-type routing:
 *        cash → routes to TenderLine FSM apply (may return change_due_minor).
 *        external_card_terminal → routes to FSM apply; FSM returns
 *          non_cash_overpayment_refused on overpay (FSM owns the rule —
 *          this test asserts the refusal passes through).
 *        internal_voucher → FSM returns tender_not_yet_supported (Slice-3);
 *          this passes through to the bridge response.
 *   5. Input validation at the bridge boundary:
 *        • `external_reference` regex `^[A-Z0-9]{0,6}$` is enforced
 *          main-side (FSM checks; we test the pass-through).
 *        • `amount_applied_minor` not a safe non-negative integer →
 *          `invalid_input`.
 *   6. Audit emission on FSM ok:
 *        • `tender.applied` event for `kind: 'ok'`.
 *        • `tender.refused` event for `kind: 'refused', reason:
 *          'non_cash_overpayment_refused'` (the FSM still records the
 *          refusal as a `refused`-state line; the audit fires regardless).
 *   7. `voucher_code` and `voucher_redemption_intent_token` MUST NOT
 *      appear anywhere in the bridge response (FR-017).
 *
 * **Wave G — TDD RED.** Forward-references the Wave H module.
 */

import { describe, expect, it, vi } from 'vitest';

import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';

import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makeLineRow,
  makeLinesRepoDouble,
  makeSession,
  makeSessionSource,
  makeTenderLineFsmDouble,
} from './__fixtures__/bridge-handler-deps.js';
import type { TenderApplyRequest } from '../../../../src/shared/bridge-api.js';

function validRequest(overrides: Partial<TenderApplyRequest> = {}): TenderApplyRequest {
  return {
    payment_attempt_id: 'pa-1',
    tender_type: 'cash',
    amount_applied_minor: 1500,
    idempotency_key: 'idem-apply-1',
    ...overrides,
  };
}

function setup() {
  const sessionSource = makeSessionSource(makeSession());
  const row = makeAttemptRow();
  const attemptsRepo = makeAttemptsRepoDouble([row]);
  const linesRepo = makeLinesRepoDouble();
  const fsm = makeTenderLineFsmDouble();
  const idempotency = makeIdempotencyHelperDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const uuid = vi.fn<() => string>(() => 'tl-1');
  const clock = vi.fn<() => Date>(() => new Date('2026-05-23T11:00:01.000Z'));
  const handler = createTenderApplyHandler({
    getCurrentSession: sessionSource.getCurrentSession,
    attemptsRepo,
    linesRepo,
    tenderLineFsm: fsm,
    idempotency,
    auditEmitter,
    uuid,
    clock,
  });
  return {
    sessionSource,
    attemptsRepo,
    linesRepo,
    fsm,
    idempotency,
    auditEmitter,
    uuid,
    clock,
    handler,
  };
}

describe('T105 — tender.apply bridge handler', () => {
  it('refuses no_session when there is no active session', async () => {
    const handler = createTenderApplyHandler({
      getCurrentSession: makeSessionSource(null).getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble(),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'tl-1',
      clock: () => new Date('2026-05-23T11:00:01.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
  });

  it('refuses tenant_isolation when the attempt is in another tenant scope', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ tenant_id: 'tenant-OTHER' });
    const handler = createTenderApplyHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'tl-1',
      clock: () => new Date('2026-05-23T11:00:01.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'tenant_isolation',
    });
  });

  it('refuses attempt_terminal when the attempt is settled / cancelled / failed', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ state: 'settled' });
    const handler = createTenderApplyHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'tl-1',
      clock: () => new Date('2026-05-23T11:00:01.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'attempt_terminal',
    });
  });

  it('refuses invalid_input when amount_applied_minor is not a safe non-negative integer', async () => {
    const { handler } = setup();
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const result = await handler(validRequest({ amount_applied_minor: bad }));
      expect(result).toEqual({ kind: 'refused', reason: 'invalid_input' });
    }
  });

  it('applies a cash tender line and returns ok with applied_at', async () => {
    const { handler, fsm } = setup();
    fsm.apply.mockReturnValueOnce({
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: '2026-05-23T11:00:01.000Z',
    });
    const result = await handler(validRequest({ tender_type: 'cash' }));
    expect(result).toEqual({
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: '2026-05-23T11:00:01.000Z',
    });
    expect(fsm.apply).toHaveBeenCalledTimes(1);
    expect(fsm.apply.mock.calls[0]?.[0]).toMatchObject({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1500,
      attribution_operator_id: 'op-clerk-user-abc',
      applied_at: '2026-05-23T11:00:01.000Z',
      action_id: 'idem-apply-1',
    });
  });

  it('returns change_due_minor when the FSM signals cash overpayment', async () => {
    const { handler, fsm } = setup();
    fsm.apply.mockReturnValueOnce({
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: '2026-05-23T11:00:01.000Z',
      change_due_minor: 500,
    });
    const result = await handler(validRequest({ tender_type: 'cash', amount_applied_minor: 2000 }));
    expect(result).toEqual({
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: '2026-05-23T11:00:01.000Z',
      change_due_minor: 500,
    });
  });

  it('passes non_cash_overpayment_refused from the FSM through unchanged for external_card_terminal', async () => {
    const { handler, fsm } = setup();
    fsm.apply.mockReturnValueOnce({
      kind: 'refused',
      reason: 'non_cash_overpayment_refused',
    });
    const result = await handler(
      validRequest({
        tender_type: 'external_card_terminal',
        amount_applied_minor: 9999,
        external_reference: 'AB12XY',
      }),
    );
    expect(result).toEqual({
      kind: 'refused',
      reason: 'non_cash_overpayment_refused',
    });
  });

  it('passes tender_not_yet_supported from the FSM for internal_voucher (Slice-3 gate)', async () => {
    const { handler, fsm } = setup();
    fsm.apply.mockReturnValueOnce({ kind: 'refused', reason: 'tender_not_yet_supported' });
    const result = await handler(
      validRequest({
        tender_type: 'internal_voucher',
        voucher_code: 'V-ABC-123',
      }),
    );
    expect(result).toEqual({
      kind: 'refused',
      reason: 'tender_not_yet_supported',
    });
  });

  it('refuses idempotency_payload_mismatch when the helper signals mismatch', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const handler = createTenderApplyHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'mismatch' }),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'tl-1',
      clock: () => new Date('2026-05-23T11:00:01.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
  });

  it('returns the prior outcome when the idempotency helper signals replay', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-existing',
        tender_type: 'cash',
        amount_applied_minor: 2000,
        change_due_minor: 500,
        applied_at: '2026-05-23T10:59:55.000Z',
        last_action_id: 'idem-apply-1',
      }),
    ]);
    const fsm = makeTenderLineFsmDouble();
    const handler = createTenderApplyHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo,
      tenderLineFsm: fsm,
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay', tender_line_id: 'tl-existing' }),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'tl-NEW',
      clock: () => new Date('2026-05-23T11:00:01.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({
      kind: 'ok',
      tender_line_id: 'tl-existing',
      applied_at: '2026-05-23T10:59:55.000Z',
      change_due_minor: 500,
    });
    expect(fsm.apply).not.toHaveBeenCalled();
  });

  it('emits tender.applied on FSM ok (cash, no overpayment)', async () => {
    const { handler, fsm, auditEmitter } = setup();
    fsm.apply.mockReturnValueOnce({
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: '2026-05-23T11:00:01.000Z',
    });
    await handler(validRequest({ tender_type: 'cash' }));
    expect(auditEmitter.captured).toHaveLength(1);
    expect(auditEmitter.captured[0]?.action_category).toBe('tender.applied');
    expect(auditEmitter.captured[0]?.payload).toMatchObject({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1500,
    });
  });

  it('emits tender.refused on FSM refusal (non_cash_overpayment_refused)', async () => {
    const { handler, fsm, auditEmitter } = setup();
    fsm.apply.mockReturnValueOnce({
      kind: 'refused',
      reason: 'non_cash_overpayment_refused',
    });
    await handler(
      validRequest({
        tender_type: 'external_card_terminal',
        amount_applied_minor: 9999,
        external_reference: 'AB12XY',
      }),
    );
    const refused = auditEmitter.captured.filter((e) => e.action_category === 'tender.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.payload).toMatchObject({
      tender_type: 'external_card_terminal',
      refusal_reason: 'non_cash_overpayment_refused',
    });
  });

  it('does NOT emit any audit event on idempotency replay or mismatch', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({ tender_line_id: 'tl-existing', last_action_id: 'idem-apply-1' }),
    ]);
    const auditEmitter = makeAuditEmitterDouble();

    // Replay branch — same idempotency_key, identical payload → no audit.
    const replayHandler = createTenderApplyHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter,
      uuid: () => 'tl-NEW',
      clock: () => new Date('2026-05-23T11:00:01.000Z'),
    });
    await replayHandler(validRequest());
    expect(auditEmitter.captured).toHaveLength(0);

    // Mismatch branch — same idempotency_key, divergent payload → no audit.
    const mismatchHandler = createTenderApplyHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'mismatch' }),
      auditEmitter,
      uuid: () => 'tl-NEW-2',
      clock: () => new Date('2026-05-23T11:00:01.000Z'),
    });
    await mismatchHandler(validRequest({ idempotency_key: 'idem-apply-2' }));
    expect(auditEmitter.captured).toHaveLength(0);
  });

  it('response never contains voucher_code or voucher_redemption_intent_token', async () => {
    const { handler, fsm } = setup();
    fsm.apply.mockReturnValueOnce({
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: '2026-05-23T11:00:01.000Z',
    });
    const result = await handler(
      validRequest({ tender_type: 'internal_voucher', voucher_code: 'V-SECRET' }),
    );
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('voucher_code');
    expect(serialised).not.toContain('voucher_redemption_intent_token');
    expect(serialised).not.toContain('V-SECRET');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T263 — Wave 4 voucher branch of tender.apply
// ─────────────────────────────────────────────────────────────────────────────

type T263ValidateOutcome =
  | {
      kind: 'validated';
      applied_amount_minor: number;
      intent_expires_at: string;
      redemption_intent_token: string;
    }
  | { kind: 'refused'; reason: 'voucher_not_found' | 'voucher_expired' }
  | { kind: 'authority_unreachable' };

describe('T263 — tender.apply voucher branch (Wave 4)', () => {
  function setupVoucher(opts: { validateOutcome?: T263ValidateOutcome } = {}) {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 3000 });
    const attemptsRepo = makeAttemptsRepoDouble([row]);
    const linesRepo = makeLinesRepoDouble();
    const fsm = makeTenderLineFsmDouble();
    const idempotency = makeIdempotencyHelperDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const validateVoucher = vi.fn(() =>
      Promise.resolve(
        opts.validateOutcome ?? {
          kind: 'validated' as const,
          applied_amount_minor: 1500,
          intent_expires_at: '2026-06-01T10:05:00.000Z',
          redemption_intent_token: 'opaque-intent-token-XYZ',
        },
      ),
    );
    const uuid = vi.fn(() => 'tl-v');
    const clock = vi.fn(() => new Date('2026-05-25T10:00:01.000Z'));
    const handler = createTenderApplyHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo,
      linesRepo,
      tenderLineFsm: fsm,
      idempotency,
      auditEmitter,
      validateVoucher,
      uuid,
      clock,
    });
    return { handler, fsm, validateVoucher, auditEmitter, idempotency };
  }

  it('routes voucher tender_type through V-A validate and returns ok on validated', async () => {
    const { handler, validateVoucher } = setupVoucher();
    const result = await handler(
      validRequest({
        tender_type: 'internal_voucher',
        voucher_code: 'V-CODE',
        amount_applied_minor: 1500,
      }),
    );
    expect(validateVoucher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: 'ok',
      tender_line_id: 'tl-v',
      applied_at: '2026-05-25T10:00:01.000Z',
    });
  });

  it('refuses with the closed-set voucher reason on V-A refused', async () => {
    const { handler } = setupVoucher({
      validateOutcome: { kind: 'refused', reason: 'voucher_expired' },
    });
    expect(
      await handler(
        validRequest({
          tender_type: 'internal_voucher',
          voucher_code: 'V-CODE',
          amount_applied_minor: 1500,
        }),
      ),
    ).toEqual({ kind: 'refused', reason: 'voucher_expired' });
  });

  it('refuses dependency_unavailable on V-A authority_unreachable', async () => {
    const { handler } = setupVoucher({ validateOutcome: { kind: 'authority_unreachable' } });
    expect(
      await handler(
        validRequest({
          tender_type: 'internal_voucher',
          voucher_code: 'V-CODE',
          amount_applied_minor: 1500,
        }),
      ),
    ).toEqual({ kind: 'refused', reason: 'dependency_unavailable' });
  });

  it('refuses invalid_input when voucher_code is missing or empty', async () => {
    const { handler } = setupVoucher();
    expect(await handler(validRequest({ tender_type: 'internal_voucher' }))).toEqual({
      kind: 'refused',
      reason: 'invalid_input',
    });
    expect(
      await handler(validRequest({ tender_type: 'internal_voucher', voucher_code: '' })),
    ).toEqual({ kind: 'refused', reason: 'invalid_input' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch-coverage backfill (CI gate — Slice 3 lines 156–166, 187–188).
//
// The voucher branch added in Wave 4 amplified two pre-existing Slice-3
// branches that lacked direct unit coverage:
//   • Replay reconstruction from a `refused`-state line row (lines 156–166).
//     Slice 3 only exercised the `applied` replay path; the refused path
//     is the persisted mirror for `non_cash_overpayment_refused` lines.
//   • The `appliedNetSum` accumulator loop body inside the voucher branch
//     (lines 187–188) — only executes when at least one prior `applied`
//     line exists on the attempt at voucher-apply time, including the
//     `change_due_minor ?? 0` nullish-coalesce.
// ─────────────────────────────────────────────────────────────────────────────

describe('tender.apply — branch-coverage backfill', () => {
  it('replays a prior refused tender line (idempotent replay → refusal echoed back)', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-prior-refused',
        tender_type: 'external_card_terminal',
        amount_applied_minor: 9999,
        state: 'refused',
        applied_at: null,
        refused_at: '2026-05-23T10:59:55.000Z',
        refusal_reason: 'non_cash_overpayment_refused',
        last_action_id: 'idem-apply-1',
      }),
    ]);
    const fsm = makeTenderLineFsmDouble();
    const handler = createTenderApplyHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo,
      tenderLineFsm: fsm,
      idempotency: makeIdempotencyHelperDouble({
        kind: 'replay',
        tender_line_id: 'tl-prior-refused',
      }),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'tl-NEW',
      clock: () => new Date('2026-05-23T11:00:01.000Z'),
    });
    const result = await handler(
      validRequest({
        tender_type: 'external_card_terminal',
        amount_applied_minor: 9999,
        external_reference: 'AB12XY',
      }),
    );
    expect(result).toEqual({
      kind: 'refused',
      reason: 'non_cash_overpayment_refused',
    });
    // The FSM is never re-invoked on replay — the outcome is reconstructed
    // from the persisted row's `refusal_reason` column.
    expect(fsm.apply).not.toHaveBeenCalled();
  });

  it('voucher branch computes remaining_balance against PRIOR applied lines on the attempt', async () => {
    // Seed a cash line that has already consumed 1000 of the 3000 envelope
    // subtotal (and overpaid by 100, with 100 change due → net 900) so the
    // appliedNetSum loop body and the change_due_minor nullish-coalesce both
    // execute. The voucher request then asks for 1500 against a remaining
    // balance of 3000 − 900 = 2100; V-A validates and returns ok.
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 3000 });
    const priorCash = makeLineRow({
      tender_line_id: 'tl-prior-cash',
      tender_type: 'cash',
      amount_applied_minor: 1000,
      change_due_minor: 100,
      applied_at: '2026-05-25T09:59:00.000Z',
      last_action_id: 'apply-prior-cash',
    });
    const linesRepo = makeLinesRepoDouble([priorCash]);
    const fsm = makeTenderLineFsmDouble();
    const validateVoucher = vi.fn(() =>
      Promise.resolve({
        kind: 'validated' as const,
        applied_amount_minor: 1500,
        intent_expires_at: '2026-06-01T10:05:00.000Z',
        redemption_intent_token: 'opaque-intent-token-XYZ',
      }),
    );
    const handler = createTenderApplyHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo,
      tenderLineFsm: fsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      validateVoucher,
      uuid: () => 'tl-v',
      clock: () => new Date('2026-05-25T10:00:01.000Z'),
    });
    const result = await handler(
      validRequest({
        tender_type: 'internal_voucher',
        voucher_code: 'V-CODE',
        amount_applied_minor: 1500,
      }),
    );
    expect(result).toEqual({
      kind: 'ok',
      tender_line_id: 'tl-v',
      applied_at: '2026-05-25T10:00:01.000Z',
    });
    expect(validateVoucher).toHaveBeenCalledTimes(1);
    expect(validateVoucher.mock.calls[0]?.[0]).toMatchObject({
      // 3000 envelope − (1000 amount − 100 change) = 2100 remaining.
      remaining_balance_minor: 2100,
    });
  });
});
