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
 *   • a replay still answers after the original action's rows have moved on
 *     (attempt cancelled, line reversed, voucher reversal pending)
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
import { hashActionPayload } from '../../../../src/main/payments/action-payload.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import { makeAuditEmitterDouble, makeSession } from './__fixtures__/bridge-handler-deps.js';
import type { OperatorSessionForPayments } from '../../../../src/main/payments/require-operator-session.js';
import type {
  ValidateVoucherInput,
  ValidateVoucherOutcome,
} from '../../../../src/main/payments/voucher-authority-client/validate.js';
import type {
  ReverseVoucherInput,
  ReverseVoucherOutcome,
} from '../../../../src/main/payments/voucher-authority-client/reverse.js';

type ValidateVoucherFn = (input: ValidateVoucherInput) => Promise<ValidateVoucherOutcome>;
type ReverseVoucherFn = (input: ReverseVoucherInput) => Promise<ReverseVoucherOutcome>;

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

// ── Stack ────────────────────────────────────────────────────────────────────

interface StackOptions {
  validateVoucher?: ValidateVoucherFn;
  reverseVoucher?: ReverseVoucherFn;
}

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

function build(options: StackOptions = {}) {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  const tenderLineFsm = createTenderLineFsm({ db: handle, attempts, lines, outbox });
  const paymentAttemptFsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
  const idempotency = createIdempotencyHelper({ outbox });
  const auditEmitter = makeAuditEmitterDouble();
  const { validateVoucher = cappedVoucherAuthority(0), reverseVoucher } = options;
  let session: OperatorSessionForPayments = makeSession();
  let n = 0;
  const shared = {
    getCurrentSession: (): OperatorSessionForPayments => session,
    attemptsRepo: attempts,
    idempotency,
    auditEmitter,
    clock: (): Date => new Date('2026-10-08T10:00:00.000Z'),
  };
  const uuid = (): string => `uuid-${String(++n)}`;

  return {
    outbox,
    lines,
    tenderLineFsm,
    useSession(next: OperatorSessionForPayments): void {
      session = next;
    },
    start: createPaymentsStartHandler({
      ...shared,
      paymentAttemptFsm,
      uuid,
      checkCartForPayment: () => ({ kind: 'ok' }),
      attemptHasLiveTender: () => false,
    }),
    apply: createTenderApplyHandler({
      ...shared,
      linesRepo: lines,
      tenderLineFsm,
      validateVoucher,
      uuid,
    }),
    validate: createVouchersValidateHandler({
      ...shared,
      linesRepo: lines,
      tenderLineFsm,
      validateVoucher,
      uuid,
    }),
    reverse: createTenderReverseHandler({
      ...shared,
      linesRepo: lines,
      tenderLineFsm,
      ...(reverseVoucher !== undefined ? { reverseVoucher } : {}),
    }),
    confirm: createPaymentsConfirmHandler({ ...shared, linesRepo: lines, paymentAttemptFsm }),
    cancel: createPaymentsCancelHandler({ ...shared, linesRepo: lines, paymentAttemptFsm }),
    forceFail: createPaymentsForceFailHandler({ ...shared, paymentAttemptFsm }),
  };
}

type Stack = ReturnType<typeof build>;

const MANAGER = makeSession({ role: 'manager', operator_id: 'op-manager' });

/** Runs `fn` as another operator, then restores the cashier session. */
async function as<T>(s: Stack, who: OperatorSessionForPayments, fn: () => Promise<T>): Promise<T> {
  s.useSession(who);
  try {
    return await fn();
  } finally {
    s.useSession(makeSession());
  }
}

function startRequest(key: string, cart: string, subtotal = 1500) {
  return {
    envelope_handoff_action_id: `handoff-${cart}`,
    envelope_cart_id: cart,
    envelope_subtotal_minor: subtotal,
    envelope_version: 'v1' as const,
    idempotency_key: key,
  };
}

async function startAttempt(s: Stack, cart = 'cart-1'): Promise<string> {
  const r = await s.start(startRequest(`k-start-${cart}`, cart));
  if (r.kind !== 'ok') throw new Error(`start refused: ${r.reason}`);
  return r.payment_attempt_id;
}

async function applyCash(s: Stack, attempt: string, key: string, amount: number): Promise<string> {
  const r = await s.apply({
    payment_attempt_id: attempt,
    tender_type: 'cash',
    amount_applied_minor: amount,
    idempotency_key: key,
  });
  if (r.kind !== 'ok') throw new Error(`apply refused: ${r.reason}`);
  return r.tender_line_id;
}

/** A started attempt on a fresh cart, fully tendered so it can be confirmed. */
async function tenderedAttempt(s: Stack, cart: string, amount = 1500): Promise<string> {
  const attempt = await startAttempt(s, cart);
  await applyCash(s, attempt, `k-apply-${cart}`, amount);
  return attempt;
}

const MISMATCH = { kind: 'refused', reason: 'idempotency_payload_mismatch' };

// ── Per action: replay and mismatch ─────────────────────────────────────────

type Variant = 'same' | 'different' | 'redacted';
type Act = (variant: Variant) => Promise<{ kind: string }>;

interface Scenario {
  name: string;
  options?: StackOptions;
  /** True when a retry differing only in a redacted field must still replay. */
  redacted?: boolean;
  /** Readies state and returns the action under test, parameterised by retry. */
  arrange(s: Stack): Promise<Act>;
}

/** An action that runs against one freshly started attempt. */
function onStartedAttempt(
  name: string,
  act: (s: Stack, attempt: string) => Act,
  extra: Pick<Scenario, 'options' | 'redacted'> = {},
): Scenario {
  return { name, ...extra, arrange: async (s) => act(s, await startAttempt(s)) };
}

/**
 * An attempt-level action: 'different' retargets the same key at another
 * attempt that is otherwise in the same state.
 */
function onAttempt(
  name: string,
  attempts: { original: (s: Stack) => Promise<string>; other: (s: Stack) => Promise<string> },
  run: (s: Stack, payment_attempt_id: string) => Promise<{ kind: string }>,
): Scenario {
  return {
    name,
    async arrange(s) {
      const original = await attempts.original(s);
      return async (v) => run(s, v === 'different' ? await attempts.other(s) : original);
    },
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'payments.start',
    arrange: (s) =>
      Promise.resolve((v) => s.start(startRequest('k', 'cart-1', v === 'different' ? 9999 : 1500))),
  },
  onStartedAttempt(
    'tender.apply (cash)',
    (s, attempt) => (v) =>
      s.apply({
        payment_attempt_id: attempt,
        tender_type: 'cash',
        amount_applied_minor: v === 'different' ? 1100 : 1000,
        idempotency_key: 'k',
      }),
  ),
  onStartedAttempt(
    'tender.apply (card terminal)',
    (s, attempt) => (v) =>
      s.apply({
        payment_attempt_id: attempt,
        tender_type: 'external_card_terminal',
        amount_applied_minor: v === 'different' ? 600 : 500,
        external_reference: v === 'redacted' ? 'ZZ99ZZ' : 'AB12XY',
        idempotency_key: 'k',
      }),
    { redacted: true },
  ),
  onStartedAttempt(
    'tender.apply (capped voucher)',
    (s, attempt) => (v) =>
      s.apply({
        payment_attempt_id: attempt,
        tender_type: 'internal_voucher',
        amount_applied_minor: v === 'different' ? 900 : 1000,
        voucher_code: v === 'redacted' ? 'V-TWO' : 'V-ONE',
        idempotency_key: 'k',
      }),
    { redacted: true, options: { validateVoucher: cappedVoucherAuthority(800) } },
  ),
  onStartedAttempt(
    'vouchers.validate',
    (s, attempt) => (v) =>
      s.validate({
        payment_attempt_id: attempt,
        voucher_code: 'V-CODE',
        amount_applied_minor: v === 'different' ? 900 : 1000,
        idempotency_key: 'k',
      }),
    { options: { validateVoucher: cappedVoucherAuthority(800) } },
  ),
  {
    name: 'tender.reverse',
    async arrange(s) {
      const attempt = await startAttempt(s);
      const first = await applyCash(s, attempt, 'k-a', 500);
      const second = await applyCash(s, attempt, 'k-b', 500);
      return (v) =>
        s.reverse({ tender_line_id: v === 'different' ? second : first, idempotency_key: 'k' });
    },
  },
  onAttempt(
    'payments.confirm',
    { original: (s) => tenderedAttempt(s, 'cart-a'), other: (s) => tenderedAttempt(s, 'cart-b') },
    (s, id) => s.confirm({ payment_attempt_id: id, idempotency_key: 'k' }),
  ),
  onAttempt(
    'payments.cancel',
    {
      original: (s) => tenderedAttempt(s, 'cart-a', 700),
      other: (s) => startAttempt(s, 'cart-b'),
    },
    (s, id) => s.cancel({ payment_attempt_id: id, idempotency_key: 'k' }),
  ),
  onAttempt(
    'payments.force_fail',
    { original: (s) => startAttempt(s, 'cart-a'), other: (s) => startAttempt(s, 'cart-b') },
    (s, id) => as(s, MANAGER, () => s.forceFail({ payment_attempt_id: id, idempotency_key: 'k' })),
  ),
];

describe.each(SCENARIOS)('RT-304 — $name', (scenario) => {
  const arrange = async () => {
    const s = build(scenario.options);
    return { s, act: await scenario.arrange(s) };
  };

  it('replays the original result on a same-key retry', async () => {
    const { act } = await arrange();
    const first = await act('same');
    const retry = await act('same');
    expect(first.kind).toBe('ok');
    expect(retry).toEqual(first);
  });

  it('refuses a same-key retry with a different request as a mismatch', async () => {
    const { act } = await arrange();
    await act('same');
    expect(await act('different')).toEqual(MISMATCH);
  });

  // Defined only where the action carries a redacted field, so the report has
  // no skipped placeholders.
  if (scenario.redacted === true) {
    it('treats a retry differing only in a redacted field as identical', async () => {
      const { act } = await arrange();
      const first = await act('same');
      expect(first.kind).toBe('ok');
      expect(await act('redacted')).toEqual(first);
    });
  }
});

describe('RT-304 — redaction at the hash boundary', () => {
  it('never hashes the voucher code: the stored hash is that of the payload without it', async () => {
    const s = build({ validateVoucher: cappedVoucherAuthority(1000) });
    const attempt = await startAttempt(s);
    await s.apply({
      payment_attempt_id: attempt,
      tender_type: 'internal_voucher',
      amount_applied_minor: 1000,
      voucher_code: 'V-SECRET-CODE',
      idempotency_key: 'k',
    });
    expect(s.outbox.findByActionId('k')?.action_payload_hash).toBe(
      hashActionPayload('tender.apply', {
        payment_attempt_id: attempt,
        tender_type: 'internal_voucher',
        amount_applied_minor: 1000,
      }),
    );
  });
});

// ── A replay still answers after the original action's rows moved on ────────

describe('RT-304 — replay after the original action has been superseded', () => {
  it('payments.start replays once its attempt is no longer started', async () => {
    const s = build();
    const req = startRequest('k-start', 'cart-1');
    const first = await s.start(req);
    if (first.kind !== 'ok') throw new Error('start refused');
    await s.cancel({ payment_attempt_id: first.payment_attempt_id, idempotency_key: 'k-cancel' });
    expect(await s.start(req)).toEqual(first);
  });

  it.each([
    ['terminal', { terminal_id: 'terminal-OTHER' }, 'tenant_isolation'],
    ['operator session', { operator_session_id: 'sess-NEW-SIGN-IN' }, 'wrong_owner'],
  ])(
    'payments.start refuses a replay made from another %s rather than leak the attempt id',
    async (_what, otherSession, reason) => {
      const s = build();
      const req = startRequest('k-start', 'cart-1');
      await s.start(req);
      s.useSession(makeSession(otherSession));
      expect(await s.start(req)).toEqual({ kind: 'refused', reason });
    },
  );

  it('payments.cancel replays only the lines this cancel reversed, not one reversed earlier', async () => {
    const s = build();
    const attempt = await startAttempt(s);
    const manual = await applyCash(s, attempt, 'k-a', 500);
    const swept = await applyCash(s, attempt, 'k-b', 500);
    await s.reverse({ tender_line_id: manual, idempotency_key: 'k-manual-rev' });
    const req = { payment_attempt_id: attempt, idempotency_key: 'k-cancel' };
    const first = await s.cancel(req);
    expect(first).toMatchObject({ kind: 'ok', reversed_tender_line_ids: [swept] });
    expect(await s.cancel(req)).toEqual(first);
  });

  it('tender.apply replays once its line has been reversed', async () => {
    const s = build();
    const attempt = await startAttempt(s);
    const req = {
      payment_attempt_id: attempt,
      tender_type: 'cash' as const,
      amount_applied_minor: 1000,
      idempotency_key: 'k-apply',
    };
    const first = await s.apply(req);
    if (first.kind !== 'ok') throw new Error('apply refused');
    await s.reverse({ tender_line_id: first.tender_line_id, idempotency_key: 'k-rev' });
    expect(await s.apply(req)).toEqual(first);
  });

  it('tender.reverse replays a voucher reversal that is still pending at the authority', async () => {
    const s = build({
      validateVoucher: cappedVoucherAuthority(1000),
      reverseVoucher: () => Promise.resolve({ kind: 'authority_unreachable' }),
    });
    const attempt = await startAttempt(s);
    const applied = await s.apply({
      payment_attempt_id: attempt,
      tender_type: 'internal_voucher',
      amount_applied_minor: 1000,
      voucher_code: 'V-CODE',
      idempotency_key: 'k-apply',
    });
    if (applied.kind !== 'ok') throw new Error('apply refused');
    s.lines.persistAuthorityRedemptionId({
      tender_line_id: applied.tender_line_id,
      voucher_authority_redemption_id: 'redemption-1',
      last_action_id: 'k-apply',
    });
    const req = { tender_line_id: applied.tender_line_id, idempotency_key: 'k-rev' };
    const first = await s.reverse(req);
    expect(first).toMatchObject({ kind: 'ok', state: 'reversal_pending' });
    expect(await s.reverse(req)).toEqual(first);

    // The deferred resolver later settles the line under its OWN action id.
    // The retry must still get the original pending answer and timestamp.
    s.tenderLineFsm.confirmReversed({
      tender_line_id: applied.tender_line_id,
      payment_attempt_id: attempt,
      reversed_at: '2026-10-08T11:30:00.000Z',
      attribution_operator_id: 'op-resolver',
      action_id: 'resolver-1',
    });
    expect(s.lines.findByLineId(applied.tender_line_id)?.state).toBe('reversed');
    expect(await s.reverse(req)).toEqual(first);
  });
});

describe('RT-339 — cash with nothing owed, through the real tender.apply handler', () => {
  it('is refused, writes nothing, and a same-key retry is evaluated again and refused again', async () => {
    const s = build();
    const attempt = await tenderedAttempt(s, 'cart-339');
    const again = {
      payment_attempt_id: attempt,
      tender_type: 'cash' as const,
      amount_applied_minor: 1500,
      idempotency_key: 'k-again',
    };
    const refused = { kind: 'refused', reason: 'attempt_fully_tendered' };

    expect(await s.apply(again)).toEqual(refused);
    expect(s.lines.findByAttempt(attempt)).toHaveLength(1);
    expect(s.outbox.findByActionId('k-again')).toBeUndefined();

    expect(await s.apply(again)).toEqual(refused);
    expect(s.lines.findByAttempt(attempt)).toHaveLength(1);

    // The original apply still replays on its own key, and the attempt settles on it.
    const original = await s.apply({ ...again, idempotency_key: 'k-apply-cart-339' });
    expect(original.kind).toBe('ok');
    const settled = await s.confirm({ payment_attempt_id: attempt, idempotency_key: 'k-confirm' });
    expect(settled.kind).toBe('ok');
  });
});
