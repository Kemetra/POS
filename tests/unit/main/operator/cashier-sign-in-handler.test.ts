import { beforeAll, describe, expect, it, vi } from 'vitest';

import { hashPin } from '../../../../src/main/operator/pin-credential.js';
import { sealPinMaterial } from '../../../../src/main/operator/pin-seal.js';
import {
  CashierSignInHandler,
  type CashierSignInRequest,
} from '../../../../src/main/operator/sign-in-handler.js';
import type { SafeStorageLike } from '../../../../src/main/secrets/safe-storage.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import type {
  CheckActiveSessionHandler,
  CheckActiveSessionResult,
} from '../../../../src/main/operator/check-active-session.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import { ProtoSessionStore } from '../../../../src/main/operator/takeover-handler.js';

/**
 * 004-operator-session T069 — cashier sign-in handler unit tests.
 *
 * Verifies:
 *  - Not paired → refused (invalid_input).
 *  - Row not found → refused (invalid_input).
 *  - Active lockout → refused (rate_limited), no DB write.
 *  - Wrong PIN → refused (invalid_input), DB updated with incremented count.
 *  - 5th wrong PIN triggers lockout → DB updated with lockout_until.
 *  - Expired lockout + correct PIN → proceeds to sign_in.
 *  - Correct PIN + no active session → signed_in, failure counter reset.
 *  - Correct PIN + active session → takeover_required.
 *  - checkActiveSession refused (no_connection) → refused (no_connection).
 *  - checkActiveSession refused (invalid_input) → refused (invalid_input).
 *  - PR-1: response for wrong PIN contains no PIN value.
 *
 * One Argon2id hash is computed in beforeAll and shared across tests.
 */

const PIN = '4829';
const WRONG_PIN = '0000';
const TENANT = 't1';
const BRANCH = 'b1';
const TERMINAL = 'term1';
const CASHIER_ID = 'cashier-001';

// --- fake safeStorage (same prefix-seal scheme as pin-seal.test.ts) ---

const PREFIX = Buffer.from('SEALED:', 'utf8');

function makeFakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain: string): Buffer {
      return Buffer.concat([PREFIX, Buffer.from(plain, 'utf8')]);
    },
    decryptString(buf: Buffer): string {
      if (buf.length < PREFIX.length || !buf.subarray(0, PREFIX.length).equals(PREFIX)) {
        throw new Error('decryptString: invalid or tampered ciphertext');
      }
      return buf.subarray(PREFIX.length).toString('utf8');
    },
  };
}

const ss = makeFakeSafeStorage();

// --- DB row type used in tests ---

interface TestDbRow {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  cashier_clerk_user_id: string;
  pin_hash: Buffer;
  pin_salt: Buffer;
  failed_attempt_count: number;
  lockout_until: string | null;
}

let baseRow: TestDbRow;

beforeAll(async () => {
  const { pin_hash, pin_salt } = await hashPin(PIN);
  const sealed = sealPinMaterial({ pin_hash, pin_salt }, ss);
  baseRow = {
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    cashier_clerk_user_id: CASHIER_ID,
    pin_hash: sealed.pin_hash,
    pin_salt: sealed.pin_salt,
    failed_attempt_count: 0,
    lockout_until: null,
  };
}, 15_000);

// --- fakes ---

function makeDb(
  row: TestDbRow | undefined,
  onUpdate?: (failed: number, lockout: string | null) => void,
): DatabaseHandle {
  return {
    pragma: () => undefined,
    prepare(sql: string) {
      if (/^\s*SELECT/i.test(sql)) {
        return { get: () => row };
      }
      // UPDATE stmt
      return {
        run: (failed: unknown, lockout: unknown) =>
          onUpdate?.(failed as number, lockout as string | null),
      };
    },
    exec: () => undefined,
    transaction: <T>(fn: T) => fn,
    close: () => undefined,
  };
}

function makePairedStore(): PairingStore {
  return {
    getStatus: () =>
      Promise.resolve({
        kind: 'paired',
        tenant_id: TENANT,
        branch_id: BRANCH,
        terminal_id: TERMINAL,
        terminal_label: 'T1',
        paired_at: 0,
      }),
    persist: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
}

function makeUnpairedStore(): PairingStore {
  return {
    getStatus: () => Promise.resolve({ kind: 'unpaired' }),
    persist: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
}

function makeCheckActive(result: CheckActiveSessionResult): CheckActiveSessionHandler {
  return {
    checkActiveSession: vi.fn().mockResolvedValue(result),
  } as unknown as CheckActiveSessionHandler;
}

function makeRequest(overrides: Partial<CashierSignInRequest> = {}): CashierSignInRequest {
  return {
    kind: 'cashier',
    cashier_clerk_user_id: CASHIER_ID,
    pin: PIN,
    display_name: 'Test Cashier',
    ...overrides,
  };
}

function makeHandler(
  overrides: Partial<{
    db: DatabaseHandle;
    pairingStore: PairingStore;
    checkActiveSession: CheckActiveSessionHandler;
    sessionManager: SessionManager;
    protoStore: ProtoSessionStore;
  }> = {},
): CashierSignInHandler {
  return new CashierSignInHandler({
    db: overrides.db ?? makeDb(baseRow),
    safeStorage: ss,
    sessionManager: overrides.sessionManager ?? new SessionManager(),
    checkActiveSession: overrides.checkActiveSession ?? makeCheckActive({ kind: 'none' }),
    pairingStore: overrides.pairingStore ?? makePairedStore(),
    protoStore: overrides.protoStore ?? new ProtoSessionStore(),
  });
}

// --- tests ---

describe('CashierSignInHandler — terminal not paired', () => {
  it('refuses with invalid_input when terminal is unpaired', async () => {
    const handler = makeHandler({ pairingStore: makeUnpairedStore() });
    const result = await handler.signIn(makeRequest());
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('refuses with invalid_input when pairing status is invalid', async () => {
    const store: PairingStore = {
      getStatus: () => Promise.resolve({ kind: 'invalid', reason: 'decrypt_failed' }),
      persist: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    const handler = makeHandler({ pairingStore: store });
    const result = await handler.signIn(makeRequest());
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
  });
});

describe('CashierSignInHandler — row not found', () => {
  it('refuses with invalid_input when no pin record exists for the cashier', async () => {
    const handler = makeHandler({ db: makeDb(undefined) });
    const result = await handler.signIn(makeRequest());
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
  });
});

describe('CashierSignInHandler — active lockout', () => {
  it('refuses with rate_limited and does not write to DB', async () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const updateSpy = vi.fn();
    const row: TestDbRow = { ...baseRow, failed_attempt_count: 5, lockout_until: future };
    const handler = makeHandler({ db: makeDb(row, updateSpy) });
    const result = await handler.signIn(makeRequest());
    expect(result).toEqual({ kind: 'refused', category: 'rate_limited' });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('CashierSignInHandler — wrong PIN', () => {
  it('refuses with invalid_input and increments failed_attempt_count from 0 to 1', async () => {
    let capturedFailed = -1;
    let capturedLockout: string | null = 'UNSET';
    const handler = makeHandler({
      db: makeDb(baseRow, (f, l) => {
        capturedFailed = f;
        capturedLockout = l;
      }),
    });
    const result = await handler.signIn(makeRequest({ pin: WRONG_PIN }));
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(capturedFailed).toBe(1);
    expect(capturedLockout).toBeNull();
  });

  it('sets lockout_until on the 5th consecutive failure', async () => {
    const captured = { failed: -1, lockout: null as string | null };
    const row: TestDbRow = { ...baseRow, failed_attempt_count: 4 };
    const before = Date.now();
    const handler = makeHandler({
      db: makeDb(row, (f, l) => {
        captured.failed = f;
        captured.lockout = l;
      }),
    });
    const result = await handler.signIn(makeRequest({ pin: WRONG_PIN }));
    const after = Date.now();
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(captured.failed).toBe(5);
    expect(captured.lockout).not.toBeNull();
    if (captured.lockout === null) return;
    const lockoutTs = new Date(captured.lockout).getTime();
    expect(lockoutTs).toBeGreaterThanOrEqual(before + 4 * 60 * 1000);
    expect(lockoutTs).toBeLessThanOrEqual(after + 6 * 60 * 1000);
  });
});

describe('CashierSignInHandler — expired lockout', () => {
  it('allows sign-in after lockout expires (correct PIN)', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const row: TestDbRow = { ...baseRow, failed_attempt_count: 5, lockout_until: past };
    const handler = makeHandler({ db: makeDb(row) });
    const result = await handler.signIn(makeRequest());
    expect(result.kind).toBe('signed_in');
  });
});

describe('CashierSignInHandler — correct PIN, no active session', () => {
  it('returns signed_in with correct session shape', async () => {
    let capturedFailed = -1;
    let capturedLockout: string | null = 'UNSET';
    const handler = makeHandler({
      db: makeDb(baseRow, (f, l) => {
        capturedFailed = f;
        capturedLockout = l;
      }),
      checkActiveSession: makeCheckActive({ kind: 'none' }),
    });
    const result = await handler.signIn(makeRequest());
    expect(result.kind).toBe('signed_in');
    if (result.kind !== 'signed_in') return;
    expect(result.session.role).toBe('cashier');
    expect(result.session.operator_id).toBe(CASHIER_ID);
    expect(result.session.tenant_id).toBe(TENANT);
    expect(result.session.branch_id).toBe(BRANCH);
    // failure counter must be reset to 0
    expect(capturedFailed).toBe(0);
    expect(capturedLockout).toBeNull();
  });

  it('session display_name matches the request field', async () => {
    const handler = makeHandler();
    const result = await handler.signIn(makeRequest({ display_name: 'Jane Smith' }));
    expect(result.kind).toBe('signed_in');
    if (result.kind !== 'signed_in') return;
    expect(result.session.display_name).toBe('Jane Smith');
  });

  it('passes the paired branch_id into active-session lookup', async () => {
    const checkActiveSession = {
      checkActiveSession: vi.fn().mockResolvedValue({ kind: 'none' }),
    } as unknown as CheckActiveSessionHandler;
    const handler = makeHandler({ checkActiveSession });

    const result = await handler.signIn(makeRequest());

    expect(result.kind).toBe('signed_in');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(checkActiveSession.checkActiveSession)).toHaveBeenCalledWith(
      CASHIER_ID,
      BRANCH,
    );
  });
});

describe('CashierSignInHandler — correct PIN, active session exists', () => {
  it('returns takeover_required with capability token without creating a new session', async () => {
    const sm = new SessionManager();
    const handler = makeHandler({
      checkActiveSession: makeCheckActive({ kind: 'active' }),
      sessionManager: sm,
    });
    const result = await handler.signIn(makeRequest());
    expect(result.kind).toBe('takeover_required');
    if (result.kind !== 'takeover_required') return;
    // FR-013: no identifying detail other than the opaque capability token.
    expect(typeof result.pending_takeover_id).toBe('string');
    expect(result.pending_takeover_id.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('operator_id');
    expect(sm.getCurrent()).toBeNull();
  });
});

describe('CashierSignInHandler — active-session check refusals', () => {
  it('propagates no_connection refusal from checkActiveSession', async () => {
    const handler = makeHandler({
      checkActiveSession: makeCheckActive({ kind: 'refused', category: 'no_connection' }),
    });
    const result = await handler.signIn(makeRequest());
    expect(result).toEqual({ kind: 'refused', category: 'no_connection' });
  });

  it('propagates invalid_input refusal from checkActiveSession', async () => {
    const handler = makeHandler({
      checkActiveSession: makeCheckActive({ kind: 'refused', category: 'invalid_input' }),
    });
    const result = await handler.signIn(makeRequest());
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
  });
});

describe('CashierSignInHandler — PR-1 PIN redaction', () => {
  it('response for a wrong PIN does not contain the PIN value', async () => {
    const SENSITIVE_PIN = '9876';
    const handler = makeHandler({ db: makeDb(baseRow) });
    const result = await handler.signIn(makeRequest({ pin: SENSITIVE_PIN }));
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(JSON.stringify(result)).not.toContain(SENSITIVE_PIN);
  });
});

describe('CashierSignInHandler — tampered/corrupt sealed material', () => {
  it('returns generic invalid_input when pin_hash ciphertext is corrupted', async () => {
    const corruptRow: TestDbRow = {
      ...baseRow,
      pin_hash: Buffer.from('not-a-valid-ciphertext', 'utf8'),
    };
    const handler = makeHandler({ db: makeDb(corruptRow) });
    const result = await handler.signIn(makeRequest());
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('returns generic invalid_input when pin_salt ciphertext is corrupted', async () => {
    const corruptRow: TestDbRow = {
      ...baseRow,
      pin_salt: Buffer.from('not-a-valid-ciphertext', 'utf8'),
    };
    const handler = makeHandler({ db: makeDb(corruptRow) });
    const result = await handler.signIn(makeRequest());
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('response does not contain the PIN or raw decrypt error details', async () => {
    const SENSITIVE_PIN = '1234';
    const corruptRow: TestDbRow = {
      ...baseRow,
      pin_hash: Buffer.from('corrupted', 'utf8'),
    };
    const handler = makeHandler({ db: makeDb(corruptRow) });
    const result = await handler.signIn(makeRequest({ pin: SENSITIVE_PIN }));
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(SENSITIVE_PIN);
    expect(serialised).not.toContain('ciphertext');
    expect(serialised).not.toContain('corrupted');
    expect(serialised).not.toContain('decryptString');
  });
});

// RT-117 (RT-116 §2.4) — the same 004 PIN check, reused for same-operator
// unlock of a LOCKED session. It verifies and applies the lockout rules but
// never creates (or replaces) a session.
describe('CashierSignInHandler.verifyPin — RT-117 unlock verifier', () => {
  it('returns null on a correct PIN and creates no session', async () => {
    const sm = new SessionManager();
    let started = 0;
    sm.onStarted(() => {
      started += 1;
    });
    const handler = makeHandler({ sessionManager: sm });

    const result = await handler.verifyPin(CASHIER_ID, PIN);

    expect(result).toBeNull();
    expect(sm.getCurrent()).toBeNull();
    expect(started).toBe(0);
  });

  it('refuses invalid_input on a wrong PIN and counts the failure', async () => {
    let capturedFailed = -1;
    const handler = makeHandler({
      db: makeDb(baseRow, (f) => {
        capturedFailed = f;
      }),
    });

    const result = await handler.verifyPin(CASHIER_ID, WRONG_PIN);

    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(capturedFailed).toBe(1);
  });

  it('refuses rate_limited during an active lockout', async () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const row: TestDbRow = { ...baseRow, failed_attempt_count: 5, lockout_until: future };
    const handler = makeHandler({ db: makeDb(row) });

    const result = await handler.verifyPin(CASHIER_ID, PIN);

    expect(result).toEqual({ kind: 'refused', category: 'rate_limited' });
  });

  it('refuses invalid_input when the terminal is unpaired', async () => {
    const handler = makeHandler({ pairingStore: makeUnpairedStore() });
    const result = await handler.verifyPin(CASHIER_ID, PIN);
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
  });
});
