/**
 * RT-604 (VN-S6 S6-3) — the bridge-fed terminal status store. It starts with
 * no snapshot (shown as «checking», never «online»), is written only by the
 * `terminalStatus` bridge subscription, and never polls: the push is the source.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatusBridgeAPI } from '../../../shared/bridge-api';
import type { TerminalStatusSnapshot } from '../../../shared/terminal-status/types';
import { connectTerminalStatus, useTerminalStatusStore } from '../terminal-status-store';

function snapshot(connection: TerminalStatusSnapshot['connection']): TerminalStatusSnapshot {
  return {
    v: 1,
    connection,
    connectionSince: '2026-10-17T12:00:00.000Z',
    lastContactAt: null,
    sync: {
      pending: 0,
      heldPreviousPairing: 0,
      deadLetter: 0,
      oldestPendingAt: null,
      paused: null,
      lastSuccessAt: null,
    },
  };
}

interface FakeBridge {
  bridge: TerminalStatusBridgeAPI;
  get: ReturnType<typeof vi.fn>;
  onChanged: ReturnType<typeof vi.fn>;
  push: (s: TerminalStatusSnapshot) => void;
  resolveGet: (s: TerminalStatusSnapshot) => void;
  rejectGet: () => void;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function fakeBridge(): FakeBridge {
  let listener: ((s: TerminalStatusSnapshot) => void) | undefined;
  let resolveGet: (s: TerminalStatusSnapshot) => void = () => undefined;
  let rejectGet: () => void = () => undefined;
  const unsubscribe = vi.fn();
  const get = vi.fn(
    () =>
      new Promise<TerminalStatusSnapshot>((res, rej) => {
        resolveGet = res;
        rejectGet = () => {
          rej(new Error('terminal_status_unavailable'));
        };
      }),
  );
  const onChanged = vi.fn((cb: (s: TerminalStatusSnapshot) => void) => {
    listener = cb;
    return unsubscribe as () => void;
  });
  const bridge: TerminalStatusBridgeAPI = { get, onChanged };
  return {
    bridge,
    get,
    onChanged,
    push: (s) => listener?.(s),
    resolveGet: (s) => {
      resolveGet(s);
    },
    rejectGet: () => {
      rejectGet();
    },
    unsubscribe,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  useTerminalStatusStore.setState({ snapshot: null });
});

describe('terminal status store', () => {
  it('starts with no snapshot, which the indicator shows as checking (never online)', () => {
    expect(useTerminalStatusStore.getState().snapshot).toBeNull();
  });

  it('subscribes to the push, then reads once, and keeps the read', async () => {
    const f = fakeBridge();
    const stop = connectTerminalStatus(f.bridge);
    expect(f.onChanged).toHaveBeenCalledTimes(1);
    expect(f.get).toHaveBeenCalledTimes(1);
    f.resolveGet(snapshot('online'));
    await flush();
    expect(useTerminalStatusStore.getState().snapshot?.connection).toBe('online');
    stop();
  });

  it('applies every push', () => {
    const f = fakeBridge();
    const stop = connectTerminalStatus(f.bridge);
    f.push(snapshot('offline'));
    expect(useTerminalStatusStore.getState().snapshot?.connection).toBe('offline');
    f.push(snapshot('degraded'));
    expect(useTerminalStatusStore.getState().snapshot?.connection).toBe('degraded');
    stop();
  });

  it('lets a push that arrived first win over a slower initial read', async () => {
    const f = fakeBridge();
    const stop = connectTerminalStatus(f.bridge);
    f.push(snapshot('offline'));
    f.resolveGet(snapshot('online'));
    await flush();
    expect(useTerminalStatusStore.getState().snapshot?.connection).toBe('offline');
    stop();
  });

  it('keeps no snapshot when the read is refused (locked session or malformed answer)', async () => {
    const f = fakeBridge();
    const stop = connectTerminalStatus(f.bridge);
    f.rejectGet();
    await flush();
    expect(useTerminalStatusStore.getState().snapshot).toBeNull();
    stop();
  });

  it('does nothing without a bridge (stays checking)', () => {
    const stop = connectTerminalStatus(undefined);
    expect(useTerminalStatusStore.getState().snapshot).toBeNull();
    stop();
  });

  it('unsubscribes and forgets the snapshot on disconnect, so a remount never shows a stale «online»', async () => {
    const f = fakeBridge();
    const stop = connectTerminalStatus(f.bridge);
    f.resolveGet(snapshot('online'));
    await flush();
    stop();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(useTerminalStatusStore.getState().snapshot).toBeNull();
    f.push(snapshot('online'));
    expect(useTerminalStatusStore.getState().snapshot).toBeNull();
  });

  it('ignores a read that resolves after disconnect', async () => {
    const f = fakeBridge();
    const stop = connectTerminalStatus(f.bridge);
    stop();
    f.resolveGet(snapshot('online'));
    await flush();
    expect(useTerminalStatusStore.getState().snapshot).toBeNull();
  });
});

describe('source scope (doc 24 §5.1)', () => {
  const renderer = resolve(__dirname, '../..');

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full);
      return /\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it('nothing in the renderer writes terminal status except the bridge subscription', () => {
    const writers = sources(renderer).filter((file) =>
      /useTerminalStatusStore\.setState/.test(readFileSync(file, 'utf8')),
    );
    expect(writers.map((f) => f.slice(renderer.length + 1))).toEqual([
      join('terminal-status', 'terminal-status-store.ts'),
    ]);
  });

  it('the store never polls (no interval)', () => {
    const store = readFileSync(
      join(renderer, 'terminal-status', 'terminal-status-store.ts'),
      'utf8',
    );
    expect(store).not.toMatch(/setInterval/);
  });
});
