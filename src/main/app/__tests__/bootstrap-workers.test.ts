import { describe, it, expect, vi, type Mock } from 'vitest';

import { createWorkerRegistry, type WorkerRegistryLogger } from '../bootstrap-workers.js';

/**
 * 021-pos-maintainability-rescue S1 (T010–T015) — background-worker lifecycle.
 *
 * These tests characterise the shutdown behaviour that previously lived inline in
 * `src/main/index.ts` as three module-scope handles plus a `runStopper` helper
 * invoked from `closeDbHandle()`. They are authored BEFORE the extraction
 * (Constitution Principle VI) and assert the CURRENT semantics, so they must pass
 * both before and after the move.
 *
 * The invariants under test (plan AD-2 / AD-3):
 *
 *   • stop order is FIXED: finalize → read-down → sale-sync, because a
 *     mid-flight background tick must not run against a closed DB handle;
 *   • a THROWING stop routine is caught and logged, and does NOT prevent the
 *     remaining workers from stopping;
 *   • `stopAll()` is IDEMPOTENT — on a normal Windows exit the shutdown path is
 *     reached twice (`window-all-closed` calls it, then `app.quit()` fires the
 *     `quit` handler which calls it again), so each worker must stop exactly once;
 *   • a worker that was never registered (feature flag off, or terminal
 *     unpaired) is simply absent — registration is what encodes the gate.
 */

function createRecordingLogger(): WorkerRegistryLogger & {
  error: Mock<(...args: unknown[]) => void>;
} {
  return { error: vi.fn<(...args: unknown[]) => void>() };
}

describe('021 S1 — worker registry: stop ordering (T012)', () => {
  it('stops workers in the fixed order finalize → read-down → sale-sync', () => {
    const order: string[] = [];
    const registry = createWorkerRegistry({ logger: createRecordingLogger() });

    // Registration order deliberately does NOT match stop order: the registry
    // owns the ordering, not the caller.
    registry.register('sale-sync interval', () => {
      order.push('sale-sync');
    });
    registry.register('read-down driver', () => {
      order.push('read-down');
    });
    registry.register('finalize listener', () => {
      order.push('finalize');
    });

    registry.stopAll();

    expect(order).toEqual(['finalize', 'read-down', 'sale-sync']);
  });

  it('skips workers that were never registered (gated off / unpaired) (T015)', () => {
    const order: string[] = [];
    const registry = createWorkerRegistry({ logger: createRecordingLogger() });

    // Unpaired terminal: only the flag-gated finalize listener is present.
    registry.register('finalize listener', () => {
      order.push('finalize');
    });

    registry.stopAll();

    expect(order).toEqual(['finalize']);
  });

  it('is a no-op when nothing was registered at all (T015)', () => {
    const registry = createWorkerRegistry({ logger: createRecordingLogger() });
    expect(() => {
      registry.stopAll();
    }).not.toThrow();
  });
});

describe('021 S1 — worker registry: throwing stopper isolation (T013)', () => {
  it('logs a throwing stopper and still stops the remaining workers', () => {
    const order: string[] = [];
    const logger = createRecordingLogger();
    const registry = createWorkerRegistry({ logger });

    registry.register('finalize listener', () => {
      order.push('finalize');
      throw new Error('finalize boom');
    });
    registry.register('read-down driver', () => {
      order.push('read-down');
    });
    registry.register('sale-sync interval', () => {
      order.push('sale-sync');
    });

    expect(() => {
      registry.stopAll();
    }).not.toThrow();

    // The throw must not short-circuit the remaining teardown.
    expect(order).toEqual(['finalize', 'read-down', 'sale-sync']);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('isolates every failure when all stoppers throw', () => {
    const order: string[] = [];
    const logger = createRecordingLogger();
    const registry = createWorkerRegistry({ logger });

    for (const name of ['finalize listener', 'read-down driver', 'sale-sync interval'] as const) {
      registry.register(name, () => {
        order.push(name);
        throw new Error(`${name} boom`);
      });
    }

    expect(() => {
      registry.stopAll();
    }).not.toThrow();
    expect(order).toEqual(['finalize listener', 'read-down driver', 'sale-sync interval']);
    expect(logger.error).toHaveBeenCalledTimes(3);
  });
});

describe('021 S1 — worker registry: idempotency (T014, plan AD-3)', () => {
  it('stops each worker exactly once when stopAll() is called twice', () => {
    const finalize = vi.fn();
    const readDown = vi.fn();
    const saleSync = vi.fn();
    const registry = createWorkerRegistry({ logger: createRecordingLogger() });

    registry.register('finalize listener', finalize);
    registry.register('read-down driver', readDown);
    registry.register('sale-sync interval', saleSync);

    // `window-all-closed` → closeDbHandle(), then app.quit() → `quit` →
    // closeDbHandle() again. Both reach stopAll().
    registry.stopAll();
    registry.stopAll();

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(readDown).toHaveBeenCalledTimes(1);
    expect(saleSync).toHaveBeenCalledTimes(1);
  });

  it('remains idempotent even when a stopper threw on the first pass', () => {
    const readDown = vi.fn();
    const logger = createRecordingLogger();
    const registry = createWorkerRegistry({ logger });

    registry.register('finalize listener', () => {
      throw new Error('finalize boom');
    });
    registry.register('read-down driver', readDown);

    registry.stopAll();
    registry.stopAll();

    // The throwing stopper is cleared despite throwing, so it is not retried.
    expect(readDown).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('021 S1 — worker registry: registration semantics', () => {
  it('replaces a re-registered worker rather than stopping it twice', () => {
    const first = vi.fn();
    const second = vi.fn();
    const registry = createWorkerRegistry({ logger: createRecordingLogger() });

    registry.register('read-down driver', first);
    registry.register('read-down driver', second);

    registry.stopAll();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('reports whether any worker is currently registered', () => {
    const registry = createWorkerRegistry({ logger: createRecordingLogger() });
    expect(registry.hasRegistered()).toBe(false);

    registry.register('sale-sync interval', vi.fn());
    expect(registry.hasRegistered()).toBe(true);

    registry.stopAll();
    expect(registry.hasRegistered()).toBe(false);
  });
});
