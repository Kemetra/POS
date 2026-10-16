import { describe, expect, it } from 'vitest';

import { createSaleHistoryService } from '../sale-history-service.js';
import { CASHIER, MANAGER, harness, okDetail } from './__helpers__/service-fixtures.js';
import { OTHER_USER, SALE_REF } from './__helpers__/wire-fixtures.js';

const OTHERS = { operator: { userRef: OTHER_USER, displayName: 'Ali', nameSource: 'snapshot' } };

describe('RT-542 saleHistory.read', () => {
  it('returns the detail, joined to this terminal’s own record', async () => {
    const h = harness(MANAGER);
    h.localIds.set(SALE_REF, 'sale-local-1');
    const res = await createSaleHistoryService(h.deps).read({ sale_ref: SALE_REF });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.detail.summary.local_sale_id).toBe('sale-local-1');
      expect(res.detail.erp.sale).toBe('posted');
      expect(res.detail.lines[0]?.unit_price_minor).toBe(1275);
    }
  });

  it('a manager may open another operator’s sale (store scope)', async () => {
    const h = harness(MANAGER);
    h.client.read.mockResolvedValue(okDetail({}, OTHERS));
    expect((await createSaleHistoryService(h.deps).read({ sale_ref: SALE_REF })).kind).toBe('ok');
  });

  it('a cashier is refused another operator’s sale, non-disclosing, and it is audited', async () => {
    const h = harness(CASHIER);
    h.client.read.mockResolvedValue(okDetail({}, OTHERS));
    expect(await createSaleHistoryService(h.deps).read({ sale_ref: SALE_REF })).toEqual({
      kind: 'refused',
      reason: 'sale_not_found',
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action_category: 'sale.access.refused',
        attribution_operator_id: 'op-cashier',
        payload: { action: 'saleHistory.read', reason: 'not_owner', sale_id: SALE_REF },
      }),
    );
  });

  it('a cashier is refused a sale with no recorded operator', async () => {
    const h = harness(CASHIER);
    h.client.read.mockResolvedValue(
      okDetail({}, { operator: { userRef: null, displayName: null, nameSource: 'unavailable' } }),
    );
    expect(await createSaleHistoryService(h.deps).read({ sale_ref: SALE_REF })).toEqual({
      kind: 'refused',
      reason: 'sale_not_found',
    });
  });

  it.each([
    ['not_found', 'sale_not_found'],
    ['unauthorized', 'server_refused'],
    ['unreachable', 'unavailable'],
    ['unreadable', 'unavailable'],
    ['invalid', 'unavailable'],
  ] as const)('maps %s to %s', async (kind, reason) => {
    const h = harness(MANAGER);
    h.client.read.mockResolvedValue({ kind });
    expect(await createSaleHistoryService(h.deps).read({ sale_ref: SALE_REF })).toEqual({
      kind: 'refused',
      reason,
    });
  });

  it('refuses without a credential (detail is online only)', async () => {
    const h = harness(MANAGER);
    h.credential.value = null;
    expect(await createSaleHistoryService(h.deps).read({ sale_ref: SALE_REF })).toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
  });

  it.each([
    ['a malformed ref', { sale_ref: '../etc' }, 'invalid_request'],
    ['an extra key', { sale_ref: SALE_REF, terminal_id: 'x' }, 'invalid_request'],
    ['a forbidden key', { sale_ref: SALE_REF, cvv: '1' }, 'forbidden_field_in_request'],
  ])('refuses %s with no request', async (_label, req, reason) => {
    const h = harness(MANAGER);
    expect(await createSaleHistoryService(h.deps).read(req)).toEqual({
      kind: 'refused',
      reason,
    });
    expect(h.client.read).not.toHaveBeenCalled();
  });
});
