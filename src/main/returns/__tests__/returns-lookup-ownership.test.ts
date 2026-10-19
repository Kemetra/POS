/**
 * RT-741 (RT-546 follow-up) — `returns.lookup` and the shared RT-546 sale
 * access rule (`sale-access-policy.ts`).
 *
 * The return flow admits only a manager or admin (D-b), so a cashier is refused
 * `role_denied` before any sale is read or any request is sent. Behind that,
 * the local sale lookup applies the shared own-sales rule as defence in depth:
 * should a cashier ever be admitted, another operator's sale refuses as
 * `role_denied` before the live `readSale`, audited once (`sale.return.refused`).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Role } from '../../../shared/operator/role.js';
import type { SaleRow } from '../../sales/repositories/sales.repository.js';
import type { AuthSnapshot, ReturnsAuthorizer } from '../returns-auth.js';
import { createReturnsService, type ReturnsServiceDeps } from '../returns-service.js';
import {
  CASH_SUMMARY,
  SALE_NUMBER,
  SCOPE,
  initReturnsSql,
  returnsHarness,
  seedSyncedSale,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

describe('RT-741 — returns.lookup through the composed domain', () => {
  let h: ReturnsHarness;

  afterEach(() => {
    h.close();
  });

  function setup(role: Role | null): ReturnsHarness {
    h = returnsHarness({ role });
    seedSyncedSale(h.db);
    return h;
  }

  it('a cashier is refused role_denied with nothing else, before any request is sent', async () => {
    setup('cashier');
    await expect(h.service.lookup({ saleNumber: SALE_NUMBER })).resolves.toEqual({
      kind: 'refused',
      reason: 'role_denied',
    });
    expect(h.backend.calls).toHaveLength(0);
  });

  it.each<Role>(['manager', 'admin'])(
    "a %s looks up another operator's sale (store scope)",
    async (role) => {
      setup(role);
      await expect(h.service.lookup({ saleNumber: SALE_NUMBER })).resolves.toMatchObject({
        kind: 'ok',
      });
    },
  );

  it('a locked session is refused before any request is sent', async () => {
    setup('manager');
    h.state.locked = true;
    await expect(h.service.lookup({ saleNumber: SALE_NUMBER })).resolves.toMatchObject({
      kind: 'refused',
    });
    expect(h.backend.calls).toHaveLength(0);
  });

  it('no session is refused before any request is sent', async () => {
    setup(null);
    await expect(h.service.lookup({ saleNumber: SALE_NUMBER })).resolves.toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    expect(h.backend.calls).toHaveLength(0);
  });
});

describe('RT-741 — the own-sales rule behind the role gate (defence in depth)', () => {
  function serviceFor(role: Role, sellingOperatorId: string) {
    const actor: AuthSnapshot = Object.freeze({
      scope: SCOPE,
      operatorId: 'op-actor',
      operatorSessionId: 'sess-actor',
      role,
      envelope: 'envelope',
    });
    const authorizer: ReturnsAuthorizer = {
      current: () => ({ kind: 'ok', actor }),
      recheck: () => null,
    };
    const row = {
      sale_id: 'sale-1',
      sale_number: SALE_NUMBER,
      selling_operator_id: sellingOperatorId,
      tender_lines_summary_json: CASH_SUMMARY,
    } as unknown as SaleRow;
    const readSale = vi.fn().mockResolvedValue({ kind: 'unavailable' });
    const refused = vi.fn();
    const deps = {
      captureCurrencyCode: 'EGP',
      authorizer,
      sales: { findByNumber: () => row },
      saleRefs: { findServerSaleRefBySaleId: () => 'sale-ref-1' },
      client: { readSale },
      audit: { refused },
      isStopped: () => false,
    } as unknown as ReturnsServiceDeps;
    return { service: createReturnsService(deps), readSale, refused };
  }

  it("an admitted cashier is refused another operator's sale before the live read", async () => {
    const { service, readSale, refused } = serviceFor('cashier', 'op-other');
    await expect(service.lookup({ saleNumber: SALE_NUMBER })).resolves.toEqual({
      kind: 'refused',
      reason: 'role_denied',
    });
    expect(readSale).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledWith(
      expect.objectContaining({ operatorId: 'op-actor' }),
      expect.objectContaining({ operation: 'lookup', reason: 'role_denied', sale_id: null }),
    );
  });

  it('an admitted cashier reaches their own sale (the live read runs)', async () => {
    const { service, readSale } = serviceFor('cashier', 'op-actor');
    await service.lookup({ saleNumber: SALE_NUMBER });
    expect(readSale).toHaveBeenCalledTimes(1);
  });

  it.each<Role>(['manager', 'admin'])(
    "a %s reaches another operator's sale (the live read runs)",
    async (role) => {
      const { service, readSale } = serviceFor(role, 'op-other');
      await service.lookup({ saleNumber: SALE_NUMBER });
      expect(readSale).toHaveBeenCalledTimes(1);
    },
  );
});
