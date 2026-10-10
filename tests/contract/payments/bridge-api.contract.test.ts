/**
 * T070 — 006 Slice 3b bridge-api contract test.
 *
 * Asserts (compile-time + runtime) that `src/shared/bridge-api.ts` extends
 * `PreloadBridgeAPI` with the Slice-3 subset of the `payments.*` + `tender.*`
 * namespaces declared in `specs/006-payments-tender/contracts/bridge-api.md`.
 *
 * **Slice-3 subset only.** This test deliberately does NOT cover
 * `payments.forceFail` or `vouchers.*` — those are Slice 4 and are out of
 * scope for S3b. The test also does NOT cover `payments.discardOnSessionEnd`
 * because that handler is main-process-internal (never crosses the bridge).
 *
 * Shared types asserted to exist:
 *   • PaymentAttemptState (5-value closed union)
 *   • TenderLineState (5-value closed union)
 *   • TenderType (3-value closed union)
 *   • FailureReason (14-value closed enum)
 *   • RefusalReason (closed union covering attempt-level + per-line refusals)
 *
 * Handler shapes asserted (Request + Response per contract):
 *   payments.start · payments.confirm · payments.cancel
 *   payments.subscribe · payments.read
 *   tender.apply · tender.reverse · tender.read
 */

import { describe, it, expect } from 'vitest';
import type { PreloadBridgeAPI } from '../../../src/shared/bridge-api.js';
import {
  PAYMENT_ATTEMPT_STATES,
  TENDER_LINE_STATES,
  TENDER_TYPES,
  FAILURE_REASONS,
  REFUSAL_REASONS,
} from '../../../src/shared/payments/types.js';
import type {
  PaymentAttemptState,
  TenderLineState,
  TenderType,
  FailureReason,
  RefusalReason,
} from '../../../src/shared/payments/types.js';
import type {
  PaymentsStartRequest,
  PaymentsStartResponse,
  PaymentsConfirmRequest,
  PaymentsConfirmResponse,
  PaymentsCancelRequest,
  PaymentsCancelResponse,
  PaymentsReadRequest,
  PaymentsReadResponse,
  PaymentsSubscribeRequest,
  PaymentsSubscribeResponse,
  TenderApplyRequest,
  TenderApplyResponse,
  TenderReverseRequest,
  TenderReverseResponse,
  TenderReadRequest,
  TenderReadResponse,
  PaymentsBridgeAPI,
  TenderBridgeAPI,
} from '../../../src/shared/bridge-api.js';

// ── PreloadBridgeAPI shape ────────────────────────────────────────────────────

describe('006 bridge-api contract — namespace presence on PreloadBridgeAPI', () => {
  it('PreloadBridgeAPI declares the payments namespace', () => {
    // Compile-time shape check — the type extraction fails to compile if
    // `payments` is missing from PreloadBridgeAPI.
    type HasPayments = PreloadBridgeAPI['payments'];
    const _check: HasPayments | undefined = undefined;
    expect(_check).toBeUndefined();
  });

  it('PreloadBridgeAPI declares the tender namespace', () => {
    type HasTender = PreloadBridgeAPI['tender'];
    const _check: HasTender | undefined = undefined;
    expect(_check).toBeUndefined();
  });
});

// ── Closed unions ─────────────────────────────────────────────────────────────

describe('006 bridge-api contract — shared closed unions', () => {
  it('PaymentAttemptState has exactly five values', () => {
    const allowed: readonly PaymentAttemptState[] = PAYMENT_ATTEMPT_STATES;
    expect(allowed).toHaveLength(5);
    expect(new Set(allowed)).toEqual(
      new Set(['started', 'settled', 'cancelled', 'failed', 'force_failed']),
    );
  });

  it('TenderLineState has exactly five values', () => {
    const allowed: readonly TenderLineState[] = TENDER_LINE_STATES;
    expect(allowed).toHaveLength(5);
    expect(new Set(allowed)).toEqual(
      new Set(['applying', 'applied', 'refused', 'reversed', 'reversal_pending']),
    );
  });

  it('TenderType has exactly three values', () => {
    const allowed: readonly TenderType[] = TENDER_TYPES;
    expect(allowed).toHaveLength(3);
    expect(new Set(allowed)).toEqual(
      new Set(['cash', 'external_card_terminal', 'internal_voucher']),
    );
  });

  it('FailureReason is the FR-006 14-value closed enum', () => {
    const allowed: readonly FailureReason[] = FAILURE_REASONS;
    expect(allowed).toHaveLength(14);
    expect(new Set(allowed)).toEqual(
      new Set([
        'cart_lost',
        'operator_session_terminated',
        'dependency_unavailable',
        'internal_error',
        'stale_handoff',
        'tender_underpaid',
        'non_cash_overpayment_refused',
        'voucher_not_found',
        'voucher_expired',
        'voucher_cancelled',
        'voucher_already_redeemed',
        'voucher_tenant_mismatch',
        'voucher_branch_mismatch',
        'split_tender_rollback',
      ]),
    );
  });

  it('RefusalReason covers Slice-3 attempt-level + per-line refusals', () => {
    const allowed: readonly RefusalReason[] = REFUSAL_REASONS;
    const required: RefusalReason[] = [
      'no_session',
      'role_denied',
      'wrong_owner',
      'tenant_isolation',
      'cart_lost',
      'stale_handoff',
      'attempt_already_started_on_terminal',
      'attempt_terminal',
      'tender_underpaid',
      'attempt_fully_tendered',
      'internal_error',
      'idempotency_payload_mismatch',
      'invalid_input',
      'non_cash_overpayment_refused',
      'tender_not_yet_supported',
      'line_not_applied',
      'dependency_unavailable',
    ];
    for (const r of required) {
      expect(allowed).toContain(r);
    }
  });
});

// Helper: narrow a discriminated-union response without triggering
// "Unnecessary conditional" lint errors when the test constructs the literal
// value directly.
function isOk<T extends { kind: string }>(r: T): r is Extract<T, { kind: 'ok' }> {
  return r.kind === 'ok';
}

// ── payments.start ────────────────────────────────────────────────────────────

describe('006 bridge-api contract — payments.start', () => {
  it('PaymentsStartRequest carries the envelope handoff fields + idempotency key', () => {
    const req: PaymentsStartRequest = {
      envelope_handoff_action_id: 'handoff-uuid-v4',
      envelope_cart_id: 'cart-uuid-v4',
      envelope_subtotal_minor: 1500,
      envelope_version: 'v1',
      idempotency_key: 'idem-uuid-v4',
    };
    expect(req.envelope_subtotal_minor).toBe(1500);
    expect(req.envelope_version).toBe('v1');
  });

  it('PaymentsStartResponse ok variant has payment_attempt_id', () => {
    const ok: PaymentsStartResponse = { kind: 'ok', payment_attempt_id: 'pa-1' };
    expect(isOk(ok)).toBe(true);
    if (isOk(ok)) expect(typeof ok.payment_attempt_id).toBe('string');
  });

  it('PaymentsStartResponse refused variant carries a RefusalReason', () => {
    const refused: PaymentsStartResponse = {
      kind: 'refused',
      reason: 'attempt_already_started_on_terminal',
    };
    expect(refused.kind).toBe('refused');
    expect(typeof (refused as { reason: string }).reason).toBe('string');
  });
});

// ── payments.confirm ──────────────────────────────────────────────────────────

describe('006 bridge-api contract — payments.confirm', () => {
  it('PaymentsConfirmRequest has payment_attempt_id + idempotency_key', () => {
    const req: PaymentsConfirmRequest = {
      payment_attempt_id: 'pa-1',
      idempotency_key: 'idem-uuid-v4',
    };
    expect(typeof req.payment_attempt_id).toBe('string');
  });

  it('PaymentsConfirmResponse ok variant has settled_at', () => {
    const ok: PaymentsConfirmResponse = {
      kind: 'ok',
      settled_at: '2026-05-22T10:00:00.000Z',
    };
    if (isOk(ok)) expect(typeof ok.settled_at).toBe('string');
  });
});

// ── payments.cancel ───────────────────────────────────────────────────────────

describe('006 bridge-api contract — payments.cancel', () => {
  it('PaymentsCancelRequest has payment_attempt_id + idempotency_key', () => {
    const req: PaymentsCancelRequest = {
      payment_attempt_id: 'pa-1',
      idempotency_key: 'idem-uuid-v4',
    };
    expect(typeof req.payment_attempt_id).toBe('string');
  });

  it('PaymentsCancelResponse ok variant carries reversed/reversal_pending line ids', () => {
    const ok: PaymentsCancelResponse = {
      kind: 'ok',
      cancelled_at: '2026-05-22T10:00:00.000Z',
      reversed_tender_line_ids: ['l-1', 'l-2'],
      reversal_pending_tender_line_ids: [],
    };
    if (isOk(ok)) {
      expect(ok.reversed_tender_line_ids).toEqual(['l-1', 'l-2']);
      expect(ok.reversal_pending_tender_line_ids).toEqual([]);
    }
  });
});

// ── payments.read + payments.subscribe ────────────────────────────────────────

describe('006 bridge-api contract — payments.read + payments.subscribe', () => {
  it('PaymentsReadRequest carries only payment_attempt_id (pure read)', () => {
    const req: PaymentsReadRequest = { payment_attempt_id: 'pa-1' };
    expect(typeof req.payment_attempt_id).toBe('string');
  });

  it('PaymentsReadResponse exposes minimised renderer view (no voucher tokens)', () => {
    const resp: PaymentsReadResponse = {
      kind: 'ok',
      payment_attempt: {
        payment_attempt_id: 'pa-1',
        state: 'started',
        envelope_subtotal_minor: 1500,
        started_at: '2026-05-22T10:00:00.000Z',
        tender_lines: [],
      },
    };
    if (isOk(resp)) {
      expect(resp.payment_attempt.envelope_subtotal_minor).toBe(1500);
    }
  });

  it('PaymentsSubscribeRequest matches read shape', () => {
    const req: PaymentsSubscribeRequest = { payment_attempt_id: 'pa-1' };
    expect(typeof req.payment_attempt_id).toBe('string');
    const resp: PaymentsSubscribeResponse = {
      kind: 'ok',
      payment_attempt: {
        payment_attempt_id: 'pa-1',
        state: 'started',
        envelope_subtotal_minor: 1500,
        started_at: '2026-05-22T10:00:00.000Z',
        tender_lines: [],
      },
    };
    if (isOk(resp)) expect(resp.payment_attempt.state).toBe('started');
  });
});

// ── tender.apply ──────────────────────────────────────────────────────────────

describe('006 bridge-api contract — tender.apply', () => {
  it('TenderApplyRequest accepts cash without external_reference', () => {
    const req: TenderApplyRequest = {
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1500,
      idempotency_key: 'idem-uuid-v4',
    };
    expect(req.tender_type).toBe('cash');
  });

  it('TenderApplyRequest accepts external_card_terminal with optional reference', () => {
    const req: TenderApplyRequest = {
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 1500,
      external_reference: 'AB12XY',
      idempotency_key: 'idem-uuid-v4',
    };
    expect(req.external_reference).toBe('AB12XY');
  });

  it('TenderApplyResponse ok variant carries tender_line_id + optional change_due_minor', () => {
    const ok: TenderApplyResponse = {
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: '2026-05-22T10:00:00.000Z',
      change_due_minor: 250,
    };
    if (isOk(ok)) expect(ok.change_due_minor).toBe(250);
  });
});

// ── tender.reverse + tender.read ──────────────────────────────────────────────

describe('006 bridge-api contract — tender.reverse + tender.read', () => {
  it('TenderReverseRequest accepts tender_line_id + idempotency_key', () => {
    const req: TenderReverseRequest = {
      tender_line_id: 'tl-1',
      idempotency_key: 'idem-uuid-v4',
    };
    expect(typeof req.tender_line_id).toBe('string');
  });

  it('TenderReverseResponse ok variant exposes reversed / reversal_pending state', () => {
    const ok: TenderReverseResponse = {
      kind: 'ok',
      reversed_at: '2026-05-22T10:00:00.000Z',
      state: 'reversed',
    };
    if (isOk(ok)) expect(ok.state).toBe('reversed');
  });

  it('TenderReadRequest accepts tender_line_id', () => {
    const req: TenderReadRequest = { tender_line_id: 'tl-1' };
    expect(typeof req.tender_line_id).toBe('string');
  });

  it('TenderReadResponse exposes the minimised renderer line view', () => {
    const resp: TenderReadResponse = {
      kind: 'ok',
      tender_line: {
        tender_line_id: 'tl-1',
        tender_type: 'cash',
        amount_applied_minor: 1500,
        state: 'applied',
        apply_order: 1,
      },
    };
    if (isOk(resp)) expect(resp.tender_line.tender_type).toBe('cash');
  });
});

// ── Namespace interfaces ──────────────────────────────────────────────────────

describe('006 bridge-api contract — typed namespaces', () => {
  it('PaymentsBridgeAPI declares Slice-3 handler signatures (compile-time only)', () => {
    type Keys = keyof PaymentsBridgeAPI;
    const expectedKeys: Keys[] = ['start', 'confirm', 'cancel', 'subscribe', 'read'];
    expect(expectedKeys).toHaveLength(5);
  });

  it('TenderBridgeAPI declares Slice-3 handler signatures (compile-time only)', () => {
    type Keys = keyof TenderBridgeAPI;
    const expectedKeys: Keys[] = ['apply', 'reverse', 'read'];
    expect(expectedKeys).toHaveLength(3);
  });

  it('PaymentsBridgeAPI does NOT declare forceFail (Slice 4)', () => {
    // Compile-time negative — if `forceFail` is ever added to
    // PaymentsBridgeAPI, the `@ts-expect-error` directive flips from
    // "expected error" to "no error" and tsc fails the build, blocking
    // Slice-4 surface from leaking into Slice 3 silently.
    // @ts-expect-error 'forceFail' is Slice 4 and must not be a key of PaymentsBridgeAPI.
    const _forbidden: keyof PaymentsBridgeAPI = 'forceFail';
    void _forbidden;
    expect(true).toBe(true);
  });
});
