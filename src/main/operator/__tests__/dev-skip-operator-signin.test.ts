import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  applyDevSkipOperatorSignInIfRequested,
  DEV_OPERATOR_FIXTURE_SESSION_INPUT,
  type DevSkipOperatorSignInDeps,
} from '../dev-skip-operator-signin.js';
import { SessionManager } from '../session-manager.js';
import { isShippedApp } from '../../app/shipped-app.js';

function makeDeps(
  overrides: Partial<DevSkipOperatorSignInDeps> & { envFlag?: string } = {},
): DevSkipOperatorSignInDeps {
  const { envFlag, ...rest } = overrides;
  return {
    isShippedApp: false,
    env: envFlag !== undefined ? { POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN: envFlag } : {},
    sessionManager: {
      create: vi
        .fn()
        .mockReturnValue({ id: 'fixture-session-id', ...DEV_OPERATOR_FIXTURE_SESSION_INPUT }),
      getCurrent: vi.fn().mockReturnValue(null),
    },
    logger: { warn: vi.fn() },
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    ...rest,
  };
}

describe('applyDevSkipOperatorSignInIfRequested', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 1: unpackaged + flag truthy creates manager fixture session and returns true
  it('creates fixture manager session when isShippedApp=false and flag is truthy', () => {
    const deps = makeDeps({ envFlag: '1' });

    const result = applyDevSkipOperatorSignInIfRequested(deps);

    expect(result).toBe(true);
    expect(deps.sessionManager.create).toHaveBeenCalledOnce();
    expect(deps.sessionManager.create).toHaveBeenCalledWith({
      ...DEV_OPERATOR_FIXTURE_SESSION_INPUT,
      started_at: '2026-01-01T00:00:00.000Z',
    });
  });

  // Test 2: packaged + flag truthy does not run
  it('does NOT run when isShippedApp=true even if flag is truthy', () => {
    const deps = makeDeps({ isShippedApp: true, envFlag: '1' });

    const result = applyDevSkipOperatorSignInIfRequested(deps);

    expect(result).toBe(false);
    expect(deps.sessionManager.create).not.toHaveBeenCalled();
  });

  // RT-165 — a renamed copy of the shipped exe reports app.isPackaged=false
  // but still runs resources/app.asar; no fixture MANAGER session for it.
  it('does NOT run for a renamed shipped exe (isPackaged=false, app.asar) with the flag set', () => {
    const shipped = isShippedApp({
      isPackaged: false,
      appPath: 'C:\\copy\\resources\\app.asar',
    });
    const deps = makeDeps({ isShippedApp: shipped, envFlag: '1' });

    const result = applyDevSkipOperatorSignInIfRequested(deps);

    expect(result).toBe(false);
    expect(deps.sessionManager.create).not.toHaveBeenCalled();
  });

  it('still runs for an unpackaged dev build (`electron .`) with the flag set', () => {
    const shipped = isShippedApp({ isPackaged: false, appPath: 'C:\\Users\\dev\\POS' });
    const deps = makeDeps({ isShippedApp: shipped, envFlag: '1' });

    expect(applyDevSkipOperatorSignInIfRequested(deps)).toBe(true);
  });

  // Test 3: unpackaged + flag absent does not run
  it('does NOT run when isShippedApp=false and flag is absent', () => {
    const deps = makeDeps(); // no envFlag

    const result = applyDevSkipOperatorSignInIfRequested(deps);

    expect(result).toBe(false);
    expect(deps.sessionManager.create).not.toHaveBeenCalled();
  });

  // Test 4: falsy values 0, false, no, off, empty string do not run
  it('rejects falsy flag values: 0, false, no, off, empty string', () => {
    for (const flag of ['0', 'false', 'no', 'off', '']) {
      const deps = makeDeps({ envFlag: flag });
      const result = applyDevSkipOperatorSignInIfRequested(deps);
      expect(result, `flag="${flag}" should be falsy`).toBe(false);
      expect(deps.sessionManager.create).not.toHaveBeenCalled();
    }
  });

  // Test 5: truthy values 1, true, yes, on run
  it('accepts all truthy flag values: true, yes, on', () => {
    for (const flag of ['1', 'true', 'yes', 'on']) {
      const deps = makeDeps({ envFlag: flag });
      const result = applyDevSkipOperatorSignInIfRequested(deps);
      expect(result, `flag="${flag}" should be truthy`).toBe(true);
      expect(deps.sessionManager.create).toHaveBeenCalledOnce();
      vi.clearAllMocks();
    }
  });

  // Test 6: existing session is not overwritten (getCurrent returns non-null)
  it('does NOT overwrite an existing session (getCurrent returns non-null)', () => {
    const existingSession = { id: 'existing-session' };
    const deps = makeDeps({ envFlag: '1' });
    // Override getCurrent to return an existing session
    (deps.sessionManager.getCurrent as ReturnType<typeof vi.fn>).mockReturnValue(existingSession);

    const result = applyDevSkipOperatorSignInIfRequested(deps);

    expect(result).toBe(false);
    expect(deps.sessionManager.create).not.toHaveBeenCalled();
  });

  // Test 7: logger.warn payload contains no JWT, password, device_token, backend_session_id,
  // pairing_code, token, credential, or secret
  it('logger.warn payload contains no sensitive values', () => {
    const deps = makeDeps({ envFlag: '1' });

    applyDevSkipOperatorSignInIfRequested(deps);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.logger.warn).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.logger.warn).toHaveBeenCalledWith(
      {
        event: 'operator.dev_bypass.active',
        packaged: false,
        flag: 'POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN',
        role: 'manager',
      },
      expect.any(String),
    );
    const callLog = JSON.stringify((deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls);
    // Assert none of these sensitive terms appear in the logged payload
    for (const forbidden of [
      'jwt',
      'password',
      'pin',
      'token',
      'device_token',
      'backend_session_id',
      'pairing_code',
      'credential',
      'secret',
    ]) {
      expect(callLog.toLowerCase(), `warn payload must not contain "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });

  // Test 8: when `clock` is omitted, the default `() => new Date()` factory runs
  it('uses the default clock factory when deps.clock is omitted', () => {
    const overrides = makeDeps({ envFlag: '1' });
    // Build deps without the `clock` field so the default arrow factory on
    // line 78 is exercised (otherwise it remains the only uncovered function
    // in this module and trips the 80% functions threshold).
    const { clock: _omitted, ...depsWithoutClock } = overrides;
    void _omitted;
    const before = Date.now();

    const result = applyDevSkipOperatorSignInIfRequested(depsWithoutClock);

    const after = Date.now();
    expect(result).toBe(true);
    expect(depsWithoutClock.sessionManager.create).toHaveBeenCalledOnce();
    const createCall = (depsWithoutClock.sessionManager.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { started_at: string };
    const stampedMs = new Date(createCall.started_at).getTime();
    // The default factory returns "now" — within the [before, after] window.
    expect(stampedMs).toBeGreaterThanOrEqual(before);
    expect(stampedMs).toBeLessThanOrEqual(after);
  });

  // Test 9: SessionManager.getCurrentBridgeView does not expose backend_session_id or token fields
  it('getCurrentBridgeView does not expose backend_session_id or token fields', () => {
    const realManager = new SessionManager();
    const deps: DevSkipOperatorSignInDeps = {
      isShippedApp: false,
      env: { POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN: '1' },
      sessionManager: realManager,
      logger: { warn: vi.fn() },
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
    };

    const result = applyDevSkipOperatorSignInIfRequested(deps);
    expect(result).toBe(true);

    const bridgeView = realManager.getCurrentBridgeView();
    expect(bridgeView).not.toBeNull();

    // The bridge view must not expose sensitive fields
    const viewStr = JSON.stringify(bridgeView);
    expect(viewStr).not.toContain('backend_session_id');
    expect(viewStr).not.toContain('dev-backend-session');
    expect(viewStr).not.toContain('last_activity_at');

    // Confirm the safe fields ARE present
    expect(bridgeView?.role).toBe('manager');
    expect(bridgeView?.display_name).toBe('Dev Manager');
    expect(bridgeView?.operator_id).toBe('dev-manager');
    expect(bridgeView?.tenant_id).toBe('dev-tenant');
    expect(bridgeView?.branch_id).toBe('dev-branch');
  });
});
