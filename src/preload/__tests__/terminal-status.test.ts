/**
 * RT-603 (VN-S6 S6-2, doc 24 §3.2 A4-4, §5.1 "Bridge") — preload side of the
 * terminal status bridge.
 *
 *   • `get()` invokes `terminalStatus:get` with `{}` and returns only a parsed
 *     snapshot; a refusal or a malformed answer rejects, never coerces;
 *   • `onChanged(cb)` listens on `terminalStatus:changed`; the callback gets
 *     only a parsed snapshot (unknown fields dropped), never the IpcRendererEvent;
 *     a malformed payload is dropped (no callback), never coerced to `online`.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';

import { createTerminalStatusBridge, parseTerminalStatusSnapshot } from '../terminal-status.js';
import {
  TERMINAL_STATUS_INVALID,
  TERMINAL_STATUS_IPC_CHANNELS,
  type TerminalStatusSnapshot,
} from '../../shared/terminal-status/types.js';

type Listener = (event: unknown, payload: unknown) => void;
type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

const VALID: TerminalStatusSnapshot = {
  v: 1,
  connection: 'offline',
  connectionSince: '2026-10-17T10:00:00.000Z',
  lastContactAt: null,
  sync: {
    pending: 1,
    heldPreviousPairing: 0,
    deadLetter: 0,
    oldestPendingAt: '2026-10-17T09:00:00.000Z',
    paused: 'no_operator_credential',
    lastSuccessAt: null,
  },
};

function fakeRenderer(invokeResult: unknown = VALID): {
  renderer: {
    invoke: Mock<Invoke>;
    on: (c: string, l: Listener) => void;
    removeListener: (c: string, l: Listener) => void;
  };
  channels: string[];
  push: (payload: unknown) => void;
  count: () => number;
} {
  const listeners = new Set<Listener>();
  const channels: string[] = [];
  return {
    renderer: {
      invoke: vi.fn<Invoke>(() => Promise.resolve(invokeResult)),
      on: (c, l) => {
        channels.push(c);
        listeners.add(l);
      },
      removeListener: (_c, l) => {
        listeners.delete(l);
      },
    },
    channels,
    push: (payload) => {
      for (const l of listeners) l({ sender: { secret: true } }, payload);
    },
    count: () => listeners.size,
  };
}

function withSync(patch: Record<string, unknown>): unknown {
  return { ...VALID, sync: { ...VALID.sync, ...patch } };
}

/** Malformed payloads: each must be dropped, none coerced. */
const MALFORMED: [string, unknown][] = [
  ['null', null],
  ['a string', 'online'],
  ['an array', [VALID]],
  ['a wrong version', { ...VALID, v: 2 }],
  ['no version', { ...VALID, v: undefined }],
  ['an unknown connection code', { ...VALID, connection: 'connected' }],
  ['connection missing', { ...VALID, connection: undefined }],
  ['a non-ISO connectionSince', { ...VALID, connectionSince: 'yesterday' }],
  ['an ISO with an offset', { ...VALID, connectionSince: '2026-10-17T12:00:00.000+02:00' }],
  ['an impossible date', { ...VALID, connectionSince: '2026-13-45T99:00:00.000Z' }],
  ['a numeric lastContactAt', { ...VALID, lastContactAt: 0 }],
  ['sync missing', { ...VALID, sync: undefined }],
  ['sync null', { ...VALID, sync: null }],
  ['a negative count', withSync({ pending: -1 })],
  ['a fractional count', withSync({ deadLetter: 1.5 })],
  ['a string count', withSync({ heldPreviousPairing: '2' })],
  ['an unsafe integer count', withSync({ pending: Number.MAX_SAFE_INTEGER + 1 })],
  ['NaN count', withSync({ pending: Number.NaN })],
  ['an unknown paused reason', withSync({ paused: 'no_token' })],
  ['a non-ISO oldestPendingAt', withSync({ oldestPendingAt: 'https://api.example' })],
  ['a non-ISO lastSuccessAt', withSync({ lastSuccessAt: 'ECONNREFUSED' })],
];

describe('RT-603 parseTerminalStatusSnapshot', () => {
  it('accepts a valid snapshot', () => {
    expect(parseTerminalStatusSnapshot(VALID)).toEqual(VALID);
  });

  it('drops unknown fields at both levels', () => {
    const parsed = parseTerminalStatusSnapshot({
      ...VALID,
      host: 'api.example',
      sync: { ...VALID.sync, terminalId: 't-1' },
    });
    expect(parsed).toEqual(VALID);
    expect(Object.keys(parsed ?? {}).sort()).toEqual(
      ['connection', 'connectionSince', 'lastContactAt', 'sync', 'v'].sort(),
    );
  });

  it.each(MALFORMED)('rejects %s', (_label, payload) => {
    expect(parseTerminalStatusSnapshot(payload)).toBeNull();
  });
});

describe('RT-603 terminalStatus.get', () => {
  it('invokes terminalStatus:get with {} and returns the parsed snapshot', async () => {
    const fake = fakeRenderer({ ...VALID, extra: 'x' });
    const bridge = createTerminalStatusBridge(fake.renderer);
    await expect(bridge.get()).resolves.toEqual(VALID);
    expect(fake.renderer.invoke).toHaveBeenCalledWith(TERMINAL_STATUS_IPC_CHANNELS.GET, {});
  });

  it.each<[string, unknown]>([['the INVALID refusal', TERMINAL_STATUS_INVALID], ...MALFORMED])(
    'rejects on %s — never coerced to a snapshot',
    async (_label, answer) => {
      const bridge = createTerminalStatusBridge(fakeRenderer(answer).renderer);
      await expect(bridge.get()).rejects.toThrow('terminal_status_unavailable');
    },
  );
});

describe('RT-603 terminalStatus.onChanged', () => {
  it('listens on terminalStatus:changed and forwards only the parsed snapshot', () => {
    const fake = fakeRenderer();
    const cb = vi.fn();
    createTerminalStatusBridge(fake.renderer).onChanged(cb);
    expect(fake.channels).toEqual([TERMINAL_STATUS_IPC_CHANNELS.CHANGED]);
    fake.push({ ...VALID, url: 'https://api.example' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]).toEqual([VALID]);
  });

  it.each(MALFORMED)('drops %s (no callback)', (_label, payload) => {
    const fake = fakeRenderer();
    const cb = vi.fn();
    createTerminalStatusBridge(fake.renderer).onChanged(cb);
    fake.push(payload);
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe removes the listener', () => {
    const fake = fakeRenderer();
    const cb = vi.fn();
    const off = createTerminalStatusBridge(fake.renderer).onChanged(cb);
    expect(fake.count()).toBe(1);
    off();
    expect(fake.count()).toBe(0);
    fake.push(VALID);
    expect(cb).not.toHaveBeenCalled();
  });
});
