/**
 * RT-540 — the additive `receipt` capture field (`sales.yaml` 1.9.0-draft, RT-537).
 *
 * The POS sends what it already stores, from the durable Sale only, and only for a sale
 * finalized at/after `POS_PULSE_FEATURE_SALE_RECEIPT_SINCE` (the RT-79 pattern): the
 * Idempotency-Key is the sale's `externalId`, so a body that changes under one key is a
 * 409. The whole `receipt` is sent or none of it: a value the contract would refuse
 * (empty, over its bound) must never reach the wire, where it would be a 400 and a
 * dead-lettered sale. Line order is the order of `lines[]` (no new field).
 */
import { describe, expect, it } from 'vitest';

import {
  buildCapturePayload,
  parseReceiptSince,
  parseTendersSince,
  type CaptureSalePayload,
} from '../capture-payload.js';
import { toCashierWireBody, toWireBody } from '../create-sale-sync-client.js';
import type { SaleRow } from '../../sales/repositories/sales.repository.js';
import type { ContractCaptureSaleRequest } from './__contract__/capture-sale-request.contract.js';

function saleRow(over: Partial<SaleRow> = {}): SaleRow {
  return {
    sale_id: 'sale-1',
    sale_number: 'TILL-1-2026-10-16-000007',
    receipt_number: 'TILL-1-2026-10-16-000007',
    envelope_handoff_action_id: 'handoff-abc',
    payment_attempt_id: 'pa-1',
    envelope_cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'term-1',
    terminal_label: 'TILL-1',
    selling_operator_id: 'op-1',
    selling_operator_display_name: 'Operator One',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 1500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary_json: JSON.stringify([
      { tender_type: 'cash', amount_applied_minor: 1500, change_due_minor: 0 },
    ]),
    settled_at: '2026-10-16T10:00:00.000Z',
    finalized_at: '2026-10-16T10:00:00.000Z',
    tenant_tax_registration_id: 'TRN-123',
    branch_name: 'Main Branch',
    branch_address: '1 Nile St, Cairo',
    local_calendar_day: '2026-10-16',
    lines_json: JSON.stringify([
      {
        line_id: 'l-1',
        item_ref: 'p-1',
        display_name: 'Panadol',
        quantity: 2,
        unit_price_minor: 750,
        line_subtotal_minor: 1500,
      },
    ]),
    ...over,
  };
}

const SINCE = '2026-10-16T00:00:00.000Z';
const ON = { receiptSince: SINCE };

describe('RT-540 — parseReceiptSince (POS_PULSE_FEATURE_SALE_RECEIPT_SINCE)', () => {
  it('unset / blank / non-instant -> null (off, fail-safe)', () => {
    expect(parseReceiptSince(undefined)).toBeNull();
    expect(parseReceiptSince('  ')).toBeNull();
    expect(parseReceiptSince('2026-10-16')).toBeNull();
    expect(parseReceiptSince('2026-10-16T00:00:00')).toBeNull();
    expect(parseReceiptSince('2026-02-30T00:00:00Z')).toBeNull();
  });

  it('a valid explicit-zone instant -> its canonical UTC string, same grammar as the tenders cutoff', () => {
    expect(parseReceiptSince('2026-10-16T02:00:00+02:00')).toBe('2026-10-16T00:00:00.000Z');
    expect(parseReceiptSince(' 2026-10-16T00:00:00Z ')).toBe(
      parseTendersSince('2026-10-16T00:00:00Z'),
    );
  });
});

describe('RT-540 — receipt gate and mapping (buildCapturePayload)', () => {
  it('default off: no cutoff -> no receipt key, body identical to the pre-RT-540 payload', () => {
    const sale = saleRow();
    const off = buildCapturePayload(sale);
    expect('receipt' in off).toBe(false);
    expect('receipt' in buildCapturePayload(sale, { receiptSince: null })).toBe(false);
    expect(buildCapturePayload(sale, { receiptSince: undefined })).toEqual(off);
  });

  it('cutoff rule: before the cutoff -> no receipt; at/after -> receipt; the tenders cutoff is independent', () => {
    const before = saleRow({ finalized_at: '2026-10-15T23:59:59.999Z' });
    const at = saleRow({ finalized_at: SINCE });
    expect('receipt' in buildCapturePayload(before, ON)).toBe(false);
    expect(buildCapturePayload(at, ON).receipt).toBeDefined();
    // A tenders cutoff alone never turns the receipt on.
    expect('receipt' in buildCapturePayload(at, { tendersSince: SINCE })).toBe(false);
  });

  it('maps the stored receipt facts verbatim; receiptNumber omitted when equal to saleNumber', () => {
    const receipt = buildCapturePayload(saleRow(), ON).receipt;
    expect(receipt).toEqual({
      saleNumber: 'TILL-1-2026-10-16-000007',
      terminalLabel: 'TILL-1',
      operatorDisplayName: 'Operator One',
      settledAt: '2026-10-16T10:00:00.000Z',
      branchName: 'Main Branch',
      branchAddress: '1 Nile St, Cairo',
      taxRegistrationId: 'TRN-123',
    });
    expect(receipt !== undefined && 'receiptNumber' in receipt).toBe(false);
    expect(receipt !== undefined && 'changeGivenMinor' in receipt).toBe(false);
  });

  it('receiptNumber is sent only when it differs from saleNumber', () => {
    const receipt = buildCapturePayload(saleRow({ receipt_number: 'R-9' }), ON).receipt;
    expect(receipt?.receiptNumber).toBe('R-9');
  });

  it('cash with change -> changeGivenMinor from total_change_due_minor; cash tender stays NET', () => {
    const sale = saleRow({
      subtotal_minor: 1500,
      total_change_due_minor: 500,
      tender_lines_summary_json: JSON.stringify([
        { tender_type: 'cash', amount_applied_minor: 2000, change_due_minor: 500 },
      ]),
    });
    const p = buildCapturePayload(sale, { ...ON, tendersSince: SINCE });
    expect(p.receipt?.changeGivenMinor).toBe(500);
    expect(p.tenders).toEqual([{ method: 'cash', amountMinor: 1500 }]);
    // cash handed over = net cash tender + change
    expect((p.tenders?.[0]?.amountMinor ?? 0) + (p.receipt?.changeGivenMinor ?? 0)).toBe(2000);
  });

  it('split tender with change -> change appears once, on the receipt', () => {
    const sale = saleRow({
      subtotal_minor: 1500,
      total_change_due_minor: 200,
      tender_lines_summary_json: JSON.stringify([
        { tender_type: 'external_card_terminal', amount_applied_minor: 500 },
        { tender_type: 'cash', amount_applied_minor: 1200, change_due_minor: 200 },
      ]),
    });
    const p = buildCapturePayload(sale, { ...ON, tendersSince: SINCE });
    expect(p.tenders).toEqual([
      { method: 'card_external', amountMinor: 500 },
      { method: 'cash', amountMinor: 1000 },
    ]);
    expect(p.receipt?.changeGivenMinor).toBe(200);
    expect(JSON.stringify(p.tenders)).not.toContain('change');
  });

  it('line order is the order of lines_json, receipt on or off', () => {
    const lines = ['c', 'a', 'b'].map((id, i) => ({
      line_id: `l-${id}`,
      item_ref: `p-${id}`,
      display_name: `Item ${id}`,
      quantity: 1,
      unit_price_minor: 500,
      line_subtotal_minor: 500,
      i,
    }));
    const sale = saleRow({ subtotal_minor: 1500, lines_json: JSON.stringify(lines) });
    expect(buildCapturePayload(sale, ON).lines.map((l) => l.lineRef)).toEqual([
      'l-c',
      'l-a',
      'l-b',
    ]);
    const wire = toWireBody(buildCapturePayload(sale, ON), 'EGP');
    expect(wire.lines.map((l) => l.lineName)).toEqual(['Item c', 'Item a', 'Item b']);
  });

  it('a pre-0028 sale (empty lines_json) still builds and carries its receipt', () => {
    const p = buildCapturePayload(saleRow({ lines_json: '[]' }), ON);
    expect(p.lines).toEqual([]);
    expect(p.receipt?.saleNumber).toBe('TILL-1-2026-10-16-000007');
  });

  it('replay is idempotent: every rebuild (every retry, across a restart) is identical', () => {
    const sale = saleRow({ total_change_due_minor: 300, receipt_number: 'R-9' });
    const first = toWireBody(buildCapturePayload(sale, ON), 'EGP');
    const again = toWireBody(buildCapturePayload({ ...sale }, { ...ON }), 'EGP');
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(
      JSON.stringify(
        toCashierWireBody(
          buildCapturePayload(sale, ON),
          'EGP',
          '0190a3c4-0000-7000-8000-00000000000a',
        ),
      ),
    ).toContain('"receipt"');
  });

  describe('the whole receipt or none: a value the contract would refuse is never sent', () => {
    const cases: [string, Partial<SaleRow>][] = [
      ['empty sale number', { sale_number: '' }],
      ['sale number over 96', { sale_number: 'x'.repeat(97) }],
      ['empty terminal label', { terminal_label: '' }],
      ['terminal label over 64', { terminal_label: 'x'.repeat(65) }],
      ['empty operator display name', { selling_operator_display_name: '' }],
      ['operator display name that is an email', { selling_operator_display_name: 'a@b.example' }],
      ['operator display name with a space and an @', { selling_operator_display_name: 'a b@c.d' }],
      ['whitespace-only operator display name', { selling_operator_display_name: '   ' }],
      ['whitespace-only branch address', { branch_address: '   ' }],
      ['whitespace-only tax registration id', { tenant_tax_registration_id: ' ' }],
      ['unreadable finalized_at', { finalized_at: 'not-a-date' }],
      ['unreadable settled_at', { settled_at: 'yesterday' }],
      ['empty branch name', { branch_name: '' }],
      ['branch name over 256', { branch_name: 'x'.repeat(257) }],
      ['empty branch address', { branch_address: '' }],
      ['branch address over 512', { branch_address: 'x'.repeat(513) }],
      ['empty tax registration id', { tenant_tax_registration_id: '' }],
      ['tax registration id over 64', { tenant_tax_registration_id: 'x'.repeat(65) }],
      ['receipt number over 96 that differs', { receipt_number: 'x'.repeat(97) }],
      ['negative change', { total_change_due_minor: -1 }],
      ['non-integer change', { total_change_due_minor: 1.5 }],
    ];
    it.each(cases)('%s -> no receipt, the sale is still built', (_name, over) => {
      const p = buildCapturePayload(saleRow(over), ON);
      expect('receipt' in p).toBe(false);
      expect(p.externalId).toBe('pos-pulse:handoff-abc');
      expect(p.lines).toHaveLength(1);
    });

    it('values exactly at their bound are accepted', () => {
      const p = buildCapturePayload(
        saleRow({
          sale_number: 's'.repeat(96),
          terminal_label: 't'.repeat(64),
          branch_name: 'b'.repeat(256),
          branch_address: 'a'.repeat(512),
          tenant_tax_registration_id: 'x'.repeat(64),
        }),
        ON,
      );
      expect(p.receipt).toBeDefined();
    });

    it('an empty receipt_number is treated as the same as saleNumber (omitted, receipt kept)', () => {
      const receipt = buildCapturePayload(saleRow({ receipt_number: '' }), ON).receipt;
      expect(receipt).toBeDefined();
      expect(receipt !== undefined && 'receiptNumber' in receipt).toBe(false);
    });
  });
});

describe('RT-540 — wire body (toWireBody / toCashierWireBody)', () => {
  const sale = saleRow({
    subtotal_minor: 1500,
    total_change_due_minor: 500,
    receipt_number: 'R-9',
    tender_lines_summary_json: JSON.stringify([
      { tender_type: 'cash', amount_applied_minor: 2000, change_due_minor: 500 },
    ]),
  });
  const payload: CaptureSalePayload = buildCapturePayload(sale, { ...ON, tendersSince: SINCE });

  it('emits receipt with changeGiven as an exact-decimal string', () => {
    const wire: ContractCaptureSaleRequest = toWireBody(payload, 'EGP');
    expect(wire.receipt).toEqual({
      saleNumber: 'TILL-1-2026-10-16-000007',
      receiptNumber: 'R-9',
      terminalLabel: 'TILL-1',
      operatorDisplayName: 'Operator One',
      settledAt: '2026-10-16T10:00:00.000Z',
      branchName: 'Main Branch',
      branchAddress: '1 Nile St, Cairo',
      taxRegistrationId: 'TRN-123',
      changeGiven: '5.00',
    });
    expect(wire.tenders).toEqual([{ method: 'cash', amount: '15.00' }]);
  });

  it('the device path carries the same receipt', () => {
    const wire = toCashierWireBody(payload, 'EGP', '0190a3c4-0000-7000-8000-00000000000a');
    expect(wire.receipt).toEqual(toWireBody(payload, 'EGP').receipt);
  });

  it('changeGiven honours the currency exponent', () => {
    expect(toWireBody(payload, 'JPY').receipt?.changeGiven).toBe('500');
    expect(toWireBody(payload, 'KWD').receipt?.changeGiven).toBe('0.500');
  });

  it('no change -> no changeGiven key; no receipt -> no receipt key', () => {
    const noChange = toWireBody(buildCapturePayload(saleRow(), ON), 'EGP');
    expect(noChange.receipt !== undefined && 'changeGiven' in noChange.receipt).toBe(false);
    const off = toWireBody(buildCapturePayload(saleRow()), 'EGP');
    expect('receipt' in off).toBe(false);
  });

  it('a non-safe change amount throws at the boundary (the client maps it to permanent)', () => {
    const bad: CaptureSalePayload = {
      ...payload,
      receipt: {
        ...(payload.receipt as NonNullable<CaptureSalePayload['receipt']>),
        changeGivenMinor: Number.MAX_SAFE_INTEGER + 2,
      },
    };
    expect(() => toWireBody(bad, 'EGP')).toThrow();
  });

  it('the wire body with the default (off) payload is byte-identical to today', () => {
    expect(JSON.stringify(toWireBody(buildCapturePayload(saleRow()), 'EGP'))).toBe(
      JSON.stringify({
        sourceSystem: 'pos-pulse',
        externalId: 'pos-pulse:handoff-abc',
        currencyCode: 'EGP',
        posTotal: '15.00',
        occurredAt: '2026-10-16T10:00:00.000Z',
        lines: [
          {
            lineName: 'Panadol',
            unitPrice: '7.50',
            currencyCode: 'EGP',
            quantity: '2',
            lineAmount: '15.00',
            unit: 'unit',
          },
        ],
      }),
    );
  });
});
