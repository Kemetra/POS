import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMITTED,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';
import {
  PENDING_END_WAIT_MS,
  admitCashierOnline,
  endAdmissionTracked,
  takeUncertainEnd,
} from '../../../../src/main/operator/cashier-admission.js';
import {
  ADMISSION_REQUEST_TIMEOUT_MS,
  type CashierAdmissionEndResult,
} from '../../../../src/main/operator/cashier-admission-client.js';

/**
 * RT-113 P2 (adversarial review of 024f07c, item 3) — sign-out fires the
 * admission `end` without awaiting it. If the SAME user signs in again on this
 * device before it lands, the server renews and returns the same admission,
 * and the late `end` then kills it. An admission for a user therefore waits for
 * that user's pending `end`, bounded by {@link PENDING_END_WAIT_MS}, best-effort:
 * a failed `end` never blocks, and other users never wait.
 */

const OTHER_USER = '0192f6a0-1b2c-7d3e-8f40-999999999999';

function deferredEnd(fake: ReturnType<typeof fakeCashierAdmission>): {
  land: (r?: CashierAdmissionEndResult) => void;
  fail: () => void;
} {
  let land: (r?: CashierAdmissionEndResult) => void = () => undefined;
  let fail: () => void = () => undefined;
  fake.setEnd(
    () =>
      new Promise((resolve, reject) => {
        land = (r) => {
          resolve((r ?? { kind: 'ended' }) as { kind: 'ended' });
        };
        fail = () => {
          reject(new Error('end failed'));
        };
      }),
  );
  return {
    land: (r) => {
      land(r);
    },
    fail: () => {
      fail();
    },
  };
}

function admit(fake: ReturnType<typeof fakeCashierAdmission>, user_id = FAKE_USER_ID) {
  return admitCashierOnline(fake.deps, {
    user_id,
    operator_id: 'user_clerk_1',
    takeover: false,
    idempotency_key: 'test-idempotency-key-9999',
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a re-admission waits for the same user’s pending end', () => {
  it('the admit is sent only after the earlier end has landed', async () => {
    const fake = fakeCashierAdmission(ADMITTED);
    const end = deferredEnd(fake);
    const order: string[] = [];
    void endAdmissionTracked(
      fake.deps,
      ADMITTED.admission_id,
      ADMITTED.admission_generation,
      FAKE_USER_ID,
    ).then(() => order.push('end landed'));
    fake.setAdmit(() => {
      order.push('admit sent');
      return ADMITTED;
    });
    const res = admit(fake);
    await vi.advanceTimersByTimeAsync(PENDING_END_WAIT_MS - 1);
    expect(fake.admitCalls).toHaveLength(0);
    end.land();
    await expect(res).resolves.toMatchObject({ kind: 'admitted' });
    expect(order).toEqual(['end landed', 'admit sent']);
  });

  it('bounded: an end that never lands delays the admit by PENDING_END_WAIT_MS at most', async () => {
    const fake = fakeCashierAdmission(ADMITTED);
    deferredEnd(fake); // never lands
    void endAdmissionTracked(
      fake.deps,
      ADMITTED.admission_id,
      ADMITTED.admission_generation,
      FAKE_USER_ID,
    );
    const res = admit(fake);
    await vi.advanceTimersByTimeAsync(PENDING_END_WAIT_MS - 1);
    expect(fake.admitCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(res).resolves.toMatchObject({ kind: 'admitted' });
    expect(fake.admitCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    // Gave up waiting: the outcome is unknown, so verify early.
    expect(takeUncertainEnd(fake.deps, FAKE_USER_ID)).toBe(true);
  });

  it.each([
    { kind: 'ended' },
    { kind: 'rejected' },
    { kind: 'device_unauthorized' },
    { kind: 'no_token' },
  ] as const)('an end answered %o has a known outcome: no early verification', async (answer) => {
    const fake = fakeCashierAdmission(ADMITTED);
    fake.setEnd(() => Promise.resolve(answer as unknown as { kind: 'ended' }));
    await endAdmissionTracked(
      fake.deps,
      ADMITTED.admission_id,
      ADMITTED.admission_generation,
      FAKE_USER_ID,
    );
    expect(takeUncertainEnd(fake.deps, FAKE_USER_ID)).toBe(false);
  });

  it('RT-220: an end answered 5xx (`unavailable`) has an unknown outcome: a gateway may answer after the server applied it', async () => {
    const fake = fakeCashierAdmission(ADMITTED);
    fake.setEnd(() => Promise.resolve({ kind: 'unavailable' } as unknown as { kind: 'ended' }));
    await expect(
      endAdmissionTracked(
        fake.deps,
        ADMITTED.admission_id,
        ADMITTED.admission_generation,
        FAKE_USER_ID,
      ),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(takeUncertainEnd(fake.deps, FAKE_USER_ID)).toBe(true);
    expect(takeUncertainEnd(fake.deps, FAKE_USER_ID)).toBe(false); // consumed once
  });

  it('Codex P1 4180025698: the wait outlasts the end request’s own timeout, so a slow end cannot land after the admit', () => {
    expect(PENDING_END_WAIT_MS).toBeGreaterThan(ADMISSION_REQUEST_TIMEOUT_MS);
  });

  it('Codex P1 4180025698: a slow end that resolves after 5 s: the admit is sent only after it settles', async () => {
    const fake = fakeCashierAdmission(ADMITTED);
    const order: string[] = [];
    fake.setEnd(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            order.push('end settled');
            resolve({ kind: 'ended' });
          }, 5_000);
        }),
    );
    void endAdmissionTracked(
      fake.deps,
      ADMITTED.admission_id,
      ADMITTED.admission_generation,
      FAKE_USER_ID,
    );
    fake.setAdmit(() => {
      order.push('admit sent');
      return ADMITTED;
    });
    const res = admit(fake);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.admitCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(res).resolves.toMatchObject({ kind: 'admitted' });
    expect(order).toEqual(['end settled', 'admit sent']);
    // A definite answer: the admission needs no early verification.
    expect(takeUncertainEnd(fake.deps, FAKE_USER_ID)).toBe(false);
  });

  it('Codex P1 4180025698: an end that settles only at the client timeout (aborted) still goes before the admit', async () => {
    const fake = fakeCashierAdmission(ADMITTED);
    const order: string[] = [];
    fake.setEnd(
      () =>
        new Promise((resolve) => {
          // The production client aborts the request at its timeout.
          setTimeout(() => {
            order.push('end settled');
            resolve({ kind: 'no_connection' } as unknown as { kind: 'ended' });
          }, ADMISSION_REQUEST_TIMEOUT_MS);
        }),
    );
    void endAdmissionTracked(
      fake.deps,
      ADMITTED.admission_id,
      ADMITTED.admission_generation,
      FAKE_USER_ID,
    );
    fake.setAdmit(() => {
      order.push('admit sent');
      return ADMITTED;
    });
    const res = admit(fake);
    await vi.advanceTimersByTimeAsync(ADMISSION_REQUEST_TIMEOUT_MS - 1);
    expect(fake.admitCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(res).resolves.toMatchObject({ kind: 'admitted' });
    expect(order).toEqual(['end settled', 'admit sent']);
    // Aborted: the server may still apply it. The new admission is verified early.
    expect(takeUncertainEnd(fake.deps, FAKE_USER_ID)).toBe(true);
    expect(takeUncertainEnd(fake.deps, FAKE_USER_ID)).toBe(false); // consumed once
  });

  it('a failed end never blocks: the admit goes out once it fails', async () => {
    const fake = fakeCashierAdmission(ADMITTED);
    const end = deferredEnd(fake);
    const ended = endAdmissionTracked(
      fake.deps,
      ADMITTED.admission_id,
      ADMITTED.admission_generation,
      FAKE_USER_ID,
    );
    const res = admit(fake);
    end.fail();
    await expect(ended).resolves.toEqual({ kind: 'threw' });
    await expect(res).resolves.toMatchObject({ kind: 'admitted' });
    expect(takeUncertainEnd(fake.deps, FAKE_USER_ID)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('another user never waits', async () => {
    const fake = fakeCashierAdmission(ADMITTED);
    deferredEnd(fake); // never lands
    void endAdmissionTracked(
      fake.deps,
      ADMITTED.admission_id,
      ADMITTED.admission_generation,
      FAKE_USER_ID,
    );
    await expect(admit(fake, OTHER_USER)).resolves.toMatchObject({ kind: 'admitted' });
    expect(fake.admitCalls).toHaveLength(1);
  });

  it('with no pending end the admit goes out at once', async () => {
    const fake = fakeCashierAdmission(ADMITTED);
    await expect(admit(fake)).resolves.toMatchObject({ kind: 'admitted' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a landed end is forgotten: the next admit does not wait', async () => {
    const fake = fakeCashierAdmission(ADMITTED);
    const end = deferredEnd(fake);
    const ended = endAdmissionTracked(
      fake.deps,
      ADMITTED.admission_id,
      ADMITTED.admission_generation,
      FAKE_USER_ID,
    );
    end.land();
    await ended;
    await expect(admit(fake)).resolves.toMatchObject({ kind: 'admitted' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('RT-219 — the tracked end echoes the generation it is given', () => {
  it('passes the admission_generation to the client end, unchanged', async () => {
    const fake = fakeCashierAdmission();
    await endAdmissionTracked(fake.deps, ADMITTED.admission_id, 'gen-latest-0009', FAKE_USER_ID);
    await endAdmissionTracked(fake.deps, ADMITTED.admission_id, 'gen-untracked-0010', undefined);
    expect(fake.endRequests).toEqual([
      { admission_id: ADMITTED.admission_id, admission_generation: 'gen-latest-0009' },
      { admission_id: ADMITTED.admission_id, admission_generation: 'gen-untracked-0010' },
    ]);
  });
});
