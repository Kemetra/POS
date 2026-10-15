import { describe, expect, it, vi } from 'vitest';

import { SALE_VOID_IPC_CHANNELS } from '../../../shared/sale-void/types.js';
import {
  readAcknowledge,
  readLookup,
  readRequest,
  registerSaleVoidHandlers,
} from '../sale-void.js';

/** RT-530 — `sale-void:*` takes closed shapes only. */

const APPROVAL = '0190f5a2-3b4c-7d8e-9f01-000000000001';

describe('sale void IPC validators', () => {
  it('lookup: a bounded sale number, nothing else', () => {
    expect(readLookup({ sale_number: ' T1-2026-06-07-000001 ' })).toEqual({
      sale_number: 'T1-2026-06-07-000001',
    });
    for (const bad of [
      null,
      [],
      {},
      { sale_number: '' },
      { sale_number: '   ' },
      { sale_number: 'x'.repeat(65) },
      { sale_number: 7 },
      { sale_number: 'T1', tenant_id: 'forged' },
    ]) {
      expect(readLookup(bad)).toBeNull();
    }
  });

  it('request: a sale id and a lower-case approval uuid, nothing else', () => {
    expect(readRequest({ sale_id: 'sale-1', approval_id: APPROVAL })).toEqual({
      sale_id: 'sale-1',
      approval_id: APPROVAL,
    });
    for (const bad of [
      null,
      { sale_id: 'sale-1' },
      { sale_id: 'sale 1', approval_id: APPROVAL },
      { sale_id: 'sale-1', approval_id: 'not-a-uuid' },
      { sale_id: 'sale-1', approval_id: APPROVAL.toUpperCase() },
      { sale_id: 'sale-1', approval_id: APPROVAL, approver_user_id: 'forged' },
      { sale_id: 'sale-1', approval_id: APPROVAL, businessDate: '2026-06-07' },
    ]) {
      expect(readRequest(bad)).toBeNull();
    }
  });

  it('acknowledge: a void id only', () => {
    expect(readAcknowledge({ void_id: 'v-1' })).toEqual({ void_id: 'v-1' });
    expect(readAcknowledge({ void_id: 'v 1' })).toBeNull();
    expect(readAcknowledge({ void_id: 'v-1', state: 'confirmed' })).toBeNull();
  });
});

describe('sale void IPC handlers', () => {
  function register() {
    const handlers = new Map<string, (event: unknown, req?: unknown) => unknown>();
    const service = {
      lookup: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, reason: 'sale_not_found' as const }),
      ),
      request: vi.fn((): Promise<never> => Promise.reject(new Error('boom'))),
      list: vi.fn(() => Promise.resolve({ kind: 'list' as const, voids: [] })),
      acknowledge: vi.fn(() => Promise.resolve({ kind: 'acknowledged' as const })),
    };
    const logger = { warn: vi.fn() };
    registerSaleVoidHandlers(
      {
        handle: (c: string, fn: (event: unknown, req?: unknown) => unknown) => handlers.set(c, fn),
      } as never,
      { service, logger },
    );
    return { handlers, service, logger };
  }

  it('an invalid payload reaches nothing', async () => {
    const { handlers, service } = register();
    await expect(
      Promise.resolve(handlers.get(SALE_VOID_IPC_CHANNELS.REQUEST)?.({}, { bad: true })),
    ).resolves.toEqual({ kind: 'refused', reason: 'invalid_input' });
    expect(service.request).not.toHaveBeenCalled();
  });

  it('a throw answers void_unavailable, logged by name only (no payload)', async () => {
    const { handlers, logger } = register();
    await expect(
      Promise.resolve(
        handlers.get(SALE_VOID_IPC_CHANNELS.REQUEST)?.(
          {},
          { sale_id: 's-1', approval_id: APPROVAL },
        ),
      ),
    ).resolves.toEqual({ kind: 'refused', reason: 'void_unavailable' });
    expect(logger.warn).toHaveBeenCalledWith({ op: 'request', error: 'Error' }, 'sale_void:failed');
  });

  it('list takes no payload; lookup and acknowledge pass their request through', async () => {
    const { handlers, service } = register();
    await expect(Promise.resolve(handlers.get(SALE_VOID_IPC_CHANNELS.LIST)?.({}))).resolves.toEqual(
      { kind: 'list', voids: [] },
    );
    await expect(
      Promise.resolve(handlers.get(SALE_VOID_IPC_CHANNELS.LIST)?.({}, { x: 1 })),
    ).resolves.toEqual({ kind: 'refused', reason: 'invalid_input' });
    await handlers.get(SALE_VOID_IPC_CHANNELS.LOOKUP)?.({}, { sale_number: 'N-1' });
    expect(service.lookup).toHaveBeenCalledWith({ sale_number: 'N-1' });
    await handlers.get(SALE_VOID_IPC_CHANNELS.ACKNOWLEDGE)?.({}, { void_id: 'v-1' });
    expect(service.acknowledge).toHaveBeenCalledWith({ void_id: 'v-1' });
  });
});
