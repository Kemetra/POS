/**
 * RT-17 slice 4 part 1 — `shiftCashup:*` IPC (§A4): the renderer is untrusted
 * input, so each payload is validated against a closed shape before the
 * bridge runs; the five channels are default-denied while the session is
 * locked; and nothing is registered with `POS_PULSE_FEATURE_SHIFT_CASHUP` off.
 * The close takes a count only: no approver can be sent (10942 pending).
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import { SHIFT_CASHUP_IPC_CHANNELS } from '../../../shared/shift-cashup/channels.js';
import {
  SHIFT_MOVEMENT_REASON_CODES,
  SHIFT_NOTE_MAX_LENGTH,
} from '../../../shared/shift-cashup/types.js';
import { CASH_MOVEMENT_REASON_CODES } from '../../shift-cashup/shift-wire.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';
import { registerShiftCashupHandlers, registerShiftCashupIpc } from '../shift-cashup.js';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const { OPEN, PAY_IN, PAY_OUT, CLOSE, STATUS } = SHIFT_CASHUP_IPC_CHANNELS;
const CHANNELS = Object.values(SHIFT_CASHUP_IPC_CHANNELS);
const INVALID = { kind: 'refused', reason: 'invalid_input' };

function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  const raw = {
    handle: vi.fn((channel: string, listener: Listener) => handlers.set(channel, listener)),
    on: () => raw,
  };
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return await handler({} as IpcMainInvokeEvent, ...args);
  };
  return { raw, handlers, invoke, ipcMain: raw as unknown as IpcMain };
}

function setup(locked = false) {
  const fake = fakeIpcMain();
  const bridge = {
    open: vi.fn(() => Promise.resolve({ kind: 'opened' })),
    payIn: vi.fn(() => Promise.resolve({ kind: 'recorded' })),
    payOut: vi.fn(() => Promise.resolve({ kind: 'recorded' })),
    close: vi.fn(() => Promise.resolve({ kind: 'closed' })),
    status: vi.fn(() => Promise.resolve({ kind: 'status' })),
  };
  registerShiftCashupHandlers(createSessionLockGuardedIpcMain(fake.ipcMain, () => locked), {
    bridge,
  });
  return { ...fake, bridge };
}

const NOTE_MAX = 'n'.repeat(SHIFT_NOTE_MAX_LENGTH);
const MOVEMENT = { amountMinor: 1, reasonCode: 'bank_drop' };

describe('shiftCashup IPC registration', () => {
  it('registers exactly the five channels, none on the lock allowlist', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort());
    for (const channel of CHANNELS) expect(LOCKED_ALLOWED_CHANNELS.has(channel)).toBe(false);
  });

  it.each(CHANNELS)('refuses %s while locked, before the bridge', async (channel) => {
    const { invoke, bridge } = setup(true);
    await expect(invoke(channel, { openingFloatMinor: 1 })).rejects.toBeInstanceOf(
      SessionLockedError,
    );
    for (const fn of Object.values(bridge)) expect(fn).not.toHaveBeenCalled();
  });

  it('offers exactly the reason codes the wire builders accept', () => {
    expect([...SHIFT_MOVEMENT_REASON_CODES]).toEqual([...CASH_MOVEMENT_REASON_CODES]);
  });
});

describe('valid payloads reach the bridge unchanged', () => {
  it.each<[string, keyof ReturnType<typeof setup>['bridge'], unknown]>([
    [OPEN, 'open', { openingFloatMinor: 0 }],
    [OPEN, 'open', { openingFloatMinor: Number.MAX_SAFE_INTEGER }],
    [PAY_IN, 'payIn', MOVEMENT],
    [PAY_OUT, 'payOut', { amountMinor: 250, reasonCode: 'petty_expense', note: NOTE_MAX }],
    [PAY_OUT, 'payOut', { amountMinor: 1, reasonCode: 'other', note: 'مصروف نثري' }],
    [CLOSE, 'close', { countedCashMinor: 0 }],
    [CLOSE, 'close', { countedCashMinor: 54_000 }],
  ])('%s → %s(%j)', async (channel, member, payload) => {
    const { invoke, bridge } = setup();
    await invoke(channel, payload);
    expect(bridge[member]).toHaveBeenCalledWith(payload);
  });

  it.each([undefined, {}])('status takes no payload (%j)', async (payload) => {
    const { invoke, bridge } = setup();
    await expect(invoke(STATUS, payload)).resolves.toEqual({ kind: 'status' });
    expect(bridge.status).toHaveBeenCalledWith();
  });

  it('reads an undefined note as no note', async () => {
    const { invoke, bridge } = setup();
    await invoke(PAY_OUT, { ...MOVEMENT, note: undefined });
    expect(bridge.payOut).toHaveBeenCalledWith(MOVEMENT);
  });

  it.each(SHIFT_MOVEMENT_REASON_CODES)('accepts the reason code %s', async (reasonCode) => {
    const { invoke, bridge } = setup();
    await invoke(PAY_IN, { amountMinor: 1, reasonCode });
    expect(bridge.payIn).toHaveBeenCalledTimes(1);
  });
});

describe('anything outside the closed shapes is invalid_input, before the bridge', () => {
  const NOT_RECORDS = [undefined, null, [], 'x', 7];
  const BAD_MINOR = [-1, 1.5, '100', Number.NaN, Number.MAX_SAFE_INTEGER + 1, null];

  it.each<[string, unknown]>([
    ...NOT_RECORDS.map((p): [string, unknown] => [OPEN, p]),
    [OPEN, {}],
    ...BAD_MINOR.map((v): [string, unknown] => [OPEN, { openingFloatMinor: v }]),
    [OPEN, { openingFloatMinor: 1, currencyCode: 'USD' }],
    ...NOT_RECORDS.map((p): [string, unknown] => [PAY_IN, p]),
    [PAY_IN, { reasonCode: 'other' }],
    [PAY_IN, { amountMinor: 1 }],
    [PAY_IN, { ...MOVEMENT, amountMinor: 0 }],
    ...BAD_MINOR.map((v): [string, unknown] => [PAY_OUT, { ...MOVEMENT, amountMinor: v }]),
    [PAY_OUT, { ...MOVEMENT, reasonCode: 'theft' }],
    [PAY_OUT, { ...MOVEMENT, reasonCode: 'toString' }],
    [PAY_OUT, { ...MOVEMENT, note: '' }],
    [PAY_OUT, { ...MOVEMENT, note: `${NOTE_MAX}n` }],
    [PAY_OUT, { ...MOVEMENT, note: 'a\u0000b' }],
    [PAY_OUT, { ...MOVEMENT, note: 42 }],
    [PAY_IN, { ...MOVEMENT, kind: 'pay_out' }],
    [PAY_IN, { ...MOVEMENT, operatorUserId: 'u-1' }],
    ...NOT_RECORDS.map((p): [string, unknown] => [CLOSE, p]),
    [CLOSE, {}],
    ...BAD_MINOR.map((v): [string, unknown] => [CLOSE, { countedCashMinor: v }]),
    [CLOSE, { countedCashMinor: 1, varianceApprovedByUserId: 'u-2' }],
    [CLOSE, { countedCashMinor: 1, closeKind: 'forced' }],
    [STATUS, { scope: 'all' }],
    [STATUS, 'x'],
    [STATUS, null],
  ])('%s refuses %j', async (channel, payload) => {
    const { invoke, bridge } = setup();
    await expect(invoke(channel, payload)).resolves.toEqual(INVALID);
    for (const fn of Object.values(bridge)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('registerShiftCashupIpc — the flag gate', () => {
  let db: SqlJsDatabase | null = null;

  beforeAll(async () => {
    await initSalesSyncSql();
  });

  afterEach(() => {
    db?.close();
    db = null;
  });

  function register(enabled: boolean) {
    db = freshSalesSyncDb();
    const fake = fakeIpcMain();
    registerShiftCashupIpc({
      enabled,
      ipcMain: fake.ipcMain,
      db: handleFor(db),
      isEnabled: () => enabled,
      getSession: () => null,
      isSessionLocked: () => false,
      pairedScope: () => Promise.resolve(null),
      now: () => '2026-10-05T08:00:00.000Z',
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    return fake;
  }

  it('registers nothing with the flag off', () => {
    const { raw } = register(false);
    expect(raw.handle).not.toHaveBeenCalled();
  });

  it('registers the five channels over the composed service with the flag on', async () => {
    const { handlers, invoke } = register(true);
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort());
    await expect(invoke(STATUS)).resolves.toEqual({ kind: 'refused', reason: 'no_session' });
  });
});
