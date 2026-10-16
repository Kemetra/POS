/**
 * RT-553 (RT-545 S4) — the service feeds validated server pages to the store
 * zone monitor and answers `saleHistory.zoneStatus` through the RT-546 gate.
 */
import { describe, expect, it } from 'vitest';

import { createSaleHistoryService } from '../sale-history-service.js';
import { CASHIER, MANAGER, harness, okPage } from './__helpers__/service-fixtures.js';
import { OTHER_USER, wireItem } from './__helpers__/wire-fixtures.js';

const RANGE = { from_day: '2026-10-01', to_day: '2026-10-16' };

describe('RT-553 zone mismatch — fed by server pages', () => {
  it('a UTC page raises the flag, logs once, and still returns the page', async () => {
    const h = harness(MANAGER);
    h.client.list.mockResolvedValue(okPage({ storeTimezone: 'UTC' }));
    const service = createSaleHistoryService(h.deps);
    expect(await service.list(RANGE)).toMatchObject({ kind: 'ok', source: 'server' });
    expect(await service.list(RANGE)).toMatchObject({ kind: 'ok', source: 'server' });
    expect(await service.zoneStatus({})).toEqual({
      kind: 'ok',
      status: 'mismatch',
      expected: 'Africa/Cairo',
      reported: 'UTC',
    });
    expect(h.zoneWarn).toHaveBeenCalledTimes(1);
  });

  it('a continuation page counts too', async () => {
    const h = harness(MANAGER);
    h.client.list.mockResolvedValueOnce(okPage({ nextCursor: 'n1' }));
    const service = createSaleHistoryService(h.deps);
    const first = await service.list(RANGE);
    const cursor = first.kind === 'ok' ? first.next_cursor : null;
    h.client.list.mockResolvedValueOnce(okPage({ storeTimezone: 'UTC' }));
    await service.list({ ...RANGE, cursor });
    expect(h.zone.status().status).toBe('mismatch');
  });

  it('a matching page raises no flag and no log; a later match clears a mismatch', async () => {
    const h = harness(MANAGER);
    const service = createSaleHistoryService(h.deps);
    await service.list(RANGE);
    expect(h.zone.status().status).toBe('match');
    expect(h.zoneWarn).not.toHaveBeenCalled();
    h.client.list.mockResolvedValueOnce(okPage({ storeTimezone: 'UTC' }));
    await service.list(RANGE);
    expect(h.zone.status().status).toBe('mismatch');
    await service.list(RANGE);
    expect(h.zone.status().status).toBe('match');
  });

  it('offline pages (no connection, no credential) neither raise nor clear the flag', async () => {
    const h = harness(MANAGER);
    h.client.list.mockResolvedValueOnce(okPage({ storeTimezone: 'UTC' }));
    const service = createSaleHistoryService(h.deps);
    await service.list(RANGE);
    h.client.list.mockResolvedValueOnce({ kind: 'unreachable' });
    expect(await service.list(RANGE)).toMatchObject({ source: 'local' });
    h.credential.value = null;
    expect(await service.list(RANGE)).toMatchObject({ source: 'local' });
    expect(h.zone.status().status).toBe('mismatch');
  });

  it('nothing read yet is unknown, not a match', async () => {
    const h = harness(MANAGER);
    h.client.list.mockResolvedValue({ kind: 'unreachable' });
    const service = createSaleHistoryService(h.deps);
    await service.list(RANGE);
    expect(await service.zoneStatus({})).toMatchObject({ kind: 'ok', status: 'unknown' });
  });

  it('a page the credential check refuses is not trusted: it feeds no flag', async () => {
    const h = harness(CASHIER);
    h.client.list.mockResolvedValue(
      okPage({
        storeTimezone: 'UTC',
        visibility: 'own_sales',
        items: [
          wireItem({ operator: { userRef: OTHER_USER, displayName: 'X', nameSource: 'snapshot' } }),
        ],
      }),
    );
    expect(await createSaleHistoryService(h.deps).list(RANGE)).toMatchObject({ kind: 'refused' });
    expect(h.zone.status().status).toBe('unknown');
    expect(h.zoneWarn).not.toHaveBeenCalled();
  });

  it('does not block or alter the page: a mismatch is only reported', async () => {
    const h = harness(MANAGER);
    h.client.list.mockResolvedValue(okPage({ storeTimezone: 'UTC' }));
    const res = await createSaleHistoryService(h.deps).list(RANGE);
    expect(res).toMatchObject({ kind: 'ok', store_timezone: 'UTC' });
  });
});

describe('RT-553 saleHistory.zoneStatus — gate and shape', () => {
  it('a manager and a cashier may read it', async () => {
    for (const session of [MANAGER, CASHIER]) {
      const service = createSaleHistoryService(harness(session).deps);
      expect(await service.zoneStatus({})).toMatchObject({ kind: 'ok', status: 'unknown' });
    }
  });

  it('refuses without a session or while locked', async () => {
    const none = harness(null);
    expect(await createSaleHistoryService(none.deps).zoneStatus({})).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    const locked = harness(MANAGER);
    locked.session.locked = true;
    expect(await createSaleHistoryService(locked.deps).zoneStatus({})).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
  });

  it('refuses a role outside the allowlist, audited', async () => {
    const h = harness({ ...MANAGER, role: 'viewer' as never });
    expect(await createSaleHistoryService(h.deps).zoneStatus({})).toEqual({
      kind: 'refused',
      reason: 'role_denied',
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action_category: 'sale.access.refused',
        payload: { action: 'saleHistory.zoneStatus', reason: 'role_denied' },
      }),
    );
  });

  it.each([
    [undefined, 'invalid_request'],
    [null, 'invalid_request'],
    ['x', 'invalid_request'],
    [['a'], 'invalid_request'],
    [{ raw_envelope: 'x' }, 'forbidden_field_in_request'],
    [{ anything: 1 }, 'invalid_request'],
  ])('refuses the request %j', async (req, reason) => {
    const service = createSaleHistoryService(harness(MANAGER).deps);
    expect(await service.zoneStatus(req as never)).toEqual({ kind: 'refused', reason });
  });
});
