import { describe, expect, it, vi } from 'vitest';

import { registerSaleHistoryHandlers } from '../sale-history.js';
import { SALE_HISTORY_IPC_CHANNELS } from '../../../shared/sale-history/types.js';
import type { SaleHistoryService } from '../../sale-history/sale-history-service.js';

type Handler = (event: unknown, request: unknown) => unknown;

function setup(service: Partial<SaleHistoryService> = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  };
  const refusedNoSession = () =>
    Promise.resolve({ kind: 'refused', reason: 'no_session' } as const);
  const calls = {
    list: vi.fn(refusedNoSession),
    read: vi.fn(refusedNoSession),
    reprint: vi.fn(refusedNoSession),
  };
  const full: SaleHistoryService = { ...calls, ...service };
  const logger = { warn: vi.fn() };
  registerSaleHistoryHandlers(ipcMain as never, { service: full, logger: logger as never });
  return { handlers, calls, logger };
}

describe('RT-542 saleHistory IPC', () => {
  it('registers exactly the three channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      Object.values(SALE_HISTORY_IPC_CHANNELS).slice().sort(),
    );
  });

  it.each([undefined, null, 'x', 1, ['a']])(
    'refuses a non-object payload %j without reaching the service',
    async (payload) => {
      const { handlers, calls } = setup();
      for (const channel of Object.values(SALE_HISTORY_IPC_CHANNELS)) {
        expect(await handlers.get(channel)?.({}, payload)).toEqual({
          kind: 'refused',
          reason: 'invalid_request',
        });
      }
      expect(calls.list).not.toHaveBeenCalled();
      expect(calls.read).not.toHaveBeenCalled();
      expect(calls.reprint).not.toHaveBeenCalled();
    },
  );

  it('delegates an object payload to the service', async () => {
    const { handlers, calls } = setup();
    await handlers.get(SALE_HISTORY_IPC_CHANNELS.LIST)?.({}, { from_day: 'a', to_day: 'b' });
    expect(calls.list).toHaveBeenCalledWith({ from_day: 'a', to_day: 'b' });
  });

  it('answers unavailable on a thrown fault and logs its name only', async () => {
    const { handlers, logger } = setup({
      reprint: () => Promise.reject(new RangeError('secret detail')),
    });
    expect(await handlers.get(SALE_HISTORY_IPC_CHANNELS.REPRINT)?.({}, {})).toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { op: 'reprint', error: 'RangeError' },
      'sale_history:failed',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret detail');
  });
});
