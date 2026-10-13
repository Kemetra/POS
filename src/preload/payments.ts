import { ipcRenderer } from 'electron';

import type {
  PaymentsBridgeAPI,
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
  TenderBridgeAPI,
  TenderReadRequest,
  TenderReadResponse,
  TenderReverseRequest,
  TenderReverseResponse,
  VouchersBridgeAPI,
  VouchersValidateRequest,
  VouchersValidateResponse,
} from '../shared/bridge-api.js';
import {
  PAYMENTS_IPC_CHANNELS,
  TENDER_IPC_CHANNELS,
  VOUCHERS_IPC_CHANNELS,
} from '../shared/payments/channels.js';

/**
 * T142 — 006-payments-tender Slice 3 preload bridge.
 *
 * Thin contextBridge surface — every handler delegates to
 * `ipcRenderer.invoke` with a typed channel constant. Main-process
 * `requireOperatorSession` is the load-bearing security boundary;
 * renderer-side type checks are secondary UX defence only.
 *
 * Security (Constitution §VII / contracts/bridge-api.md):
 *   • RT-442: the internal `payments.discardOnSessionEnd` is deleted (no
 *     session end reverses tender); it was never on this surface.
 *   • `payments.forceFail` is Slice 4 (still gated) and intentionally
 *     absent.
 *   • `vouchers.validate` is Wave 4 (§A4-B authorisation 2026-05-25);
 *     `vouchers.redeem` / `vouchers.reverse` are intentionally absent
 *     — they fire ONLY from `payments.confirm` and `tender.reverse`
 *     respectively, never directly from the renderer (AD-3 / FR-017).
 *   • No PII, voucher tokens, card data, Clerk JWTs, or device tokens
 *     cross this bridge in either direction. Refusal envelopes use the
 *     generic closed RefusalReason enum.
 */
export const payments: PaymentsBridgeAPI = {
  start: (req: PaymentsStartRequest) =>
    ipcRenderer.invoke(PAYMENTS_IPC_CHANNELS.START, req) as Promise<PaymentsStartResponse>,
  confirm: (req: PaymentsConfirmRequest) =>
    ipcRenderer.invoke(PAYMENTS_IPC_CHANNELS.CONFIRM, req) as Promise<PaymentsConfirmResponse>,
  cancel: (req: PaymentsCancelRequest) =>
    ipcRenderer.invoke(PAYMENTS_IPC_CHANNELS.CANCEL, req) as Promise<PaymentsCancelResponse>,
  subscribe: (req: PaymentsSubscribeRequest) =>
    ipcRenderer.invoke(PAYMENTS_IPC_CHANNELS.SUBSCRIBE, req) as Promise<PaymentsSubscribeResponse>,
  read: (req: PaymentsReadRequest) =>
    ipcRenderer.invoke(PAYMENTS_IPC_CHANNELS.READ, req) as Promise<PaymentsReadResponse>,
  forceFail: (req: PaymentsForceFailRequest) =>
    ipcRenderer.invoke(PAYMENTS_IPC_CHANNELS.FORCE_FAIL, req) as Promise<PaymentsForceFailResponse>,
};

export const tender: TenderBridgeAPI = {
  apply: (req: TenderApplyRequest) =>
    ipcRenderer.invoke(TENDER_IPC_CHANNELS.APPLY, req) as Promise<TenderApplyResponse>,
  reverse: (req: TenderReverseRequest) =>
    ipcRenderer.invoke(TENDER_IPC_CHANNELS.REVERSE, req) as Promise<TenderReverseResponse>,
  read: (req: TenderReadRequest) =>
    ipcRenderer.invoke(TENDER_IPC_CHANNELS.READ, req) as Promise<TenderReadResponse>,
};

export const vouchers: VouchersBridgeAPI = {
  validate: (req: VouchersValidateRequest) =>
    ipcRenderer.invoke(VOUCHERS_IPC_CHANNELS.VALIDATE, req) as Promise<VouchersValidateResponse>,
};
