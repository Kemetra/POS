import { describe, expect, it, vi } from 'vitest';

import {
  createDeviceRevocationFlow,
  createRosterConfirmationProbe,
  withDeviceRevocationRecovery,
  type DeviceRevocationFlowDeps,
} from '../device-revocation-flow.js';
import type { CashierRosterResult } from '../../operator/cashier-admission-client.js';
import { SYSTEM_DEVICE_ACTOR_ID, type AuditEvent } from '../../../shared/audit/event-shape.js';
import type {
  PairingStatus,
  PairingStatusChangedEvent,
  PairingSubmitResult,
} from '../../../shared/pairing-types.js';
import type { RevokedTerminalScope } from '../../pairing/store.js';

/**
 * RT-215 — what happens once the device-401 detector CONFIRMS a revocation,
 * and when the terminal is paired again.
 */

const SCOPE: RevokedTerminalScope = {
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'term-old',
};
const NOW = new Date('2026-10-05T09:00:00.000Z');
const PAIRED_NEW: PairingStatus = {
  kind: 'paired',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'term-new',
  terminal_label: 'Till 1',
  paired_at: 1,
};

interface Harness {
  deps: DeviceRevocationFlowDeps;
  calls: string[];
  pushed: PairingStatusChangedEvent[];
  audits: AuditEvent[];
  session: { current: object | null };
  endSession(): void;
  logs: unknown[][];
}

function harness(over: Partial<DeviceRevocationFlowDeps> = {}): Harness {
  const calls: string[] = [];
  const pushed: PairingStatusChangedEvent[] = [];
  const audits: AuditEvent[] = [];
  const logs: unknown[][] = [];
  const session: { current: object | null } = { current: null };
  const ended: (() => void)[] = [];
  const status: { value: PairingStatus } = { value: PAIRED_NEW };
  const deps: DeviceRevocationFlowDeps = {
    markDeviceRevoked: () => {
      calls.push('mark');
      return SCOPE;
    },
    getStatus: () => Promise.resolve(status.value),
    sessions: {
      getCurrent: () => session.current as never,
      onEnded: (cb) => {
        ended.push(() => {
          cb(undefined as never, undefined);
        });
      },
    },
    latchSession: () => calls.push('latch'),
    clearCredentials: () => calls.push('credentials'),
    invalidateGrants: () => calls.push('grants'),
    resetDetector: () => calls.push('reset'),
    purgeOtherTerminalPins: (terminalId) => {
      calls.push(`purge:${terminalId}`);
      return 2;
    },
    pushStatus: (e) => pushed.push(e),
    audit: { emit: (e) => audits.push(e) },
    uuid: () => 'evt-1',
    now: () => NOW,
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
    pushed,
    audits,
    session,
    logs,
    endSession() {
      session.current = null;
      for (const cb of ended) cb();
    },
  };
}

describe('device revocation flow — on a confirmed revocation', () => {
  it('records the revocation FIRST (token never sent again), then clears the holders, invalidates grants and latches', () => {
    const h = harness();
    h.session.current = { id: 's1' };
    createDeviceRevocationFlow(h.deps).onConfirmed('cashier_admissions');
    expect(h.calls).toEqual(['mark', 'credentials', 'grants', 'latch']);
  });

  it('with a session open (a live tender), latches at once but routes only when the session ends at its safe point', () => {
    const h = harness();
    h.session.current = { id: 's1' };
    createDeviceRevocationFlow(h.deps).onConfirmed('cashier_admissions');
    expect(h.calls).toContain('latch');
    expect(h.pushed).toEqual([]); // not routed while the sale is live
    h.endSession(); // the keeper ended it at the safe point
    expect(h.pushed).toEqual([{ kind: 'invalid', reason: 'device_revoked' }]);
    h.endSession(); // a later session end does not route again
    expect(h.pushed).toHaveLength(1);
  });

  it('with no session, routes to pairing recovery immediately', () => {
    const h = harness();
    createDeviceRevocationFlow(h.deps).onConfirmed('read_down');
    expect(h.pushed).toEqual([{ kind: 'invalid', reason: 'device_revoked' }]);
  });

  it('routes once even if the latch ended the session synchronously', () => {
    const h = harness();
    h.session.current = { id: 's1' };
    const flow = createDeviceRevocationFlow({
      ...h.deps,
      latchSession: () => {
        h.endSession(); // already at a safe point
      },
    });
    flow.onConfirmed('cashier_admissions');
    expect(h.pushed).toEqual([{ kind: 'invalid', reason: 'device_revoked' }]);
  });

  it('a session end without a pending revocation routes nothing', () => {
    const h = harness();
    createDeviceRevocationFlow(h.deps);
    h.endSession();
    expect(h.pushed).toEqual([]);
  });

  it('audits pairing.device_revoked as system:device with payload {source} only', () => {
    const h = harness();
    createDeviceRevocationFlow(h.deps).onConfirmed('read_down');
    expect(h.audits).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        originating_terminal_id: 'term-old',
        acting_operator_id: SYSTEM_DEVICE_ACTOR_ID,
        session_id: null,
        shift_id: null,
        action_category: 'pairing.device_revoked',
        created_at: NOW.toISOString(),
        approving_supervisor_id: null,
        payload: { source: 'read_down' },
      },
    ]);
    expect(Object.keys(h.audits[0]?.payload ?? {})).toEqual(['source']);
  });

  it('every step is isolated: one failure is logged and the rest still run', () => {
    const boom = (): never => {
      throw new Error('step failed');
    };
    const h = harness({
      markDeviceRevoked: boom,
      clearCredentials: boom,
      invalidateGrants: boom,
      latchSession: boom,
    });
    createDeviceRevocationFlow(h.deps).onConfirmed('cashier_admissions');
    // No scope → no audit, but routing still happens (no session).
    expect(h.audits).toEqual([]);
    expect(h.pushed).toEqual([{ kind: 'invalid', reason: 'device_revoked' }]);
    const failed = h.logs
      .filter((l) => l[0] === 'error')
      .map((l) => (l[1] as { step: string }).step);
    expect(failed).toEqual(['mark', 'credentials', 'grants', 'latch']);
  });

  it('a throwing audit or push is logged, never thrown', () => {
    const boom = (): never => {
      throw new Error('nope');
    };
    const h = harness({ audit: { emit: boom }, pushStatus: boom });
    expect(() => {
      createDeviceRevocationFlow(h.deps).onConfirmed('cashier_admissions');
    }).not.toThrow();
    const failed = h.logs
      .filter((l) => l[0] === 'error')
      .map((l) => (l[1] as { step: string }).step);
    expect(failed).toEqual(['audit', 'push']);
  });

  it('logs carry the event and source only', () => {
    const h = harness();
    createDeviceRevocationFlow(h.deps).onConfirmed('cashier_admissions');
    expect(h.logs).toContainEqual([
      'warn',
      { event: 'pairing.device_revoked', source: 'cashier_admissions' },
      expect.any(String),
    ]);
  });
});

describe('device revocation flow — on a successful pairing', () => {
  it('after a revocation: resets the detector, deletes other terminals’ PINs, audits the clear and pushes paired', async () => {
    const h = harness();
    const flow = createDeviceRevocationFlow(h.deps);
    flow.onConfirmed('cashier_admissions');
    h.calls.length = 0;
    h.audits.length = 0;
    h.pushed.length = 0;
    await flow.onPaired({ previouslyRevoked: true });
    expect(h.calls).toEqual(['reset', 'purge:term-new']);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action_category: 'pairing.device_revoked_cleared',
      acting_operator_id: SYSTEM_DEVICE_ACTOR_ID,
      originating_terminal_id: 'term-new',
      payload: { source: 're_pair' },
    });
    expect(h.pushed).toEqual([{ kind: 'paired' }]);
  });

  it('Codex P1: a session still open at re-pair (pairing A) is latched so it cannot survive into pairing B', async () => {
    const h = harness();
    h.session.current = { id: 's-from-A' };
    await createDeviceRevocationFlow(h.deps).onPaired({ previouslyRevoked: true });
    expect(h.calls).toContain('latch');
  });

  it('with no session at re-pair, nothing is latched', async () => {
    const h = harness();
    await createDeviceRevocationFlow(h.deps).onPaired({ previouslyRevoked: true });
    expect(h.calls).not.toContain('latch');
  });

  it('a first pairing (not revoked) still deletes other terminals’ PINs but audits nothing', async () => {
    const h = harness();
    await createDeviceRevocationFlow(h.deps).onPaired({ previouslyRevoked: false });
    expect(h.calls).toEqual(['reset', 'purge:term-new']);
    expect(h.audits).toEqual([]);
  });

  it('a re-pair cancels a routing that was still pending (session still open)', async () => {
    const h = harness();
    h.session.current = { id: 's1' };
    const flow = createDeviceRevocationFlow(h.deps);
    flow.onConfirmed('cashier_admissions');
    await flow.onPaired({ previouslyRevoked: true });
    h.pushed.length = 0;
    h.endSession();
    expect(h.pushed).toEqual([]);
  });

  it('does nothing with the PINs when the status read is not paired, and never throws', async () => {
    const h = harness({
      getStatus: () => Promise.resolve({ kind: 'unpaired' }),
      purgeOtherTerminalPins: () => {
        throw new Error('unreachable');
      },
    });
    await expect(
      createDeviceRevocationFlow(h.deps).onPaired({ previouslyRevoked: true }),
    ).resolves.toBeUndefined();
    expect(h.audits).toEqual([]);
    const h2 = harness({ getStatus: () => Promise.reject(new Error('read failed')) });
    await expect(
      createDeviceRevocationFlow(h2.deps).onPaired({ previouslyRevoked: true }),
    ).resolves.toBeUndefined();
  });

  it('a failing PIN purge is logged, and the rest still runs', async () => {
    const h = harness({
      purgeOtherTerminalPins: () => {
        throw new Error('db');
      },
    });
    await createDeviceRevocationFlow(h.deps).onPaired({ previouslyRevoked: true });
    expect(h.audits).toHaveLength(1);
    expect(h.pushed).toEqual([{ kind: 'paired' }]);
    expect(h.logs.some((l) => l[0] === 'error' && (l[1] as { step: string }).step === 'pins')).toBe(
      true,
    );
  });
});

describe('withDeviceRevocationRecovery (the pairing service wrapper)', () => {
  const ok: PairingSubmitResult = {
    outcome: 'success',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'term-new',
    terminal_label: 'Till 1',
  };

  it('tells the flow whether the terminal was revoked BEFORE the pairing, then returns the result', async () => {
    const onPaired = vi.fn(() => Promise.resolve());
    const statuses: PairingStatus[] = [{ kind: 'invalid', reason: 'device_revoked' }];
    const wrapped = withDeviceRevocationRecovery(
      { submit: () => Promise.resolve(ok) },
      { getStatus: () => Promise.resolve(statuses[0] as PairingStatus), onPaired },
    );
    await expect(wrapped.submit('CODE-1')).resolves.toBe(ok);
    expect(onPaired).toHaveBeenCalledWith({ previouslyRevoked: true });

    statuses[0] = { kind: 'unpaired' };
    await wrapped.submit('CODE-2');
    expect(onPaired).toHaveBeenLastCalledWith({ previouslyRevoked: false });
  });

  it('does not call the flow on a failed pairing', async () => {
    const onPaired = vi.fn(() => Promise.resolve());
    const failed: PairingSubmitResult = { outcome: 'invalid_code' };
    const wrapped = withDeviceRevocationRecovery(
      { submit: () => Promise.resolve(failed) },
      { getStatus: () => Promise.resolve({ kind: 'unpaired' }), onPaired },
    );
    await expect(wrapped.submit('BAD')).resolves.toBe(failed);
    expect(onPaired).not.toHaveBeenCalled();
  });

  it('a failing status read or flow never changes the pairing result', async () => {
    const wrapped = withDeviceRevocationRecovery(
      { submit: () => Promise.resolve(ok) },
      {
        getStatus: () => Promise.reject(new Error('read')),
        onPaired: () => Promise.reject(new Error('flow')),
      },
    );
    await expect(wrapped.submit('CODE')).resolves.toBe(ok);
  });

  it('passes an inner rejection (programmer error) through', async () => {
    const wrapped = withDeviceRevocationRecovery(
      { submit: () => Promise.reject(new TypeError('bad arg')) },
      { getStatus: () => Promise.resolve({ kind: 'unpaired' }), onPaired: vi.fn() },
    );
    await expect(wrapped.submit('x')).rejects.toThrow('bad arg');
  });
});

describe('createRosterConfirmationProbe (the confirmation call)', () => {
  it.each<[CashierRosterResult, string]>([
    [{ kind: 'roster', cashiers: [] }, 'ok'],
    [{ kind: 'device_unauthorized' }, 'unauthorized'],
    [{ kind: 'no_token' }, 'other'],
    [{ kind: 'rejected' }, 'other'],
    [{ kind: 'unavailable' }, 'other'],
    [{ kind: 'no_connection' }, 'other'],
  ])('maps the roster answer %j to %s', async (result, outcome) => {
    const probe = createRosterConfirmationProbe({ listRoster: () => Promise.resolve(result) });
    await expect(probe()).resolves.toBe(outcome);
  });

  it('a throwing roster call is a non-answer', async () => {
    const probe = createRosterConfirmationProbe({
      listRoster: () => Promise.reject(new Error('boom')),
    });
    await expect(probe()).resolves.toBe('other');
  });
});
