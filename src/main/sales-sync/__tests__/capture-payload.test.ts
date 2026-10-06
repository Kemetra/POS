/**
 * 011 T022 (RED) — `buildCapturePayload`.
 *
 * Maps a durable `SaleRow` → the `CaptureSalePayload` POSTed to DP2 `captureSale`.
 * Pure (no I/O). Invariants (spec FR-2/FR-9/FR-10, contracts/README.md):
 *   • `externalId` is deterministic from the sale (stable across restarts/retries)
 *     — derived from `envelope_handoff_action_id`, the existing 008 idempotency anchor.
 *   • `sourceSystem` is the fixed constant 'pos-pulse'.
 *   • Identity (tenant/branch/terminal/operator) comes from the Sale row.
 *   • Money is integer minor units verbatim from the Sale — NO float, NO conversion.
 *   • NO tender / payment fields anywhere in the payload (v1, gate A.5).
 *   • Lines come from the frozen `lines_json` snapshot.
 */
import { describe, expect, it } from 'vitest';

import {
  ADMISSION_CHECK_MAX_GAP_MS,
  ADMISSION_CHECK_MIN_GAP_MS,
  buildCapturePayload,
  deriveAdmissionCheckAt,
  parseTendersSince,
  TenderNotSendableError,
} from '../capture-payload.js';
import type { SaleRow } from '../../sales/repositories/sales.repository.js';

function saleRow(over: Partial<SaleRow> = {}): SaleRow {
  return {
    sale_id: 'sale-1',
    sale_number: 'SN-1',
    receipt_number: 'R-1',
    envelope_handoff_action_id: 'handoff-abc',
    payment_attempt_id: 'pa-1',
    envelope_cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'term-1',
    terminal_label: 'Till 1',
    selling_operator_id: 'op-1',
    selling_operator_display_name: 'Operator One',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 1500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary_json: JSON.stringify([{ kind: 'cash', amount_minor: 1500 }]),
    settled_at: '2026-06-07T10:00:00.000Z',
    finalized_at: '2026-06-07T10:00:00.000Z',
    tenant_tax_registration_id: 'TRN-123',
    branch_name: 'Main',
    branch_address: 'Cairo',
    local_calendar_day: '2026-06-07',
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

describe('T022 — buildCapturePayload', () => {
  it('derives a deterministic externalId from the handoff action id', () => {
    const a = buildCapturePayload(saleRow());
    const b = buildCapturePayload(saleRow());
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId).toContain('handoff-abc');
  });

  it('sets the fixed sourceSystem constant', () => {
    expect(buildCapturePayload(saleRow()).sourceSystem).toBe('pos-pulse');
  });

  it('carries identity from the Sale row', () => {
    const p = buildCapturePayload(saleRow());
    expect(p.tenantId).toBe('tenant-1');
    expect(p.branchId).toBe('branch-1');
    expect(p.terminalId).toBe('term-1');
    expect(p.operatorId).toBe('op-1');
    expect(p.occurredAt).toBe('2026-06-07T10:00:00.000Z');
  });

  it('carries integer-minor totals verbatim (no float)', () => {
    const p = buildCapturePayload(saleRow({ subtotal_minor: 1999 }));
    expect(p.totalMinor).toBe(1999);
    expect(Number.isInteger(p.totalMinor)).toBe(true);
  });

  it('maps lines from the frozen lines_json snapshot with integer-minor money', () => {
    const p = buildCapturePayload(saleRow());
    expect(p.lines).toHaveLength(1);
    const [line] = p.lines;
    if (line === undefined) throw new Error('expected one line');
    expect(line.lineRef).toBe('l-1');
    expect(line.productRef).toBe('p-1');
    expect(line.lineName).toBe('Panadol');
    expect(line.quantity).toBe(2);
    expect(line.unitPriceMinor).toBe(750);
    expect(line.lineAmountMinor).toBe(1500);
  });

  it('emits NO tender / payment fields anywhere in the payload', () => {
    const p = buildCapturePayload(saleRow());
    const serialized = JSON.stringify(p).toLowerCase();
    expect(serialized).not.toContain('tender');
    expect(serialized).not.toContain('payment');
    expect(serialized).not.toContain('cash');
    expect(serialized).not.toContain('change');
    // and the typed object exposes no tender key
    expect('tender' in p).toBe(false);
    expect('tenderLines' in p).toBe(false);
  });

  it('handles an empty lines_json snapshot as zero lines', () => {
    const p = buildCapturePayload(saleRow({ lines_json: '[]' }));
    expect(p.lines).toEqual([]);
  });
});

// ── RT-79 — tenders on capture (RT-10 D1/D2; owner decisions D-A / D-B) ─────────

const CUTOFF = '2026-06-01T00:00:00.000Z';
const ON = { tendersSince: CUTOFF };

function withTenders(lines: unknown[], over: Partial<SaleRow> = {}): SaleRow {
  return saleRow({ tender_lines_summary_json: JSON.stringify(lines), ...over });
}

describe('RT-79 — tenders (frozen tender_lines_summary_json → payload.tenders)', () => {
  it('default off: no cutoff configured -> no tenders key, even with a tendered sale', () => {
    const sale = withTenders([{ tender_type: 'cash', amount_applied_minor: 1500 }]);
    expect('tenders' in buildCapturePayload(sale)).toBe(false);
    expect('tenders' in buildCapturePayload(sale, { tendersSince: null })).toBe(false);
  });

  it('cash with change -> NET amount (applied - change_due)', () => {
    const sale = withTenders([
      { tender_type: 'cash', amount_applied_minor: 2000, change_due_minor: 500 },
    ]);
    expect(buildCapturePayload(sale, ON).tenders).toEqual([{ method: 'cash', amountMinor: 1500 }]);
  });

  it('split cash + card -> cash and card_external; card carries NO reference (D-A)', () => {
    const sale = withTenders([
      { tender_type: 'cash', amount_applied_minor: 1000 },
      {
        tender_type: 'external_card_terminal',
        amount_applied_minor: 500,
        external_reference: '*****',
      },
    ]);
    const tenders = buildCapturePayload(sale, ON).tenders;
    expect(tenders).toEqual([
      { method: 'cash', amountMinor: 1000 },
      { method: 'card_external', amountMinor: 500 },
    ]);
    expect(JSON.stringify(tenders)).not.toContain('reference');
    expect(JSON.stringify(tenders)).not.toContain('*');
  });

  it('aggregates same-method lines into one entry', () => {
    const sale = withTenders([
      { tender_type: 'cash', amount_applied_minor: 700 },
      { tender_type: 'external_card_terminal', amount_applied_minor: 300 },
      { tender_type: 'cash', amount_applied_minor: 500, change_due_minor: 0 },
    ]);
    expect(buildCapturePayload(sale, ON).tenders).toEqual([
      { method: 'cash', amountMinor: 1200 },
      { method: 'card_external', amountMinor: 300 },
    ]);
  });

  it('a voucher tender is NOT sendable (typed error, never a fabricated method)', () => {
    const sale = withTenders([{ tender_type: 'internal_voucher', amount_applied_minor: 1500 }]);
    expect(() => buildCapturePayload(sale, ON)).toThrow(TenderNotSendableError);
  });

  it('a voucher mixed with cash is NOT sendable either', () => {
    const sale = withTenders([
      { tender_type: 'cash', amount_applied_minor: 1000 },
      { tender_type: 'internal_voucher', amount_applied_minor: 500 },
    ]);
    expect(() => buildCapturePayload(sale, ON)).toThrow(TenderNotSendableError);
  });

  it('an unknown tender type, a negative net, or a non-integer amount is NOT sendable', () => {
    for (const bad of [
      [{ tender_type: 'crypto', amount_applied_minor: 1500 }],
      [{ tender_type: 'cash', amount_applied_minor: 100, change_due_minor: 500 }],
      [{ tender_type: 'cash', amount_applied_minor: 15.5 }],
      [null],
    ]) {
      expect(() => buildCapturePayload(withTenders(bad), ON)).toThrow(TenderNotSendableError);
    }
  });

  it('malformed summary JSON is NOT sendable (dead-letter, not a crash)', () => {
    const sale = saleRow({ tender_lines_summary_json: '{not json' });
    expect(() => buildCapturePayload(sale, ON)).toThrow(TenderNotSendableError);
  });

  it('net tenders that do not sum to the sale total are NOT sendable, with the amounts in the reason', () => {
    const sale = withTenders([{ tender_type: 'cash', amount_applied_minor: 1400 }]); // total 1500
    expect(() => buildCapturePayload(sale, ON)).toThrow(
      new TenderNotSendableError('tenders sum 1400 != sale total 1500'),
    );
  });

  it('an empty summary -> tender-unknown: no tenders key', () => {
    expect('tenders' in buildCapturePayload(withTenders([]), ON)).toBe(false);
  });

  it('cutoff rule: before the cutoff -> no tenders; at/after -> tenders; retries identical', () => {
    const lines = [{ tender_type: 'cash', amount_applied_minor: 1500 }];
    const before = withTenders(lines, { finalized_at: '2026-05-31T23:59:59.999Z' });
    const at = withTenders(lines, { finalized_at: CUTOFF });
    const after = withTenders(lines, { finalized_at: '2026-06-02T08:00:00.000Z' });
    expect('tenders' in buildCapturePayload(before, ON)).toBe(false);
    expect(buildCapturePayload(at, ON).tenders).toEqual([{ method: 'cash', amountMinor: 1500 }]);
    expect(buildCapturePayload(after, ON).tenders).toEqual([{ method: 'cash', amountMinor: 1500 }]);
    expect(JSON.stringify(buildCapturePayload(after, ON))).toBe(
      JSON.stringify(buildCapturePayload(after, ON)),
    );
  });

  it('a pre-cutoff voucher sale is left alone (byte-identical to today, not dead-lettered)', () => {
    const sale = withTenders([{ tender_type: 'internal_voucher', amount_applied_minor: 1500 }], {
      finalized_at: '2026-05-01T00:00:00.000Z',
    });
    expect('tenders' in buildCapturePayload(sale, ON)).toBe(false);
  });
});

describe('RT-79 — parseTendersSince (POS_PULSE_FEATURE_SALE_TENDERS_SINCE)', () => {
  it('unset / blank / unparseable -> null (off, fail-safe)', () => {
    expect(parseTendersSince(undefined)).toBeNull();
    expect(parseTendersSince('')).toBeNull();
    expect(parseTendersSince('   ')).toBeNull();
    expect(parseTendersSince('next tuesday')).toBeNull();
  });

  it('non-instant values stay OFF (no explicit Z / offset, date-only, locale formats)', () => {
    for (const bad of [
      '2026-06-01',
      '2026-06-01T00:00:00',
      '06/01/2026',
      'June 1, 2026 00:00 UTC',
      '2026-06-01T00:00:00+0200',
      '2026-13-01T00:00:00Z',
    ]) {
      expect(parseTendersSince(bad)).toBeNull();
    }
  });

  it('calendar-invalid instants stay OFF instead of rolling over (Feb 30, 24:00, :60)', () => {
    for (const bad of [
      '2026-02-30T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-06-01T24:00:00Z',
      '2026-06-01T00:60:00Z',
      '2026-06-01T00:00:60Z',
      '2026-06-01T00:00:00+24:00',
    ]) {
      expect(parseTendersSince(bad)).toBeNull();
    }
    expect(parseTendersSince('2028-02-29T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('accepts Z and +hh:mm instants, with or without fractional seconds', () => {
    expect(parseTendersSince('2026-06-01T00:00:00Z')).toBe('2026-06-01T00:00:00.000Z');
    expect(parseTendersSince('2026-06-01T00:00:00.5Z')).toBe('2026-06-01T00:00:00.500Z');
  });

  it('a valid ISO instant -> its canonical UTC ISO string', () => {
    expect(parseTendersSince(' 2026-06-01T02:00:00+02:00 ')).toBe('2026-06-01T00:00:00.000Z');
  });
});

// ── RT-225 — admissionCheckAt (sales.yaml 1.6.0-draft; owner decision 10916) ─────

const SETTLED = '2026-06-07T10:00:00.000Z';
const SETTLED_MS = Date.parse(SETTLED);
/** A sale settled at SETTLED and finalized `gapMs` later (e.g. by boot recovery). */
function finalizedAfter(gapMs: number, over: Partial<SaleRow> = {}): SaleRow {
  return saleRow({
    settled_at: SETTLED,
    finalized_at: new Date(SETTLED_MS + gapMs).toISOString(),
    ...over,
  });
}

describe('RT-225 — admissionCheckAt = settled_at, only when 5 s < gap <= 7 days', () => {
  it('pins the owner-approved bounds: more than 5 s, at most 7 days', () => {
    expect(ADMISSION_CHECK_MIN_GAP_MS).toBe(5_000);
    expect(ADMISSION_CHECK_MAX_GAP_MS).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it('a sale finalized late (boot recovery) carries its settled time', () => {
    const sale = finalizedAfter(2 * 60 * 60 * 1_000);
    expect(deriveAdmissionCheckAt(sale)).toBe(SETTLED);
    const p = buildCapturePayload(sale);
    expect(p.admissionCheckAt).toBe(SETTLED);
    // occurredAt stays the sale fact (finalized_at), unchanged.
    expect(p.occurredAt).toBe(sale.finalized_at);
  });

  it.each([
    ['no gap (an ordinary sale)', 0],
    ['a 1 ms gap', 1],
    ['exactly 5 s', 5_000],
  ])('%s: no admissionCheckAt, the payload is byte-identical to before', (_n, gapMs) => {
    const sale = finalizedAfter(gapMs);
    expect(deriveAdmissionCheckAt(sale)).toBeNull();
    const p = buildCapturePayload(sale);
    expect('admissionCheckAt' in p).toBe(false);
  });

  it('just over 5 s: sent', () => {
    expect(deriveAdmissionCheckAt(finalizedAfter(5_001))).toBe(SETTLED);
  });

  it('exactly 7 days: sent (the server cap is inclusive)', () => {
    expect(deriveAdmissionCheckAt(finalizedAfter(ADMISSION_CHECK_MAX_GAP_MS))).toBe(SETTLED);
  });

  it('over 7 days: omitted (the server would answer 400)', () => {
    expect(deriveAdmissionCheckAt(finalizedAfter(ADMISSION_CHECK_MAX_GAP_MS + 1))).toBeNull();
    expect('admissionCheckAt' in buildCapturePayload(finalizedAfter(8 * 86_400_000))).toBe(false);
  });

  it('settled AFTER finalized (clock step back): omitted, never a value later than occurredAt', () => {
    expect(deriveAdmissionCheckAt(finalizedAfter(-60_000))).toBeNull();
  });

  it.each([
    ['an unparseable settled_at', { settled_at: 'not-a-date' }],
    ['a zone-less settled_at', { settled_at: '2026-06-07T10:00:00' }],
    ['an unparseable finalized_at', { finalized_at: 'garbage' }],
    ['a calendar-invalid settled_at', { settled_at: '2026-02-30T10:00:00.000Z' }],
  ])('%s: omitted (fail safe — the sale keeps today’s body)', (_n, over) => {
    const sale = finalizedAfter(60 * 60 * 1_000, over);
    expect(deriveAdmissionCheckAt(sale)).toBeNull();
  });

  it('is decided from the stored sale alone: every rebuild (every retry) is identical', () => {
    const sale = finalizedAfter(10 * 60 * 1_000);
    expect(buildCapturePayload(sale)).toEqual(buildCapturePayload(sale));
    expect(JSON.stringify(buildCapturePayload(sale))).toBe(
      JSON.stringify(buildCapturePayload({ ...sale })),
    );
  });

  it('sends settled_at verbatim (an explicit-offset instant is not rewritten)', () => {
    const sale = saleRow({
      settled_at: '2026-06-07T12:00:00.000+02:00',
      finalized_at: '2026-06-07T10:30:00.000Z',
    });
    expect(deriveAdmissionCheckAt(sale)).toBe('2026-06-07T12:00:00.000+02:00');
  });
});
