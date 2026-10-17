/**
 * RT-603 (VN-S6 S6-2, doc 24 §3, §5.1 "Bridge") — `terminalStatus:get` IPC.
 *
 *   • exactly one invoke channel, `terminalStatus:get`; no write channel;
 *   • `{}` only — anything else gets `INVALID` and never reaches the reader (A4-2);
 *   • the response is the reader's snapshot, unchanged;
 *   • the sender guard applies once registered through the guarded ipcMain (A4-1);
 *   • the channel is NOT on the locked-session allowlist (D-6-10, A4-6).
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerTerminalStatusHandlers } from '../terminal-status.js';
import { createSenderGuardedIpcMain, UntrustedSenderError } from '../sender-guard.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';
import {
  TERMINAL_STATUS_INVALID,
  TERMINAL_STATUS_IPC_CHANNELS,
  type TerminalStatusSnapshot,
} from '../../../shared/terminal-status/types.js';

type Handler = (event: IpcMainInvokeEvent, request?: unknown) => unknown;

function fakeIpcMain(): {
  ipcMain: IpcMain;
  invoke: (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  channels: () => string[];
} {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, fn: Handler) {
      handlers.set(channel, fn);
    },
    on() {
      return ipcMain;
    },
  } as unknown as IpcMain;
  return {
    ipcMain,
    invoke: (channel, event, ...args) => {
      const fn = handlers.get(channel);
      if (fn === undefined) throw new Error(`no handler for ${channel}`);
      return (fn as (...a: unknown[]) => unknown)(event, ...args);
    },
    channels: () => [...handlers.keys()],
  };
}

const ORIGIN = 'file:///C:/app/resources/app/dist/renderer/';
const TRUSTED = { senderFrame: { url: `${ORIGIN}index.html` } } as unknown as IpcMainInvokeEvent;
const UNTRUSTED = {
  senderFrame: { url: 'https://evil.example/' },
} as unknown as IpcMainInvokeEvent;

const SNAPSHOT: TerminalStatusSnapshot = {
  v: 1,
  connection: 'online',
  connectionSince: '2026-10-17T10:00:00.000Z',
  lastContactAt: '2026-10-17T10:00:05.000Z',
  sync: {
    pending: 2,
    heldPreviousPairing: 0,
    deadLetter: 1,
    oldestPendingAt: '2026-10-17T09:59:00.000Z',
    paused: null,
    lastSuccessAt: '2026-10-17T09:58:00.000Z',
  },
};

describe('RT-603 terminalStatus:get', () => {
  it('registers exactly one channel: terminalStatus:get', () => {
    const fake = fakeIpcMain();
    registerTerminalStatusHandlers(fake.ipcMain, { read: () => Promise.resolve(SNAPSHOT) });
    expect(fake.channels()).toEqual([TERMINAL_STATUS_IPC_CHANNELS.GET]);
    expect(TERMINAL_STATUS_IPC_CHANNELS.GET).toBe('terminalStatus:get');
    expect(TERMINAL_STATUS_IPC_CHANNELS.CHANGED).toBe('terminalStatus:changed');
  });

  it('{} returns the reader snapshot unchanged', async () => {
    const fake = fakeIpcMain();
    const read = vi.fn(() => Promise.resolve(SNAPSHOT));
    registerTerminalStatusHandlers(fake.ipcMain, { read });
    await expect(fake.invoke(TERMINAL_STATUS_IPC_CHANNELS.GET, TRUSTED, {})).resolves.toEqual(
      SNAPSHOT,
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each<[string, unknown[]]>([
    ['no argument', []],
    ['undefined', [undefined]],
    ['null', [null]],
    ['a string', ['{}']],
    ['a number', [0]],
    ['an array', [[]]],
    ['a key', [{ terminalId: 't-1' }]],
    ['a prototype key', [JSON.parse('{"__proto__":{"x":1}}')]],
    ['a non-plain object', [new Date(0)]],
    ['{} plus an extra argument', [{}, { extra: true }]],
  ])('%s → INVALID; the reader is never called', async (_label, args) => {
    const fake = fakeIpcMain();
    const read = vi.fn(() => Promise.resolve(SNAPSHOT));
    registerTerminalStatusHandlers(fake.ipcMain, { read });
    await expect(
      Promise.resolve(fake.invoke(TERMINAL_STATUS_IPC_CHANNELS.GET, TRUSTED, ...args)),
    ).resolves.toEqual(TERMINAL_STATUS_INVALID);
    expect(read).not.toHaveBeenCalled();
  });

  it('INVALID is the closed refusal shape', () => {
    expect(TERMINAL_STATUS_INVALID).toEqual({ kind: 'refused', reason: 'invalid_input' });
  });

  it('the sender guard refuses an untrusted frame before the reader runs (A4-1)', async () => {
    const fake = fakeIpcMain();
    const read = vi.fn(() => Promise.resolve(SNAPSHOT));
    registerTerminalStatusHandlers(createSenderGuardedIpcMain(fake.ipcMain, ORIGIN), { read });
    await expect(fake.invoke(TERMINAL_STATUS_IPC_CHANNELS.GET, UNTRUSTED, {})).rejects.toThrow(
      UntrustedSenderError,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('is not on the locked-session allowlist, so a locked session is refused (D-6-10)', async () => {
    expect(LOCKED_ALLOWED_CHANNELS.has(TERMINAL_STATUS_IPC_CHANNELS.GET)).toBe(false);
    expect(LOCKED_ALLOWED_CHANNELS.has(TERMINAL_STATUS_IPC_CHANNELS.CHANGED)).toBe(false);
    const fake = fakeIpcMain();
    const read = vi.fn(() => Promise.resolve(SNAPSHOT));
    registerTerminalStatusHandlers(
      createSessionLockGuardedIpcMain(fake.ipcMain, () => true),
      { read },
    );
    await expect(fake.invoke(TERMINAL_STATUS_IPC_CHANNELS.GET, TRUSTED, {})).rejects.toThrow(
      SessionLockedError,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('is served when no operator session exists: the handler has no session gate (A4-6)', async () => {
    const fake = fakeIpcMain();
    registerTerminalStatusHandlers(
      createSessionLockGuardedIpcMain(fake.ipcMain, () => false),
      { read: () => Promise.resolve(SNAPSHOT) },
    );
    await expect(fake.invoke(TERMINAL_STATUS_IPC_CHANNELS.GET, TRUSTED, {})).resolves.toEqual(
      SNAPSHOT,
    );
  });
});
