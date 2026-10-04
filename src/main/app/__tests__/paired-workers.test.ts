import { describe, expect, it, vi, type Mock } from 'vitest';

import { createPairedWorkers, type PairedWorkersLogger } from '../paired-workers.js';

/**
 * RT-202 — paired-only worker lifecycle.
 *
 * The catalogue read-down driver, the AD-2 finalize listener and the 011
 * sale-sync engine need the paired terminal's scope. They used to be built only
 * in a "paired at boot" branch, so a terminal that paired in-process (the
 * renderer never relaunches the app) stayed without workers until a restart.
 *
 * `createPairedWorkers` is the once-latch behind both entry points:
 *   • boot, already paired  → `notifyPaired` first, so each later `register`
 *     starts immediately (same order and error behaviour as before);
 *   • boot, unpaired        → starters are held until `notifyPaired`;
 *   • in-process pairing    → `notifyPaired` after the pairing is persisted.
 */

const TERMINAL = { tenant_id: 'tenant-A', branch_id: 'branch-B', terminal_id: 'terminal-C' };

type LogFn = (payload: Record<string, unknown>, message: string) => void;

function makeLogger(): PairedWorkersLogger & { info: Mock<LogFn>; error: Mock<LogFn> } {
  return { info: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
}

describe('RT-202 paired workers — deferred start', () => {
  it('holds registered starters while the terminal is unpaired', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const start = vi.fn();
    workers.register('finalize', start);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts every held starter, in registration order, with the paired scope', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const order: string[] = [];
    const seen: unknown[] = [];
    workers.register('read-down', (t) => {
      order.push('read-down');
      seen.push(t);
    });
    workers.register('finalize+sync', (t) => {
      order.push('finalize+sync');
      seen.push(t);
    });

    workers.notifyPaired(TERMINAL);

    expect(order).toEqual(['read-down', 'finalize+sync']);
    expect(seen).toEqual([TERMINAL, TERMINAL]);
  });

  it('starts each starter exactly once even when notifyPaired is called repeatedly', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const start = vi.fn();
    workers.register('finalize+sync', start);

    workers.notifyPaired(TERMINAL);
    workers.notifyPaired(TERMINAL);
    workers.notifyPaired({ ...TERMINAL, terminal_id: 'terminal-other' });

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(TERMINAL);
  });

  it('starts a starter registered AFTER pairing immediately, and only once (paired boot)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    workers.notifyPaired(TERMINAL);

    const start = vi.fn();
    workers.register('read-down', start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(TERMINAL);
    workers.notifyPaired(TERMINAL);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('lets an immediate start failure propagate (paired-boot behaviour is unchanged)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    workers.notifyPaired(TERMINAL);
    expect(() => {
      workers.register('finalize+sync', () => {
        throw new Error('boot wiring failed');
      });
    }).toThrow('boot wiring failed');
  });

  it('isolates a deferred start failure: logs it and still starts the others', () => {
    const logger = makeLogger();
    const workers = createPairedWorkers({ logger });
    const second = vi.fn();
    workers.register('read-down', () => {
      throw new Error('boom');
    });
    workers.register('finalize+sync', second);

    expect(() => {
      workers.notifyPaired(TERMINAL);
    }).not.toThrow();

    expect(second).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('paired_workers:start_failed');
    expect(payload).toMatchObject({ worker: 'read-down', error: 'boom' });
  });

  it('does not retry a starter that failed (no duplicate half-built workers)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const flaky = vi.fn(() => {
      throw new Error('boom');
    });
    workers.register('finalize+sync', flaky);

    workers.notifyPaired(TERMINAL);
    workers.notifyPaired(TERMINAL);

    expect(flaky).toHaveBeenCalledTimes(1);
  });

  it('never starts anything when pairing never happens (failed/incomplete pairing)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const start = vi.fn();
    workers.register('read-down', start);
    workers.register('finalize+sync', start);
    // No notifyPaired — the pairing failed or was never completed.
    expect(start).not.toHaveBeenCalled();
  });
});

describe('RT-202 paired workers — shutdown latch', () => {
  it('after close(), a late pairing starts nothing (no worker against a closed DB)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const start = vi.fn();
    workers.register('finalize+sync', start);

    workers.close();
    workers.notifyPaired(TERMINAL);

    expect(start).not.toHaveBeenCalled();
  });

  it('after close(), a late register does not start even if already paired', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    workers.notifyPaired(TERMINAL);
    workers.close();

    const start = vi.fn();
    workers.register('read-down', start);

    expect(start).not.toHaveBeenCalled();
  });

  it('close() is idempotent (window-all-closed then quit both call it)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    expect(() => {
      workers.close();
      workers.close();
    }).not.toThrow();
  });
});
