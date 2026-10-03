import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  applyDevSkipPairingIfRequested,
  DEV_BYPASS_FIXTURE_TOKEN,
  DEV_BYPASS_FIXTURE_ASSIGNMENT,
  type DevSkipPairingDeps,
} from '../dev-skip-pairing.js';

function makeDeps(
  overrides: Partial<DevSkipPairingDeps> & { envFlag?: string } = {},
): DevSkipPairingDeps {
  const { envFlag, ...rest } = overrides;
  return {
    isPackaged: false,
    env: envFlag !== undefined ? { POS_PULSE_DEV_SKIP_PAIRING: envFlag } : {},
    pairingStore: { persist: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn() },
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    ...rest,
  };
}

describe('applyDevSkipPairingIfRequested', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds fixture pairing state when isPackaged=false and flag is truthy', async () => {
    const deps = makeDeps({ envFlag: '1' });

    const result = await applyDevSkipPairingIfRequested(deps);

    expect(result).toBe(true);
    expect(deps.pairingStore.persist).toHaveBeenCalledOnce();
    expect(deps.pairingStore.persist).toHaveBeenCalledWith({
      device_token: DEV_BYPASS_FIXTURE_TOKEN,
      ...DEV_BYPASS_FIXTURE_ASSIGNMENT,
      paired_at: Math.floor(new Date('2026-01-01T00:00:00.000Z').getTime() / 1000),
    });
  });

  it('does NOT run when isPackaged=true even if flag is truthy', async () => {
    const deps = makeDeps({ isPackaged: true, envFlag: '1' });

    const result = await applyDevSkipPairingIfRequested(deps);

    expect(result).toBe(false);
    expect(deps.pairingStore.persist).not.toHaveBeenCalled();
  });

  it('does NOT run when isPackaged=false and flag is absent', async () => {
    const deps = makeDeps(); // no envFlag

    const result = await applyDevSkipPairingIfRequested(deps);

    expect(result).toBe(false);
    expect(deps.pairingStore.persist).not.toHaveBeenCalled();
  });

  it('accepts all truthy flag values: true, yes, on', async () => {
    for (const flag of ['true', 'yes', 'on']) {
      const deps = makeDeps({ envFlag: flag });
      const result = await applyDevSkipPairingIfRequested(deps);
      expect(result, `flag="${flag}" should be truthy`).toBe(true);
    }
  });

  it('rejects falsy flag values: 0, false, no, off, empty string', async () => {
    for (const flag of ['0', 'false', 'no', 'off', '']) {
      const deps = makeDeps({ envFlag: flag });
      const result = await applyDevSkipPairingIfRequested(deps);
      expect(result, `flag="${flag}" should be falsy`).toBe(false);
      expect(deps.pairingStore.persist).not.toHaveBeenCalled();
    }
  });

  it('uses real clock when clock dep is omitted', async () => {
    const before = Math.floor(Date.now() / 1000);
    const deps: DevSkipPairingDeps = {
      isPackaged: false,
      env: { POS_PULSE_DEV_SKIP_PAIRING: '1' },
      pairingStore: { persist: vi.fn().mockResolvedValue(undefined) },
      logger: { warn: vi.fn() },
      // clock intentionally omitted — exercises the () => new Date() default
    };

    const result = await applyDevSkipPairingIfRequested(deps);
    const after = Math.floor(Date.now() / 1000);

    expect(result).toBe(true);
    expect(deps.pairingStore.persist).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const persistArg = (deps.pairingStore.persist as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      paired_at: number;
    };
    expect(persistArg.paired_at).toBeGreaterThanOrEqual(before);
    expect(persistArg.paired_at).toBeLessThanOrEqual(after);
  });

  it('logger.warn payload contains no device_token value', async () => {
    const deps = makeDeps({ envFlag: '1' });

    await applyDevSkipPairingIfRequested(deps);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.logger.warn).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.logger.warn).toHaveBeenCalledWith(
      {
        event: 'pairing.dev_bypass.active',
        packaged: false,
        flag: 'POS_PULSE_DEV_SKIP_PAIRING',
      },
      expect.any(String),
    );
    // Belt-and-braces: confirm device_token never appears in the warn payload.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const warnSpy = vi.mocked(deps.logger.warn);
    const callLog = JSON.stringify(warnSpy.mock.calls);
    expect(callLog).not.toContain(DEV_BYPASS_FIXTURE_TOKEN);
    expect(callLog).not.toContain('device_token');
  });
});
