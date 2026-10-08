import { describe, expect, it } from 'vitest';

import { createRevocationRecheck, type RevocationRecheckDeps } from '../revocation-recheck.js';
import type { DeviceAuthOutcome } from '../../pairing/device-auth-detector.js';
import type { RevokedTerminalScope } from '../../pairing/store.js';

/**
 * RT-215 10897-A (owner approval 10906) — the user-initiated "Check again" on
 * `/pairing` while the terminal is `invalid / device_revoked`: ONE roster
 * probe with the sealed token. 2xx clears; 401 and anything else stay revoked.
 */

const SCOPE: RevokedTerminalScope = {
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'term-1',
};

interface Harness {
  deps: RevocationRecheckDeps;
  calls: string[];
  revoked: { value: boolean };
  epoch: { value: number | null };
  probes: { count: number };
  /** Settle the pending probe(s) with `outcome`. */
  answer(outcome: DeviceAuthOutcome | Error): void;
  logs: unknown[][];
}

function harness(over: Partial<RevocationRecheckDeps> = {}): Harness {
  const calls: string[] = [];
  const logs: unknown[][] = [];
  const revoked = { value: true };
  const epoch: { value: number | null } = { value: 1_760_000_000 };
  const probes = { count: 0 };
  const pending: ((o: DeviceAuthOutcome | Error) => void)[] = [];
  const deps: RevocationRecheckDeps = {
    probe: () => {
      probes.count += 1;
      calls.push('probe');
      return new Promise<DeviceAuthOutcome>((resolve, reject) => {
        pending.push((o) => {
          if (o instanceof Error) reject(o);
          else resolve(o);
        });
      });
    },
    store: {
      isDeviceRevoked: () => revoked.value,
      getStoredPairingEpoch: () => epoch.value,
      clearDeviceRevoked: () => {
        calls.push('clear');
        if (!revoked.value) return null;
        revoked.value = false;
        return SCOPE;
      },
    },
    onCleared: (scope) => {
      calls.push(`cleared:${scope.terminal_id}`);
    },
    rebindPaired: () => {
      calls.push('rebind');
      return Promise.resolve();
    },
    logger: {
      info: (...a: unknown[]) => logs.push(['info', ...a]),
      warn: (...a: unknown[]) => logs.push(['warn', ...a]),
      error: (...a: unknown[]) => logs.push(['error', ...a]),
    },
    ...over,
  };
  return {
    deps,
    calls,
    revoked,
    epoch,
    probes,
    logs,
    answer(outcome) {
      for (const settle of pending.splice(0)) settle(outcome);
    },
  };
}

describe('RT-215 10897-A — revocation recheck', () => {
  it('2xx: clears the revocation once, then the flow (detector, audit, push), then re-binds', async () => {
    const h = harness();
    const recheck = createRevocationRecheck(h.deps);
    const pending = recheck();
    h.answer('ok');
    await expect(pending).resolves.toEqual({ outcome: 'cleared' });
    expect(h.calls).toEqual(['probe', 'clear', 'cleared:term-1', 'rebind']);
    expect(h.revoked.value).toBe(false);
  });

  it('401: stays revoked, nothing is cleared or re-run', async () => {
    const h = harness();
    const pending = createRevocationRecheck(h.deps)();
    h.answer('unauthorized');
    await expect(pending).resolves.toEqual({ outcome: 'still_revoked' });
    expect(h.calls).toEqual(['probe']);
    expect(h.revoked.value).toBe(true);
  });

  it.each<[string, DeviceAuthOutcome | Error]>([
    ['no answer / network error / no token', 'other'],
    ['a throwing probe', new Error('boom')],
  ])('%s: stays revoked, "couldn’t reach the server"', async (_label, outcome) => {
    const h = harness();
    const pending = createRevocationRecheck(h.deps)();
    h.answer(outcome);
    await expect(pending).resolves.toEqual({ outcome: 'unreachable' });
    expect(h.calls).toEqual(['probe']);
    expect(h.revoked.value).toBe(true);
  });

  it('single-flight: concurrent presses share ONE probe and one result', async () => {
    const h = harness();
    const recheck = createRevocationRecheck(h.deps);
    const a = recheck();
    const b = recheck();
    h.answer('ok');
    await expect(Promise.all([a, b])).resolves.toEqual([
      { outcome: 'cleared' },
      { outcome: 'cleared' },
    ]);
    expect(h.probes.count).toBe(1);
    expect(h.calls.filter((c) => c === 'clear')).toHaveLength(1);
  });

  it('a later press (after the first settled) probes again', async () => {
    const h = harness();
    const recheck = createRevocationRecheck(h.deps);
    const first = recheck();
    h.answer('unauthorized');
    await first;
    const second = recheck();
    h.answer('unauthorized');
    await second;
    expect(h.probes.count).toBe(2);
  });

  it('not revoked when pressed: no probe (the token is never read for it)', async () => {
    const h = harness();
    h.revoked.value = false;
    await expect(createRevocationRecheck(h.deps)()).resolves.toEqual({ outcome: 'unreachable' });
    expect(h.probes.count).toBe(0);
  });

  it.each<[string, (h: Harness) => void]>([
    [
      'the revocation ended (a re-pair)',
      (h) => {
        h.revoked.value = false;
      },
    ],
    [
      'the pairing changed (a re-pair, then a new revocation)',
      (h) => {
        h.epoch.value = 1_760_000_001;
      },
    ],
  ])('a 2xx that lands after %s clears nothing', async (_label, change) => {
    const h = harness();
    const pending = createRevocationRecheck(h.deps)();
    change(h);
    h.answer('ok');
    await expect(pending).resolves.toEqual({ outcome: 'unreachable' });
    expect(h.calls).toEqual(['probe']);
  });

  it('a failing durable clear stays revoked (fail closed), runs nothing else, and is logged by step', async () => {
    const h = harness();
    const store: RevocationRecheckDeps['store'] = {
      ...h.deps.store,
      clearDeviceRevoked: () => {
        throw new Error('disk /path/secret');
      },
    };
    const pending = createRevocationRecheck({ ...h.deps, store })();
    h.answer('ok');
    await expect(pending).resolves.toEqual({ outcome: 'unreachable' });
    expect(h.calls).toEqual(['probe']);
    expect(JSON.stringify(h.logs)).not.toContain('/path/secret');
  });

  it('a failing flow step or re-bind does not undo the clear (the server accepted the device)', async () => {
    const h = harness({
      onCleared: () => {
        throw new Error('flow');
      },
      rebindPaired: () => Promise.reject(new Error('rebind')),
    });
    const pending = createRevocationRecheck(h.deps)();
    h.answer('ok');
    await expect(pending).resolves.toEqual({ outcome: 'cleared' });
    expect(h.revoked.value).toBe(false);
  });

  it('logs the outcome only — never a token, a URL or a body', async () => {
    const h = harness();
    const pending = createRevocationRecheck(h.deps)();
    h.answer('unauthorized');
    await pending;
    expect(h.logs).toContainEqual([
      'warn',
      { event: 'pairing.device_revoked.recheck', outcome: 'still_revoked' },
      expect.any(String),
    ]);
  });
});
