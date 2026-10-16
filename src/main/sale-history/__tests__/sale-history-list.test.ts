import { describe, expect, it } from 'vitest';

import { createSaleHistoryService } from '../sale-history-service.js';
import {
  ADMISSION_ID,
  CASHIER,
  DEVICE_TOKEN,
  ENVELOPE_TOKEN,
  MANAGER,
  harness,
  localRow,
  okPage,
} from './__helpers__/service-fixtures.js';
import { CASHIER_USER, OTHER_USER, SALE_REF, wireItem } from './__helpers__/wire-fixtures.js';

const RANGE = { from_day: '2026-10-01', to_day: '2026-10-16' };

describe('RT-542 saleHistory.list — role matrix (OD-534-1)', () => {
  it('a manager reads the store with the envelope; the page keeps its server facts', async () => {
    const h = harness(MANAGER);
    h.localIds.set(SALE_REF, 'sale-local-1');
    const res = await createSaleHistoryService(h.deps).list(RANGE);
    expect(h.client.list).toHaveBeenCalledWith(
      { from: '2026-10-01', to: '2026-10-16', pageSize: 50, cursor: null },
      { kind: 'envelope', token: ENVELOPE_TOKEN },
    );
    expect(res).toMatchObject({
      kind: 'ok',
      source: 'server',
      store_timezone: 'Africa/Cairo',
      as_of: '2026-10-16T09:00:00.000Z',
      visibility: 'store',
      next_cursor: null,
    });
    if (res.kind === 'ok' && res.source === 'server') {
      expect(res.rows[0]?.local_sale_id).toBe('sale-local-1');
    }
  });

  it('a cashier reads their own sales across tills with the device token + admission', async () => {
    const h = harness(CASHIER);
    h.client.list.mockResolvedValue(okPage({ visibility: 'own_sales' }));
    const res = await createSaleHistoryService(h.deps).list(RANGE);
    expect(h.client.list.mock.calls[0]?.[1]).toEqual({
      kind: 'device',
      token: DEVICE_TOKEN,
      admissionId: ADMISSION_ID,
    });
    expect(res).toMatchObject({ kind: 'ok', source: 'server', visibility: 'own_sales' });
  });

  it('matches the cashier’s own sales whatever the case of the server’s user ref', async () => {
    const h = harness(CASHIER);
    const upper = {
      userRef: CASHIER_USER.toUpperCase(),
      displayName: 'Mona',
      nameSource: 'snapshot',
    };
    h.client.list.mockResolvedValue(
      okPage({ visibility: 'own_sales', items: [wireItem({ operator: upper })] }),
    );
    expect(await createSaleHistoryService(h.deps).list(RANGE)).toMatchObject({
      kind: 'ok',
      source: 'server',
    });
  });

  it('fails closed when the server gives a cashier another operator’s sale', async () => {
    const h = harness(CASHIER);
    h.client.list.mockResolvedValue(
      okPage({
        visibility: 'own_sales',
        items: [
          wireItem(),
          wireItem({ operator: { userRef: OTHER_USER, displayName: 'X', nameSource: 'snapshot' } }),
        ],
      }),
    );
    expect(await createSaleHistoryService(h.deps).list(RANGE)).toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action_category: 'sale.access.refused',
        payload: { action: 'saleHistory.list', reason: 'not_owner', sale_id: SALE_REF },
      }),
    );
  });

  it('fails closed on a visibility that does not match the credential', async () => {
    const cashier = harness(CASHIER);
    cashier.client.list.mockResolvedValue(okPage({ visibility: 'store' }));
    expect(await createSaleHistoryService(cashier.deps).list(RANGE)).toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
    const manager = harness(MANAGER);
    manager.client.list.mockResolvedValue(okPage({ visibility: 'own_sales' }));
    expect(await createSaleHistoryService(manager.deps).list(RANGE)).toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
  });

  it('merges only this terminal’s unsent sales, filtered to the cashier, on page one', async () => {
    const h = harness(CASHIER);
    h.client.list.mockResolvedValue(okPage({ visibility: 'own_sales', nextCursor: 'n1' }));
    h.unsynced.mockReturnValue([{ ...localRow(), sync: 'pending' }]);
    const res = await createSaleHistoryService(h.deps).list(RANGE);
    const query = h.unsynced.mock.calls[0]?.[0];
    expect(query?.selling_operator_id).toBe('op-cashier');
    expect(query?.scope).toEqual({ tenant_id: 't1', branch_id: 'b1', terminal_id: 'term-1' });
    expect(res).toMatchObject({
      kind: 'ok',
      source: 'server',
      unsynced: [{ sale_id: 'sale-local-1', sync: 'pending', business_day: '2026-10-16' }],
      unsynced_truncated: false,
      next_cursor: 's.n1',
    });
  });

  it('marks the unsent list truncated past 100 and never merges on later pages', async () => {
    const h = harness(MANAGER);
    h.unsynced.mockReturnValue(
      Array.from({ length: 101 }, () => ({ ...localRow(), sync: 'pending' })),
    );
    const first = await createSaleHistoryService(h.deps).list(RANGE);
    expect(first).toMatchObject({ unsynced_truncated: true });
    if (first.kind === 'ok' && first.source === 'server') expect(first.unsynced).toHaveLength(100);
    h.unsynced.mockClear();
    await createSaleHistoryService(h.deps).list({ ...RANGE, cursor: 's.n1' });
    expect(h.unsynced).not.toHaveBeenCalled();
  });
});

describe('RT-542 saleHistory.list — session gate (RT-546)', () => {
  it('refuses without a session or while locked, with no request', async () => {
    const none = harness(null);
    expect(await createSaleHistoryService(none.deps).list(RANGE)).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    const locked = harness(MANAGER);
    locked.session.locked = true;
    expect(await createSaleHistoryService(locked.deps).list(RANGE)).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    expect(none.client.list).not.toHaveBeenCalled();
    expect(locked.client.list).not.toHaveBeenCalled();
  });

  it('refuses a page that lands after the session changed', async () => {
    const h = harness(MANAGER);
    h.client.list.mockImplementation(() => {
      h.session.current = { ...CASHIER };
      return Promise.resolve(okPage());
    });
    expect(await createSaleHistoryService(h.deps).list(RANGE)).toEqual({
      kind: 'refused',
      reason: 'session_changed',
    });
  });
});

describe('RT-542 saleHistory.list — request validation (§A4)', () => {
  it.each([
    ['an unknown key', { ...RANGE, tenant_id: 't2' }, 'invalid_request'],
    ['a bad day', { from_day: '2026-13-01', to_day: '2026-10-16' }, 'invalid_request'],
    ['a reversed range', { from_day: '2026-10-16', to_day: '2026-10-01' }, 'invalid_request'],
    ['32 days', { from_day: '2026-09-15', to_day: '2026-10-16' }, 'range_too_wide'],
    ['a page size of 101', { ...RANGE, page_size: 101 }, 'invalid_request'],
    ['a cursor without a source', { ...RANGE, cursor: 'abc' }, 'invalid_request'],
    ['a server cursor off the charset', { ...RANGE, cursor: 's.a|b' }, 'invalid_request'],
    ['a forbidden key', { ...RANGE, raw_envelope: 'x' }, 'forbidden_field_in_request'],
  ])('refuses %s with no request', async (_label, req, reason) => {
    const h = harness(MANAGER);
    expect(await createSaleHistoryService(h.deps).list(req)).toEqual({
      kind: 'refused',
      reason,
    });
    expect(h.client.list).not.toHaveBeenCalled();
  });

  it('accepts exactly 31 days and passes the page size through', async () => {
    const h = harness(MANAGER);
    await createSaleHistoryService(h.deps).list({
      from_day: '2026-09-16',
      to_day: '2026-10-16',
      page_size: 100,
    });
    expect(h.client.list.mock.calls[0]?.[0]).toMatchObject({ pageSize: 100 });
  });
});

describe('RT-542 saleHistory.list — pagination, offline and refusals', () => {
  it('continues a server walk with the opaque cursor', async () => {
    const h = harness(MANAGER);
    await createSaleHistoryService(h.deps).list({ ...RANGE, cursor: 's.abc_1' });
    expect(h.client.list.mock.calls[0]?.[0]).toMatchObject({ cursor: 'abc_1' });
  });

  it('falls back to this device only when the server cannot be reached on page one', async () => {
    const h = harness(MANAGER);
    h.client.list.mockResolvedValue({ kind: 'unreachable' });
    const res = await createSaleHistoryService(h.deps).list(RANGE);
    expect(res).toMatchObject({
      kind: 'ok',
      source: 'local',
      coverage: 'this_device_only',
      offline_reason: 'no_connection',
    });
  });

  it('falls back to this device only, saying the server failed, on a 5xx / 429', async () => {
    const h = harness(MANAGER);
    h.client.list.mockResolvedValue({ kind: 'server_error' });
    const res = await createSaleHistoryService(h.deps).list(RANGE);
    expect(res).toMatchObject({
      kind: 'ok',
      source: 'local',
      offline_reason: 'server_unavailable',
    });
    const cursorOf = await createSaleHistoryService(h.deps).list({ ...RANGE, cursor: 's.n1' });
    expect(cursorOf).toEqual({ kind: 'refused', reason: 'continuation_failed' });
  });

  it('falls back to this device only without a credential (no request)', async () => {
    const h = harness(CASHIER);
    h.credential.value = null;
    const res = await createSaleHistoryService(h.deps).list(RANGE);
    expect(res).toMatchObject({ kind: 'ok', source: 'local', offline_reason: 'no_credential' });
    expect(h.client.list).not.toHaveBeenCalled();
    // OD-534-1 on the local read too: a cashier sees only their own.
    expect(h.localList.mock.calls[0]?.[0]).toMatchObject({ selling_operator_id: 'op-cashier' });
  });

  it('continues a local walk locally, keeping its reason, and never asks the server', async () => {
    const h = harness(MANAGER);
    h.localList.mockReturnValue(Array.from({ length: 51 }, () => localRow()));
    const first = await createSaleHistoryService(h.deps).list({ ...RANGE });
    expect(first).toMatchObject({ source: 'server' });
    h.credential.value = null;
    const offline = await createSaleHistoryService(h.deps).list(RANGE);
    expect(offline).toMatchObject({ source: 'local' });
    const cursor = offline.kind === 'ok' ? offline.next_cursor : null;
    expect(cursor?.startsWith('c.')).toBe(true);
    h.credential.value = 'auto';
    h.client.list.mockClear();
    const next = await createSaleHistoryService(h.deps).list({ ...RANGE, cursor });
    expect(next).toMatchObject({ source: 'local', offline_reason: 'no_credential' });
    expect(h.client.list).not.toHaveBeenCalled();
  });

  it('reports a continuation failure without switching to the local view', async () => {
    const h = harness(MANAGER);
    h.client.list.mockResolvedValue({ kind: 'unreachable' });
    expect(await createSaleHistoryService(h.deps).list({ ...RANGE, cursor: 's.n1' })).toEqual({
      kind: 'refused',
      reason: 'continuation_failed',
    });
  });

  it('restarts the walk when the server rejects the cursor', async () => {
    const h = harness(MANAGER);
    h.client.list.mockResolvedValue({ kind: 'invalid' });
    expect(await createSaleHistoryService(h.deps).list({ ...RANGE, cursor: 's.n1' })).toEqual({
      kind: 'refused',
      reason: 'cursor_rejected',
    });
    expect(await createSaleHistoryService(h.deps).list(RANGE)).toEqual({
      kind: 'refused',
      reason: 'invalid_request',
    });
  });

  it.each([
    ['unauthorized', 'server_refused'],
    ['unreadable', 'unavailable'],
    ['not_found', 'unavailable'],
  ] as const)('maps %s to %s', async (kind, reason) => {
    const h = harness(MANAGER);
    h.client.list.mockResolvedValue({ kind });
    expect(await createSaleHistoryService(h.deps).list(RANGE)).toEqual({ kind: 'refused', reason });
  });
});
