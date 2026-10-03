import { describe, it, expect, vi } from 'vitest';

import { createSecretStore } from '../index.js';
import type { SafeStorageLike } from '../safe-storage.js';
import type { DatabaseHandle } from '../../db/client.js';

/**
 * T044 — backend-selection matrix tests.
 *
 * Four cells of (isEncryptionAvailable, isPackaged):
 *
 *   | available | packaged | expected                                |
 *   |:---------:|:--------:|:----------------------------------------|
 *   |   true    |   true   | safeStorage backend, isProductionBacked |
 *   |   true    |   false  | safeStorage backend                     |
 *   |   false   |   false  | in-memory backend, warning logged       |
 *   |   false   |   true   | factory throws fatal                    |
 */

function makeStubDb(): DatabaseHandle {
  return {
    pragma: vi.fn(),
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
    exec: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
}

function makeSafeStorage(available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer): string => b.toString('utf8'),
  };
}

describe('createSecretStore — backend selection', () => {
  it('available=true, packaged=true → safeStorage backend (production)', () => {
    const store = createSecretStore({
      handle: makeStubDb(),
      safeStorage: makeSafeStorage(true),
      isPackaged: true,
    });
    expect(store.isProductionBacked()).toBe(true);
  });

  it('available=true, packaged=false → safeStorage backend (dev with DPAPI)', () => {
    const store = createSecretStore({
      handle: makeStubDb(),
      safeStorage: makeSafeStorage(true),
      isPackaged: false,
    });
    expect(store.isProductionBacked()).toBe(true);
  });

  it('available=false, packaged=false → in-memory backend with warning', () => {
    const warn = vi.fn();
    const store = createSecretStore({
      handle: makeStubDb(),
      safeStorage: makeSafeStorage(false),
      isPackaged: false,
      warn,
    });
    expect(store.isProductionBacked()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/safeStorage|encryption/i);
  });

  it('available=false, packaged=true → throws fatal (production refusal)', () => {
    const error = vi.fn();
    expect(() =>
      createSecretStore({
        handle: makeStubDb(),
        safeStorage: makeSafeStorage(false),
        isPackaged: true,
        error,
      }),
    ).toThrow(/safeStorage|encryption|production/i);
    // The fatal log MUST fire before the throw so operators see why.
    expect(error).toHaveBeenCalled();
  });

  it('uses console.warn as the default sink when no `warn` override is supplied', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      createSecretStore({
        handle: makeStubDb(),
        safeStorage: makeSafeStorage(false),
        isPackaged: false,
        // no `warn` override — defaultWarn must fire
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('uses console.error as the default sink when no `error` override is supplied', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() =>
        createSecretStore({
          handle: makeStubDb(),
          safeStorage: makeSafeStorage(false),
          isPackaged: true,
          // no `error` override — defaultError must fire before the throw
        }),
      ).toThrow();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('production refusal log message does not include any secret value', () => {
    // Defensive regression: even though no value was set, future iterations
    // of the factory could be tempted to include caller-supplied data in
    // the fatal message. Plaintext leakage rule.
    const error = vi.fn();
    try {
      createSecretStore({
        handle: makeStubDb(),
        safeStorage: makeSafeStorage(false),
        isPackaged: true,
        error,
      });
    } catch {
      // expected
    }
    for (const call of error.mock.calls) {
      const joined = call.map((a) => String(a)).join(' ');
      expect(joined.toLowerCase()).not.toContain('placeholder');
      expect(joined.toLowerCase()).not.toContain('test.placeholder');
    }
  });
});
