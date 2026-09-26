/**
 * S3c — `registerPaymentsHandlers` IPC registrar test.
 *
 * Mirrors `tests/unit/main/ipc/cart.test.ts`. Verifies:
 *   • Every `payments.*` + `tender.*` channel registers exactly once.
 *   • Input validation refuses malformed payloads generically with
 *     `{ kind: 'refused', reason: 'invalid_input' }` (NFR-003 / PR-2 —
 *     no field-name leakage).
 *   • Money-invariant guard (Constitution §II, CR-1) — `envelope_subtotal_minor`
 *     and `amount_applied_minor` refuse floats, negatives, NaN, infinity,
 *     and unsafe integers AT THE IPC BOUNDARY, before the handler is
 *     called.
 *   • Valid payloads forward to the underlying handler.
 *
 * SECURITY: this test is the trust-boundary acceptance gate for the
 * payments IPC surface. It MUST cover every refusal path that gates
 * the renderer against the FSM.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerPaymentsHandlers } from '../../../../src/main/ipc/payments.js';
import {
  PAYMENTS_IPC_CHANNELS,
  TENDER_IPC_CHANNELS,
} from '../../../../src/shared/payments/channels.js';
import type {
  PaymentsCancelResponse,
  PaymentsConfirmResponse,
  PaymentsForceFailResponse,
  PaymentsReadResponse,
  PaymentsStartResponse,
  PaymentsSubscribeResponse,
  TenderApplyResponse,
  TenderReadResponse,
  TenderReverseResponse,
} from '../../../../src/shared/bridge-api.js';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function mkIpc(): { ipcMain: IpcMain; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, fn: Handler): void => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

function fakeEvent(): IpcMainInvokeEvent {
  return {} as IpcMainInvokeEvent;
}

function mkDeps() {
  // Every handler resolves to a generic refused outcome by default so
  // forwarding can be detected via vi.fn().mock.calls without having to
  // build full Response shapes per assertion. The forwarding-asserting
  // tests below replace specific handlers with response-shaped fakes.
  const refusedStart: PaymentsStartResponse = { kind: 'refused', reason: 'no_session' };
  const refusedConfirm: PaymentsConfirmResponse = { kind: 'refused', reason: 'no_session' };
  const refusedCancel: PaymentsCancelResponse = { kind: 'refused', reason: 'no_session' };
  const refusedSubscribe: PaymentsSubscribeResponse = { kind: 'refused', reason: 'no_session' };
  const refusedRead: PaymentsReadResponse = { kind: 'refused', reason: 'no_session' };
  const refusedApply: TenderApplyResponse = { kind: 'refused', reason: 'no_session' };
  const refusedReverse: TenderReverseResponse = { kind: 'refused', reason: 'no_session' };
  const refusedTenderRead: TenderReadResponse = { kind: 'refused', reason: 'no_session' };
  const refusedForceFail: PaymentsForceFailResponse = { kind: 'refused', reason: 'no_session' };
  return {
    paymentsStart: vi.fn(() => Promise.resolve(refusedStart)),
    paymentsConfirm: vi.fn(() => Promise.resolve(refusedConfirm)),
    paymentsCancel: vi.fn(() => Promise.resolve(refusedCancel)),
    paymentsSubscribe: vi.fn(() => Promise.resolve(refusedSubscribe)),
    paymentsRead: vi.fn(() => Promise.resolve(refusedRead)),
    tenderApply: vi.fn(() => Promise.resolve(refusedApply)),
    tenderReverse: vi.fn(() => Promise.resolve(refusedReverse)),
    tenderRead: vi.fn(() => Promise.resolve(refusedTenderRead)),
    paymentsForceFail: vi.fn(() => Promise.resolve(refusedForceFail)),
  };
}

describe('registerPaymentsHandlers — channel registration', () => {
  it('registers all 6 payments.* + 3 tender.* channels', () => {
    const { ipcMain, handlers } = mkIpc();
    registerPaymentsHandlers(ipcMain, mkDeps());
    for (const ch of Object.values(PAYMENTS_IPC_CHANNELS)) {
      expect(handlers.has(ch)).toBe(true);
    }
    for (const ch of Object.values(TENDER_IPC_CHANNELS)) {
      expect(handlers.has(ch)).toBe(true);
    }
    expect(handlers.size).toBe(
      Object.keys(PAYMENTS_IPC_CHANNELS).length + Object.keys(TENDER_IPC_CHANNELS).length,
    );
  });
});

describe('registerPaymentsHandlers — generic refusal on malformed payload', () => {
  it.each([
    // payments.start — missing / wrong-typed fields
    [PAYMENTS_IPC_CHANNELS.START, null],
    [PAYMENTS_IPC_CHANNELS.START, 'not-an-object'],
    [PAYMENTS_IPC_CHANNELS.START, {}],
    [
      PAYMENTS_IPC_CHANNELS.START,
      // envelope_version must be 'v1'
      {
        envelope_handoff_action_id: 'h',
        envelope_cart_id: 'c',
        envelope_subtotal_minor: 1500,
        envelope_version: 'v2',
        idempotency_key: 'k',
      },
    ],
    // payments.confirm / cancel / subscribe / read — missing required fields
    [PAYMENTS_IPC_CHANNELS.CONFIRM, {}],
    [PAYMENTS_IPC_CHANNELS.CONFIRM, { payment_attempt_id: 'pa-1' }], // no idempotency_key
    [PAYMENTS_IPC_CHANNELS.CANCEL, {}],
    [PAYMENTS_IPC_CHANNELS.SUBSCRIBE, {}],
    [PAYMENTS_IPC_CHANNELS.READ, {}],
    // tender.apply
    [TENDER_IPC_CHANNELS.APPLY, {}],
    [
      TENDER_IPC_CHANNELS.APPLY,
      // unknown tender_type
      {
        payment_attempt_id: 'pa-1',
        tender_type: 'crypto',
        amount_applied_minor: 1500,
        idempotency_key: 'k',
      },
    ],
    // tender.reverse / read — missing required fields
    [TENDER_IPC_CHANNELS.REVERSE, {}],
    [TENDER_IPC_CHANNELS.READ, {}],
    // payments.forceFail — missing required fields (Wave 5b-renderer)
    [PAYMENTS_IPC_CHANNELS.FORCE_FAIL, null],
    [PAYMENTS_IPC_CHANNELS.FORCE_FAIL, 'not-an-object'],
    [PAYMENTS_IPC_CHANNELS.FORCE_FAIL, {}],
    [PAYMENTS_IPC_CHANNELS.FORCE_FAIL, { payment_attempt_id: 'pa-1' }], // no idempotency_key
    [PAYMENTS_IPC_CHANNELS.FORCE_FAIL, { idempotency_key: 'k' }], // no payment_attempt_id
    [
      PAYMENTS_IPC_CHANNELS.FORCE_FAIL,
      // wrong-typed payment_attempt_id (number instead of string)
      { payment_attempt_id: 42, idempotency_key: 'k' },
    ],
  ])('refuses %s with invalid_input on malformed payload', async (channel, payload) => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`missing handler for ${channel}`);
    const result = (await handler(fakeEvent(), payload)) as {
      kind: string;
      reason?: string;
    };
    expect(result).toEqual({ kind: 'refused', reason: 'invalid_input' });
    // Crucially — the underlying handler was NOT called. The IPC
    // validator short-circuits before invocation.
    for (const fn of Object.values(deps)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('registerPaymentsHandlers — money invariant (CR-1)', () => {
  /**
   * Constitution §II — minor units must be safe non-negative integers.
   * The IPC validator MUST refuse floats / unsafe ints / negatives / NaN
   * / Infinity before the handler runs.
   */
  it.each([
    // payments.start — envelope_subtotal_minor
    [PAYMENTS_IPC_CHANNELS.START, 'envelope_subtotal_minor', -1],
    [PAYMENTS_IPC_CHANNELS.START, 'envelope_subtotal_minor', 1.5],
    [PAYMENTS_IPC_CHANNELS.START, 'envelope_subtotal_minor', Number.NaN],
    [PAYMENTS_IPC_CHANNELS.START, 'envelope_subtotal_minor', Number.POSITIVE_INFINITY],
    [PAYMENTS_IPC_CHANNELS.START, 'envelope_subtotal_minor', Number.MAX_SAFE_INTEGER + 1],
    // tender.apply — amount_applied_minor
    [TENDER_IPC_CHANNELS.APPLY, 'amount_applied_minor', -1],
    [TENDER_IPC_CHANNELS.APPLY, 'amount_applied_minor', 1.5],
    [TENDER_IPC_CHANNELS.APPLY, 'amount_applied_minor', Number.NaN],
    [TENDER_IPC_CHANNELS.APPLY, 'amount_applied_minor', Number.POSITIVE_INFINITY],
    [TENDER_IPC_CHANNELS.APPLY, 'amount_applied_minor', Number.MAX_SAFE_INTEGER + 1],
  ])('refuses %s when %s is %s', async (channel, fieldName, badValue) => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`missing handler for ${channel}`);
    // Base valid payloads — overlaid with the bad field.
    const basePayloads: Record<string, Record<string, unknown>> = {
      [PAYMENTS_IPC_CHANNELS.START]: {
        envelope_handoff_action_id: 'h',
        envelope_cart_id: 'c',
        envelope_subtotal_minor: 1500,
        envelope_version: 'v1',
        idempotency_key: 'k',
      },
      [TENDER_IPC_CHANNELS.APPLY]: {
        payment_attempt_id: 'pa-1',
        tender_type: 'cash',
        amount_applied_minor: 1500,
        idempotency_key: 'k',
      },
    };
    const payload = { ...basePayloads[channel], [fieldName]: badValue };
    const result = (await handler(fakeEvent(), payload)) as {
      kind: string;
      reason?: string;
    };
    expect(result).toEqual({ kind: 'refused', reason: 'invalid_input' });
    // Handler MUST NOT be invoked — guard fires at the boundary.
    for (const fn of Object.values(deps)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('registerPaymentsHandlers — valid payloads forward to the handler', () => {
  it('payments.start forwards a fully-typed request', async () => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(PAYMENTS_IPC_CHANNELS.START);
    if (handler === undefined) throw new Error('missing START');
    const req = {
      envelope_handoff_action_id: 'h',
      envelope_cart_id: 'c',
      envelope_subtotal_minor: 1500,
      envelope_version: 'v1' as const,
      idempotency_key: 'k',
    };
    await handler(fakeEvent(), req);
    expect(deps.paymentsStart).toHaveBeenCalledWith(req);
  });

  it('payments.confirm forwards', async () => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(PAYMENTS_IPC_CHANNELS.CONFIRM);
    if (handler === undefined) throw new Error('missing CONFIRM');
    await handler(fakeEvent(), { payment_attempt_id: 'pa-1', idempotency_key: 'k' });
    expect(deps.paymentsConfirm).toHaveBeenCalledWith({
      payment_attempt_id: 'pa-1',
      idempotency_key: 'k',
    });
  });

  it('payments.cancel forwards', async () => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(PAYMENTS_IPC_CHANNELS.CANCEL);
    if (handler === undefined) throw new Error('missing CANCEL');
    await handler(fakeEvent(), { payment_attempt_id: 'pa-1', idempotency_key: 'k' });
    expect(deps.paymentsCancel).toHaveBeenCalled();
  });

  it('payments.forceFail forwards (Wave 5b-renderer happy path)', async () => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(PAYMENTS_IPC_CHANNELS.FORCE_FAIL);
    if (handler === undefined) throw new Error('missing FORCE_FAIL');
    await handler(fakeEvent(), { payment_attempt_id: 'pa-1', idempotency_key: 'k' });
    expect(deps.paymentsForceFail).toHaveBeenCalledWith({
      payment_attempt_id: 'pa-1',
      idempotency_key: 'k',
    });
  });

  it('payments.forceFail channel is NOT registered when paymentsForceFail is undefined', () => {
    // Backward-compat path for older test boots that don't supply the
    // force-fail handler. Mirrors the same pattern used for
    // vouchersValidate registration.
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    const depsWithoutForceFail = { ...deps };
    delete (depsWithoutForceFail as Partial<typeof deps>).paymentsForceFail;
    registerPaymentsHandlers(ipcMain, depsWithoutForceFail);
    expect(handlers.has(PAYMENTS_IPC_CHANNELS.FORCE_FAIL)).toBe(false);
  });

  it('payments.subscribe forwards', async () => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(PAYMENTS_IPC_CHANNELS.SUBSCRIBE);
    if (handler === undefined) throw new Error('missing SUBSCRIBE');
    await handler(fakeEvent(), { payment_attempt_id: 'pa-1' });
    expect(deps.paymentsSubscribe).toHaveBeenCalledWith({ payment_attempt_id: 'pa-1' });
  });

  it('payments.read forwards', async () => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(PAYMENTS_IPC_CHANNELS.READ);
    if (handler === undefined) throw new Error('missing READ');
    await handler(fakeEvent(), { payment_attempt_id: 'pa-1' });
    expect(deps.paymentsRead).toHaveBeenCalledWith({ payment_attempt_id: 'pa-1' });
  });

  it('tender.apply forwards including optional external_reference + voucher_code', async () => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(TENDER_IPC_CHANNELS.APPLY);
    if (handler === undefined) throw new Error('missing APPLY');
    await handler(fakeEvent(), {
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 1500,
      external_reference: 'AB12XY',
      voucher_code: 'V-ABC',
      idempotency_key: 'k',
    });
    expect(deps.tenderApply).toHaveBeenCalledWith({
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 1500,
      external_reference: 'AB12XY',
      voucher_code: 'V-ABC',
      idempotency_key: 'k',
    });
  });

  it('tender.apply forwards without optional fields when omitted', async () => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(TENDER_IPC_CHANNELS.APPLY);
    if (handler === undefined) throw new Error('missing APPLY');
    await handler(fakeEvent(), {
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1500,
      idempotency_key: 'k',
    });
    // `.toEqual` is a deep-equality check — the assertion above already
    // proves `external_reference` and `voucher_code` are absent from the
    // forwarded request (the validator strips them when undefined per
    // exactOptionalPropertyTypes).
    const args = deps.tenderApply.mock.calls[0]?.[0];
    expect(args).toEqual({
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1500,
      idempotency_key: 'k',
    });
  });

  it('tender.reverse forwards', async () => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(TENDER_IPC_CHANNELS.REVERSE);
    if (handler === undefined) throw new Error('missing REVERSE');
    await handler(fakeEvent(), { tender_line_id: 'tl-1', idempotency_key: 'k' });
    expect(deps.tenderReverse).toHaveBeenCalledWith({
      tender_line_id: 'tl-1',
      idempotency_key: 'k',
    });
  });

  it('tender.read forwards', async () => {
    const { ipcMain, handlers } = mkIpc();
    const deps = mkDeps();
    registerPaymentsHandlers(ipcMain, deps);
    const handler = handlers.get(TENDER_IPC_CHANNELS.READ);
    if (handler === undefined) throw new Error('missing READ');
    await handler(fakeEvent(), { tender_line_id: 'tl-1' });
    expect(deps.tenderRead).toHaveBeenCalledWith({ tender_line_id: 'tl-1' });
  });

  describe('payments.start bounds every id at the IPC boundary (§A4 LOW-1)', () => {
    const valid = {
      envelope_handoff_action_id: 'handoff-1',
      envelope_cart_id: 'cart-1',
      envelope_subtotal_minor: 1250,
      envelope_version: 'v1',
      idempotency_key: 'idem-1',
    };
    it.each([
      ['envelope_handoff_action_id', 'x'.repeat(129)],
      ['envelope_cart_id', ''],
      ['envelope_cart_id', 'cart 1; DROP'],
      ['idempotency_key', 'k'.repeat(129)],
      ['idempotency_key', 'idem/../1'],
    ])('refuses invalid_input for %s = %j without calling the handler', async (field, bad) => {
      const { ipcMain, handlers } = mkIpc();
      const deps = mkDeps();
      registerPaymentsHandlers(ipcMain, deps);
      const res = await handlers.get(PAYMENTS_IPC_CHANNELS.START)?.(fakeEvent(), {
        ...valid,
        [field]: bad,
      });
      expect(res).toEqual({ kind: 'refused', reason: 'invalid_input' });
      expect(deps.paymentsStart).not.toHaveBeenCalled();
    });

    it('admits UUID-shaped ids at the 128-char bound', async () => {
      const { ipcMain, handlers } = mkIpc();
      const deps = mkDeps();
      registerPaymentsHandlers(ipcMain, deps);
      await handlers.get(PAYMENTS_IPC_CHANNELS.START)?.(fakeEvent(), {
        ...valid,
        envelope_cart_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        idempotency_key: 'k'.repeat(128),
      });
      expect(deps.paymentsStart).toHaveBeenCalledOnce();
    });
  });
});
