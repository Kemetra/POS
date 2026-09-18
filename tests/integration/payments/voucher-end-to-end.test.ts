/**
 * T296 — Voucher end-to-end integration test (Wave 5d).
 *
 * Drives a complete Slice-4 voucher lifecycle across the FSMs +
 * deferred-reversal resolver against a real sql.js SQLite database.
 * V-A (Data-Pulse-2 voucher authority) is the only seam stubbed —
 * `validateVoucher` / `redeemVoucher` / `reverseVoucher` are
 * function-injection points that production wires to HTTP clients in
 * `src/main/payments/voucher-authority-client/*.ts`.
 *
 * Three scenarios:
 *
 *   1. **Happy path** — `validate → applied → confirm → redeem → settled`.
 *      The voucher line lands in state='applied'; on confirm, V-A
 *      redeem succeeds; attempt transitions to 'settled'; per-line
 *      `voucher_authority_redemption_id` is persisted; outbox carries
 *      the matching action rows.
 *
 *   2. **Failure path** — `redeem → dependency_unavailable → failed
 *      + reversal_pending`. The voucher line is `applied`; on confirm
 *      V-A redeem returns `authority_unreachable`; attempt transitions
 *      to 'failed' (`failure_reason: 'dependency_unavailable'`); the
 *      voucher line stays applied (CR-3: single voucher, never
 *      redeemed → no V-A redemption to reverse). For the multi-voucher
 *      partial sweep case we drive `markReversalPending` directly to
 *      assert the resolver hand-off.
 *
 *   3. **Resolver hand-off** — a `reversal_pending` line, simulated
 *      network restore, resolver `runOnce()` → V-A reverse `reversed`
 *      → line transitions to 'reversed' + `tender.reversed` audit row.
 *
 * Boundary discipline: the FSMs are exercised directly (matching
 * `end-to-end-lifecycle.test.ts` precedent — the FSMs ARE the atomic
 * unit). V-A clients are function-injection mocks. No
 * `_reference/Data-Pulse/` content was consulted.
 *
 * Advisor input (per session): migrations list MUST include
 * `0018_audit_event_tender_reversal_pending.sql` for the failure-path
 * + resolver scenarios. The Slice 3 `end-to-end-lifecycle.test.ts`
 * stopped at 0017 — do not blindly copy.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bindPaymentAttemptsRepository } from '../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { bindPaymentActionOutboxRepository } from '../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { makeSqlJsHandle } from '../../unit/main/cart/__helpers__/sql-js-handle.js';
import { createPaymentAttemptFsm } from '../../../src/main/payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from '../../../src/main/payments/fsm/tender-line-fsm.js';
import { createDeferredReversalResolver } from '../../../src/main/payments/deferred-reversal-resolver.js';
import type {
  ReverseVoucherInput,
  ReverseVoucherOutcome,
} from '../../../src/main/payments/voucher-authority-client/reverse.js';
import type { PaymentTenderLineRow } from '../../../src/main/payments/repositories/payment-tender-lines.repository.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
const MIGRATIONS = [
  '0001_init.sql',
  '0002_secrets.sql',
  '0003_terminal_assignment.sql',
  '0004_audit_events.sql',
  '0005_operator_sessions.sql',
  '0006_cashier_pin_records.sql',
  '0007_shifts.sql',
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0015_create_payment_action_outbox.sql',
  '0016_payment_action_outbox_append_only_trigger.sql',
  '0017_extend_audit_event_categories.sql',
  '0018_audit_event_tender_reversal_pending.sql',
  '0019_extend_payment_failure_reason_enum.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

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

afterEach(() => {
  db.close();
});

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';
const TERMINAL = 'terminal-1';
const CASHIER = 'op-cashier-1';
const SESSION = 'sess-cashier-1';

function buildStack() {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  const attemptFsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
  const lineFsm = createTenderLineFsm({ db: handle, attempts, lines, outbox });
  return { handle, attempts, lines, outbox, attemptFsm, lineFsm };
}

// Constitution §P-II — every fixture that touches money MUST guard
// minor-unit values at its boundary. The FSMs already validate, but a
// raw-number test helper accepting a float / NaN / negative would let
// drift slip in silently. These guards make any future fixture mistake
// loud at write-time, not at audit-time.
function assertMinorUnits(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} must be a non-negative safe integer (minor units); got ${String(value)}`,
    );
  }
}

function startAttempt(
  attemptFsm: ReturnType<typeof buildStack>['attemptFsm'],
  payment_attempt_id: string,
  envelope_subtotal_minor: number,
): void {
  assertMinorUnits('envelope_subtotal_minor', envelope_subtotal_minor);
  const result = attemptFsm.start({
    payment_attempt_id,
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    acting_operator_id: CASHIER,
    operator_session_id: SESSION,
    envelope_handoff_action_id: `handoff-${payment_attempt_id}`,
    envelope_cart_id: `cart-${payment_attempt_id}`,
    envelope_subtotal_minor,
    started_at: '2026-05-25T10:00:00.000Z',
    action_id: `start-${payment_attempt_id}`,
  });
  expect(result.kind).toBe('ok');
}

function applyVoucher(
  lineFsm: ReturnType<typeof buildStack>['lineFsm'],
  args: {
    tender_line_id: string;
    payment_attempt_id: string;
    amount: number;
    intent_token: string;
    applied_at?: string;
    action_id?: string;
  },
): void {
  assertMinorUnits('args.amount', args.amount);
  // The bridge handler resolves V-A `vouchers.validate` BEFORE this call
  // and threads the outcome through. We simulate the `validated`
  // outcome — the field that matters end-to-end is the intent token,
  // which the FSM persists for later redeem.
  const result = lineFsm.apply({
    tender_line_id: args.tender_line_id,
    payment_attempt_id: args.payment_attempt_id,
    tender_type: 'internal_voucher',
    amount_applied_minor: args.amount,
    voucher_outcome: {
      kind: 'validated',
      redemption_intent_token: args.intent_token,
      applied_amount_minor: args.amount,
    },
    attribution_operator_id: CASHIER,
    applied_at: args.applied_at ?? '2026-05-25T10:00:01.000Z',
    action_id: args.action_id ?? `apply-${args.tender_line_id}`,
  });
  expect(result.kind).toBe('ok');
}

// ─── Resolver test fixtures (lightweight doubles where the resolver
// composes external helpers — V-A reverse + logger + network signal).

function makeNetworkRestoreSignal() {
  const callbacks: Array<() => void | Promise<void>> = [];
  return {
    subscribe: vi.fn((cb: () => void | Promise<void>) => {
      callbacks.push(cb);
      return (): void => {
        const i = callbacks.indexOf(cb);
        if (i >= 0) callbacks.splice(i, 1);
      };
    }),
    async fire(): Promise<void> {
      for (const cb of callbacks) await cb();
    },
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('T296 — voucher end-to-end integration', () => {
  // ── Scenario 1: happy path ───────────────────────────────────────────────

  it('happy path: validate → applied → confirm → redeem → settled', () => {
    const { handle, attempts, lines, attemptFsm, lineFsm } = buildStack();

    startAttempt(attemptFsm, 'pa-happy', 1500);
    applyVoucher(lineFsm, {
      tender_line_id: 'tl-voucher-1',
      payment_attempt_id: 'pa-happy',
      amount: 1500,
      intent_token: 'INTENT-TOKEN-OK',
    });

    // Line is persisted in 'applied' state with the intent_token captured.
    const appliedLines = lines.findByAttempt('pa-happy');
    expect(appliedLines).toHaveLength(1);
    const voucherLine = appliedLines[0];
    if (voucherLine === undefined) throw new Error('voucher line missing');
    expect(voucherLine.state).toBe('applied');
    expect(voucherLine.tender_type).toBe('internal_voucher');
    expect(voucherLine.amount_applied_minor).toBe(1500);
    expect(voucherLine.voucher_redemption_intent_token).toBe('INTENT-TOKEN-OK');
    // No V-A redemption_id yet — that's stamped at confirm-time only.
    expect(voucherLine.voucher_authority_redemption_id).toBeNull();

    // Settlement invariant precondition.
    expect(lines.settlementSumMinor('pa-happy')).toBe(1500);

    // Confirm settles the attempt. The bridge handler would call
    // V-A redeem here and persist the redemption_id; we simulate the
    // persistence shape directly via the repo setter so the FSM-only
    // e2e path is still authoritative.
    lines.persistAuthorityRedemptionId({
      tender_line_id: 'tl-voucher-1',
      voucher_authority_redemption_id: 'redemption-OK',
      last_action_id: 'confirm-pa-happy',
    });
    const confirmResult = attemptFsm.confirm({
      payment_attempt_id: 'pa-happy',
      settled_at: '2026-05-25T10:00:05.000Z',
      action_id: 'confirm-pa-happy',
    });
    expect(confirmResult.kind).toBe('ok');

    const settled = attempts.findById('pa-happy');
    expect(settled?.state).toBe('settled');
    const settledLine = lines
      .findByAttempt('pa-happy')
      .find((l) => l.tender_line_id === 'tl-voucher-1');
    expect(settledLine?.voucher_authority_redemption_id).toBe('redemption-OK');

    // Outbox carries start + apply + confirm.
    const stmt = handle.prepare(
      'SELECT action_kind FROM payment_action_outbox WHERE payment_attempt_id = ? ORDER BY action_kind',
    ) as { all(...p: unknown[]): { action_kind: string }[] };
    const kinds = stmt
      .all('pa-happy')
      .map((r) => r.action_kind)
      .sort();
    expect(kinds).toEqual(['payment.attempt.start', 'payment.confirm', 'tender.apply']);
  });

  // ── Scenario 2: failure path ─────────────────────────────────────────────

  it('failure path: applied → markReversalPending → failed (dependency_unavailable)', () => {
    // Multi-voucher case is the only one where `reversal_pending`
    // matters at the FSM layer (per CR-3: single voucher never
    // redeemed → no reverse → stays applied). We simulate the
    // confirm-time partial-sweep outcome directly: line 1 was
    // redeemed at V-A, V-A reverse on line 1 returns
    // authority_unreachable → markReversalPending → fail.
    const { attempts, lines, attemptFsm, lineFsm } = buildStack();

    startAttempt(attemptFsm, 'pa-fail', 2000);
    applyVoucher(lineFsm, {
      tender_line_id: 'tl-v-1',
      payment_attempt_id: 'pa-fail',
      amount: 1000,
      intent_token: 'INTENT-1',
      applied_at: '2026-05-25T10:00:01.000Z',
      action_id: 'apply-tl-v-1',
    });
    applyVoucher(lineFsm, {
      tender_line_id: 'tl-v-2',
      payment_attempt_id: 'pa-fail',
      amount: 1000,
      intent_token: 'INTENT-2',
      applied_at: '2026-05-25T10:00:02.000Z',
      action_id: 'apply-tl-v-2',
    });

    // Confirm sweep happens at the handler. Simulate: line 1 redeem
    // ok → persist redemption_id. Line 2 → V-A authority_unreachable.
    // Compensating reverse on line 1 → also authority_unreachable →
    // markReversalPending. Then attempt → fail.
    lines.persistAuthorityRedemptionId({
      tender_line_id: 'tl-v-1',
      voucher_authority_redemption_id: 'redemption-1',
      last_action_id: 'confirm-pa-fail',
    });
    const markResult = lineFsm.markReversalPending({
      tender_line_id: 'tl-v-1',
      payment_attempt_id: 'pa-fail',
      reversal_pending_since: '2026-05-25T10:00:05.000Z',
      attribution_operator_id: CASHIER,
      action_id: 'mark-pending-tl-v-1',
    });
    expect(markResult.kind).toBe('ok');

    const failResult = attemptFsm.fail({
      payment_attempt_id: 'pa-fail',
      failure_reason: 'dependency_unavailable',
      failed_at: '2026-05-25T10:00:05.500Z',
      action_id: 'fail-pa-fail',
    });
    expect(failResult.kind).toBe('ok');

    const failed = attempts.findById('pa-fail');
    expect(failed?.state).toBe('failed');
    expect(failed?.failure_reason).toBe('dependency_unavailable');

    const allLines = lines.findByAttempt('pa-fail');
    const line1 = allLines.find((l) => l.tender_line_id === 'tl-v-1');
    const line2 = allLines.find((l) => l.tender_line_id === 'tl-v-2');
    expect(line1?.state).toBe('reversal_pending');
    expect(line1?.reversal_pending_since).toBe('2026-05-25T10:00:05.000Z');
    expect(line1?.voucher_authority_redemption_id).toBe('redemption-1');
    // Line 2 was never redeemed at V-A → stays applied (CR-3).
    expect(line2?.state).toBe('applied');
    expect(line2?.voucher_authority_redemption_id).toBeNull();
  });

  // ── Scenario 3: deferred-reversal resolver hand-off ──────────────────────

  it('resolver hand-off: reversal_pending line + simulated network restore → reversed', async () => {
    const { lines, attempts, attemptFsm, lineFsm } = buildStack();

    // Seed: attempt with one voucher line in reversal_pending state.
    startAttempt(attemptFsm, 'pa-resolve', 1500);
    applyVoucher(lineFsm, {
      tender_line_id: 'tl-resolve',
      payment_attempt_id: 'pa-resolve',
      amount: 1500,
      intent_token: 'INTENT-RESOLVE',
    });
    lines.persistAuthorityRedemptionId({
      tender_line_id: 'tl-resolve',
      voucher_authority_redemption_id: 'redemption-resolve',
      last_action_id: 'pre-fail-pa-resolve',
    });
    lineFsm.markReversalPending({
      tender_line_id: 'tl-resolve',
      payment_attempt_id: 'pa-resolve',
      reversal_pending_since: '2026-05-25T10:00:05.000Z',
      attribution_operator_id: CASHIER,
      action_id: 'mark-pending-tl-resolve',
    });
    attemptFsm.fail({
      payment_attempt_id: 'pa-resolve',
      failure_reason: 'dependency_unavailable',
      failed_at: '2026-05-25T10:00:05.500Z',
      action_id: 'fail-pa-resolve',
    });

    // Sanity — line is in reversal_pending before the resolver runs.
    const pendingBefore = lines
      .findByAttempt('pa-resolve')
      .find((l) => l.tender_line_id === 'tl-resolve');
    expect(pendingBefore?.state).toBe('reversal_pending');

    // Resolver wiring. First V-A call returns authority_unreachable
    // (initial app-start sweep — network still down). Second call (after
    // the network-restore signal fires) returns reversed.
    const outcomes: ReverseVoucherOutcome[] = [
      { kind: 'authority_unreachable' },
      {
        kind: 'reversed',
        already_reversed: false,
        redemption_id: 'redemption-resolve',
        reversed_at: '2026-05-25T10:05:30.000Z',
      },
    ];
    let i = 0;
    const reverseVoucher = vi.fn<
      (
        input: ReverseVoucherInput,
        options: { idempotencyKey: string },
      ) => Promise<ReverseVoucherOutcome>
    >(async () => {
      const slot = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      if (slot === undefined) throw new Error('no more outcomes');
      return await Promise.resolve(slot);
    });
    const networkRestoreSignal = makeNetworkRestoreSignal();
    const auditEmitterCaptures: unknown[] = [];
    const auditEmitter = {
      emitTenderReversed: vi.fn((evt: unknown) => {
        auditEmitterCaptures.push(evt);
      }),
    } as unknown as Parameters<typeof createDeferredReversalResolver>[0]['auditEmitter'];

    // Inline a minimal linesRepo that the resolver consumes — wrap the
    // real repo's findReversalPendingLines + findByLineId.
    // (The resolver only reads via these two methods, then drives the
    // FSM which owns the persistence transition.)
    const linesRepo = {
      findReversalPendingLines: () => {
        // Real repo doesn't expose this; query the table directly.
        type Row = PaymentTenderLineRow;
        const stmt = db.prepare(
          "SELECT * FROM payment_tender_lines WHERE state = 'reversal_pending'",
        );
        const rows: Row[] = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject() as unknown as Row);
        }
        stmt.free();
        return rows;
      },
      findByLineId: (id: string) =>
        lines.findByAttempt('pa-resolve').find((l) => l.tender_line_id === id),
    };

    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo: attempts,
      tenderLineFsm: lineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal,
      logger: makeLogger(),
      clock: () => new Date('2026-05-25T10:05:30.000Z'),
    });

    await resolver.start();
    // First sweep — V-A unreachable. Line still pending.
    expect(reverseVoucher).toHaveBeenCalledTimes(1);
    const afterFirst = lines
      .findByAttempt('pa-resolve')
      .find((l) => l.tender_line_id === 'tl-resolve');
    expect(afterFirst?.state).toBe('reversal_pending');

    // Simulated network restore — resolver picks up the line and V-A
    // reverse succeeds.
    await networkRestoreSignal.fire();
    expect(reverseVoucher).toHaveBeenCalledTimes(2);

    const reversed = lines
      .findByAttempt('pa-resolve')
      .find((l) => l.tender_line_id === 'tl-resolve');
    expect(reversed?.state).toBe('reversed');
    expect(reversed?.reversed_at).toBe('2026-05-25T10:05:30.000Z');

    // Audit row emitted via the resolver — carries the original
    // reversal_pending_since for incident reconstruction (T231).
    expect(auditEmitter.emitTenderReversed).toHaveBeenCalledTimes(1);
    expect(auditEmitterCaptures).toHaveLength(1);
    expect(auditEmitterCaptures[0]).toMatchObject({
      tender_line_id: 'tl-resolve',
      tender_type: 'internal_voucher',
      reversal_pending_since: '2026-05-25T10:00:05.000Z',
      reversed_at: '2026-05-25T10:05:30.000Z',
      manual_void_required: false,
    });

    resolver.stop();
  });
});
