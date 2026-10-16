/**
 * T030 — 008 Slice 1b bridge-api contract test.
 *
 * Asserts (compile-time + runtime) that `src/shared/bridge-api.ts` extends
 * `PreloadBridgeAPI` with the Slice-1 subset of the `sales.*` namespace
 * declared in `specs/008-sale-finalization-and-receipts/contracts/bridge-api.md`.
 *
 * **Slice-1 subset only.** This test covers the four READ-ONLY sales.*
 * handlers (`read`, `findByNumber`, `subscribe`, `unsubscribe`). The
 * mutating `receipts.*` namespace lands in Slice 2+ and is OUT of scope here.
 *
 * Shared types asserted to exist:
 *   • SaleId, SaleNumber                   — branded primitives
 *   • TenderLineSummary                    — per-line cached summary
 *   • PrintEventSummary                    — latest print-event projection
 *   • DrawerEventSummary                   — latest drawer-event projection
 *   • SalesRefusalReason                   — closed enum (8 values) from contract
 *   • ReceiptPayload                       — canonical FR-017 fields
 *   • ReceiptTemplateVariant               — 'first_print' | 'reprint_duplicate' | 'preview'
 *
 * Handler shapes asserted (Request + Response per contract):
 *   sales.read · sales.findByNumber · sales.subscribe · sales.unsubscribe
 *
 * Mirrors `tests/contract/payments/bridge-api.contract.test.ts` (006 S3b T070).
 */

import { describe, expect, it } from 'vitest';
import type { PreloadBridgeAPI } from '../../../src/shared/bridge-api.js';
import { SALES_REFUSAL_REASONS } from '../../../src/shared/sales/types.js';
import type {
  SaleId,
  SaleNumber,
  TenderLineSummary,
  PrintEventSummary,
  DrawerEventSummary,
  SalesRefusalReason,
} from '../../../src/shared/sales/types.js';
import { RECEIPT_TEMPLATE_VARIANTS } from '../../../src/shared/receipts/types.js';
import type { ReceiptPayload, ReceiptTemplateVariant } from '../../../src/shared/receipts/types.js';
import type {
  SalesBridgeAPI,
  SalesReadRequest,
  SalesReadResponse,
  SalesFindByNumberRequest,
  SalesFindByNumberResponse,
  SalesSubscribeRequest,
  SalesSubscribeResponse,
  SalesUnsubscribeRequest,
  SalesUnsubscribeResponse,
  SaleSummary,
} from '../../../src/shared/bridge-api.js';

describe('T030 — 008 Slice 1b sales.* bridge contract', () => {
  describe('closed-enum tuples', () => {
    it('SALES_REFUSAL_REASONS contains the 12 contract-defined values exactly', () => {
      // Per contracts/bridge-api.md §"Refusal envelope" — the closed reason
      // union across all 008 sales.* + receipts.* handlers.
      // 'not_implemented' added in S1c.2 to match 005's CartRefusalReason
      // posture for the sales.subscribe stub (push primitive deferred).
      // 'invalid_request' / 'range_too_wide' added by RT-541 for sales.list.
      // 'sale_voided' added by RT-542 for receipts.reprint (OD-534-8 B).
      expect(SALES_REFUSAL_REASONS).toEqual([
        'no_session',
        'role_denied',
        'tenant_isolation',
        'sale_not_found',
        'not_yet_printed',
        'idempotency_payload_mismatch',
        'printer_unavailable',
        'forbidden_field_in_request',
        'not_implemented',
        'invalid_request',
        'range_too_wide',
        'sale_voided',
      ]);
    });

    it('SalesRefusalReason is derived exhaustively from SALES_REFUSAL_REASONS', () => {
      // Compile-time exhaustiveness: every value in the tuple must be
      // assignable to SalesRefusalReason, and vice versa.
      const reasons: SalesRefusalReason[] = [...SALES_REFUSAL_REASONS];
      expect(reasons).toHaveLength(SALES_REFUSAL_REASONS.length);
    });

    it('RECEIPT_TEMPLATE_VARIANTS contains the 3 contract-defined values exactly', () => {
      expect(RECEIPT_TEMPLATE_VARIANTS).toEqual(['first_print', 'reprint_duplicate', 'preview']);
    });

    it('ReceiptTemplateVariant is derived exhaustively from RECEIPT_TEMPLATE_VARIANTS', () => {
      const variants: ReceiptTemplateVariant[] = [...RECEIPT_TEMPLATE_VARIANTS];
      expect(variants).toHaveLength(RECEIPT_TEMPLATE_VARIANTS.length);
    });
  });

  describe('PreloadBridgeAPI extension', () => {
    it('exposes sales: SalesBridgeAPI on PreloadBridgeAPI', () => {
      // Compile-time assertion via type satisfaction: a stub conforming to
      // the contract must be assignable to `Pick<PreloadBridgeAPI, 'sales'>`.
      const stub: Pick<PreloadBridgeAPI, 'sales'> = {
        sales: undefined as SalesBridgeAPI | undefined,
      };
      // Runtime assertion to keep this test from being elided as dead code.
      expect('sales' in stub).toBe(true);
    });

    it('SalesBridgeAPI has the four read-only handlers (compile-time signature check)', () => {
      // Pure type-level assertions — each handler-signature alias only
      // compiles if the corresponding member exists on SalesBridgeAPI
      // with the expected Request → Promise<Response> shape.
      // Pattern mirrors `tests/contract/payments/bridge-api.contract.test.ts`.
      type ReadSig = SalesBridgeAPI['read'];
      type FindByNumberSig = SalesBridgeAPI['findByNumber'];
      type SubscribeSig = SalesBridgeAPI['subscribe'];
      type UnsubscribeSig = SalesBridgeAPI['unsubscribe'];

      // Cross-check each alias against the explicit signature from the
      // contract — any drift produces a compile error.
      const _read: ReadSig | undefined = undefined as
        | ((req: SalesReadRequest) => Promise<SalesReadResponse>)
        | undefined;
      const _find: FindByNumberSig | undefined = undefined as
        | ((req: SalesFindByNumberRequest) => Promise<SalesFindByNumberResponse>)
        | undefined;
      const _sub: SubscribeSig | undefined = undefined as
        | ((req: SalesSubscribeRequest) => Promise<SalesSubscribeResponse>)
        | undefined;
      const _unsub: UnsubscribeSig | undefined = undefined as
        | ((req: SalesUnsubscribeRequest) => Promise<SalesUnsubscribeResponse>)
        | undefined;

      expect(_read).toBeUndefined();
      expect(_find).toBeUndefined();
      expect(_sub).toBeUndefined();
      expect(_unsub).toBeUndefined();
    });
  });

  describe('SaleSummary shape (used by sales.read + sales.findByNumber)', () => {
    it('matches the contract-listed fields and excludes main-only fields', () => {
      // Build a sample SaleSummary; type-check enforces the shape.
      const summary: SaleSummary = {
        sale_id: 'sale-1' as SaleId,
        sale_number: 'TERM-01-2026-05-27-000001' as SaleNumber,
        receipt_number: 'TERM-01-2026-05-27-000001',
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        terminal_id: 'terminal-1',
        terminal_label: 'TERM-01',
        selling_operator_id: 'op-abc',
        selling_operator_display_name: 'Mohamed Ahmed',
        subtotal_minor: 19925,
        total_tax_minor: 2450,
        total_change_due_minor: 75,
        tender_lines_summary: [],
        finalized_at: '2026-05-27T08:42:18.500Z',
      };
      expect(summary.sale_id).toBe('sale-1');

      // Forbidden main-only fields MUST NOT be assignable to SaleSummary.
      // The following lines are intentionally commented; if uncommented,
      // they MUST cause a TypeScript compilation error:
      //
      //   summary.envelope_handoff_action_id = 'forbidden';
      //   summary.payment_attempt_id = 'forbidden';
      //   summary.envelope_cart_id = 'forbidden';
      //   summary.tenant_tax_registration_id = 'forbidden';
      //
      // These are documented main-only fields per contracts/bridge-api.md
      // §"Namespace: sales.* (read-only)" → "Notes" bullet 1.
    });

    it('admits optional latest_print_event / latest_drawer_event projections', () => {
      const printSummary: PrintEventSummary = {
        print_event_id: 'pe-1',
        outcome: 'success',
        purpose: 'first_print',
        printed_at: '2026-05-27T08:42:19.000Z',
      };
      const drawerSummary: DrawerEventSummary = {
        drawer_event_id: 'de-1',
        outcome: 'opened',
        attempted_at: '2026-05-27T08:42:20.000Z',
      };

      const summary: SaleSummary = {
        sale_id: 'sale-1' as SaleId,
        sale_number: 'TERM-01-2026-05-27-000001' as SaleNumber,
        receipt_number: 'TERM-01-2026-05-27-000001',
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        terminal_id: 'terminal-1',
        terminal_label: 'TERM-01',
        selling_operator_id: 'op-abc',
        selling_operator_display_name: 'Mohamed Ahmed',
        subtotal_minor: 19925,
        total_tax_minor: 2450,
        total_change_due_minor: 75,
        tender_lines_summary: [],
        finalized_at: '2026-05-27T08:42:18.500Z',
        latest_print_event: printSummary,
        latest_drawer_event: drawerSummary,
      };

      expect(summary.latest_print_event).toBe(printSummary);
      expect(summary.latest_drawer_event).toBe(drawerSummary);
    });
  });

  describe('TenderLineSummary shape (non-sensitive only)', () => {
    it('carries tender_type + amount + optional change_due_minor / external_reference / voucher_authority_redemption_id', () => {
      const cash: TenderLineSummary = {
        tender_type: 'cash',
        amount_applied_minor: 20000,
        change_due_minor: 75,
      };
      const card: TenderLineSummary = {
        tender_type: 'external_card_terminal',
        amount_applied_minor: 19925,
        external_reference: 'AB12XY',
      };
      const voucher: TenderLineSummary = {
        tender_type: 'internal_voucher',
        amount_applied_minor: 19925,
        voucher_authority_redemption_id: 'redemption-xyz',
      };

      expect(cash.tender_type).toBe('cash');
      expect(card.external_reference).toBe('AB12XY');
      expect(voucher.voucher_authority_redemption_id).toBe('redemption-xyz');

      // Contract §"Refusal envelope" + spec FR-071: forbidden fields MUST
      // NOT be assignable. The commented lines below would each be a
      // TypeScript compile error if uncommented:
      //
      //   cash.voucher_code = 'forbidden';          // sensitive
      //   card.pin_record_id = 'forbidden';         // sensitive (CR3)
      //   voucher.issuer_name = 'forbidden';        // sensitive (CR3)
      //   cash.envelope_handoff_action_id = 'fb';   // main-only
    });
  });

  describe('Handler request/response payload shapes', () => {
    it('SalesReadRequest = { sale_id }', () => {
      const req: SalesReadRequest = { sale_id: 'sale-1' as SaleId };
      expect(req.sale_id).toBe('sale-1');
    });

    it('SalesReadResponse is { kind: "ok", sale } | { kind: "refused", reason }', () => {
      const ok: SalesReadResponse = {
        kind: 'ok',
        sale: {
          sale_id: 'sale-1' as SaleId,
          sale_number: 'TERM-01-2026-05-27-000001' as SaleNumber,
          receipt_number: 'TERM-01-2026-05-27-000001',
          tenant_id: 'tenant-1',
          branch_id: 'branch-1',
          terminal_id: 'terminal-1',
          terminal_label: 'TERM-01',
          selling_operator_id: 'op-abc',
          selling_operator_display_name: 'Mohamed Ahmed',
          subtotal_minor: 19925,
          total_tax_minor: 2450,
          total_change_due_minor: 75,
          tender_lines_summary: [],
          finalized_at: '2026-05-27T08:42:18.500Z',
        },
      };
      const refused: SalesReadResponse = {
        kind: 'refused',
        reason: 'sale_not_found',
      };
      expect(ok.kind).toBe('ok');
      expect(refused.kind).toBe('refused');
    });

    it('SalesFindByNumberRequest = { sale_number }', () => {
      const req: SalesFindByNumberRequest = {
        sale_number: 'TERM-01-2026-05-27-000001' as SaleNumber,
      };
      expect(req.sale_number).toBeDefined();
    });

    it('SalesSubscribeRequest carries topic = "recent" | "banner_state"', () => {
      const recent: SalesSubscribeRequest = { topic: 'recent' };
      const banner: SalesSubscribeRequest = { topic: 'banner_state' };
      expect(recent.topic).toBe('recent');
      expect(banner.topic).toBe('banner_state');
    });

    it('SalesSubscribeResponse carries an opaque subscription token', () => {
      const resp: SalesSubscribeResponse = {
        kind: 'ok',
        subscription_token: 'tok-abc',
      };
      expect(resp.subscription_token).toBe('tok-abc');
    });

    it('SalesUnsubscribeRequest carries the subscription_token', () => {
      const req: SalesUnsubscribeRequest = { subscription_token: 'tok-abc' };
      expect(req.subscription_token).toBe('tok-abc');
    });

    it('SalesUnsubscribeResponse is { kind: "ok" }', () => {
      const resp: SalesUnsubscribeResponse = { kind: 'ok' };
      expect(resp.kind).toBe('ok');
    });
  });

  describe('ReceiptPayload shape (FR-017 minimum)', () => {
    it('carries the canonical FR-017 fields', () => {
      const payload: ReceiptPayload = {
        sale_id: 'sale-1' as SaleId,
        sale_number: 'TERM-01-2026-05-27-000001' as SaleNumber,
        receipt_number: 'TERM-01-2026-05-27-000001',
        variant: 'first_print',
        tenant_tax_registration_id: '100123456789012',
        branch_name: 'Al-Rahma Pharmacy',
        branch_address: '10th of Ramadan branch',
        terminal_label: 'TERM-01',
        selling_operator_display_name: 'Mohamed Ahmed',
        subtotal_minor: 19925,
        total_tax_minor: 2450,
        total_change_due_minor: 75,
        tender_lines_summary: [],
        settled_at: '2026-05-27T08:42:18.000Z',
        finalized_at: '2026-05-27T08:42:18.500Z',
        local_calendar_day: '2026-05-27',
      };
      expect(payload.variant).toBe('first_print');
    });

    it('reprint variant carries duplicate_copy_sequence_number + reprinted_at', () => {
      const payload: ReceiptPayload = {
        sale_id: 'sale-1' as SaleId,
        sale_number: 'TERM-01-2026-05-27-000001' as SaleNumber,
        receipt_number: 'TERM-01-2026-05-27-000001',
        variant: 'reprint_duplicate',
        duplicate_copy_sequence_number: 1,
        reprinted_at: '2026-05-27T14:08:33.000Z',
        tenant_tax_registration_id: '100123456789012',
        branch_name: 'Al-Rahma Pharmacy',
        branch_address: '10th of Ramadan branch',
        terminal_label: 'TERM-01',
        selling_operator_display_name: 'Mohamed Ahmed',
        subtotal_minor: 19925,
        total_tax_minor: 2450,
        total_change_due_minor: 75,
        tender_lines_summary: [],
        settled_at: '2026-05-27T08:42:18.000Z',
        finalized_at: '2026-05-27T08:42:18.500Z',
        local_calendar_day: '2026-05-27',
      };
      expect(payload.variant).toBe('reprint_duplicate');
      expect(payload.duplicate_copy_sequence_number).toBe(1);
    });
  });
});
