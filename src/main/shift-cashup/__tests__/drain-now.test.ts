import { describe, expect, it, vi } from 'vitest';

import { drainNow } from '../compose-shift-cashup.js';
import type { ShiftDrainReport, ShiftSyncEngine } from '../shift-sync-engine.js';

/**
 * RT-554 (b) — `drainNow`: kicks the shift sync drain for the forced-close
 * handler and says whether Backend-Core has everything (the queue ended
 * `idle`). Anything else — held, waiting, blocked, a tick already running that
 * does not finish, a timeout — is "queued", never "sent".
 */

const IDLE: ShiftDrainReport = { sent: 1, stop: { kind: 'idle' } };
const HELD: ShiftDrainReport = {
  sent: 0,
  stop: { kind: 'held', reason: 'no_envelope_credential' },
};

function engine(script: Array<'running' | ShiftDrainReport | Promise<ShiftDrainReport>>) {
  const queue = [...script];
  const drain = vi.fn(() => Promise.resolve());
  const runTickOnce = vi.fn(() => {
    const next = queue.shift() ?? 'running';
    return next === 'running'
      ? ({ kind: 'already_running' } as const)
      : ({ kind: 'started', completed: Promise.resolve(next) } as const);
  });
  return { runTickOnce, drain } satisfies Pick<ShiftSyncEngine, 'runTickOnce' | 'drain'>;
}

describe('drainNow', () => {
  it('is true when the tick ends idle (everything sent)', async () => {
    await expect(drainNow(engine([IDLE]), 1_000)).resolves.toBe(true);
  });

  it.each([
    ['held', HELD],
    ['waiting', { sent: 0, stop: { kind: 'waiting', seq: 3, nextRetryAt: 'x' } }],
    ['blocked', { sent: 0, stop: { kind: 'blocked', seq: 3, reason: 'rejected' } }],
  ] as const)('is false when the tick stops %s', async (_name, report) => {
    await expect(drainNow(engine([report]), 1_000)).resolves.toBe(false);
  });

  it('waits for a tick already running, then runs one more', async () => {
    const e = engine(['running', IDLE]);
    await expect(drainNow(e, 1_000)).resolves.toBe(true);
    expect(e.drain).toHaveBeenCalledOnce();
    expect(e.runTickOnce).toHaveBeenCalledTimes(2);
  });

  it('is false when a tick is still running after the wait', async () => {
    await expect(drainNow(engine(['running', 'running']), 1_000)).resolves.toBe(false);
  });

  it('is false, and does not hang, when the tick outlasts the timeout', async () => {
    const never = new Promise<ShiftDrainReport>(() => undefined);
    await expect(drainNow(engine([never]), 20)).resolves.toBe(false);
  });
});
