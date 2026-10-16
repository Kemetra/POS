import { describe, expect, it, vi } from 'vitest';

import { createSaleHistoryService } from '../sale-history-service.js';
import {
  CASHIER,
  MANAGER,
  harness,
  localSaleRow,
  okDetail,
  okReprint,
} from './__helpers__/service-fixtures.js';
import { OTHER_SALE_REF, OTHER_USER, SALE_REF, wireReturn } from './__helpers__/wire-fixtures.js';

const DUPLICATE = { sale_ref: SALE_REF, kind: 'duplicate' as const };
const RECORD = { sale_ref: SALE_REF, kind: 'sale_record' as const };
const VOIDED = {
  void: {
    voidedAt: '2026-10-16T12:00:00.000Z',
    voidBusinessDate: '2026-10-16',
    approved: true,
    approverRole: 'store_manager',
  },
  reprint: { duplicate: 'unavailable_voided', saleRecord: 'allowed', marks: ['voided'] },
};

describe('RT-542 saleHistory.reprint — duplicate (OD-534-3)', () => {
  it('authorizes first, then prints a marked duplicate with the server copy number', async () => {
    const h = harness(MANAGER);
    const res = await createSaleHistoryService(h.deps).reprint(DUPLICATE);
    expect(h.client.authorizeReprint).toHaveBeenCalledWith(
      {
        saleRef: SALE_REF,
        kind: 'duplicate',
        printedAt: '2026-10-16T11:00:00.000Z',
        idempotencyKey: 'pos-pulse-reprint:0190a3c4-0000-4000-8000-000000000001',
      },
      { kind: 'envelope', token: 'env-token' },
    );
    expect(res).toEqual({
      kind: 'ok',
      printed: 'duplicate',
      copy_number: 2,
      marks: [],
      printed_at: '2026-10-16T11:00:00.000Z',
    });
    expect(h.printed).toHaveLength(1);
    expect(h.printed[0]).toContain('نسخة طبق الأصل');
    expect(h.printed[0]).toContain('Duplicate # 2');
    expect(h.printed[0]).toContain('Rahma Pharmacy');
    // RT-249 N-S5: the sale stamp is the Cairo time of settledAt (07:59 UTC → 10:59).
    expect(h.printed[0]).toContain('2026-10-16 10:59');
  });

  it('prints this terminal’s own record when it made the sale (receipt fidelity)', async () => {
    const h = harness(MANAGER);
    h.localIds.set(SALE_REF, 'sale-local-1');
    h.localSales.set('sale-local-1', localSaleRow());
    h.successfulPrints.add('sale-local-1');
    await createSaleHistoryService(h.deps).reprint(DUPLICATE);
    expect(h.printed[0]).toContain('Local Branch Name');
    expect(h.printed[0]).toContain('Duplicate # 2');
  });

  it('refuses this terminal’s own sale that never printed its original', async () => {
    const h = harness(MANAGER);
    h.localIds.set(SALE_REF, 'sale-local-1');
    h.localSales.set('sale-local-1', localSaleRow());
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'not_yet_printed',
    });
    expect(h.client.authorizeReprint).not.toHaveBeenCalled();
  });

  it('never prints a duplicate the detail does not allow (incomplete or voided)', async () => {
    for (const overrides of [
      {
        receiptFacts: 'partial',
        reprint: { duplicate: 'unavailable_incomplete', saleRecord: 'allowed', marks: [] },
      },
      VOIDED,
    ]) {
      const h = harness(MANAGER);
      h.client.read.mockResolvedValue(
        okDetail(overrides, overrides === VOIDED ? { voided: true } : {}),
      );
      expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
        kind: 'refused',
        reason: 'duplicate_unavailable',
      });
      expect(h.client.authorizeReprint).not.toHaveBeenCalled();
      expect(h.printed).toHaveLength(0);
    }
  });

  it('maps the server 422 to duplicate_unavailable and prints nothing', async () => {
    const h = harness(MANAGER);
    h.client.authorizeReprint.mockResolvedValue({ kind: 'duplicate_unavailable' });
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'duplicate_unavailable',
    });
    expect(h.printed).toHaveLength(0);
  });

  it('marks a returned sale and lists its returns (OD-534-8 A)', async () => {
    const h = harness(MANAGER);
    h.client.read.mockResolvedValue(
      okDetail(
        {
          returns: [wireReturn()],
          reprint: { duplicate: 'allowed', saleRecord: 'allowed', marks: ['returned'] },
        },
        { returnState: 'partial' },
      ),
    );
    h.client.authorizeReprint.mockResolvedValue(okReprint({ marks: ['returned'] }));
    const res = await createSaleHistoryService(h.deps).reprint(DUPLICATE);
    expect(res).toMatchObject({ kind: 'ok', marks: ['returned'] });
    expect(h.printed[0]).toContain('RETURNED');
    expect(h.printed[0]).toContain('مرتجع');
    expect(h.printed[0]).toContain('12.75');
  });
});

describe('RT-542 saleHistory.reprint — sale record (OD-534-3/8)', () => {
  it('prints a VOIDED sale record, never a receipt copy', async () => {
    const h = harness(MANAGER);
    h.client.read.mockResolvedValue(okDetail(VOIDED, { voided: true }));
    h.client.authorizeReprint.mockResolvedValue(
      okReprint({ kind: 'sale_record', marks: ['voided'], copyNumber: 1 }),
    );
    const res = await createSaleHistoryService(h.deps).reprint(RECORD);
    expect(res).toMatchObject({
      kind: 'ok',
      printed: 'sale_record',
      copy_number: 1,
      marks: ['voided'],
    });
    const slip = h.printed[0] ?? '';
    expect(slip).toContain('SALE RECORD');
    expect(slip).toContain('VOIDED');
    expect(slip).toContain('ملغي');
    expect(slip).not.toContain('نسخة طبق الأصل');
  });

  it('labels every unrecorded block of a legacy sale instead of guessing', async () => {
    const h = harness(MANAGER);
    h.client.read.mockResolvedValue(
      okDetail(
        {
          tenderState: 'unknown',
          tenders: [],
          changeGiven: null,
          settledAt: null,
          receiptNumber: null,
          receiptHeader: null,
          lineOrder: 'not_recorded',
          receiptFacts: 'partial',
          reprint: { duplicate: 'unavailable_incomplete', saleRecord: 'allowed', marks: [] },
        },
        {
          saleNumber: null,
          device: { deviceRef: null, label: null, labelSource: 'unavailable' },
          operator: { userRef: null, displayName: 'Mona', nameSource: 'current' },
        },
      ),
    );
    h.client.authorizeReprint.mockResolvedValue(okReprint({ kind: 'sale_record', copyNumber: 1 }));
    await createSaleHistoryService(h.deps).reprint(RECORD);
    const slip = h.printed[0] ?? '';
    expect(slip).toContain('not recorded');
    expect(slip).toContain('(current name)');
    expect(slip).not.toContain('Tax ID');
  });

  it('strips bidi overrides from server text before printing', async () => {
    const h = harness(MANAGER);
    h.client.read.mockResolvedValue(okDetail({ lines: [{ ...lineWithName('Pana\u202Edol') }] }));
    h.client.authorizeReprint.mockResolvedValue(okReprint({ kind: 'sale_record' }));
    await createSaleHistoryService(h.deps).reprint(RECORD);
    expect(h.printed[0]).toContain('Panadol');
    expect(h.printed[0]).not.toContain('\u202E');
  });
});

function lineWithName(lineName: string): Record<string, unknown> {
  return {
    lineRef: '0190a3c4-0000-4000-8000-0000000000e1',
    sequence: 1,
    lineName,
    unitPrice: '12.75',
    currencyCode: 'EGP',
    quantity: '2',
    lineAmount: '25.50',
    taxAmount: null,
    unit: 'box',
    returnedQuantity: '0',
  };
}

describe('RT-542 saleHistory.reprint — authority, audit and limits', () => {
  it('a cashier reprints only their own sale (OD-534-2), refused non-disclosing otherwise', async () => {
    const h = harness(CASHIER);
    h.client.read.mockResolvedValue(
      okDetail(
        {},
        { operator: { userRef: OTHER_USER, displayName: 'Ali', nameSource: 'snapshot' } },
      ),
    );
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'sale_not_found',
    });
    expect(h.client.authorizeReprint).not.toHaveBeenCalled();
  });

  it('a cashier reprints their own sale on the device path', async () => {
    const h = harness(CASHIER);
    const res = await createSaleHistoryService(h.deps).reprint(DUPLICATE);
    expect(res.kind).toBe('ok');
    expect(h.client.authorizeReprint.mock.calls[0]?.[1]).toMatchObject({ kind: 'device' });
  });

  it('audits the reprint under the signed-in operator, with no secrets', async () => {
    const h = harness(MANAGER);
    await createSaleHistoryService(h.deps).reprint(DUPLICATE);
    expect(h.audit).toHaveBeenCalledWith({
      action_category: 'sale.history.reprinted',
      attribution_operator_id: 'op-manager',
      tenant_id: 't1',
      branch_id: 'b1',
      originating_terminal_id: 'term-1',
      session_id: 'sess-manager',
      created_at: '2026-10-16T11:00:00.000Z',
      payload: {
        sale_ref: SALE_REF,
        kind: 'duplicate',
        copy_number: 2,
        marks: [],
        outcome: 'printed',
      },
    });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('env-token');
  });

  it('reports a printer failure, still audited as print_failed', async () => {
    const h = harness(MANAGER);
    h.printResult.ok = false;
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'printer_unavailable',
    });
    expect(h.audit.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { outcome: 'print_failed' } });
  });

  it('prints nothing when the authorization answers another sale or kind', async () => {
    for (const reprint of [
      okReprint({ saleRef: OTHER_SALE_REF }),
      okReprint({ kind: 'sale_record' }),
    ]) {
      const h = harness(MANAGER);
      h.client.authorizeReprint.mockResolvedValue(reprint);
      expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
        kind: 'refused',
        reason: 'unavailable',
      });
      expect(h.printed).toHaveLength(0);
    }
  });

  it('runs one reprint of a sale at a time', async () => {
    const h = harness(MANAGER);
    let release: () => void = () => undefined;
    h.client.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(okDetail());
          };
        }),
    );
    const service = createSaleHistoryService(h.deps);
    const first = service.reprint(DUPLICATE);
    expect(await service.reprint(DUPLICATE)).toEqual({ kind: 'refused', reason: 'busy' });
    await vi.waitFor(() => {
      expect(h.client.read).toHaveBeenCalled();
    });
    release();
    expect((await first).kind).toBe('ok');
    expect((await service.reprint(DUPLICATE)).kind).toBe('ok');
  });

  it('prints nothing when the session changed during the authorization', async () => {
    const h = harness(MANAGER);
    h.client.authorizeReprint.mockImplementation(() => {
      h.session.current = { ...CASHIER };
      return Promise.resolve(okReprint());
    });
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'session_changed',
    });
    expect(h.printed).toHaveLength(0);
  });

  it.each([['no credential', 'unavailable']])('refuses with %s', async (_label, reason) => {
    const h = harness(MANAGER);
    h.credential.value = null;
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason,
    });
  });

  it.each([
    ['an unknown kind', { sale_ref: SALE_REF, kind: 'original' }, 'invalid_request'],
    [
      'an idempotency key from the renderer',
      { ...DUPLICATE, idempotency_key: 'x' },
      'invalid_request',
    ],
    ['a copy number from the renderer', { ...DUPLICATE, copy_number: 1 }, 'invalid_request'],
  ])('refuses %s', async (_label, req, reason) => {
    const h = harness(MANAGER);
    expect(await createSaleHistoryService(h.deps).reprint(req as typeof DUPLICATE)).toEqual({
      kind: 'refused',
      reason,
    });
  });
});

describe('RT-542 review fixes — marks never weaker than the record (OD-534-8)', () => {
  function ownLocalSale(h: ReturnType<typeof harness>): void {
    h.localIds.set(SALE_REF, 'sale-local-1');
    h.localSales.set('sale-local-1', localSaleRow());
    h.successfulPrints.add('sale-local-1');
  }

  it('refuses a duplicate of this terminal’s sale with a live local void the server does not know yet', async () => {
    const h = harness(MANAGER);
    ownLocalSale(h);
    h.localVoided.add('sale-local-1');
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'duplicate_unavailable',
    });
    expect(h.client.authorizeReprint).not.toHaveBeenCalled();
  });

  it('marks the sale record VOIDED for a live local void', async () => {
    const h = harness(MANAGER);
    ownLocalSale(h);
    h.localVoided.add('sale-local-1');
    h.client.authorizeReprint.mockResolvedValue(okReprint({ kind: 'sale_record', copyNumber: 1 }));
    const res = await createSaleHistoryService(h.deps).reprint(RECORD);
    expect(res).toMatchObject({ kind: 'ok', marks: ['voided'] });
    expect(h.printed[0]).toContain('VOIDED');
  });

  it('refuses a duplicate when the detail itself says voided, whatever the eligibility says', async () => {
    const h = harness(MANAGER);
    h.client.read.mockResolvedValue(okDetail({}, { voided: true }));
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'duplicate_unavailable',
    });
  });

  it('prints nothing when the authorization drops a mark the detail implies', async () => {
    const h = harness(MANAGER);
    h.client.read.mockResolvedValue(
      okDetail({ returns: [wireReturn()] }, { returnState: 'partial' }),
    );
    h.client.authorizeReprint.mockResolvedValue(okReprint({ marks: [] }));
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
    expect(h.printed).toHaveLength(0);
  });

  it('builds no duplicate from server lines that do not add up to the total', async () => {
    const h = harness(MANAGER);
    h.client.read.mockResolvedValue(okDetail({}, { posTotal: '99.00' }));
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'duplicate_unavailable',
    });
  });

  it('re-checks the local void after the authorization (a void made meanwhile)', async () => {
    const h = harness(MANAGER);
    ownLocalSale(h);
    h.client.authorizeReprint.mockImplementation(() => {
      h.localVoided.add('sale-local-1');
      return Promise.resolve(okReprint());
    });
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'duplicate_unavailable',
    });
    expect(h.printed).toHaveLength(0);
    expect(h.audit.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { outcome: 'unprintable' } });
  });

  it('marks a sale record VOIDED for a local void made during the authorization', async () => {
    const h = harness(MANAGER);
    ownLocalSale(h);
    h.client.authorizeReprint.mockImplementation(() => {
      h.localVoided.add('sale-local-1');
      return Promise.resolve(okReprint({ kind: 'sale_record', copyNumber: 1 }));
    });
    expect(await createSaleHistoryService(h.deps).reprint(RECORD)).toMatchObject({
      kind: 'ok',
      marks: ['voided'],
    });
  });

  it('builds no duplicate from server facts whose line tax is not recorded', async () => {
    const h = harness(MANAGER);
    h.client.read.mockResolvedValue(okDetail({ lines: [lineWithName('Panadol')] }));
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'duplicate_unavailable',
    });
  });

  it('a cashier never prints another operator’s local record', async () => {
    const h = harness(CASHIER);
    ownLocalSale(h);
    h.localSales.set('sale-local-1', localSaleRow({ selling_operator_id: 'op-other' }));
    expect(await createSaleHistoryService(h.deps).reprint(DUPLICATE)).toEqual({
      kind: 'refused',
      reason: 'sale_not_found',
    });
  });
});
