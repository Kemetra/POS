import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEVICE_401_CONFIRM_MS,
  createDeviceAuthDetector,
  deviceAuthConfirmDelayMs,
  deviceBearerSource,
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
    h.detector.observeResponse(ADMIT, 401);
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
    h.detector.observeResponse(ADMIT, 401);
    await advance(DEVICE_401_CONFIRM_MS * 10);
    expect(h.confirmed).toEqual([]);
    expect(h.detector.state).toBe('suspect');
  });

  it('two consecutive 401s revoke: the confirmation call (roster) also answers 401', async () => {
    const h = harness();
    h.detector.observeResponse(ADMIT, 401);
    await advance(DEVICE_401_CONFIRM_MS - 1);
    expect(h.confirmed).toEqual([]);
    await advance(1);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.confirmed).toEqual(['cashier_admissions']);
    expect(h.detector.state).toBe('confirmed');
  });

  it('a 2xx in between resets the count: the pending confirmation is cancelled', async () => {
    const h = harness();
    h.detector.observeResponse(ADMIT, 401);
    h.detector.observeResponse(ROSTER, 200);
    expect(h.detector.state).toBe('clear');
    await advance(DEVICE_401_CONFIRM_MS * 2);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.confirmed).toEqual([]);
  });

  it('after a reset, the next 401 is a FIRST 401 again and needs its own confirmation', async () => {
    const h = harness();
    h.detector.observeResponse(ADMIT, 401);
    h.detector.observeResponse(ADMIT, 200);
    h.detector.observeResponse(END, 401);
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
    h.detector.observeResponse(ADMIT, 401);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.probe).toHaveBeenCalledTimes(1);
    h.detector.observeResponse(SNAPSHOT, 200); // 2xx in between
    release('unauthorized');
    await advance(0);
    expect(h.confirmed).toEqual([]);
    expect(h.detector.state).toBe('suspect');
  });

  it('other device-bearer 401s while a confirmation is pending do not confirm early', async () => {
    const h = harness();
    // sign-in, takeover and a heartbeat all 401 within the window
    h.detector.observeResponse(ADMIT, 401);
    h.detector.observeResponse(ADMIT, 401);
    h.detector.observeResponse(ADMIT, 401);
    h.detector.observeResponse(SNAPSHOT, 401);
    expect(h.confirmed).toEqual([]);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.confirmed).toEqual(['cashier_admissions']); // the source of the FIRST 401
  });

  it('a non-answer from the confirmation call keeps the count and retries the confirmation', async () => {
    const h = harness();
    h.setProbe('other');
    h.detector.observeResponse(ADMIT, 401);
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
    h.detector.observeResponse(ADMIT, 401);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual([]);
    expect(h.detector.state).toBe('suspect');
  });

  it('non-2xx, non-401 answers (403, 5xx) neither count nor reset', async () => {
    const h = harness();
    h.detector.observeResponse(ADMIT, 403);
    h.detector.observeResponse(ADMIT, 503);
    expect(h.detector.state).toBe('clear');
    h.detector.observeResponse(ADMIT, 401);
    h.detector.observeResponse(ADMIT, 403);
    h.detector.observeResponse(ADMIT, 500);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual(['cashier_admissions']);
  });

  it('confirms once; later observations are ignored until reset()', async () => {
    const h = harness();
    h.detector.observeResponse(SNAPSHOT, 401);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual(['read_down']);
    h.detector.observeResponse(ADMIT, 401);
    h.detector.observeResponse(ADMIT, 200);
    await advance(DEVICE_401_CONFIRM_MS * 2);
    expect(h.confirmed).toEqual(['read_down']);
    expect(h.detector.state).toBe('confirmed');
    h.detector.reset(); // a re-pair
    expect(h.detector.state).toBe('clear');
    h.detector.observeResponse(ADMIT, 401);
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
    detector.observeResponse(ADMIT, 401);
    await advance(10);
    expect(detector.state).toBe('confirmed');
  });

  it('stop() cancels a pending confirmation and ignores everything after', async () => {
    const h = harness();
    h.detector.observeResponse(ADMIT, 401);
    h.detector.stop();
    await advance(DEVICE_401_CONFIRM_MS * 2);
    expect(h.probe).not.toHaveBeenCalled();
    h.detector.observeResponse(ADMIT, 401);
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
    h.detector.observeResponse(ADMIT, 401);
    await advance(DEVICE_401_CONFIRM_MS);
    h.detector.stop();
    release('unauthorized');
    await advance(0);
    expect(h.confirmed).toEqual([]);
  });

  it('waits the delay supplied at the time of the first 401 (min(30 s, TTL/2))', async () => {
    const h = harness();
    h.delay.ms = 5_000;
    h.detector.observeResponse(ADMIT, 401);
    await advance(4_999);
    expect(h.probe).not.toHaveBeenCalled();
    await advance(1);
    expect(h.probe).toHaveBeenCalledTimes(1);
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
    detector.observeResponse(ADMIT, 401);
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

describe('device-401 detector — which 401s count (decision 2)', () => {
  it.each([
    [`${BASE}/api/pos/v1/sales`, 'sale sync (operator envelope)'],
    [`${BASE}/api/pos/v1/sales/0192f6a0-1b2c-7d3e-8f40-123456789abc/returns`, 'returns'],
    [`${BASE}/api/pos/v1/vouchers/validate`, 'vouchers'],
    [`${BASE}/api/pos/v1/operators/sign-in`, 'operator sign-in'],
    [`${BASE}/api/pos/v1/cashier-admissions-v2`, 'a look-alike path'],
    ['not a url', 'garbage'],
  ])('ignores a 401 from %s (%s)', async (url) => {
    const h = harness();
    h.detector.observeResponse(url, 401);
    h.detector.observeResponse(url, 401);
    h.detector.observeResponse(url, 401);
    await advance(DEVICE_401_CONFIRM_MS * 3);
    expect(h.detector.state).toBe('clear');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.confirmed).toEqual([]);
  });

  it('an operator-route 2xx does not reset a device-bearer count', async () => {
    const h = harness();
    h.detector.observeResponse(ADMIT, 401);
    h.detector.observeResponse(`${BASE}/api/pos/v1/sales`, 201);
    await advance(DEVICE_401_CONFIRM_MS);
    expect(h.confirmed).toEqual(['cashier_admissions']);
  });

  it.each<[string, DeviceRevokedSource | null]>([
    [ADMIT, 'cashier_admissions'],
    [ROSTER, 'cashier_admissions'],
    [END, 'cashier_admissions'],
    [SNAPSHOT, 'read_down'],
    [`${BASE}/api/pos/v1/catalog/snapshot`, 'read_down'],
    ['/api/pos/v1/cashier-admissions', 'cashier_admissions'],
    [`${BASE}/api/pos/v1/sales`, null],
    [`${BASE}/api/pos/v1/catalog/deltas`, null],
  ])('deviceBearerSource(%s) = %s', (url, source) => {
    expect(deviceBearerSource(url)).toBe(source);
  });
});

describe('deviceAuthConfirmDelayMs', () => {
  it.each<[number | undefined, number]>([
    [undefined, 30_000],
    [43_200, 30_000],
    [60, 30_000],
    [10, 5_000],
    [1, 500],
    [0, 30_000],
    [Number.NaN, 30_000],
  ])('ttl %s s → %s ms', (ttl, ms) => {
    expect(deviceAuthConfirmDelayMs(ttl)).toBe(ms);
  });
});

describe('withDeviceAuthObservation (the fetch the device-bearer clients use)', () => {
  it('reports each answer to the detector and returns the response untouched', async () => {
    const observed: [string, number][] = [];
    const response = new Response(null, { status: 401 });
    const fetchImpl = vi.fn(() => Promise.resolve(response));
    const wrapped = withDeviceAuthObservation(fetchImpl, {
      observeResponse: (url, status) => observed.push([url, status]),
    });
    const init = { method: 'GET' };
    await expect(wrapped(ROSTER, init)).resolves.toBe(response);
    await wrapped(new URL(SNAPSHOT));
    await wrapped(new Request(ADMIT, { method: 'POST' }));
    expect(fetchImpl).toHaveBeenNthCalledWith(1, ROSTER, init);
    expect(observed).toEqual([
      [ROSTER, 401],
      [SNAPSHOT, 401],
      [ADMIT, 401],
    ]);
  });

  it('reports nothing and rethrows on a transport failure', async () => {
    const observeResponse = vi.fn();
    const wrapped = withDeviceAuthObservation(() => Promise.reject(new TypeError('offline')), {
      observeResponse,
    });
    await expect(wrapped(ADMIT)).rejects.toThrow('offline');
    expect(observeResponse).not.toHaveBeenCalled();
  });

  it('a throwing observer never breaks the call', async () => {
    const response = new Response(null, { status: 200 });
    const wrapped = withDeviceAuthObservation(() => Promise.resolve(response), {
      observeResponse: () => {
        throw new Error('observer failed');
      },
    });
    await expect(wrapped(ADMIT)).resolves.toBe(response);
  });
});
