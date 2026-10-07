/**
 * RT-304 — same-key replay through the REAL stack.
 *
 * Every other handler test injects a double for the FSM and/or the idempotency
 * helper, so none of them noticed that the outbox hash the FSM writes never
 * equalled the hash the helper checks. This file wires the real handlers, the
 * real FSMs, the real repositories and the real helper over an in-memory
 * SQLite database and asserts the 006 replay contract per action:
 *
 *   • same key + same request      → replay of the original result
 *   • same key + different request → `idempotency_payload_mismatch`
 *   • redacted fields (external_reference, voucher_code) never reach the hash
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bindPaymentActionOutboxRepository } from '../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { bindPaymentAttemptsRepository } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { createPaymentAttemptFsm } from '../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from '../../../../src/main/payments/fsm/tender-line-fsm.js';
import { createIdempotencyHelper } from '../../../../src/main/payments/idempotency.js';
import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';
import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';
import { createPaymentsCancelHandler } from '../../../../src/main/payments/handlers/payments-cancel.js';
import { createPaymentsForceFailHandler } from '../../../../src/main/payments/handlers/payments-force-fail.js';
import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import { createVouchersValidateHandler } from '../../../../src/main/payments/handlers/vouchers-validate.js';
import { createTenderReverseHandler } from '../../../../src/main/payments/handlers/tender-reverse.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import { makeAuditEmitterDouble, makeSession } from './__fixtures__/bridge-handler-deps.js';
import { hashActionPayload } from '../../../../src/main/payments/action-payload.js';
import type { OperatorSessionForPayments } from '../../../../src/main/payments/require-operator-session.js';
import type {
  ValidateVoucherInput,
  ValidateVoucherOutcome,
} from '../../../../src/main/payments/voucher-authority-client/validate.js';

type ValidateVoucherFn = (input: ValidateVoucherInput) => Promise<ValidateVoucherOutcome>;

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATION_DIR = path.join(REPO_ROOT, 'migrations');
const MIGRATIONS = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATION_DIR, f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
});

/** V-A answers every validate with the same capped value. */
function cappedVoucherAuthority(applied_amount_minor: number): ValidateVoucherFn {
  return () =>
    Promise.resolve({
      kind: 'validated' as const,
      applied_amount_minor,
      intent_expires_at: '2026-10-08T10:05:00.000Z',
      redemption_intent_token: 'opaque-intent-token-SECRET',
    });
}

function build(
  initialSession: OperatorSessionForPayments = makeSession(),
  validateVoucher?: ValidateVoucherFn,
) {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  const tenderLineFsm = createTenderLineFsm({ db: handle, attempts, lines, outbox });
  const paymentAttemptFsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
  const idempotency = createIdempotencyHelper({ outbox });
  const auditEmitter = makeAuditEmitterDouble();
  let session = initialSession;
  const getCurrentSession = (): OperatorSessionForPayments => session;
  let n = 0;
  const uuid = (): string => `uuid-${String(++n)}`;
  const clock = (): Date => new Date('2026-10-08T10:00:00.000Z');

  return {
    outbox,
    lines,
    attempts,
    useSession(next: OperatorSessionForPayments): void {
      session = next;
    },
    start: createPaymentsStartHandler({
      getCurrentSession,
      attemptsRepo: attempts,
      paymentAttemptFsm,
      idempotency,
      auditEmitter,
      uuid,
      clock,
      checkCartForPayment: () => ({ kind: 'ok' }),
      attemptHasLiveTender: () => false,
    }),
    apply: createTenderApplyHandler({
      getCurrentSession,
      attemptsRepo: attempts,
      linesRepo: lines,
      tenderLineFsm,
      idempotency,
      auditEmitter,
      ...(validateVoucher !== undefined ? { validateVoucher } : {}),
      uuid,
      clock,
    }),
    validate: createVouchersValidateHandler({
      getCurrentSession,
      attemptsRepo: attempts,
      linesRepo: lines,
      tenderLineFsm,
      idempotency,
      auditEmitter,
      validateVoucher: validateVoucher ?? cappedVoucherAuthority(0),
      uuid,
      clock,
    }),
    reverse: createTenderReverseHandler({
      getCurrentSession,
      attemptsRepo: attempts,
      linesRepo: lines,
      tenderLineFsm,
      idempotency,
      auditEmitter,
      clock,
    }),
    confirm: createPaymentsConfirmHandler({
      getCurrentSession,
      attemptsRepo: attempts,
      linesRepo: lines,
      paymentAttemptFsm,
      idempotency,
      auditEmitter,
      clock,
    }),
    cancel: createPaymentsCancelHandler({
      getCurrentSession,
      attemptsRepo: attempts,
      linesRepo: lines,
      paymentAttemptFsm,
      idempotency,
      auditEmitter,
      clock,
    }),
    forceFail: createPaymentsForceFailHandler({
      getCurrentSession,
      attemptsRepo: attempts,
      paymentAttemptFsm,
      idempotency,
      auditEmitter,
      clock,
    }),
  };
}

type Stack = ReturnType<typeof build>;

function startRequest(key: string, cart = 'cart-1', subtotal = 1500) {
  return {
    envelope_handoff_action_id: `handoff-${cart}`,
    envelope_cart_id: cart,
    envelope_subtotal_minor: subtotal,
    envelope_version: 'v1' as const,
    idempotency_key: key,
  };
}

async function startAttempt(s: Stack, key = 'k-start', cart = 'cart-1'): Promise<string> {
  const r = await s.start(startRequest(key, cart));
  if (r.kind !== 'ok') throw new Error(`start refused: ${r.reason}`);
  return r.payment_attempt_id;
}

describe('RT-304 — payments.start', () => {
  it('replays the original attempt on a same-key retry', async () => {
    const s = build();
    const first = await s.start(startRequest('k-start'));
    const retry = await s.start(startRequest('k-start'));
    expect(first.kind).toBe('ok');
    expect(retry).toEqual(first);
  });

  it('refuses a same-key retry with a different subtotal as a mismatch', async () => {
    const s = build();
    await s.start(startRequest('k-start'));
    const retry = await s.start(startRequest('k-start', 'cart-1', 9999));
    expect(retry).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });
});

describe('RT-304 — tender.apply', () => {
  it('replays a cash line on a same-key retry', async () => {
    const s = build();
    const attempt = await startAttempt(s);
    const req = {
      payment_attempt_id: attempt,
      tender_type: 'cash' as const,
      amount_applied_minor: 1000,
      idempotency_key: 'k-apply',
    };
    const first = await s.apply(req);
    const retry = await s.apply(req);
    expect(first.kind).toBe('ok');
    expect(retry).toEqual(first);
  });

  it('refuses a same-key retry with a different amount as a mismatch', async () => {
    const s = build();
    const attempt = await startAttempt(s);
    const base = {
      payment_attempt_id: attempt,
      tender_type: 'cash' as const,
      idempotency_key: 'k-apply',
    };
    await s.apply({ ...base, amount_applied_minor: 1000 });
    const retry = await s.apply({ ...base, amount_applied_minor: 1100 });
    expect(retry).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });

  it('treats retries that differ only in external_reference as identical (redacted)', async () => {
    const s = build();
    const attempt = await startAttempt(s);
    const base = {
      payment_attempt_id: attempt,
      tender_type: 'external_card_terminal' as const,
      amount_applied_minor: 500,
      idempotency_key: 'k-card',
    };
    const first = await s.apply({ ...base, external_reference: 'AB12XY' });
    const retry = await s.apply({ ...base, external_reference: 'ZZ99ZZ' });
    expect(first.kind).toBe('ok');
    expect(retry).toEqual(first);
  });
});

describe('RT-304 — tender.apply (voucher)', () => {
  const voucherRequest = (voucher_code: string, attempt: string) => ({
    payment_attempt_id: attempt,
    tender_type: 'internal_voucher' as const,
    amount_applied_minor: 1000,
    voucher_code,
    idempotency_key: 'k-voucher',
  });

  it('replays a capped voucher line: the retry carries the request, not the authority cap', async () => {
    const s = build(makeSession(), cappedVoucherAuthority(800));
    const attempt = await startAttempt(s);
    const first = await s.apply(voucherRequest('V-CODE', attempt));
    const retry = await s.apply(voucherRequest('V-CODE', attempt));
    expect(first.kind).toBe('ok');
    expect(retry).toEqual(first);
    expect(s.lines.findByAttempt(attempt)[0]?.amount_applied_minor).toBe(800);
  });

  it('treats retries that differ only in voucher_code as identical, and never hashes the code', async () => {
    const s = build(makeSession(), cappedVoucherAuthority(1000));
    const attempt = await startAttempt(s);
    const first = await s.apply(voucherRequest('V-ONE', attempt));
    const retry = await s.apply(voucherRequest('V-TWO', attempt));
    expect(first.kind).toBe('ok');
    expect(retry).toEqual(first);
    expect(s.outbox.findByActionId('k-voucher')?.action_payload_hash).toBe(
      hashActionPayload('tender.apply', {
        payment_attempt_id: attempt,
        tender_type: 'internal_voucher',
        amount_applied_minor: 1000,
      }),
    );
  });

  it('refuses a same-key retry with a different requested amount as a mismatch', async () => {
    const s = build(makeSession(), cappedVoucherAuthority(800));
    const attempt = await startAttempt(s);
    await s.apply(voucherRequest('V-CODE', attempt));
    const retry = await s.apply({
      ...voucherRequest('V-CODE', attempt),
      amount_applied_minor: 900,
    });
    expect(retry).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });
});

describe('RT-304 — vouchers.validate', () => {
  const validateRequest = (attempt: string, amount_applied_minor = 1000) => ({
    payment_attempt_id: attempt,
    voucher_code: 'V-CODE',
    amount_applied_minor,
    idempotency_key: 'k-validate',
  });

  it('replays a capped voucher line, reporting the persisted amount, on a same-key retry', async () => {
    const s = build(makeSession(), cappedVoucherAuthority(800));
    const attempt = await startAttempt(s);
    const first = await s.validate(validateRequest(attempt));
    const retry = await s.validate(validateRequest(attempt));
    expect(first).toMatchObject({ kind: 'ok', applied_amount_minor: 800 });
    expect(retry).toEqual(first);
  });

  it('refuses a same-key retry with a different requested amount as a mismatch', async () => {
    const s = build(makeSession(), cappedVoucherAuthority(800));
    const attempt = await startAttempt(s);
    await s.validate(validateRequest(attempt));
    const retry = await s.validate(validateRequest(attempt, 900));
    expect(retry).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });
});

describe('RT-304 — tender.reverse', () => {
  it('replays a reversal on a same-key retry', async () => {
    const s = build();
    const attempt = await startAttempt(s);
    const applied = await s.apply({
      payment_attempt_id: attempt,
      tender_type: 'cash',
      amount_applied_minor: 1000,
      idempotency_key: 'k-apply',
    });
    if (applied.kind !== 'ok') throw new Error('apply refused');
    const req = { tender_line_id: applied.tender_line_id, idempotency_key: 'k-rev' };
    const first = await s.reverse(req);
    const retry = await s.reverse(req);
    expect(first.kind).toBe('ok');
    expect(retry).toEqual(first);
  });

  it('refuses the same key reused for a different line as a mismatch', async () => {
    const s = build();
    const attempt = await startAttempt(s);
    const apply = (key: string) =>
      s.apply({
        payment_attempt_id: attempt,
        tender_type: 'cash',
        amount_applied_minor: 500,
        idempotency_key: key,
      });
    const a = await apply('k-a');
    const b = await apply('k-b');
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('apply refused');
    await s.reverse({ tender_line_id: a.tender_line_id, idempotency_key: 'k-rev' });
    const retry = await s.reverse({ tender_line_id: b.tender_line_id, idempotency_key: 'k-rev' });
    expect(retry).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });
});

describe('RT-304 — payments.confirm', () => {
  it('replays the settlement on a same-key retry', async () => {
    const s = build();
    const attempt = await startAttempt(s);
    await s.apply({
      payment_attempt_id: attempt,
      tender_type: 'cash',
      amount_applied_minor: 1500,
      idempotency_key: 'k-apply',
    });
    const req = { payment_attempt_id: attempt, idempotency_key: 'k-confirm' };
    const first = await s.confirm(req);
    const retry = await s.confirm(req);
    expect(first.kind).toBe('ok');
    expect(retry).toEqual(first);
  });

  it('refuses the same key reused for another attempt as a mismatch', async () => {
    const s = build();
    const a = await startAttempt(s, 'k-start-a', 'cart-a');
    await s.apply({
      payment_attempt_id: a,
      tender_type: 'cash',
      amount_applied_minor: 1500,
      idempotency_key: 'k-apply-a',
    });
    await s.confirm({ payment_attempt_id: a, idempotency_key: 'k-confirm' });
    const b = await startAttempt(s, 'k-start-b', 'cart-b');
    await s.apply({
      payment_attempt_id: b,
      tender_type: 'cash',
      amount_applied_minor: 1500,
      idempotency_key: 'k-apply-b',
    });
    const retry = await s.confirm({ payment_attempt_id: b, idempotency_key: 'k-confirm' });
    expect(retry).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });
});

describe('RT-304 — payments.cancel', () => {
  it('replays the cancellation (including its reversed lines) on a same-key retry', async () => {
    const s = build();
    const attempt = await startAttempt(s);
    await s.apply({
      payment_attempt_id: attempt,
      tender_type: 'cash',
      amount_applied_minor: 700,
      idempotency_key: 'k-apply',
    });
    const req = { payment_attempt_id: attempt, idempotency_key: 'k-cancel' };
    const first = await s.cancel(req);
    const retry = await s.cancel(req);
    expect(first.kind).toBe('ok');
    expect(retry).toEqual(first);
  });

  it('refuses the same key reused for another attempt as a mismatch', async () => {
    const s = build();
    const a = await startAttempt(s, 'k-start-a', 'cart-a');
    await s.cancel({ payment_attempt_id: a, idempotency_key: 'k-cancel' });
    const b = await startAttempt(s, 'k-start-b', 'cart-b');
    const retry = await s.cancel({ payment_attempt_id: b, idempotency_key: 'k-cancel' });
    expect(retry).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });
});

describe('RT-304 — payments.force_fail', () => {
  it('replays the force-fail on a same-key retry', async () => {
    const s = build();
    const attempt = await startAttempt(s);
    s.useSession(makeSession({ role: 'manager', operator_id: 'op-manager' }));
    const req = { payment_attempt_id: attempt, idempotency_key: 'k-ff' };
    const first = await s.forceFail(req);
    const retry = await s.forceFail(req);
    expect(first.kind).toBe('ok');
    expect(retry).toEqual(first);
  });

  it('refuses the same key reused for another attempt as a mismatch', async () => {
    const s = build();
    const a = await startAttempt(s, 'k-start-a', 'cart-a');
    s.useSession(makeSession({ role: 'manager', operator_id: 'op-manager' }));
    await s.forceFail({ payment_attempt_id: a, idempotency_key: 'k-ff' });
    s.useSession(makeSession());
    const b = await startAttempt(s, 'k-start-b', 'cart-b');
    s.useSession(makeSession({ role: 'manager', operator_id: 'op-manager' }));
    const retry = await s.forceFail({ payment_attempt_id: b, idempotency_key: 'k-ff' });
    expect(retry).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });
});
