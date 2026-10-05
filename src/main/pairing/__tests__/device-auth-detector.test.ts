import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEVICE_401_CONFIRM_MS,
  createDeviceAuthDetector,
  deviceAuthConfirmDelayMs,
  withDeviceAuthObservation,
  type DeviceAuthDetector,
  type DeviceAuthOutcome,
} from '../device-auth-detector.js';
import type { DeviceRevokedSource } from '../../../shared/pairing-types.js';

/**
 * RT-215 decisions 1 + 2 — the ONE device-401 detector.
 *
 *  - Revocation is confirmed by TWO consecutive device-bearer 401s; the second
 *    comes from a confirmation call (the cashier-admissions roster) made
 *    min(30 s, TTL/2) after the first.
 *  - Any device-bearer 2xx in between resets the count.
 *  - Only device-bearer routes count: the three cashier-admissions routes and
 *    the catalogue read-down. Operator-credential routes (sale sync, returns,
 *    vouchers) are ignored.
 */

const BASE = 'https://backend.example';
const ADMIT = `${BASE}/api/pos/v1/cashier-admissions`;
const ROSTER = `${BASE}/api/pos/v1/cashier-admissions/roster`;
const END = `${BASE}/api/pos/v1/cashier-admissions/0192f6a0-aaaa-7bbb-8ccc-000000000001/end`;
const SNAPSHOT = `${BASE}/api/pos/v1/catalog/snapshot?page_token=abc`;

interface Harness {
  detector: DeviceAuthDetector;
  probe: ReturnType<typeof vi.fn<() => Promise<DeviceAuthOutcome>>>;
  confirmed: DeviceRevokedSource[];
  setProbe(answer: DeviceAuthOutcome | (() => Promise<DeviceAuthOutcome>)): void;
  delay: { ms: number };
}

function harness(): Harness {
  let answer: DeviceAuthOutcome | (() => Promise<DeviceAuthOutcome>) = 'unauthorized';
  const probe = vi.fn(() => (typeof answer === 'function' ? answer() : Promise.resolve(answer)));
  const confirmed: DeviceRevokedSource[] = [];
  const delay = { ms: DEVICE_401_CONFIRM_MS };
  const detector = createDeviceAuthDetector({
    probe,
    confirmDelayMs: () => delay.ms,
    onConfirmed: (source) => {
      confirmed.push(source);
    },
  });
  return {
    detector,
    probe,
    confirmed,
    delay,
    setProbe(a) {
      answer = a;
    },
  };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('device-401 detector — debounce (decision 1)', () => {
  it('one transient 401 does not revoke: the confirmation call answers 2xx', async () => {
    const h = harness();
    h.setProbe('ok');
    h.detector.observe('cashier_admissions', 401);
    expect(h.detector.state).toBe('suspect');
    expect(h.probe).not.toHaveBeenCalled();
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.confirmed).toEqual([]);
    expect(h.detector.state).toBe('clear');
  });

  it('a single 401 never revokes on its own, however long nothing else happens', async () => {
    const h = harness();
    h.setProbe('other'); // the confirmation call never gets an answer
    h.detector.observe('cashier_admissions', 401);
    await advance(DEVICE_401_CONFIRM_MS * 10);
    expect(h.confirmed).toEqual([]);
    expect(h.detector.state).toBe('suspect');
  });

  it('two consecutive 401s revoke: the confirmation call (roster) also answers 401', async () => {
    const h = harness();
    h.detector.observe('cashier_admissions', 401);
    await advance(DEVICE_401_CONFIRM_MS - 1);
    expect(h.confirmed).toEqual([]);
    await advance(1);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.confirmed).toEqual(['cashier_admissions']);
    expect(h.detector.state).toBe('confirmed');
  });

  it('a 2xx in between resets the count: the pending confirmation is cancelled', async () => {
    const h = harness();
    h.detector.observe('cashier_admissions', 401);
    h.detector.observe('cashier_admissions', 200);
    expect(h.detector.state).toBe('clear');
    await advance(DEVICE_401_CONFIRM_MS * 2);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.confirmed).toEqual([]);
  });

  it('after a reset, the next 401 is a FIRST 401 again and needs its own confirmation', async () => {
    const h = harness();
    h.detector.observe('cashier_admissions', 401);
    h.detector.observe('cashier_admissions', 200);
    h.detector.observe('cashier_admissions', 401);
    expect(h.confirmed).toEqual([]);
    expect(h.detector.state).toBe('suspect');
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual(['cashier_admissions']);
  });

  it('a 2xx while the confirmation call is in flight resets it; that call’s 401 starts a new count', async () => {
    const h = harness();
    let release: (o: DeviceAuthOutcome) => void = () => undefined;
    h.setProbe(
      () =>
        new Promise<DeviceAuthOutcome>((resolve) => {
          release = resolve;
        }),
    );
    h.detector.observe('cashier_admissions', 401);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.probe).toHaveBeenCalledTimes(1);
    h.detector.observe('read_down', 200); // 2xx in between
    release('unauthorized');
    await advance(0);
    expect(h.confirmed).toEqual([]);
    expect(h.detector.state).toBe('suspect');
  });

  it('other device-bearer 401s while a confirmation is pending do not confirm early', async () => {
    const h = harness();
    // sign-in, takeover and a heartbeat all 401 within the window
    h.detector.observe('cashier_admissions', 401);
    h.detector.observe('cashier_admissions', 401);
    h.detector.observe('cashier_admissions', 401);
    h.detector.observe('read_down', 401);
    expect(h.confirmed).toEqual([]);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.confirmed).toEqual(['cashier_admissions']); // the source of the FIRST 401
  });

  it('a non-answer from the confirmation call keeps the count and retries the confirmation', async () => {
    const h = harness();
    h.setProbe('other');
    h.detector.observe('cashier_admissions', 401);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.probe).toHaveBeenCalledTimes(1);
    h.setProbe('unauthorized');
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect(h.confirmed).toEqual(['cashier_admissions']);
  });

  it('a throwing confirmation call counts as a non-answer', async () => {
    const h = harness();
    h.setProbe(() => Promise.reject(new Error('boom')));
    h.detector.observe('cashier_admissions', 401);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual([]);
    expect(h.detector.state).toBe('suspect');
  });

  it('non-2xx, non-401 answers (403, 5xx) neither count nor reset', async () => {
    const h = harness();
    h.detector.observe('cashier_admissions', 403);
    h.detector.observe('cashier_admissions', 503);
    expect(h.detector.state).toBe('clear');
    h.detector.observe('cashier_admissions', 401);
    h.detector.observe('cashier_admissions', 403);
    h.detector.observe('cashier_admissions', 500);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual(['cashier_admissions']);
  });

  it('confirms once; later observations are ignored until reset()', async () => {
    const h = harness();
    h.detector.observe('read_down', 401);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual(['read_down']);
    h.detector.observe('cashier_admissions', 401);
    h.detector.observe('cashier_admissions', 200);
    await advance(DEVICE_401_CONFIRM_MS * 2);
    expect(h.confirmed).toEqual(['read_down']);
    expect(h.detector.state).toBe('confirmed');
    h.detector.reset(); // a re-pair
    expect(h.detector.state).toBe('clear');
    h.detector.observe('cashier_admissions', 401);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual(['read_down', 'cashier_admissions']);
  });

  it('a throwing onConfirmed does not break the detector', async () => {
    const probe = vi.fn(() => Promise.resolve<DeviceAuthOutcome>('unauthorized'));
    const detector = createDeviceAuthDetector({
      probe,
      confirmDelayMs: () => 10,
      onConfirmed: () => {
        throw new Error('handler failed');
      },
    });
    detector.observe('cashier_admissions', 401);
    await advance(10);
    expect(detector.state).toBe('confirmed');
  });

  it('stop() cancels a pending confirmation and ignores everything after', async () => {
    const h = harness();
    h.detector.observe('cashier_admissions', 401);
    h.detector.stop();
    await advance(DEVICE_401_CONFIRM_MS * 2);
    expect(h.probe).not.toHaveBeenCalled();
    h.detector.observe('cashier_admissions', 401);
    await advance(DEVICE_401_CONFIRM_MS * 2);
    expect(h.confirmed).toEqual([]);
  });

  it('a confirmation call that settles after stop() is ignored', async () => {
    const h = harness();
    let release: (o: DeviceAuthOutcome) => void = () => undefined;
    h.setProbe(
      () =>
        new Promise<DeviceAuthOutcome>((resolve) => {
          release = resolve;
        }),
    );
    h.detector.observe('cashier_admissions', 401);
    await advance(DEVICE_401_CONFIRM_MS);
    h.detector.stop();
    release('unauthorized');
    await advance(0);
    expect(h.confirmed).toEqual([]);
  });

  it('waits the delay supplied at the time of the first 401 (min(30 s, TTL/2))', async () => {
    const h = harness();
    h.delay.ms = 5_000;
    h.detector.observe('cashier_admissions', 401);
    await advance(4_999);
    expect(h.probe).not.toHaveBeenCalled();
    await advance(1);
    expect(h.probe).toHaveBeenCalledTimes(1);
  });

  it('review F4: onSuspect fires on the FIRST device 401 only (once per count), never on a 2xx', async () => {
    const suspects: DeviceRevokedSource[] = [];
    const detector = createDeviceAuthDetector({
      probe: () => Promise.resolve('ok'),
      confirmDelayMs: () => 10,
      onConfirmed: () => undefined,
      onSuspect: (source) => suspects.push(source),
    });
    detector.observe('cashier_admissions', 200);
    expect(suspects).toEqual([]);
    detector.observe('read_down', 401);
    detector.observe('cashier_admissions', 401); // still the same count
    expect(suspects).toEqual(['read_down']);
    await advance(10); // the confirmation answers 2xx: count cleared
    detector.observe('cashier_admissions', 401); // a new first 401
    expect(suspects).toEqual(['read_down', 'cashier_admissions']);
  });

  it('review F4: a throwing onSuspect does not stop the confirmation', async () => {
    const onConfirmed = vi.fn();
    const detector = createDeviceAuthDetector({
      probe: () => Promise.resolve('unauthorized'),
      confirmDelayMs: () => 10,
      onConfirmed,
      onSuspect: () => {
        throw new Error('seam failed');
      },
    });
    detector.observe('cashier_admissions', 401);
    await advance(10);
    expect(onConfirmed).toHaveBeenCalledWith('cashier_admissions');
  });

  it('logs the source and transition only', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const detector = createDeviceAuthDetector({
      probe: () => Promise.resolve('unauthorized'),
      confirmDelayMs: () => 10,
      onConfirmed: () => undefined,
      logger: { info, warn },
    });
    detector.observe('cashier_admissions', 401);
    await advance(10);
    expect(info).toHaveBeenCalledWith(
      { event: 'pairing.device_auth.suspect', source: 'cashier_admissions' },
      expect.any(String),
    );
    expect(warn).toHaveBeenCalledWith(
      { event: 'pairing.device_auth.confirmed', source: 'cashier_admissions' },
      expect.any(String),
    );
  });
});

describe('device-401 detector — which 401s count (decision 2, review F5)', () => {
  /** The observed fetch for one client: its route family and its own base URL. */
  function observed(baseUrl: string, source: DeviceRevokedSource) {
    const h = harness();
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
    const wrapped = withDeviceAuthObservation(fetchImpl, h.detector, { source, baseUrl });
    return { h, wrapped, fetchImpl };
  }

  it.each([
    [`${BASE}/api/pos/v1/sales`, 'sale sync (operator envelope)'],
    [`${BASE}/api/pos/v1/sales/0192f6a0-1b2c-7d3e-8f40-123456789abc/returns`, 'returns'],
    [`${BASE}/api/pos/v1/vouchers/validate`, 'vouchers'],
    [`${BASE}/api/pos/v1/operators/sign-in`, 'operator sign-in'],
    [`${BASE}/api/pos/v1/cashier-admissions-v2`, 'a look-alike path'],
    ['https://other.example/api/pos/v1/cashier-admissions', 'another origin'],
    ['not a url', 'garbage'],
  ])('ignores a 401 from %s (%s), even on an observed fetch', async (url) => {
    const { h, wrapped } = observed(BASE, 'cashier_admissions');
    await wrapped(url);
    await wrapped(url);
    await advance(DEVICE_401_CONFIRM_MS * 3);
    expect(h.detector.state).toBe('clear');
    expect(h.probe).not.toHaveBeenCalled();
  });

  it.each<[string, DeviceRevokedSource, string]>([
    ['', 'cashier_admissions', ADMIT],
    ['', 'cashier_admissions', ROSTER],
    ['', 'cashier_admissions', END],
    ['', 'read_down', SNAPSHOT],
    ['/backend', 'cashier_admissions', `${BASE}/backend/api/pos/v1/cashier-admissions`],
    ['/backend/', 'cashier_admissions', `${BASE}/backend/api/pos/v1/cashier-admissions/roster`],
    ['/backend', 'read_down', `${BASE}/backend/api/pos/v1/catalog/snapshot?page_token=x`],
  ])('review F5: base %j counts a 401 on its %s route (%s)', async (prefix, source, url) => {
    const { h, wrapped } = observed(`${BASE}${prefix}`, source);
    await wrapped(url);
    expect(h.detector.state).toBe('suspect');
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual([source]);
  });

  it('review F5: with a prefixed base, the un-prefixed path is not the client’s route', async () => {
    const { h, wrapped } = observed(`${BASE}/backend`, 'cashier_admissions');
    await wrapped(ADMIT);
    expect(h.detector.state).toBe('clear');
  });

  it('a read-down-tagged fetch does not count a cashier-admissions path, and vice versa', async () => {
    const a = observed(BASE, 'read_down');
    await a.wrapped(ADMIT);
    expect(a.h.detector.state).toBe('clear');
    const b = observed(BASE, 'cashier_admissions');
    await b.wrapped(SNAPSHOT);
    expect(b.h.detector.state).toBe('clear');
  });

  it('an operator-route 2xx does not reset a device-bearer count', async () => {
    const h = harness();
    const ok = vi.fn(() => Promise.resolve(new Response(null, { status: 201 })));
    const wrapped = withDeviceAuthObservation(ok, h.detector, {
      source: 'cashier_admissions',
      baseUrl: BASE,
    });
    h.detector.observe('cashier_admissions', 401);
    await wrapped(`${BASE}/api/pos/v1/sales`);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual(['cashier_admissions']);
  });
});

describe('deviceAuthConfirmDelayMs', () => {
  it.each<[number | undefined, number]>([
    [undefined, 30_000],
    [43_200, 30_000],
    [60, 30_000],
    [20, 10_000],
    [10, 5_000],
    // review F7: floored at 5 s — never a near-immediate second call.
    [6, 5_000],
    [1, 5_000],
    [0, 30_000],
    [Number.NaN, 30_000],
  ])('ttl %s s → %s ms', (ttl, ms) => {
    expect(deviceAuthConfirmDelayMs(ttl)).toBe(ms);
  });
});

describe('withDeviceAuthObservation (the fetch the device-bearer clients use)', () => {
  const tag = { source: 'cashier_admissions', baseUrl: BASE } as const;

  it('reports each matching answer to the detector and returns the response untouched', async () => {
    const observedCalls: [string, number][] = [];
    const response = new Response(null, { status: 401 });
    const fetchImpl = vi.fn(() => Promise.resolve(response));
    const wrapped = withDeviceAuthObservation(
      fetchImpl,
      { observe: (source, status) => observedCalls.push([source, status]) },
      tag,
    );
    const init = { method: 'GET' };
    await expect(wrapped(ROSTER, init)).resolves.toBe(response);
    await wrapped(new URL(ADMIT));
    await wrapped(new Request(END, { method: 'POST' }));
    expect(fetchImpl).toHaveBeenNthCalledWith(1, ROSTER, init);
    expect(observedCalls).toEqual([
      ['cashier_admissions', 401],
      ['cashier_admissions', 401],
      ['cashier_admissions', 401],
    ]);
  });

  it('reports nothing and rethrows on a transport failure', async () => {
    const observe = vi.fn();
    const wrapped = withDeviceAuthObservation(
      () => Promise.reject(new TypeError('offline')),
      { observe },
      tag,
    );
    await expect(wrapped(ADMIT)).rejects.toThrow('offline');
    expect(observe).not.toHaveBeenCalled();
  });

  it('a throwing observer never breaks the call', async () => {
    const response = new Response(null, { status: 200 });
    const wrapped = withDeviceAuthObservation(
      () => Promise.resolve(response),
      {
        observe: () => {
          throw new Error('observer failed');
        },
      },
      tag,
    );
    await expect(wrapped(ADMIT)).resolves.toBe(response);
  });
});
