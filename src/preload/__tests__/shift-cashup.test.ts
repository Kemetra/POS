import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SHIFT_CASHUP_IPC_CHANNELS } from '../../shared/shift-cashup/channels';

const ipcRendererInvoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>();
const exposeInMainWorld = vi.fn<(name: string, api: unknown) => void>();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke: ipcRendererInvoke },
}));

beforeEach(() => {
  vi.clearAllMocks();
  ipcRendererInvoke.mockResolvedValue({ kind: 'ok' });
});

/**
 * RT-17 slice 4 part 1 — the `shiftCashup.*` preload namespace is a thin
 * wire-up: one typed channel per member, the request passed through
 * unchanged, no payload for status.
 */
describe('preload shiftCashup bridge', () => {
  const movement = { amountMinor: 100, reasonCode: 'other' } as const;

  it.each([
    ['open', SHIFT_CASHUP_IPC_CHANNELS.OPEN, { openingFloatMinor: 0 }],
    ['payIn', SHIFT_CASHUP_IPC_CHANNELS.PAY_IN, movement],
    ['payOut', SHIFT_CASHUP_IPC_CHANNELS.PAY_OUT, movement],
    ['close', SHIFT_CASHUP_IPC_CHANNELS.CLOSE, { countedCashMinor: 0 }],
    [
      'close',
      SHIFT_CASHUP_IPC_CHANNELS.CLOSE,
      { countedCashMinor: 1, approver: { managerPin: '246810' } },
    ],
    ['enrollManagerPin', SHIFT_CASHUP_IPC_CHANNELS.ENROLL_MANAGER_PIN, { managerPin: '246810' }],
  ] as const)('%s invokes its channel with the request', async (member, channel, arg) => {
    const { shiftCashup } = await import('../shift-cashup');
    const call = shiftCashup[member] as (a: unknown) => Promise<unknown>;
    await expect(call(arg)).resolves.toEqual({ kind: 'ok' });
    expect(ipcRendererInvoke).toHaveBeenCalledWith(channel, arg);
  });

  it('status invokes its channel with no payload', async () => {
    const { shiftCashup } = await import('../shift-cashup');
    await shiftCashup.status();
    expect(ipcRendererInvoke).toHaveBeenCalledWith(SHIFT_CASHUP_IPC_CHANNELS.STATUS);
  });

  it('is exposed on window.api.shiftCashup', async () => {
    vi.resetModules();
    await import('../index');
    const api = exposeInMainWorld.mock.calls.at(-1)?.[1] as {
      shiftCashup?: Record<string, unknown>;
    };
    expect(Object.keys(api.shiftCashup ?? {}).sort()).toEqual([
      'close',
      'enrollManagerPin',
      'open',
      'payIn',
      'payOut',
      'status',
    ]);
  });
});
