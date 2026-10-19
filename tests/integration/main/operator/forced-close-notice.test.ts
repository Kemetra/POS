import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  CashierSignInHandler,
  makeShiftDismissKey,
  type CashierSignInRequest,
} from '../../../../src/main/operator/sign-in-handler.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import { ProtoSessionStore } from '../../../../src/main/operator/takeover-handler.js';
import { hashPin } from '../../../../src/main/operator/pin-credential.js';
import { sealPinMaterial } from '../../../../src/main/operator/pin-seal.js';
import { fakeCashierAdmission } from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';
import type { SafeStorageLike } from '../../../../src/main/secrets/safe-storage.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import type { SecretKey, SecretStore } from '../../../../src/shared/secret-store.js';
import { handleFor } from '../../../../src/main/sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { initSalesSyncSql } from '../../../../src/main/sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  cashierSession,
  type ServiceHarness,
} from '../../../../src/main/shift-cashup/__tests__/__helpers__/shift-cashup-service-fixture.js';
import {
  OTHER_TERMINAL,
  SCOPE,
  USER,
} from '../../../../src/main/shift-cashup/__tests__/__helpers__/shift-sync-fixture.js';
import {
  CLOSE_AT,
  setupForcedClose,
  type ForcedCloseFixture,
} from './__helpers__/forced-close-fixture.js';

/**
 * RT-554 follow-up — the cashier's "your shift was force-closed" notice at the
 * next sign-in reads the REAL shift record: a forced close in
 * `shift_cashup_closes` (0043) of a shift in `shift_cashup_opens` the cashier
 * opened on this terminal. The legacy `shifts` table (0007, never written in
 * production) is not consulted. Real 0043 schema (sql.js), real cash-up
 * service and forced-close handler; only the cashier admission is faked.
 *
 * Disclosure (FR-013): only `closed_at` crosses to the renderer.
 */

const CLERK_ID = 'op-cashier-1';
const OTHER_USER = '0190f5a2-3b4c-7d8e-9f01-23456789abff';
const PIN = '4321';

const PREFIX = Buffer.from('SEALED:', 'utf8');
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.concat([PREFIX, Buffer.from(plain, 'utf8')]),
  decryptString: (buf) => {
    const bytes = Buffer.from(buf);
    if (!bytes.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('invalid ciphertext');
    return bytes.subarray(PREFIX.length).toString('utf8');
  },
};

function memorySecretStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn((key: SecretKey) => Promise.resolve(data.get(key) ?? null)),
    set: vi.fn((key: SecretKey, val: string) => {
      data.set(key, val);
      return Promise.resolve();
    }),
    delete: vi.fn((key: SecretKey) => {
      data.delete(key);
      return Promise.resolve();
    }),
    isProductionBacked: () => false,
  };
}

function pairedAt(terminalId: string): PairingStore {
  return {
    getStatus: () =>
      Promise.resolve({
        kind: 'paired',
        tenant_id: SCOPE.tenantId,
        branch_id: SCOPE.branchId,
        terminal_id: terminalId,
        terminal_label: 'T',
        paired_at: 0,
      }),
    persist: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
}

let db: SqlJsDatabase;
let harness: ServiceHarness;
let makeHandler: ForcedCloseFixture['makeHandler'];
let request: ForcedCloseFixture['request'];
let sealed: { pin_hash: Buffer; pin_salt: Buffer };

beforeAll(async () => {
  await initSalesSyncSql();
  const { pin_hash, pin_salt } = await hashPin(PIN);
  sealed = sealPinMaterial({ pin_hash, pin_salt }, safeStorage);
}, 15_000);

beforeEach(() => {
  ({ db, harness, makeHandler, request } = setupForcedClose());
});

afterEach(() => {
  db.close();
});

/** A paired cashier PIN record on `terminalId` for the `users.id` `userId`. */
function provisionCashier(terminalId: string, userId: string): void {
  db.run(
    `INSERT INTO cashier_pin_records
       (tenant_id, branch_id, terminal_id, user_id, cashier_clerk_user_id,
        pin_hash, pin_salt, failed_attempt_count, lockout_until, created_at, created_by_operator_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, '2026-10-01T00:00:00.000Z', 'op-manager-1')`,
    [
      SCOPE.tenantId,
      SCOPE.branchId,
      terminalId,
      userId,
      CLERK_ID,
      sealed.pin_hash,
      sealed.pin_salt,
    ],
  );
}

function signInHandler(options: {
  terminalId?: string;
  store?: SecretStore;
}): CashierSignInHandler {
  return new CashierSignInHandler({
    db: handleFor(db),
    safeStorage,
    sessionManager: new SessionManager(),
    admission: fakeCashierAdmission().deps,
    pairingStore: pairedAt(options.terminalId ?? SCOPE.terminalId),
    protoStore: new ProtoSessionStore(),
    ...(options.store === undefined ? {} : { secretStore: options.store }),
  });
}

const SIGN_IN: CashierSignInRequest = {
  kind: 'cashier',
  cashier_clerk_user_id: CLERK_ID,
  pin: PIN,
  display_name: 'Terry Cashier',
};

async function noticeAfterSignIn(handler: CashierSignInHandler): Promise<unknown> {
  const result = await handler.signIn(SIGN_IN);
  expect(result.kind).toBe('signed_in');
  return result.kind === 'signed_in' ? result.forced_close_notice : undefined;
}

async function forceCloseByManager(): Promise<void> {
  const result = await makeHandler().forceCloseShift(request());
  expect(result.kind).toBe('forced_closed');
}

describe('the forced-close notice reads the real cash-up tables', () => {
  it('shows the notice, with only closed_at, after a manager force-closed the cashier’s shift', async () => {
    provisionCashier(SCOPE.terminalId, USER);
    await forceCloseByManager();

    const notice = await noticeAfterSignIn(signInHandler({ store: memorySecretStore() }));

    expect(notice).toEqual({ closed_at: CLOSE_AT });
  });

  it('shows no notice while the cashier’s shift is still open', async () => {
    provisionCashier(SCOPE.terminalId, USER);

    expect(await noticeAfterSignIn(signInHandler({ store: memorySecretStore() }))).toBeUndefined();
  });

  it('shows no notice for a shift the cashier closed normally', async () => {
    provisionCashier(SCOPE.terminalId, USER);
    harness.state.session = cashierSession();
    harness.state.clock = CLOSE_AT;
    harness.service.closeShift({ countedCashMinor: 50_000 });

    expect(await noticeAfterSignIn(signInHandler({ store: memorySecretStore() }))).toBeUndefined();
  });

  it('shows no notice to a cashier whose own shift was not the one force-closed', async () => {
    provisionCashier(SCOPE.terminalId, OTHER_USER);
    await forceCloseByManager(); // the shift opened by USER

    expect(await noticeAfterSignIn(signInHandler({ store: memorySecretStore() }))).toBeUndefined();
  });

  it('shows no notice on another terminal of the branch', async () => {
    provisionCashier(OTHER_TERMINAL.terminalId, USER);
    await forceCloseByManager(); // closed on SCOPE.terminalId

    const handler = signInHandler({
      terminalId: OTHER_TERMINAL.terminalId,
      store: memorySecretStore(),
    });
    expect(await noticeAfterSignIn(handler)).toBeUndefined();
  });

  it('ignores a legacy shifts-table row: that table is not the shift record', async () => {
    provisionCashier(SCOPE.terminalId, USER);
    db.run(
      `INSERT INTO shifts
         (id, tenant_id, branch_id, originating_terminal_id, opening_operator_id,
          lifecycle_state, opened_at, closed_at, declared_count)
       VALUES ('legacy-1', ?, ?, ?, ?, 'closed_forced', '2026-10-05T08:00:00.000Z', ?, NULL)`,
      [SCOPE.tenantId, SCOPE.branchId, SCOPE.terminalId, CLERK_ID, CLOSE_AT],
    );

    expect(await noticeAfterSignIn(signInHandler({ store: memorySecretStore() }))).toBeUndefined();
  });
});

const DISMISS_KEY = makeShiftDismissKey(SCOPE.tenantId, SCOPE.branchId, SCOPE.terminalId, CLERK_ID);

/** The cashier dismisses the notice (the IPC handler's call into the handler). */
function dismiss(handler: CashierSignInHandler): Promise<void> {
  return handler.dismissForcedCloseNotice(
    SCOPE.tenantId,
    SCOPE.branchId,
    SCOPE.terminalId,
    CLERK_ID,
  );
}

/** A secret store already holding a dismissal of the forced close made at `closedAt`. */
function storeDismissing(closedAt: string): ReturnType<typeof memorySecretStore> {
  const store = memorySecretStore();
  store.data.set(DISMISS_KEY, JSON.stringify({ dismissed_closed_at: closedAt }));
  return store;
}

describe('dismissal keeps its behaviour on the new source', () => {
  it.each([
    ['the dismiss record matches closed_at', CLOSE_AT, undefined],
    [
      'the dismiss record is for a different closed_at',
      '2026-01-01T00:00:00.000Z',
      { closed_at: CLOSE_AT },
    ],
  ])('on sign-in, when %s', async (_case, dismissedAt, expected) => {
    provisionCashier(SCOPE.terminalId, USER);
    await forceCloseByManager();

    expect(await noticeAfterSignIn(signInHandler({ store: storeDismissing(dismissedAt) }))).toEqual(
      expected,
    );
  });

  it('dismissForcedCloseNotice records closed_at under the cashier’s dismiss key, then sign-in omits it', async () => {
    provisionCashier(SCOPE.terminalId, USER);
    await forceCloseByManager();
    const store = memorySecretStore();

    await dismiss(signInHandler({ store }));

    expect(JSON.parse(String(store.data.get(DISMISS_KEY)))).toEqual({
      dismissed_closed_at: CLOSE_AT,
    });
    expect(await noticeAfterSignIn(signInHandler({ store }))).toBeUndefined();
  });

  it.each([
    ['nothing was force-closed', USER, false],
    ['the forced close was another cashier’s', OTHER_USER, true],
  ])('dismissForcedCloseNotice writes nothing when %s', async (_case, provisionedUser, forced) => {
    provisionCashier(SCOPE.terminalId, provisionedUser);
    if (forced) await forceCloseByManager(); // the shift opened by USER
    const store = memorySecretStore();

    await dismiss(signInHandler({ store }));

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(store.set)).not.toHaveBeenCalled();
  });

  it('dismissForcedCloseNotice is a no-op when the secret store is absent', async () => {
    provisionCashier(SCOPE.terminalId, USER);
    await forceCloseByManager();

    await expect(dismiss(signInHandler({}))).resolves.toBeUndefined();
  });
});
