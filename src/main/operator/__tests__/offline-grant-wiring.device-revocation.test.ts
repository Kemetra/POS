/**
 * RT-215 × RT-113 P1.2 — the device-401 detector and the offline grant seam,
 * on the REAL grant store + wiring (#545 harness).
 *
 *  - review F4 / OD5 + rev546b F-A: EVERY device 401 from ANY observed source
 *    (admit, `end`, roster, read-down) invalidates every grant
 *    (`onUnauthorized`), not only the first of a count;
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
import { bindPairingStoreDb, createPairingStore } from '../../pairing/store.js';
import { withOfflineGrantPairing } from '../offline-grant-wiring.js';
import {
  CATEGORY,
  USER_2,
  OPERATOR_2,
  admit,
  admitBoth,
  audits,
  TOKEN_KEY,
  g,
  installWiringHarness,
  memorySecretStore,
  pairInput,
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
    onUnauthorized: () => {
      hooks.onUnauthorized();
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
  it('an admit 401 invalidates via onUnauthorized AND notifyGrantSeam, but each grant is audited once', async () => {
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
    await r.admission.client.listRoster(); // first 401 (onUnauthorized)
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS); // confirmation 401
    expect(r.detector.state).toBe('confirmed');
    expect(wiring.evaluate(USER, T0).admissible).toBe(false);
    admit({ user_id: USER_2, operator_id: OPERATOR_2 }); // a late admitted: no scope
    expect(wiring.evaluate(USER_2, T0).admissible).toBe(false);
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('scope_mismatch'));
  });
});

// ── rev546b F-A: EVERY device 401 reaches the seam, not only the first ──────

describe('rev546b F-A — a second device 401 in the same count still invalidates', () => {
  const ADMITTED_BODY = {
    kind: 'admitted',
    admission_id: ADMISSION_ID,
    offline_grace_seconds: 86_400,
    admission_ttl_seconds: 600,
    server_time: '2026-10-05T09:00:00.000Z',
    display_name: 'Mona',
    admission_generation: 'gen-signin-0001',
  };

  /** Admit answers 200 admitted only when released; every other device route answers 401. */
  function probeRig() {
    let release: () => void = () => undefined;
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      if (path === '/api/pos/v1/cashier-admissions') {
        return new Promise<Response>((resolve) => {
          release = () => {
            resolve(new Response(JSON.stringify(ADMITTED_BODY), { status: 200 }));
          };
        });
      }
      return Promise.resolve(new Response('{}', { status: 401 }));
    });
    const hooks = deviceRevocationGrantHooks(wiring);
    const detector = createDeviceAuthDetector({
      probe: () => Promise.resolve('other'), // the confirmation never answers here
      confirmDelayMs: () => DEVICE_401_CONFIRM_MS,
      onConfirmed: () => {
        hooks.onConfirmed();
      },
      onUnauthorized: () => {
        hooks.onUnauthorized();
      },
    });
    const token = () => Promise.resolve('device-token');
    const admission: CashierAdmissionDeps = {
      client: createCashierAdmissionClient({
        baseUrl: BASE,
        fetch: withDeviceAuthObservation(fetchImpl, detector, {
          source: 'cashier_admissions',
          baseUrl: BASE,
        }),
        getDeviceToken: token,
      }),
      grantSeam: wiring.seam,
      now: () => T0, // the harness clock (the grant's local receipt time)
    };
    const readDown = createReadDownClient({
      baseUrl: BASE,
      fetch: withDeviceAuthObservation(fetchImpl, detector, { source: 'read_down', baseUrl: BASE }),
      getDeviceToken: token,
    });
    return {
      detector,
      admission,
      readDown,
      fetchImpl,
      release: () => {
        release();
      },
    };
  }

  async function startAdmission(r: ReturnType<typeof probeRig>) {
    const pending = admitCashierOnline(r.admission, {
      user_id: USER,
      operator_id: 'user_clerk_SENTINEL_9e3b',
      takeover: false,
      idempotency_key: 'test-idempotency-key-0001',
    });
    // The send mark is captured and the request is on the wire.
    await vi.advanceTimersByTimeAsync(0);
    expect(r.fetchImpl).toHaveBeenCalledTimes(2);
    // Wrapped: an async function returning the promise would await it.
    return { pending };
  }

  it.each(['roster', 'read_down', 'end'] as const)(
    'first 401 (read-down) → admission minted → second 401 (%s) → 200 admitted: the grant is NOT admissible',
    async (second) => {
      const r = probeRig();
      await r.readDown.fetchSnapshot(); // first 401: suspect
      expect(r.detector.state).toBe('suspect');
      const { pending } = await startAdmission(r);
      if (second === 'roster') await r.admission.client.listRoster();
      if (second === 'read_down') await r.readDown.fetchSnapshot();
      if (second === 'end') await endAdmissionTracked(r.admission, ADMISSION_ID, 'gen-1', USER);
      expect(r.detector.state).toBe('suspect'); // the same count
      r.release();
      await pending;
      expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_missing'));
    },
  );

  it('control: with no second 401, the admitted after the first 401 writes an admissible grant', async () => {
    const r = probeRig();
    await r.readDown.fetchSnapshot();
    const { pending } = await startAdmission(r);
    r.release();
    await pending;
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
  });
});

// ── rev546b S-2: the prior epoch survives a revocation ──────────────────────

describe('rev546b S-2 — a re-pair after a revocation keeps the prior+1 epoch floor', () => {
  it('revoke, delete the clock mark, re-pair in the same second: the new epoch is above the prior one', async () => {
    const inner = createPairingStore({
      secretStore: memorySecretStore(),
      db: bindPairingStoreDb(g.handle),
      deviceTokenKey: TOKEN_KEY,
    });
    const pairing = withOfflineGrantPairing(inner, wiring);
    await pairing.persist(pairInput());
    const before = await pairing.getStatus();
    if (before.kind !== 'paired') throw new Error('not paired');
    pairing.markDeviceRevoked();
    deviceRevocationGrantHooks(wiring).onConfirmed(); // as the confirmation does: scope → null
    g.raw.run('DELETE FROM cashier_offline_clock_hwm'); // the mark cannot keep the floor
    await pairing.persist(pairInput()); // the same paired_at second
    const after = await pairing.getStatus();
    if (after.kind !== 'paired') throw new Error('not paired');
    expect(after.paired_at).toBeGreaterThan(before.paired_at);
  });

  it('getStoredPairingEpoch reports the stored epoch even while revoked; getPairingEpoch stays null', async () => {
    const inner = createPairingStore({
      secretStore: memorySecretStore(),
      db: bindPairingStoreDb(g.handle),
      deviceTokenKey: TOKEN_KEY,
    });
    expect(inner.getStoredPairingEpoch()).toBeNull();
    await inner.persist(pairInput());
    inner.markDeviceRevoked();
    expect(inner.getStoredPairingEpoch()).toBe(pairInput().paired_at);
    expect(inner.getPairingEpoch()).toBeNull();
  });
});
