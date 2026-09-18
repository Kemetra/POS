import { describe, it, expect, vi, type Mock } from 'vitest';

import { createDatabaseHolder, type DatabaseHolderLogger } from '../bootstrap-db.js';

/**
 * 021-pos-maintainability-rescue S2 (T040–T046) — database handle lifetime.
 *
 * These tests characterise the open/close mechanics that previously lived in
 * `src/main/index.ts` as a module-scope `let dbHandle: DatabaseHandle | null`
 * plus the close block inside `closeDbHandle()`. They are authored BEFORE the
 * extraction (Constitution Principle VI) and assert the CURRENT semantics.
 *
 * **Why a holder rather than a moved block (plan AD-5).** `dbHandle` is
 * module-scope for exactly one reason: `closeDbHandle()` lives OUTSIDE
 * `app.whenReady()` and has to reach it. Every one of the ~26 consumers is
 * inside `whenReady()`, after the open. So the handle is not genuinely
 * process-wide shared state — it is a teardown artifact. Moving ownership into
 * a holder lets `whenReady()` use a plain local `const` while the close path
 * still has a reference, which discharges SC-1 (no process-lifetime mutable
 * state in the composition root) WITHOUT the ~900-line context-object refactor
 * FR-6 prohibits.
 *
 * The two invariants below are the S2 analogues of S1's ordering/idempotency
 * pair, and are the most likely silent regressions in this slice:
 *
 *   • CLOSE BEFORE OPEN — `closeDbHandle()` is called from the `.catch` that
 *     wraps `whenReady()`. If startup throws before the DB is opened (logger
 *     init, for instance), close runs with nothing to close. Today the
 *     `dbHandle !== null` guard makes that a no-op; it must stay a no-op.
 *   • DOUBLE CLOSE — on a normal Windows exit the path is reached twice
 *     (`window-all-closed` → `app.quit()` → `quit`). Today `dbHandle = null`
 *     makes the second call a no-op; the handle must close exactly once.
 */

function createRecordingLogger(): DatabaseHolderLogger & {
  error: Mock<(...args: unknown[]) => void>;
} {
  return { error: vi.fn<(...args: unknown[]) => void>() };
}

/** Minimal stand-in for the `better-sqlite3` handle — only `close()` matters here. */
function createFakeHandle() {
  return { close: vi.fn() };
}

describe('021 S2 — database holder: open + access', () => {
  it('holds the handle it was given', () => {
    const holder = createDatabaseHolder({ logger: createRecordingLogger() });
    const handle = createFakeHandle();

    holder.set(handle as never);

    expect(holder.isOpen()).toBe(true);
  });

  it('reports not-open before anything is set', () => {
    const holder = createDatabaseHolder({ logger: createRecordingLogger() });
    expect(holder.isOpen()).toBe(false);
  });
});

describe('021 S2 — database holder: close before open (startup failure path)', () => {
  it('is a no-op when close runs before the DB was ever opened', () => {
    const logger = createRecordingLogger();
    const holder = createDatabaseHolder({ logger });

    // The `.catch` around whenReady() fires when startup throws early — e.g.
    // logger init or SecretStore refusal, both BEFORE openDatabase().
    expect(() => {
      holder.close();
    }).not.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
    expect(holder.isOpen()).toBe(false);
  });
});

describe('021 S2 — database holder: close idempotency', () => {
  it('closes the handle exactly once across repeated close() calls', () => {
    const handle = createFakeHandle();
    const holder = createDatabaseHolder({ logger: createRecordingLogger() });
    holder.set(handle as never);

    // window-all-closed → closeDbHandle(), then app.quit() → `quit` →
    // closeDbHandle() again. Both reach here.
    holder.close();
    holder.close();
    holder.close();

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(holder.isOpen()).toBe(false);
  });

  it('remains closed-and-idempotent even when close() throws', () => {
    const handle = {
      close: vi.fn(() => {
        throw new Error('sqlite busy');
      }),
    };
    const logger = createRecordingLogger();
    const holder = createDatabaseHolder({ logger });
    holder.set(handle as never);

    // A failing close must not propagate — it would strand app quit.
    expect(() => {
      holder.close();
    }).not.toThrow();
    expect(logger.error).toHaveBeenCalledTimes(1);

    // ...and must not be retried on the second shutdown pass.
    holder.close();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(holder.isOpen()).toBe(false);
  });
});

describe('021 S2 — database holder: reopen semantics', () => {
  it('can hold a new handle after a close (no latched terminal state)', () => {
    const first = createFakeHandle();
    const second = createFakeHandle();
    const holder = createDatabaseHolder({ logger: createRecordingLogger() });

    holder.set(first as never);
    holder.close();
    holder.set(second as never);

    expect(holder.isOpen()).toBe(true);
    holder.close();
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
  });
});
