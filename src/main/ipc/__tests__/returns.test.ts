/**
 * RT-15 S2 — `returns:*` IPC (§A4): bounded-id validation before the service,
 * the five channels registered, and every one refused while the session is
 * locked (default deny — none is on the lock allowlist).
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { RETURNS_IPC_CHANNELS } from '../../../shared/returns/channels.js';
import type { ReturnsBridgeAPI } from '../../../shared/returns/types.js';
import { registerReturnsHandlers, RETURNS_INPUT_BOUNDS } from '../returns.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const LINE = '0190f5a2-7b3c-7d4e-8f90-00000000000a';
const OTHER = '0190f5a2-7b3c-7d4e-8f90-00000000000b';

function setup(locked = false) {
  const handlers = new Map<string, Listener>();
  const raw = {
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
    on: () => raw,
  } as unknown as IpcMain;
  const service = {
    lookup: vi.fn(() => Promise.resolve({ kind: 'ok' })),
    quote: vi.fn(() => Promise.resolve({ kind: 'ok' })),
    submit: vi.fn(() => Promise.resolve({ kind: 'confirmed' })),
    resolve: vi.fn(() => Promise.resolve({ kind: 'ok' })),
    list: vi.fn(() => Promise.resolve({ kind: 'ok' })),
  };
  registerReturnsHandlers(
    createSessionLockGuardedIpcMain(raw, () => locked),
    {
      service: service as unknown as ReturnsBridgeAPI,
    },
  );
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return await handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, service, invoke };
}

const INVALID = { kind: 'refused', reason: 'invalid_input' };
const longNumber = 'x'.repeat(RETURNS_INPUT_BOUNDS.saleNumberMaxLength + 1);
const manyLines = Array.from({ length: RETURNS_INPUT_BOUNDS.maxLines + 1 }, (_, i) => ({
  lineRef: `0190f5a2-7b3c-7d4e-8f90-${String(i).padStart(12, '0')}`,
  quantity: 1,
}));

describe('returns IPC registration', () => {
  it('registers exactly the five returns channels, none on the lock allowlist', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(Object.values(RETURNS_IPC_CHANNELS).sort());
    for (const channel of Object.values(RETURNS_IPC_CHANNELS)) {
      expect(LOCKED_ALLOWED_CHANNELS.has(channel)).toBe(false);
    }
  });

  it.each(Object.values(RETURNS_IPC_CHANNELS))('refuses %s while locked', async (channel) => {
    const { invoke, service } = setup(true);
    await expect(invoke(channel, { saleNumber: 'SN-1' })).rejects.toBeInstanceOf(
      SessionLockedError,
    );
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('forwards a valid lookup and quote / submit', async () => {
    const { invoke, service } = setup();
    const lines = [
      { lineRef: LINE, quantity: 2 },
      { lineRef: OTHER, quantity: 1 },
    ];
    await invoke(RETURNS_IPC_CHANNELS.LOOKUP, { saleNumber: 'TILL 1-2026-10-04-000001' });
    await invoke(RETURNS_IPC_CHANNELS.QUOTE, { saleNumber: 'SN-1', lines });
    await invoke(RETURNS_IPC_CHANNELS.SUBMIT, { saleNumber: 'SN-1', lines });
    await invoke(RETURNS_IPC_CHANNELS.RESOLVE);
    await invoke(RETURNS_IPC_CHANNELS.LIST, {});
    expect(service.lookup).toHaveBeenCalledWith({ saleNumber: 'TILL 1-2026-10-04-000001' });
    expect(service.quote).toHaveBeenCalledWith({ saleNumber: 'SN-1', lines });
    expect(service.submit).toHaveBeenCalledWith({ saleNumber: 'SN-1', lines });
    expect(service.resolve).toHaveBeenCalledTimes(1);
    expect(service.list).toHaveBeenCalledTimes(1);
  });
});

describe('returns IPC validation (bounded ids, closed shapes)', () => {
  it.each<[string, unknown]>([
    ['a non-object', 'SN-1'],
    ['null', null],
    ['a missing sale number', {}],
    ['an empty sale number', { saleNumber: '' }],
    ['an over-long sale number', { saleNumber: longNumber }],
    ['a control character', { saleNumber: 'SN-1\n' }],
    ['a numeric sale number', { saleNumber: 1 }],
    ['an extra key (scope smuggling)', { saleNumber: 'SN-1', tenantId: 't2' }],
  ])('lookup refuses %s', async (_label, request) => {
    const { invoke, service } = setup();
    await expect(invoke(RETURNS_IPC_CHANNELS.LOOKUP, request)).resolves.toEqual(INVALID);
    expect(service.lookup).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['no lines', { saleNumber: 'SN-1', lines: [] }],
    ['lines not an array', { saleNumber: 'SN-1', lines: { lineRef: LINE, quantity: 1 } }],
    ['too many lines', { saleNumber: 'SN-1', lines: manyLines }],
    ['a non-UUID lineRef', { saleNumber: 'SN-1', lines: [{ lineRef: 'l-1', quantity: 1 }] }],
    ['a zero quantity', { saleNumber: 'SN-1', lines: [{ lineRef: LINE, quantity: 0 }] }],
    ['a fractional quantity', { saleNumber: 'SN-1', lines: [{ lineRef: LINE, quantity: 1.5 }] }],
    ['a string quantity', { saleNumber: 'SN-1', lines: [{ lineRef: LINE, quantity: '1' }] }],
    [
      'a huge quantity',
      {
        saleNumber: 'SN-1',
        lines: [{ lineRef: LINE, quantity: RETURNS_INPUT_BOUNDS.maxQuantity + 1 }],
      },
    ],
    [
      'a duplicate lineRef (any case)',
      {
        saleNumber: 'SN-1',
        lines: [
          { lineRef: LINE, quantity: 1 },
          { lineRef: LINE.toUpperCase(), quantity: 1 },
        ],
      },
    ],
    [
      'a smuggled amount on a line',
      { saleNumber: 'SN-1', lines: [{ lineRef: LINE, quantity: 1, amountMinor: 1 }] },
    ],
    ['a line that is not an object', { saleNumber: 'SN-1', lines: [LINE] }],
    ['a smuggled key', { saleNumber: 'SN-1', lines: [{ lineRef: LINE, quantity: 1 }], key: 'k' }],
    ['a bad sale number', { saleNumber: '', lines: [{ lineRef: LINE, quantity: 1 }] }],
  ])('quote and submit refuse %s', async (_label, request) => {
    const { invoke, service } = setup();
    await expect(invoke(RETURNS_IPC_CHANNELS.QUOTE, request)).resolves.toEqual(INVALID);
    await expect(invoke(RETURNS_IPC_CHANNELS.SUBMIT, request)).resolves.toEqual({
      ...INVALID,
      ret: null,
    });
    expect(service.quote).not.toHaveBeenCalled();
    expect(service.submit).not.toHaveBeenCalled();
  });

  it.each([RETURNS_IPC_CHANNELS.RESOLVE, RETURNS_IPC_CHANNELS.LIST])(
    '%s refuses any payload',
    async (channel) => {
      const { invoke, service } = setup();
      await expect(invoke(channel, { scope: 'x' })).resolves.toEqual(INVALID);
      await expect(invoke(channel, [])).resolves.toEqual(INVALID);
      expect(service.resolve).not.toHaveBeenCalled();
      expect(service.list).not.toHaveBeenCalled();
    },
  );
});
