import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RETURNS_IPC_CHANNELS } from '../../shared/returns/channels';

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
 * RT-15 S2 — the `returns.*` preload namespace is a thin wire-up: one typed
 * channel per member, the request passed through unchanged, no payload for
 * resolve / list.
 */
describe('preload returns bridge', () => {
  const req = { saleNumber: 'SN-1', lines: [{ lineRef: 'l', quantity: 1 }] };

  it.each([
    ['lookup', RETURNS_IPC_CHANNELS.LOOKUP, { saleNumber: 'SN-1' }],
    ['quote', RETURNS_IPC_CHANNELS.QUOTE, req],
    ['submit', RETURNS_IPC_CHANNELS.SUBMIT, req],
    ['payout', RETURNS_IPC_CHANNELS.PAYOUT, { returnId: 'r', action: 'start' }],
    ['reprintSlip', RETURNS_IPC_CHANNELS.REPRINT_SLIP, { returnId: 'r' }],
  ] as const)('%s invokes its channel with the request', async (member, channel, arg) => {
    const { returns } = await import('../returns');
    const call = returns[member] as (a: unknown) => Promise<unknown>;
    await expect(call(arg)).resolves.toEqual({ kind: 'ok' });
    expect(ipcRendererInvoke).toHaveBeenCalledWith(channel, arg);
  });

  it.each([
    ['resolve', RETURNS_IPC_CHANNELS.RESOLVE],
    ['list', RETURNS_IPC_CHANNELS.LIST],
  ] as const)('%s invokes its channel with no payload', async (member, channel) => {
    const { returns } = await import('../returns');
    await returns[member]();
    expect(ipcRendererInvoke).toHaveBeenCalledWith(channel);
  });

  it('is exposed on window.api.returns', async () => {
    vi.resetModules();
    await import('../index');
    const api = exposeInMainWorld.mock.calls.at(-1)?.[1] as { returns?: Record<string, unknown> };
    expect(Object.keys(api.returns ?? {}).sort()).toEqual([
      'list',
      'lookup',
      'payout',
      'quote',
      'reprintSlip',
      'resolve',
      'submit',
    ]);
  });
});
