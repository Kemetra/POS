import type { DatabaseHandle } from '../db/client.js';
import type { SecretStore } from '../../shared/secret-store.js';
import { createInMemorySecretStore } from './in-memory.js';
import { createSafeStorageSecretStore, type SafeStorageLike } from './safe-storage.js';

/**
 * T048 — SecretStore factory.
 *
 * Picks a backend based on (`safeStorage.isEncryptionAvailable()`,
 * shipped app) per data-model.md § SecretEntry → "Backend
 * selection":
 *
 *   | available | shipped  | result                                    |
 *   |:---------:|:--------:|:------------------------------------------|
 *   |   true    |   any    | safe-storage backend (production-grade)   |
 *   |   false   |   false  | in-memory backend + warning               |
 *   |   false   |   true   | THROW fatal — production refuses to start |
 *
 * R8: until US6 (logging) lands, warnings/errors are routed through
 * console.warn / console.error placeholders. The factory still throws on
 * production refusal — the deferral is the *log mechanism*, not the
 * refusal itself.
 *
 * RT-165: "shipped" is `isShippedApp(...)`, not `app.isPackaged` alone, so a
 * renamed copy of the shipped exe cannot drop to the in-memory backend.
 */

export interface CreateSecretStoreOptions {
  /** Open SQLite handle shared with the migration runner (R9). */
  handle: DatabaseHandle;
  /** Electron's `safeStorage` (production) or a fake (tests). */
  safeStorage: SafeStorageLike;
  /** `isShippedApp(...)` (RT-165): `app.isPackaged` OR running from the shipped `app.asar`. */
  isShippedApp: boolean;
  /** Override for the warning sink. Defaults to console.warn. */
  warn?: (...args: unknown[]) => void;
  /** Override for the error sink. Defaults to console.error. */
  error?: (...args: unknown[]) => void;
}

export function createSecretStore(options: CreateSecretStoreOptions): SecretStore {
  const { handle, safeStorage, isShippedApp } = options;
  const warn = options.warn ?? defaultWarn;
  const error = options.error ?? defaultError;

  const available = safeStorage.isEncryptionAvailable();

  if (!available && isShippedApp) {
    // R8: log via the placeholder sink BEFORE throwing so operators see
    // the cause even if the catch in src/main/index.ts only does
    // app.exit(1). Plaintext leakage rule: this message MUST NOT contain
    // any caller-supplied secret data — and it doesn't, because no value
    // has been written to the store at this point.
    error(
      '[pos-pulse] SecretStore: production build refuses to start — Electron safeStorage is unavailable on this machine.',
    );
    throw new Error(
      'SecretStore: production build refuses to start — safeStorage encryption is unavailable.',
    );
  }

  if (!available) {
    // !available && !shipped — dev/test fallback.
    warn(
      '[pos-pulse] SecretStore: safeStorage unavailable; using in-memory backend (dev/test only). Production builds will refuse to start in this state.',
    );
    return createInMemorySecretStore();
  }

  return createSafeStorageSecretStore({ handle, safeStorage });
}

function defaultWarn(...args: unknown[]): void {
  console.warn(...args);
}

function defaultError(...args: unknown[]): void {
  console.error(...args);
}
