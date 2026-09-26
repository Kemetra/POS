/**
 * F-004 — 006-payments-tender Slice 3 IPC channel registration.
 *
 * Mirrors `src/main/ipc/cart.ts` (005 T029). Every channel is wired to
 * its `payments.*` / `tender.*` handler from
 * `src/main/payments/handlers/`. This file is a thin wire-up: no
 * business logic, only shape validation + delegation.
 *
 * Input shape validation refuses generically per Constitution VII /
 * NFR-003 / PR-2 — a malformed payload collapses to
 * `{ kind: 'refused', reason: 'invalid_input' }` without leaking which
 * field failed validation. The handler itself owns the closed
 * RefusalReason enum; `invalid_input` is the appropriate generic
 * envelope for "renderer sent something we can't parse".
 *
 * `payments.discardOnSessionEnd` is INTERNAL and is NOT registered
 * here. The main-process bootstrap calls it directly when the operator
 * session ends; the renderer cannot trigger it.
 */

import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  PAYMENTS_IPC_CHANNELS,
  TENDER_IPC_CHANNELS,
  VOUCHERS_IPC_CHANNELS,
} from '../../shared/payments/channels.js';
import type { PaymentRefusal, TenderType } from '../../shared/payments/types.js';
import type { PaymentsCancelHandler } from '../payments/handlers/payments-cancel.js';
import type { PaymentsConfirmHandler } from '../payments/handlers/payments-confirm.js';
import type { PaymentsForceFailHandler } from '../payments/handlers/payments-force-fail.js';
import type { PaymentsReadHandler } from '../payments/handlers/payments-read.js';
import type { PaymentsStartHandler } from '../payments/handlers/payments-start.js';
import type { PaymentsSubscribeHandler } from '../payments/handlers/payments-subscribe.js';
import type { TenderApplyHandler } from '../payments/handlers/tender-apply.js';
import type { TenderReadHandler } from '../payments/handlers/tender-read.js';
import type { TenderReverseHandler } from '../payments/handlers/tender-reverse.js';
import type { VouchersValidateHandler } from '../payments/handlers/vouchers-validate.js';
import type {
  PaymentsCancelRequest,
  PaymentsCancelResponse,
  PaymentsConfirmRequest,
  PaymentsConfirmResponse,
  PaymentsForceFailRequest,
  PaymentsForceFailResponse,
  PaymentsReadRequest,
  PaymentsReadResponse,
  PaymentsStartRequest,
  PaymentsStartResponse,
  PaymentsSubscribeRequest,
  PaymentsSubscribeResponse,
  TenderApplyRequest,
  TenderApplyResponse,
  TenderReadRequest,
  TenderReadResponse,
  TenderReverseRequest,
  TenderReverseResponse,
  VouchersValidateRequest,
  VouchersValidateResponse,
} from '../../shared/bridge-api.js';

export interface PaymentsIpcDeps {
  paymentsStart: PaymentsStartHandler;
  paymentsConfirm: PaymentsConfirmHandler;
  paymentsCancel: PaymentsCancelHandler;
  paymentsSubscribe: PaymentsSubscribeHandler;
  paymentsRead: PaymentsReadHandler;
  tenderApply: TenderApplyHandler;
  tenderReverse: TenderReverseHandler;
  tenderRead: TenderReadHandler;
  /** Wave 4 — voucher validate. Optional so Slice-3-only test boots
   *  continue to register without it. */
  vouchersValidate?: VouchersValidateHandler;
  /** Wave 5b — manager / admin-only force-fail. Optional so existing
   *  test boots continue to register without it. */
  paymentsForceFail?: PaymentsForceFailHandler;
}

function refuseInvalid(): PaymentRefusal {
  return { kind: 'refused', reason: 'invalid_input' };
}

// ── Payload validators ─────────────────────────────────────────────────────

/**
 * Money invariant guard (Constitution §II) — minor-unit values MUST be
 * safe non-negative integers at the IPC trust boundary. The handlers
 * themselves also validate (defence-in-depth), but admitting a float or
 * unsafe integer here would let the FSM see a corrupted value before
 * the handler's own check fires; the audit trail's deterministic
 * payload hash also depends on integer canonicalisation.
 */
function isValidMinorUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Ids that `payments.start` persists (attempt, outbox) are bounded at the IPC
 * boundary, matching `ipc/cart.ts` (§A4 review, 2026-09-26).
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function asPaymentsStartReq(value: unknown): PaymentsStartRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    !isBoundedId(v['envelope_handoff_action_id']) ||
    !isBoundedId(v['envelope_cart_id']) ||
    !isValidMinorUnit(v['envelope_subtotal_minor']) ||
    v['envelope_version'] !== 'v1' ||
    !isBoundedId(v['idempotency_key'])
  ) {
    return null;
  }
  return {
    envelope_handoff_action_id: v['envelope_handoff_action_id'],
    envelope_cart_id: v['envelope_cart_id'],
    envelope_subtotal_minor: v['envelope_subtotal_minor'],
    envelope_version: 'v1',
    idempotency_key: v['idempotency_key'],
  };
}

function asPaymentsConfirmReq(value: unknown): PaymentsConfirmRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['payment_attempt_id'] !== 'string' || typeof v['idempotency_key'] !== 'string') {
    return null;
  }
  return {
    payment_attempt_id: v['payment_attempt_id'],
    idempotency_key: v['idempotency_key'],
  };
}

function asPaymentsCancelReq(value: unknown): PaymentsCancelRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['payment_attempt_id'] !== 'string' || typeof v['idempotency_key'] !== 'string') {
    return null;
  }
  return {
    payment_attempt_id: v['payment_attempt_id'],
    idempotency_key: v['idempotency_key'],
  };
}

function asPaymentsForceFailReq(value: unknown): PaymentsForceFailRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['payment_attempt_id'] !== 'string' || typeof v['idempotency_key'] !== 'string') {
    return null;
  }
  return {
    payment_attempt_id: v['payment_attempt_id'],
    idempotency_key: v['idempotency_key'],
  };
}

function asPaymentsSubscribeReq(value: unknown): PaymentsSubscribeRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['payment_attempt_id'] !== 'string') return null;
  return { payment_attempt_id: v['payment_attempt_id'] };
}

function asPaymentsReadReq(value: unknown): PaymentsReadRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['payment_attempt_id'] !== 'string') return null;
  return { payment_attempt_id: v['payment_attempt_id'] };
}

const TENDER_TYPES_RUNTIME: readonly TenderType[] = [
  'cash',
  'external_card_terminal',
  'internal_voucher',
];

function isTenderType(value: unknown): value is TenderType {
  return typeof value === 'string' && TENDER_TYPES_RUNTIME.includes(value as TenderType);
}

function asTenderApplyReq(value: unknown): TenderApplyRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['payment_attempt_id'] !== 'string' ||
    !isTenderType(v['tender_type']) ||
    !isValidMinorUnit(v['amount_applied_minor']) ||
    typeof v['idempotency_key'] !== 'string'
  ) {
    return null;
  }
  const req: TenderApplyRequest = {
    payment_attempt_id: v['payment_attempt_id'],
    tender_type: v['tender_type'],
    amount_applied_minor: v['amount_applied_minor'],
    idempotency_key: v['idempotency_key'],
  };
  // Optional fields — only attach when present + well-typed.
  if (typeof v['external_reference'] === 'string') {
    (req as { external_reference?: string }).external_reference = v['external_reference'];
  }
  if (typeof v['voucher_code'] === 'string') {
    (req as { voucher_code?: string }).voucher_code = v['voucher_code'];
  }
  return req;
}

function asTenderReverseReq(value: unknown): TenderReverseRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['tender_line_id'] !== 'string' || typeof v['idempotency_key'] !== 'string') {
    return null;
  }
  return {
    tender_line_id: v['tender_line_id'],
    idempotency_key: v['idempotency_key'],
  };
}

function asTenderReadReq(value: unknown): TenderReadRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['tender_line_id'] !== 'string') return null;
  return { tender_line_id: v['tender_line_id'] };
}

function asVouchersValidateReq(value: unknown): VouchersValidateRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['payment_attempt_id'] !== 'string' ||
    typeof v['voucher_code'] !== 'string' ||
    !isValidMinorUnit(v['amount_applied_minor']) ||
    typeof v['idempotency_key'] !== 'string'
  ) {
    return null;
  }
  return {
    payment_attempt_id: v['payment_attempt_id'],
    voucher_code: v['voucher_code'],
    amount_applied_minor: v['amount_applied_minor'],
    idempotency_key: v['idempotency_key'],
  };
}

// ── Registration ───────────────────────────────────────────────────────────

export function registerPaymentsHandlers(ipcMain: IpcMain, deps: PaymentsIpcDeps): void {
  ipcMain.handle(
    PAYMENTS_IPC_CHANNELS.START,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<PaymentsStartResponse> => {
      const req = asPaymentsStartReq(request);
      if (req === null) return refuseInvalid();
      return deps.paymentsStart(req);
    },
  );

  ipcMain.handle(
    PAYMENTS_IPC_CHANNELS.CONFIRM,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<PaymentsConfirmResponse> => {
      const req = asPaymentsConfirmReq(request);
      if (req === null) return refuseInvalid();
      return deps.paymentsConfirm(req);
    },
  );

  ipcMain.handle(
    PAYMENTS_IPC_CHANNELS.CANCEL,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<PaymentsCancelResponse> => {
      const req = asPaymentsCancelReq(request);
      if (req === null) return refuseInvalid();
      return deps.paymentsCancel(req);
    },
  );

  ipcMain.handle(
    PAYMENTS_IPC_CHANNELS.SUBSCRIBE,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<PaymentsSubscribeResponse> => {
      const req = asPaymentsSubscribeReq(request);
      if (req === null) return refuseInvalid();
      return deps.paymentsSubscribe(req);
    },
  );

  ipcMain.handle(
    PAYMENTS_IPC_CHANNELS.READ,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<PaymentsReadResponse> => {
      const req = asPaymentsReadReq(request);
      if (req === null) return refuseInvalid();
      return deps.paymentsRead(req);
    },
  );

  ipcMain.handle(
    TENDER_IPC_CHANNELS.APPLY,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<TenderApplyResponse> => {
      const req = asTenderApplyReq(request);
      if (req === null) return refuseInvalid();
      return deps.tenderApply(req);
    },
  );

  ipcMain.handle(
    TENDER_IPC_CHANNELS.REVERSE,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<TenderReverseResponse> => {
      const req = asTenderReverseReq(request);
      if (req === null) return refuseInvalid();
      return deps.tenderReverse(req);
    },
  );

  ipcMain.handle(
    TENDER_IPC_CHANNELS.READ,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<TenderReadResponse> => {
      const req = asTenderReadReq(request);
      if (req === null) return refuseInvalid();
      return deps.tenderRead(req);
    },
  );

  // Wave 4 — vouchers.validate (§A4-B authorisation 2026-05-25).
  if (deps.vouchersValidate !== undefined) {
    const handler = deps.vouchersValidate;
    ipcMain.handle(
      VOUCHERS_IPC_CHANNELS.VALIDATE,
      async (_event: IpcMainInvokeEvent, request: unknown): Promise<VouchersValidateResponse> => {
        const req = asVouchersValidateReq(request);
        if (req === null) return refuseInvalid();
        return handler(req);
      },
    );
  }

  // Wave 5b — payments.forceFail (manager / admin-only). The handler
  // itself runs the role gate; this IPC layer only does shape
  // validation. Registration is optional so existing tests can boot
  // a Slice-3-only ipcMain.
  if (deps.paymentsForceFail !== undefined) {
    const handler = deps.paymentsForceFail;
    ipcMain.handle(
      PAYMENTS_IPC_CHANNELS.FORCE_FAIL,
      async (_event: IpcMainInvokeEvent, request: unknown): Promise<PaymentsForceFailResponse> => {
        const req = asPaymentsForceFailReq(request);
        if (req === null) return refuseInvalid();
        return handler(req);
      },
    );
  }
}
