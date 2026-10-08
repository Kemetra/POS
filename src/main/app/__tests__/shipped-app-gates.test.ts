import { describe, it, expect, vi } from 'vitest';

import { isShippedApp } from '../shipped-app.js';
import { applyDevSkipPairingIfRequested } from '../../pairing/dev-skip-pairing.js';
import { createSecretStore } from '../../secrets/index.js';
import type { SafeStorageLike } from '../../secrets/safe-storage.js';
import type { DatabaseHandle } from '../../db/client.js';

/**
 * RT-165 — the shipped-app identity, end to end through the two gates whose
 * modules (`src/main/pairing/`, `src/main/secrets/`) are protected by the
 * source-scope guard. Those modules are unchanged: their `isPackaged` dep
 * now receives `isShippedApp(...)` from the composition root (pinned by
 * `src/main/__tests__/bootstrap-shipped-app.test.ts`). These cases prove that
 * value gives the intended behaviour for a renamed shipped exe and for an
 * unpackaged `electron .` build.
 */

const RENAMED_SHIPPED = isShippedApp({
  isPackaged: false,
  appPath: 'C:\\copy\\resources\\app.asar',
});
const UNPACKAGED_DEV = isShippedApp({ isPackaged: false, appPath: 'C:\\Users\\dev\\POS' });

function makeStubDb(): DatabaseHandle {
  return {
    pragma: vi.fn(),
    prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
    exec: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
}

const unavailableSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer): string => b.toString('utf8'),
};

describe('pairing dev bypass (POS_PULSE_DEV_SKIP_PAIRING)', () => {
  async function run(isPackaged: boolean): Promise<{ applied: boolean; persisted: number }> {
    const persist = vi.fn().mockResolvedValue(undefined);
    const applied = await applyDevSkipPairingIfRequested({
      isPackaged,
      env: { POS_PULSE_DEV_SKIP_PAIRING: '1' },
      pairingStore: { persist },
      logger: { warn: vi.fn() },
    });
    return { applied, persisted: persist.mock.calls.length };
  }

  it('does NOT seed fixture pairing for a renamed shipped exe', async () => {
    expect(await run(RENAMED_SHIPPED)).toEqual({ applied: false, persisted: 0 });
  });

  it('still seeds fixture pairing for an unpackaged dev build (`electron .`)', async () => {
    expect(await run(UNPACKAGED_DEV)).toEqual({ applied: true, persisted: 1 });
  });
});

describe('SecretStore production refusal', () => {
  it('refuses to start a renamed shipped exe when safeStorage is unavailable', () => {
    expect(() =>
      createSecretStore({
        handle: makeStubDb(),
        safeStorage: unavailableSafeStorage,
        isPackaged: RENAMED_SHIPPED,
        error: vi.fn(),
        warn: vi.fn(),
      }),
    ).toThrow(/production/i);
  });

  it('falls back to the in-memory backend only for an unpackaged dev build', () => {
    const store = createSecretStore({
      handle: makeStubDb(),
      safeStorage: unavailableSafeStorage,
      isPackaged: UNPACKAGED_DEV,
      warn: vi.fn(),
    });
    expect(store.isProductionBacked()).toBe(false);
  });
});
