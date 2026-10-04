import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

import { CashierSignInHandler } from '../sign-in-handler.js';
import { SessionManager } from '../session-manager.js';
import { ProtoSessionStore } from '../takeover-handler.js';
import { FAKE_USER_ID, fakeCashierAdmission } from './__helpers__/fake-cashier-admission.js';
import { hashPin } from '../pin-credential.js';
import { sealPinMaterial } from '../pin-seal.js';
import type { SafeStorageLike } from '../../secrets/safe-storage.js';
import type { DatabaseHandle } from '../../db/client.js';
import type { PairingStore } from '../../pairing/store.js';

/**
 * T081 — pino log sites with PR-1 redaction for PIN failure / lockout outcomes.
 *
 * Verified log events:
 *   operator.cashier_sign_in.refused  (wrong_pin / locked_out / not_found)
 *   operator.cashier_sign_in.lockout_triggered  (5th failure sets lockout_until)
 *   operator.cashier_sign_in.lockout_released   (match after expired lockout)
 *   operator.cashier_sign_in.outcome            (signed_in / takeover_required)
 *
 * PR-1 invariants:
 *   - No PIN value appears in any log call args.
 *   - No pin_hash / pin_salt appears in any log call args.
 *   - No cashier_clerk_user_id appears in any log call args.
 *   - category field may appear (it is not a credential).
 *   - event field must appear (structural, not a secret).
 */

const SENTINEL_PIN = 'SENTINEL-1234';
const CASHIER_ID = 'clerk-user-cashier-T081';
const TENANT = 't-T081';
const BRANCH = 'b-T081';
const TERMINAL = 'term-T081';

const PAIRED_STATUS = {
  kind: 'paired' as const,
  tenant_id: TENANT,
  branch_id: BRANCH,
  terminal_id: TERMINAL,
  terminal_label: 'Terminal 1',
};

function makePairingStore(): PairingStore {
  return {
    getStatus: vi.fn(() => Promise.resolve(PAIRED_STATUS)),
    saveStatus: vi.fn(),
    clearStatus: vi.fn(),
  } as unknown as PairingStore;
}

function makeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace(/^enc:/, '')),
  };
}

/** Build a DB stub that returns a pinRow with given lockout state. */
function makeDb(opts: {
  failed_attempt_count: number;
  lockout_until: string | null;
  pinHash: Buffer;
  pinSalt: Buffer;
}): DatabaseHandle {
  const row = {
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    cashier_clerk_user_id: CASHIER_ID,
    user_id: FAKE_USER_ID,
    pin_hash: opts.pinHash,
    pin_salt: opts.pinSalt,
    failed_attempt_count: opts.failed_attempt_count,
    lockout_until: opts.lockout_until,
  };

  const selectGet = vi.fn(() => row);
  const updateRun = vi.fn();

  const prepare = vi.fn((sql: string) => {
    if (sql.includes('SELECT')) return { get: selectGet };
    return { run: updateRun };
  });

  return { prepare } as unknown as DatabaseHandle;
}

function captureLogger(): { logger: Logger; logCalls: Array<[string, ...unknown[]]> } {
  const logCalls: Array<[string, ...unknown[]]> = [];
  const infoFn = vi.fn((...args: unknown[]) => logCalls.push(['info', ...args]));
  const logger = { info: infoFn } as unknown as Logger;
  return { logger, logCalls };
}

async function buildHandlerWithPin(
  correctPin: string,
  failedCount: number,
  lockoutUntil: string | null,
): Promise<{
  handler: CashierSignInHandler;
  logCalls: Array<[string, ...unknown[]]>;
}> {
  const safeStorage = makeSafeStorage();
  const { pin_hash, pin_salt } = await hashPin(correctPin);
  const sealed = sealPinMaterial({ pin_hash, pin_salt }, safeStorage);

  const db = makeDb({
    failed_attempt_count: failedCount,
    lockout_until: lockoutUntil,
    pinHash: sealed.pin_hash,
    pinSalt: sealed.pin_salt,
  });

  const { logger, logCalls } = captureLogger();

  const handler = new CashierSignInHandler({
    db,
    safeStorage,
    sessionManager: new SessionManager(),
    admission: fakeCashierAdmission().deps,
    pairingStore: makePairingStore(),
    protoStore: new ProtoSessionStore(),
    logger,
  });

  return { handler, logCalls };
}

const BASE_REQ = {
  kind: 'cashier' as const,
  cashier_clerk_user_id: CASHIER_ID,
  display_name: 'Cashier T081',
};

describe('CashierSignInHandler — T081 log sites + PR-1 redaction', () => {
  it('logs wrong_pin refusal on bad PIN', async () => {
    const { handler, logCalls } = await buildHandlerWithPin('9999', 0, null);
    await handler.signIn({ ...BASE_REQ, pin: '0000' });

    const events = logCalls.map(([, first]) => (first as { event?: string }).event ?? '');
    expect(events).toContain('operator.cashier_sign_in.refused');

    const refusalCall = logCalls.find(
      ([, first]) => (first as { event?: string }).event === 'operator.cashier_sign_in.refused',
    );
    expect(refusalCall).toBeDefined();
    const logArg = JSON.stringify(refusalCall);
    expect(logArg).not.toContain('0000');
    expect(logArg).not.toContain(CASHIER_ID);
    expect(logArg).not.toContain('pin_hash');
    expect(logArg).not.toContain('pin_salt');
  });

  it('logs lockout_triggered when 5th failure sets lockout_until', async () => {
    const { handler, logCalls } = await buildHandlerWithPin('9999', 4, null);
    const res = await handler.signIn({ ...BASE_REQ, pin: '0000' });

    expect(res).toMatchObject({ kind: 'refused', category: 'invalid_input' });

    const events = logCalls.map(([, first]) => (first as { event?: string }).event ?? '');
    expect(events).toContain('operator.cashier_sign_in.lockout_triggered');

    // PR-1: lockout_triggered log must not carry any credential data
    const triggeredCall = logCalls.find(
      ([, first]) =>
        (first as { event?: string }).event === 'operator.cashier_sign_in.lockout_triggered',
    );
    const logArg = JSON.stringify(triggeredCall);
    expect(logArg).not.toContain('0000');
    expect(logArg).not.toContain(CASHIER_ID);
  });

  it('logs locked_out refusal when lockout is active', async () => {
    const futureDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { handler, logCalls } = await buildHandlerWithPin('9999', 5, futureDate);
    const res = await handler.signIn({ ...BASE_REQ, pin: '9999' });

    expect(res).toMatchObject({ kind: 'refused', category: 'rate_limited' });

    const events = logCalls.map(([, first]) => (first as { event?: string }).event ?? '');
    expect(events).toContain('operator.cashier_sign_in.refused');

    const refusalCall = logCalls.find(
      ([, first]) => (first as { event?: string }).event === 'operator.cashier_sign_in.refused',
    );
    const logArg = JSON.stringify(refusalCall);
    expect(logArg).not.toContain('9999');
    expect(logArg).not.toContain(CASHIER_ID);
  });

  it('logs lockout_released when expired lockout clears on successful sign-in', async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const { handler, logCalls } = await buildHandlerWithPin('1234', 5, pastDate);
    const res = await handler.signIn({ ...BASE_REQ, pin: '1234' });

    expect(res.kind).toBe('signed_in');

    const events = logCalls.map(([, first]) => (first as { event?: string }).event ?? '');
    expect(events).toContain('operator.cashier_sign_in.lockout_released');

    // PR-1: lockout_released log must not carry any credential data
    const releasedCall = logCalls.find(
      ([, first]) =>
        (first as { event?: string }).event === 'operator.cashier_sign_in.lockout_released',
    );
    const logArg = JSON.stringify(releasedCall);
    expect(logArg).not.toContain('1234');
    expect(logArg).not.toContain(CASHIER_ID);
    expect(logArg).not.toContain('pin_hash');
    expect(logArg).not.toContain('pin_salt');
  });

  it('does not log lockout_released on normal successful sign-in (no prior lockout)', async () => {
    const { handler, logCalls } = await buildHandlerWithPin('1234', 0, null);
    await handler.signIn({ ...BASE_REQ, pin: '1234' });

    const events = logCalls.map(([, first]) => (first as { event?: string }).event ?? '');
    expect(events).not.toContain('operator.cashier_sign_in.lockout_released');
    expect(events).toContain('operator.cashier_sign_in.outcome');
  });

  it('no PIN value appears in any log call for any outcome', async () => {
    const { handler, logCalls } = await buildHandlerWithPin(SENTINEL_PIN, 0, null);
    await handler.signIn({ ...BASE_REQ, pin: 'wrong-pin-x9z' });

    const allLogText = JSON.stringify(logCalls);
    expect(allLogText).not.toContain(SENTINEL_PIN);
    expect(allLogText).not.toContain('wrong-pin-x9z');
    expect(allLogText).not.toContain('pin_hash');
    expect(allLogText).not.toContain('pin_salt');
  });
});
