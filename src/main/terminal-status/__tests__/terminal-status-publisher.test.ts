/**
 * RT-603 (VN-S6 S6-2, doc 24 §3, §5.1 "Bridge") — the main-side publisher
 * behind `terminalStatus:get` and the `terminalStatus:changed` push.
 *
 *   • the snapshot is built from an allowlist: closed-set codes, counts and ISO
 *     times only; nothing else the sources carry reaches it (A4-3);
 *   • unpaired or revoked (the device gate) → `checking`, never `offline` or
 *     `online`, and an empty sync axis while no sync reader exists (A4-5, §2.1);
 *   • pushes only on change, at most 1 per second (A4-7);
 *   • the invoke read is cached for 1 s; the background sync read runs every
 *     5 s or on a connection change;
 *   • a failing sync read or a throwing send never breaks the publisher.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createTerminalStatusPublisher,
  TERMINAL_STATUS_GET_CACHE_MS,
  TERMINAL_STATUS_PUSH_MIN_INTERVAL_MS,
  TERMINAL_STATUS_SYNC_POLL_MS,
  type TerminalStatusPublisherDeps,
} from '../terminal-status-publisher.js';
import type { ConnectionSnapshot } from '../terminal-status-monitor.js';
import type { TerminalSyncAggregate } from '../sync-aggregate.js';
import { SALE_SYNC_PAUSED_REASONS } from '../../sales-sync/sale-sync-engine.js';
import {
  CONNECTION_STATE_CODES,
  TERMINAL_STATUS_PAUSED_REASONS,
  type TerminalStatusSnapshot,
} from '../../../shared/terminal-status/types.js';

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const AGGREGATE: TerminalSyncAggregate = {
  pending: 3,
  heldPreviousPairing: 1,
  deadLetter: 2,
  oldestPendingAt: '2026-10-17T09:00:00.000Z',
  paused: 'no_operator_credential',
  lastSuccessAt: '2026-10-17T08:00:00.000Z',
};

const EMPTY_SYNC = {
  pending: 0,
  heldPreviousPairing: 0,
  deadLetter: 0,
  oldestPendingAt: null,
  paused: null,
  lastSuccessAt: null,
};

interface Harness {
  clock: { t: number };
  connection: { value: ConnectionSnapshot };
  gate: { gated: boolean };
  sent: TerminalStatusSnapshot[];
  warn: ReturnType<typeof vi.fn>;
  publisher: ReturnType<typeof createTerminalStatusPublisher>;
  advance(ms: number): void;
}

function harness(overrides: Partial<TerminalStatusPublisherDeps> = {}): Harness {
  const clock = { t: T0 };
  const connection = {
    value: {
      connection: 'online',
      connectionSince: '2026-10-17T09:59:00.000Z',
      lastContactAt: '2026-10-17T09:59:59.000Z',
    } as ConnectionSnapshot,
  };
  const gate = { gated: false };
  const sent: TerminalStatusSnapshot[] = [];
  const warn = vi.fn();
  const publisher = createTerminalStatusPublisher({
    readConnection: () => connection.value,
    isDeviceGated: () => gate.gated,
    send: (snapshot) => {
      sent.push(snapshot);
    },
    now: () => clock.t,
    monotonicNow: () => clock.t,
    logger: { warn },
    ...overrides,
  });
  return {
    clock,
    connection,
    gate,
    sent,
    warn,
    publisher,
    advance(ms) {
      clock.t += ms;
    },
  };
}

/** Every string leaf must be a closed-set code or an ISO time; every number a non-negative integer. */
function assertClosedLeaves(value: unknown, path = '$'): void {
  if (value === null) return;
  if (typeof value === 'number') {
    expect(Number.isSafeInteger(value) && value >= 0, path).toBe(true);
    return;
  }
  if (typeof value === 'string') {
    const allowed: readonly string[] = [
      ...CONNECTION_STATE_CODES,
      ...TERMINAL_STATUS_PAUSED_REASONS,
    ];
    expect(allowed.includes(value) || ISO.test(value), `${path}=${value}`).toBe(true);
    return;
  }
  expect(typeof value, path).toBe('object');
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertClosedLeaves(v, `${path}.${k}`);
  }
}

describe('RT-603 shared closed sets', () => {
  it('the paused reasons equal the engine closed set', () => {
    expect([...TERMINAL_STATUS_PAUSED_REASONS]).toEqual([...SALE_SYNC_PAUSED_REASONS]);
  });

  it('the connection codes are the §2.2 four', () => {
    expect([...CONNECTION_STATE_CODES]).toEqual(['checking', 'online', 'degraded', 'offline']);
  });
});

describe('RT-603 terminal status publisher — snapshot', () => {
  it('paired: the monitor connection and the sync aggregate, exactly the §3.1 keys', async () => {
    const h = harness();
    h.publisher.setSyncReader(() =>
      Promise.resolve({
        ...AGGREGATE,
        // Whatever else a source carries never reaches the snapshot.
        terminalId: 'term-1',
        url: 'https://api.example',
      } as TerminalSyncAggregate),
    );
    const snap = await h.publisher.read();
    expect(snap).toEqual({
      v: 1,
      connection: 'online',
      connectionSince: '2026-10-17T09:59:00.000Z',
      lastContactAt: '2026-10-17T09:59:59.000Z',
      sync: AGGREGATE,
    });
    expect(Object.keys(snap).sort()).toEqual(
      ['connection', 'connectionSince', 'lastContactAt', 'sync', 'v'].sort(),
    );
    expect(Object.keys(snap.sync).sort()).toEqual(Object.keys(AGGREGATE).sort());
    assertClosedLeaves(snap);
  });

  it('extra fields on the connection source never reach the snapshot', async () => {
    const h = harness();
    h.connection.value = {
      ...h.connection.value,
      host: 'api.example',
      error: 'ECONNREFUSED',
    } as unknown as ConnectionSnapshot;
    const snap = await h.publisher.read();
    expect(Object.keys(snap).sort()).toEqual(
      ['connection', 'connectionSince', 'lastContactAt', 'sync', 'v'].sort(),
    );
    expect(JSON.stringify(snap)).not.toMatch(/api\.example|ECONNREFUSED/);
  });

  it('unpaired (no sync reader, gated): checking and an empty sync axis — available, not refused', async () => {
    const h = harness();
    h.gate.gated = true;
    const snap = await h.publisher.read();
    expect(snap.connection).toBe('checking');
    expect(snap.connectionSince).toBe(new Date(T0).toISOString());
    expect(snap.sync).toEqual(EMPTY_SYNC);
    assertClosedLeaves(snap);
  });

  it.each<ConnectionSnapshot['connection']>(['online', 'offline', 'degraded'])(
    'a gated device reports checking, never %s (§2.1: a revoked device is never "offline")',
    async (code) => {
      const h = harness();
      h.connection.value = { ...h.connection.value, connection: code };
      h.gate.gated = true;
      expect((await h.publisher.read()).connection).toBe('checking');
    },
  );

  it('when the gate opens, connectionSince is never earlier than the gate change', async () => {
    const h = harness();
    h.gate.gated = true;
    await h.publisher.read();
    h.advance(10_000);
    h.gate.gated = false;
    const snap = await h.publisher.read();
    expect(snap.connection).toBe('online');
    expect(snap.connectionSince).toBe(new Date(T0 + 10_000).toISOString());
  });

  it('a later monitor transition after the gate opened is reported as is', async () => {
    const h = harness();
    await h.publisher.read();
    h.connection.value = {
      connection: 'offline',
      connectionSince: '2026-10-17T10:05:00.000Z',
      lastContactAt: null,
    };
    expect((await h.publisher.read()).connectionSince).toBe('2026-10-17T10:05:00.000Z');
  });

  it('clearing the sync reader returns to the empty sync axis', async () => {
    const h = harness();
    h.publisher.setSyncReader(() => Promise.resolve(AGGREGATE));
    expect((await h.publisher.read()).sync).toEqual(AGGREGATE);
    h.publisher.setSyncReader(null);
    expect((await h.publisher.read()).sync).toEqual(EMPTY_SYNC);
  });
});

describe('RT-603 terminal status publisher — invoke cache (A4-7)', () => {
  it('reads the sync aggregate at most once per second', async () => {
    const h = harness();
    const reader = vi.fn(() => Promise.resolve(AGGREGATE));
    h.publisher.setSyncReader(reader);
    await h.publisher.read();
    h.advance(TERMINAL_STATUS_GET_CACHE_MS - 1);
    await h.publisher.read();
    expect(reader).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.publisher.read();
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('concurrent reads share one sync query', async () => {
    const h = harness();
    const reader = vi.fn(() => Promise.resolve(AGGREGATE));
    h.publisher.setSyncReader(reader);
    await Promise.all([h.publisher.read(), h.publisher.read(), h.publisher.read()]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('the connection axis is never cached', async () => {
    const h = harness();
    await h.publisher.read();
    h.connection.value = { ...h.connection.value, connection: 'offline' };
    expect((await h.publisher.read()).connection).toBe('offline');
  });
});

describe('RT-603 terminal status publisher — push (terminalStatus:changed)', () => {
  it('pushes the first snapshot, then only on change', async () => {
    const h = harness();
    await h.publisher.refresh();
    expect(h.sent).toHaveLength(1);
    h.advance(1_000);
    await h.publisher.refresh();
    expect(h.sent).toHaveLength(1);
    h.connection.value = { ...h.connection.value, connection: 'offline' };
    await h.publisher.refresh();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.connection).toBe('offline');
  });

  it('coalesces to at most one push per second, and delivers the latest state after', async () => {
    const h = harness();
    await h.publisher.refresh();
    h.advance(200);
    h.connection.value = { ...h.connection.value, connection: 'degraded' };
    await h.publisher.refresh();
    h.advance(200);
    h.connection.value = { ...h.connection.value, connection: 'offline' };
    await h.publisher.refresh();
    expect(h.sent).toHaveLength(1);
    h.advance(TERMINAL_STATUS_PUSH_MIN_INTERVAL_MS - 400);
    await h.publisher.refresh();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.connection).toBe('offline');
  });

  it('no two pushes are ever closer than 1 s over a busy minute', async () => {
    const h = harness();
    const pushTimes: number[] = [];
    const busy = createTerminalStatusPublisher({
      readConnection: () => h.connection.value,
      isDeviceGated: () => false,
      send: () => {
        pushTimes.push(h.clock.t);
      },
      now: () => h.clock.t,
      monotonicNow: () => h.clock.t,
      logger: { warn: vi.fn() },
    });
    const codes = ['online', 'offline', 'degraded', 'checking'] as const;
    for (let i = 0; i < 600; i += 1) {
      h.connection.value = {
        ...h.connection.value,
        connection: codes[i % codes.length] ?? 'online',
      };
      await busy.refresh();
      h.advance(100);
    }
    for (let i = 1; i < pushTimes.length; i += 1) {
      expect((pushTimes[i] ?? 0) - (pushTimes[i - 1] ?? 0)).toBeGreaterThanOrEqual(1_000);
    }
    expect(pushTimes.length).toBeGreaterThan(1);
  });

  it('the background sync read runs every 5 s, or at once on a connection change', async () => {
    const h = harness();
    const reader = vi.fn(() => Promise.resolve(AGGREGATE));
    h.publisher.setSyncReader(reader);
    await h.publisher.refresh();
    expect(reader).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i += 1) {
      h.advance(1_000);
      await h.publisher.refresh();
    }
    expect(reader).toHaveBeenCalledTimes(1);
    h.advance(TERMINAL_STATUS_SYNC_POLL_MS - 4_000);
    await h.publisher.refresh();
    expect(reader).toHaveBeenCalledTimes(2);
    h.advance(1_000);
    h.connection.value = { ...h.connection.value, connection: 'offline' };
    await h.publisher.refresh();
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it('a sync count change is pushed', async () => {
    const h = harness();
    let pending = 0;
    h.publisher.setSyncReader(() => Promise.resolve({ ...AGGREGATE, pending }));
    await h.publisher.refresh();
    pending = 1;
    h.advance(TERMINAL_STATUS_SYNC_POLL_MS);
    await h.publisher.refresh();
    expect(h.sent.map((s) => s.sync.pending)).toEqual([0, 1]);
  });

  it('a throwing send never breaks the publisher', async () => {
    const h = harness({
      send: () => {
        throw new Error('window gone');
      },
    });
    await expect(h.publisher.refresh()).resolves.toBeUndefined();
    await expect(h.publisher.read()).resolves.toMatchObject({ v: 1 });
  });
});

describe('RT-603 terminal status publisher — sync read failure', () => {
  it('keeps the last known sync axis and logs one closed-set warning per failure run', async () => {
    const h = harness();
    let fail = false;
    h.publisher.setSyncReader(() =>
      fail ? Promise.reject(new Error('SQLITE_BUSY: /secret/path.db')) : Promise.resolve(AGGREGATE),
    );
    expect((await h.publisher.read()).sync).toEqual(AGGREGATE);
    fail = true;
    h.advance(TERMINAL_STATUS_GET_CACHE_MS);
    expect((await h.publisher.read()).sync).toEqual(AGGREGATE);
    h.advance(TERMINAL_STATUS_GET_CACHE_MS);
    await h.publisher.read();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({}, 'terminal_status:sync_read_failed');
    expect(JSON.stringify(h.warn.mock.calls)).not.toMatch(/secret|SQLITE/);
    fail = false;
    h.advance(TERMINAL_STATUS_GET_CACHE_MS);
    await h.publisher.read();
    fail = true;
    h.advance(TERMINAL_STATUS_GET_CACHE_MS);
    await h.publisher.read();
    expect(h.warn).toHaveBeenCalledTimes(2);
  });

  it('a failure before any success reports the empty sync axis', async () => {
    const h = harness();
    h.publisher.setSyncReader(() => Promise.reject(new Error('boom')));
    expect((await h.publisher.read()).sync).toEqual(EMPTY_SYNC);
  });
});

describe('RT-603 terminal status publisher — gate read failure', () => {
  it('a throwing gate read fails closed to checking and never rejects', async () => {
    const h = harness({
      isDeviceGated: () => {
        throw new Error('SQLITE_BUSY');
      },
    });
    await expect(h.publisher.refresh()).resolves.toBeUndefined();
    const snap = await h.publisher.read();
    expect(snap.connection).toBe('checking');
    expect(h.sent[0]?.connection).toBe('checking');
  });

  it('keeps the last known gate when a later read throws', async () => {
    let fail = false;
    const h = harness({
      isDeviceGated: () => {
        if (fail) throw new Error('SQLITE_BUSY');
        return false;
      },
    });
    expect((await h.publisher.read()).connection).toBe('online');
    fail = true;
    expect((await h.publisher.read()).connection).toBe('online');
  });

  it('the timer-driven refresh never leaves a rejection unhandled', async () => {
    let tick: (() => void) | null = null;
    const h = harness({
      readConnection: () => {
        throw new Error('boom');
      },
      setInterval: (fn) => {
        tick = fn;
        return {};
      },
      clearInterval: () => undefined,
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      h.publisher.start();
      (tick as (() => void) | null)?.();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      h.publisher.stop();
    }
  });
});

describe('RT-603 terminal status publisher — lifecycle', () => {
  it('start schedules a 1 s refresh (unref) and stop clears it', () => {
    const handle = { unref: vi.fn() };
    const setInterval = vi.fn(() => handle);
    const clearInterval = vi.fn();
    const h = harness({ setInterval, clearInterval });
    h.publisher.start();
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 1_000);
    expect(handle.unref).toHaveBeenCalled();
    h.publisher.start();
    expect(setInterval).toHaveBeenCalledTimes(1);
    h.publisher.stop();
    expect(clearInterval).toHaveBeenCalledWith(handle);
    h.publisher.stop();
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it('stop unbinds the sync reader (it runs before the DB closes); a later bind is ignored', async () => {
    const h = harness({ setInterval: () => ({}), clearInterval: () => undefined });
    const reader = vi.fn(() => Promise.resolve(AGGREGATE));
    h.publisher.setSyncReader(reader);
    h.publisher.stop();
    expect((await h.publisher.read()).sync).toEqual(EMPTY_SYNC);
    h.publisher.setSyncReader(reader);
    expect((await h.publisher.read()).sync).toEqual(EMPTY_SYNC);
    expect(reader).not.toHaveBeenCalled();
  });

  it('after stop, a refresh pushes nothing', async () => {
    const h = harness({ setInterval: () => ({}), clearInterval: () => undefined });
    h.publisher.start();
    h.publisher.stop();
    await h.publisher.refresh();
    expect(h.sent).toHaveLength(0);
  });
});
