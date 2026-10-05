/**
 * RT-215 × RT-113 P1.2 — the device-401 detector and the offline grant seam,
 * on the REAL grant store + wiring (#545 harness).
 *
 *  - review F4 / OD5: the FIRST device 401 from ANY observed source (admit,
 *    `end`, roster, read-down) invalidates every grant (`onSuspect`);
 *  - final #545 review finding B: a 401 on `end` or on the roster reaches the
 *    seam (those clients use the observed fetch);
 *  - a 401 the admission path ALSO reports (notifyGrantSeam) invalidates twice
 *    but is audited ONCE (only standing grants are audited);
 *  - the confirmed revocation invalidates every grant and clears the grant
 *    scope (nothing admissible, nothing written, until a re-pair).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deviceRevocationGrantHooks } from '../../app/device-revocation-flow.js';
import {
  DEVICE_401_CONFIRM_MS,
  createDeviceAuthDetector,
  withDeviceAuthObservation,
  type DeviceAuthDetector,
} from '../../pairing/device-auth-detector.js';
import { createCashierAdmissionClient } from '../cashier-admission-client.js';
import {
  admitCashierOnline,
  endAdmissionTracked,
  type CashierAdmissionDeps,
} from '../cashier-admission.js';
import { createReadDownClient } from '../../catalogue/read-down/read-down-client.js';
import { T0, USER } from './__helpers__/offline-grant-fixture.js';
import {
  CATEGORY,
  USER_2,
  OPERATOR_2,
  admit,
  admitBoth,
  audits,
  installWiringHarness,
  refusal,
  wiring,
} from './__helpers__/offline-grant-wiring-harness.js';

installWiringHarness();

const BASE = 'https://backend-core.test';
const ADMISSION_ID = '0192f6a0-aaaa-7bbb-8ccc-000000000001';

interface Rig {
  detector: DeviceAuthDetector;
  admission: CashierAdmissionDeps;
  readDown: ReturnType<typeof createReadDownClient>;
  probeAnswer: { status: 200 | 401 };
}

/** Backend-Core answering every device-bearer call `status`. */
function backend(status: () => number) {
  return vi.fn(() => Promise.resolve(new Response('{}', { status: status() })));
}

function rig(): Rig {
  const probeAnswer = { status: 200 as 200 | 401 };
  const hooks = deviceRevocationGrantHooks(wiring);
  const detector = createDeviceAuthDetector({
    probe: () => Promise.resolve(probeAnswer.status === 401 ? 'unauthorized' : 'ok'),
    confirmDelayMs: () => DEVICE_401_CONFIRM_MS,
    onConfirmed: () => {
      hooks.onConfirmed();
    },
    onSuspect: () => {
      hooks.onSuspect();
    },
  });
  const fetch401 = backend(() => 401);
  const admission: CashierAdmissionDeps = {
    client: createCashierAdmissionClient({
      baseUrl: BASE,
      fetch: withDeviceAuthObservation(fetch401, detector, {
        source: 'cashier_admissions',
        baseUrl: BASE,
      }),
      getDeviceToken: () => Promise.resolve('device-token'),
    }),
    grantSeam: wiring.seam,
  };
  const readDown = createReadDownClient({
    baseUrl: BASE,
    fetch: withDeviceAuthObservation(fetch401, detector, { source: 'read_down', baseUrl: BASE }),
    getDeviceToken: () => Promise.resolve('device-token'),
  });
  return { detector, admission, readDown, probeAnswer };
}

const invalidationAudits = (): number =>
  audits.filter((a) => a.action_category === CATEGORY).length;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('review finding B — a device 401 on `end` or the roster reaches the seam', () => {
  it('`end` answered device_unauthorized → no grant is admissible', async () => {
    const r = rig();
    admitBoth();
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
    const ended = await endAdmissionTracked(r.admission, ADMISSION_ID, 'gen-1', USER);
    expect(ended.kind).toBe('device_unauthorized');
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
  });

  it('the roster answered device_unauthorized → no grant is admissible', async () => {
    const r = rig();
    admit();
    await expect(r.admission.client.listRoster()).resolves.toEqual({
      kind: 'device_unauthorized',
    });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
  });

  it('a read-down 401 → no grant is admissible', async () => {
    const r = rig();
    admit();
    await r.readDown.fetchSnapshot();
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
  });
});

describe('no duplicate audit when the admission path also reports the 401', () => {
  it('an admit 401 invalidates via onSuspect AND notifyGrantSeam, but each grant is audited once', async () => {
    const r = rig();
    admitBoth();
    await admitCashierOnline(r.admission, {
      user_id: USER,
      operator_id: 'user_clerk_SENTINEL_9e3b',
      takeover: false,
      idempotency_key: 'test-idempotency-key-0001',
    });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(invalidationAudits()).toBe(2); // one per grant (two users), not four
  });
});

describe('the confirmed revocation', () => {
  it('invalidates every grant and clears the scope: nothing admissible, nothing written after', async () => {
    const r = rig();
    admit();
    r.probeAnswer.status = 401;
    await r.admission.client.listRoster(); // first 401 (onSuspect)
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS); // confirmation 401
    expect(r.detector.state).toBe('confirmed');
    expect(wiring.evaluate(USER, T0).admissible).toBe(false);
    admit({ user_id: USER_2, operator_id: OPERATOR_2 }); // a late admitted: no scope
    expect(wiring.evaluate(USER_2, T0).admissible).toBe(false);
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('scope_mismatch'));
  });
});
