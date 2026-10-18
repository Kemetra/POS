import type { SecretKey, SecretStore } from '../../shared/secret-store.js';

/**
 * T047 — in-memory SecretStore backend.
 *
 * Used in dev/test only when `safeStorage.isEncryptionAvailable()` is
 * false AND `app.isPackaged` is false. Production builds MUST refuse to
 * use this backend (enforced in `createSecretStore()`).
 *
 * No encryption: values are held in a Map<string, string> for the
 * process lifetime and discarded on exit. Suitable only for round-trip
 * tests and dev workstations without DPAPI.
 */
export function createInMemorySecretStore(): SecretStore {
  const store = new Map<string, string>();

  function rejectIfInvalidValue(value: unknown): void {
    if (typeof value !== 'string') {
      throw new TypeError('SecretStore.set: value must be a string');
    }
    if (value.length === 0) {
      throw new Error(
        'SecretStore.set: value must be non-empty. Callers must use delete() to remove a key.',
      );
    }
  }

  // Methods return Promises (per the SecretStore contract — forward-compat
  // with async backends in 002+) without `async` keyword, since the
  // in-memory implementation is synchronous and `async`-without-`await`
  // trips ESLint's @typescript-eslint/require-await rule.
  return {
    get(key: SecretKey): Promise<string | null> {
      const v = store.get(key);
      return Promise.resolve(v === undefined ? null : v);
    },
    set(key: SecretKey, value: string): Promise<void> {
      try {
        rejectIfInvalidValue(value);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      store.set(key, value);
      return Promise.resolve();
    },
    delete(key: SecretKey): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
    isProductionBacked(): boolean {
      return false;
    },
  };
}
