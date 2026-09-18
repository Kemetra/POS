/* eslint-disable @typescript-eslint/unbound-method --
 * Mirrors bridge.tender-apply.test.ts. We assert on `mock.calls` and on
 * `auditEmitter.captured` rather than `toHaveBeenCalledWith`, but the
 * lint rule still trips on the `Mock`-typed fields. The unbound-method
 * objection does not apply because the fixtures return plain functions
 * bound to their `this`-free closures.
 */
/**
 * 006 T220 — `vouchers.validate` bridge handler test (RED).
 *
 * Wave 4 — Slice 4 voucher entry path. Asserts (per
 * `specs/006-payments-tender/contracts/bridge-api.md` §"`vouchers.*`
 * namespace" + §"`tender.apply`" voucher branch, and §A4-B brief
 * §3.1–§3.4):
 *
 *   1. **Session / role / isolation gate** via requireOperatorSession:
 *      no_session, role_denied, tenant_isolation, wrong_owner,
 *      attempt_terminal.
 *   2. **V-A pass-through** — the handler computes
 *      `remaining_balance_minor` main-side and calls the injected
 *      `validateVoucher` function with the V-A request shape from
 *      `PosValidateVoucherRequest` (FR-017 / R-7).
 *   3. **Success path:** persists a `payment_tender_lines` row with
 *      `state='applied'` and `voucher_redemption_intent_token` set
 *      main-side. Response carries the new `tender_line_id`, the
 *      authority-confirmed `applied_amount_minor`, and `applied_at` —
 *      but NEVER the intent token (FR-017).
 *   4. **V-A refusal:** persists a `refused`-state line with the
 *      closed-set `refusal_reason`; response carries
 *      `{ kind: 'refused', reason }`.
 *   5. **authority_unreachable** → response is
 *      `{ kind: 'refused', reason: 'dependency_unavailable' }`. No
 *      persisted line (the V-A call never resolved; defer to the
 *      cashier).
 *   6. **Idempotency:** identical retry → replay returns the prior
 *      outcome reconstructed from the persisted line; mismatch refuses
 *      with `idempotency_payload_mismatch`.
 *   7. **F-A4B-001:** unknown V-A refusal codes are mapped via the
 *      voucher-authority-client client; the bridge layer trusts the closed
 *      enum returned and forwards refusals untouched (no parallel
 *      mapping path).
 */

import { describe, expect, it, vi } from 'vitest';

import { createVouchersValidateHandler } from '../../../../src/main/payments/handlers/vouchers-validate.js';

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
import type { VouchersValidateRequest } from '../../../../src/shared/bridge-api.js';
import type {
  ValidateVoucherOutcome,
  ValidateVoucherInput,
} from '../../../../src/main/payments/voucher-authority-client/validate.js';

function validRequest(overrides: Partial<VouchersValidateRequest> = {}): VouchersValidateRequest {
  return {
    payment_attempt_id: 'pa-1',
    voucher_code: 'V-CODE-1',
    amount_applied_minor: 1500,
    idempotency_key: 'idem-validate-1',
    ...overrides,
  };
}

function makeValidateVoucherDouble(
  outcome: ValidateVoucherOutcome = {
    kind: 'validated',
    applied_amount_minor: 1500,
    intent_expires_at: '2026-06-01T10:05:00.000Z',
    redemption_intent_token: 'opaque-intent-token-XYZ',
  },
) {
  return vi.fn<(input: ValidateVoucherInput) => Promise<ValidateVoucherOutcome>>(() =>
    Promise.resolve(outcome),
  );
}

function setup(
  opts: {
    validateOutcome?: ValidateVoucherOutcome;
    attemptRow?: ReturnType<typeof makeAttemptRow>;
  } = {},
) {
  const sessionSource = makeSessionSource(makeSession());
  const row = opts.attemptRow ?? makeAttemptRow({ envelope_subtotal_minor: 3000 });
  const attemptsRepo = makeAttemptsRepoDouble([row]);
  const linesRepo = makeLinesRepoDouble();
  const fsm = makeTenderLineFsmDouble();
  const idempotency = makeIdempotencyHelperDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const validateVoucher = makeValidateVoucherDouble(opts.validateOutcome);
  const uuid = vi.fn<() => string>(() => 'tl-VOUCHER-1');
  const clock = vi.fn<() => Date>(() => new Date('2026-05-25T10:00:01.000Z'));
  const handler = createVouchersValidateHandler({
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
  return {
    sessionSource,
    attemptsRepo,
    linesRepo,
    fsm,
    idempotency,
    auditEmitter,
    validateVoucher,
    uuid,
    clock,
    handler,
  };
}

describe('T220 — vouchers.validate bridge handler', () => {
  // ── 1. Session / role / isolation gate ────────────────────────────────────

  it('refuses no_session when there is no active session', async () => {
    const handler = createVouchersValidateHandler({
      getCurrentSession: makeSessionSource(null).getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble(),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      validateVoucher: makeValidateVoucherDouble(),
      uuid: () => 'tl-VOUCHER-1',
      clock: () => new Date('2026-05-25T10:00:01.000Z'),
    });
    expect(await handler(validRequest())).toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it('refuses tenant_isolation when the attempt is in another tenant scope', async () => {
    const row = makeAttemptRow({ tenant_id: 'tenant-OTHER' });
    const { handler } = setup({ attemptRow: row });
    expect(await handler(validRequest())).toEqual({ kind: 'refused', reason: 'tenant_isolation' });
  });

  it('refuses wrong_owner when the attempt belongs to another operator session', async () => {
    const row = makeAttemptRow({ operator_session_id: 'sess-OTHER' });
    const { handler } = setup({ attemptRow: row });
    expect(await handler(validRequest())).toEqual({ kind: 'refused', reason: 'wrong_owner' });
  });

  it('refuses attempt_terminal when the attempt is already settled / cancelled / failed', async () => {
    const row = makeAttemptRow({ state: 'settled' });
    const { handler } = setup({ attemptRow: row });
    expect(await handler(validRequest())).toEqual({ kind: 'refused', reason: 'attempt_terminal' });
  });

  it('refuses attempt_terminal when the attempt id is unknown', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const handler = createVouchersValidateHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([]),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      validateVoucher: makeValidateVoucherDouble(),
      uuid: () => 'tl-VOUCHER-1',
      clock: () => new Date('2026-05-25T10:00:01.000Z'),
    });
    expect(await handler(validRequest())).toEqual({ kind: 'refused', reason: 'attempt_terminal' });
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
      expect(await handler(validRequest({ amount_applied_minor: bad }))).toEqual({
        kind: 'refused',
        reason: 'invalid_input',
      });
    }
  });

  // ── 2. V-A pass-through ───────────────────────────────────────────────────

  it('calls validateVoucher with code + payment_attempt_id + amount + remaining_balance_minor', async () => {
    const row = makeAttemptRow({ envelope_subtotal_minor: 3000 });
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({ tender_line_id: 'tl-cash', tender_type: 'cash', amount_applied_minor: 1000 }),
    ]);
    const sessionSource = makeSessionSource(makeSession());
    const validateVoucher = makeValidateVoucherDouble();
    const handler = createVouchersValidateHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      validateVoucher,
      uuid: () => 'tl-VOUCHER-1',
      clock: () => new Date('2026-05-25T10:00:01.000Z'),
    });
    await handler(validRequest({ amount_applied_minor: 1500 }));
    expect(validateVoucher).toHaveBeenCalledTimes(1);
    expect(validateVoucher.mock.calls[0]?.[0]).toEqual({
      code: 'V-CODE-1',
      payment_attempt_id: 'pa-1',
      applied_amount_minor: 1500,
      remaining_balance_minor: 2000,
    });
  });

  // ── 3. Success path — persists applied line + ok response (FR-017 guard) ──

  it('returns ok with tender_line_id + applied_amount_minor + applied_at on V-A validated', async () => {
    const { handler } = setup();
    const result = await handler(validRequest());
    expect(result).toEqual({
      kind: 'ok',
      tender_line_id: 'tl-VOUCHER-1',
      applied_amount_minor: 1500,
      applied_at: '2026-05-25T10:00:01.000Z',
    });
  });

  it('drives the FSM with the V-A validated outcome so the line persists with intent token main-side', async () => {
    const { handler, fsm } = setup();
    await handler(validRequest());
    expect(fsm.apply).toHaveBeenCalledTimes(1);
    expect(fsm.apply.mock.calls[0]?.[0]).toMatchObject({
      tender_line_id: 'tl-VOUCHER-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_outcome: {
        kind: 'validated',
        applied_amount_minor: 1500,
        redemption_intent_token: 'opaque-intent-token-XYZ',
      },
      applied_at: '2026-05-25T10:00:01.000Z',
      action_id: 'idem-validate-1',
    });
  });

  it('response never contains voucher_redemption_intent_token or the raw code (FR-017)', async () => {
    const { handler } = setup({
      validateOutcome: {
        kind: 'validated',
        applied_amount_minor: 1500,
        intent_expires_at: '2026-06-01T10:05:00.000Z',
        redemption_intent_token: 'TOKEN-SECRET-VALUE',
      },
    });
    const result = await handler(validRequest({ voucher_code: 'V-SECRET-CODE' }));
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('voucher_redemption_intent_token');
    expect(serialised).not.toContain('redemption_intent_token');
    expect(serialised).not.toContain('TOKEN-SECRET-VALUE');
    expect(serialised).not.toContain('V-SECRET-CODE');
    expect(serialised).not.toContain('intent_expires_at');
  });

  it('emits tender.applied audit event on V-A success', async () => {
    const { handler, auditEmitter } = setup();
    await handler(validRequest());
    expect(auditEmitter.captured).toHaveLength(1);
    expect(auditEmitter.captured[0]?.action_category).toBe('tender.applied');
    expect(auditEmitter.captured[0]?.payload).toMatchObject({
      tender_line_id: 'tl-VOUCHER-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
    });
    // Defence — voucher_redemption_intent_token MUST NOT appear in the
    // emitter payload (the emitter's FORBIDDEN_PAYLOAD_KEYS would also
    // throw, but the bridge handler is the seam that guarantees the
    // forbidden key never reaches the emitter in the first place).
    const serialised = JSON.stringify(auditEmitter.captured[0]);
    expect(serialised).not.toContain('voucher_redemption_intent_token');
    expect(serialised).not.toContain('redemption_intent_token');
  });

  // ── 4. V-A refusal pass-through ───────────────────────────────────────────

  it('maps V-A voucher_not_found to the bridge refusal envelope', async () => {
    const { handler } = setup({
      validateOutcome: { kind: 'refused', reason: 'voucher_not_found' },
    });
    expect(await handler(validRequest())).toEqual({ kind: 'refused', reason: 'voucher_not_found' });
  });

  it.each([
    'voucher_expired',
    'voucher_cancelled',
    'voucher_already_redeemed',
    'voucher_tenant_mismatch',
    'voucher_branch_mismatch',
  ] as const)('maps V-A %s to the bridge refusal envelope', async (reason) => {
    const { handler } = setup({ validateOutcome: { kind: 'refused', reason } });
    expect(await handler(validRequest())).toEqual({ kind: 'refused', reason });
  });

  it('maps out-of-band V-A codes (validation_failure) to voucher_not_found (F-A4B-003 8→1 mapping)', async () => {
    const { handler } = setup({
      validateOutcome: { kind: 'refused', reason: 'validation_failure' },
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'voucher_not_found',
    });
  });

  // ── 5. authority_unreachable → dependency_unavailable ─────────────────────

  it('refuses non_cash_overpayment_refused when the FSM rejects the validated outcome (local balance too small)', async () => {
    const { handler, fsm, auditEmitter } = setup();
    // V-A validates (default success outcome) but the FSM refuses
    // because the local remaining balance was smaller than V-A's
    // authority-confirmed amount (R-7 defence-in-depth branch).
    fsm.apply.mockReturnValueOnce({
      kind: 'refused',
      reason: 'non_cash_overpayment_refused',
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'non_cash_overpayment_refused',
    });
    // tender.refused emitted by the helper.
    expect(auditEmitter.captured.some((e) => e.action_category === 'tender.refused')).toBe(true);
  });

  it('maps V-A authority_unreachable to refused/dependency_unavailable (no persisted line)', async () => {
    const { handler, fsm, auditEmitter } = setup({
      validateOutcome: { kind: 'authority_unreachable' },
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'dependency_unavailable' });
    // No FSM call — the V-A response never resolved.
    expect(fsm.apply).not.toHaveBeenCalled();
    // No audit emission — no persisted line.
    expect(auditEmitter.captured).toHaveLength(0);
  });

  // ── 6. Idempotency ────────────────────────────────────────────────────────

  it('refuses idempotency_payload_mismatch when the helper signals mismatch', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const handler = createVouchersValidateHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'mismatch' }),
      auditEmitter: makeAuditEmitterDouble(),
      validateVoucher: makeValidateVoucherDouble(),
      uuid: () => 'tl-VOUCHER-1',
      clock: () => new Date('2026-05-25T10:00:01.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
  });

  it('returns the prior outcome on idempotency replay (applied line)', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-VOUCHER-EXISTING',
        tender_type: 'internal_voucher',
        amount_applied_minor: 1500,
        applied_at: '2026-05-25T09:59:55.000Z',
        last_action_id: 'idem-validate-1',
      }),
    ]);
    const validateVoucher = makeValidateVoucherDouble();
    const handler = createVouchersValidateHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter: makeAuditEmitterDouble(),
      validateVoucher,
      uuid: () => 'tl-VOUCHER-1',
      clock: () => new Date('2026-05-25T10:00:01.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({
      kind: 'ok',
      tender_line_id: 'tl-VOUCHER-EXISTING',
      applied_amount_minor: 1500,
      applied_at: '2026-05-25T09:59:55.000Z',
    });
    expect(validateVoucher).not.toHaveBeenCalled();
  });

  it('replays a refused-state line as the prior refusal envelope', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-VOUCHER-REJECT',
        tender_type: 'internal_voucher',
        state: 'refused',
        refusal_reason: 'voucher_expired',
        last_action_id: 'idem-validate-1',
      }),
    ]);
    const handler = createVouchersValidateHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter: makeAuditEmitterDouble(),
      validateVoucher: makeValidateVoucherDouble(),
      uuid: () => 'tl-VOUCHER-1',
      clock: () => new Date('2026-05-25T10:00:01.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'voucher_expired',
    });
  });

  it('replay with no matching line refuses internal_error (impossible state but defended)', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const handler = createVouchersValidateHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter: makeAuditEmitterDouble(),
      validateVoucher: makeValidateVoucherDouble(),
      uuid: () => 'tl-VOUCHER-1',
      clock: () => new Date('2026-05-25T10:00:01.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'internal_error',
    });
  });

  it('does NOT emit any audit event on idempotency replay or mismatch', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-VOUCHER-EXISTING',
        tender_type: 'internal_voucher',
        last_action_id: 'idem-validate-1',
      }),
    ]);
    const auditEmitter = makeAuditEmitterDouble();
    const replayHandler = createVouchersValidateHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter,
      validateVoucher: makeValidateVoucherDouble(),
      uuid: () => 'tl-VOUCHER-1',
      clock: () => new Date('2026-05-25T10:00:01.000Z'),
    });
    await replayHandler(validRequest());
    expect(auditEmitter.captured).toHaveLength(0);
  });
});
