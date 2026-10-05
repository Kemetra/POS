import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import pino from 'pino';

import { registerOperatorHandlers } from '../../../../src/main/ipc/operator.js';
import { OPERATOR_IPC_CHANNELS } from '../../../../src/shared/operator/channels.js';
import { createBackendClient } from '../../../../src/main/operator/backend-client.js';
import { createCashierAdmissionClient } from '../../../../src/main/operator/cashier-admission-client.js';
import type { CashierAdmissionDeps } from '../../../../src/main/operator/cashier-admission.js';
import { CashierAdmissionKeeper } from '../../../../src/main/operator/cashier-admission-keeper.js';
import {
  CashierSignInHandler,
  SignInHandler,
} from '../../../../src/main/operator/sign-in-handler.js';
import { SignOutHandler } from '../../../../src/main/operator/sign-out-handler.js';
import { RosterHandler } from '../../../../src/main/operator/roster-handler.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import { LifecycleCascade } from '../../../../src/main/operator/lifecycle-cascade.js';
import {
  ProtoSessionStore,
  TakeoverHandler,
} from '../../../../src/main/operator/takeover-handler.js';
import { hashPin } from '../../../../src/main/operator/pin-credential.js';
import { sealPinMaterial } from '../../../../src/main/operator/pin-seal.js';
import {
  createOfflineGrantStore,
  type OfflineGrantStore,
} from '../../../../src/main/operator/offline-grant-store.js';
import {
  createOfflineGrantWiring,
  type OfflineGrantWiring,
} from '../../../../src/main/operator/offline-grant-wiring.js';
import type { ClerkExchanger } from '../../../../src/main/operator/clerk-client.js';
import type { InactivityMonitor } from '../../../../src/main/operator/inactivity-monitor.js';
import type { PinManagementHandler } from '../../../../src/main/operator/pin-management.js';
import type { ForcedCloseHandler } from '../../../../src/main/operator/forced-close-handler.js';
import type { StuckShiftsHandler } from '../../../../src/main/operator/stuck-shifts-handler.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import type { SafeStorageLike } from '../../../../src/main/secrets/safe-storage.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import {
  aeadSafeStorage,
  grantDb,
  initGrantSql,
  rows,
  type GrantDb,
} from '../../../../src/main/operator/__tests__/__helpers__/offline-grant-fixture.js';

/**
 * RT-113 P1.2 — the offline grant through the REAL cashier sign-in, takeover
 * and heartbeat paths (operator IPC → handlers → admission client → stub
 * Backend-Core), with the REAL grant store on the full migration stack.
 *
 * Plan 10871 §"PR P1.2" tests: `admitted` writes or refreshes the grant on
 * sign-in, takeover and heartbeat; a 403 invalidates that user only; a 401
 * invalidates all; transient outcomes never touch the grant; a throwing store
 * never breaks sign-in; a failed write still refuses.
 */

const BASE = 'https://bc.example.test';
const DEVICE_TOKEN = 'dev-tok-0a1b2c3d4e5f-SECRET';
const PIN = '739182';
const USER_ID = '0192f6a0-1b2c-7d3e-8f40-123456789abc';
const OTHER_USER_ID = '0192f6a0-1b2c-7d3e-8f40-123456789def';
const CLERK_ID = 'user_clerk_cashier_1';
const ADMISSION_ID = '0192f6a0-aaaa-7bbb-8ccc-000000000001';
const TTL_S = 600;
const SCOPE = {
  tenant_id: 't1',
  branch_id: 'b1',
  terminal_id: 'term-1',
  pairing_epoch: 1_790_000_000,
};

const PREFIX = Buffer.from('SEALED:', 'utf8');
const pinSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.concat([PREFIX, Buffer.from(plain, 'utf8')]),
  decryptString: (buf) => buf.subarray(PREFIX.length).toString('utf8'),
};

let pinRow: Record<string, unknown>;

beforeAll(async () => {
  await initGrantSql();
  const { pin_hash, pin_salt } = await hashPin(PIN);
  const sealed = sealPinMaterial({ pin_hash, pin_salt }, pinSafeStorage);
  pinRow = {
    tenant_id: SCOPE.tenant_id,
    branch_id: SCOPE.branch_id,
    terminal_id: SCOPE.terminal_id,
    cashier_clerk_user_id: CLERK_ID,
    user_id: USER_ID,
    pin_hash: sealed.pin_hash,
    pin_salt: sealed.pin_salt,
    failed_attempt_count: 0,
    lockout_until: null,
  };
}, 15_000);

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ADMISSIONS = '/api/pos/v1/cashier-admissions';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ADMITTED_BODY = {
  kind: 'admitted',
  admission_id: ADMISSION_ID,
  offline_grace_seconds: 86_400,
  admission_ttl_seconds: TTL_S,
  server_time: '2026-10-04T10:00:00.000Z',
  display_name: 'Mona',
  // RT-219 (#544): every `admitted` carries an opaque generation.
  admission_generation: 'gen-default-0000',
};

function errorJson(status: number): Response {
  return json(status, { error: { code: 'x', message: 'x', request_id: 'r' } });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

interface Wired {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  /** The next admission answers, in order; then `admitted`. */
  answers: (() => Response | Promise<Response>)[];
  sessions: SessionManager;
  keeper: CashierAdmissionKeeper;
  grants: OfflineGrantWiring;
  audits: AuditEvent[];
  logLines: string[];
}

let g: GrantDb;
let store: OfflineGrantStore;

function wire(grantStore: OfflineGrantStore = store): Wired {
  const answers: (() => Response | Promise<Response>)[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = urlOf(input).slice(BASE.length);
    if (init?.method === 'POST' && path === ADMISSIONS) {
      return Promise.resolve((answers.shift() ?? (() => json(200, ADMITTED_BODY)))());
    }
    if (path.endsWith('/end')) return Promise.resolve(json(200, { kind: 'ended' }));
    return Promise.resolve(errorJson(401));
  };
  const logLines: string[] = [];
  const logger = pino({ level: 'trace' }, { write: (s: string) => void logLines.push(s) });
  const audits: AuditEvent[] = [];
  const grants = createOfflineGrantWiring({
    store: grantStore,
    audit: { emit: (e) => void audits.push(e) },
    uuid: () => `evt-${String(audits.length)}`,
    now: () => new Date(),
    logger,
  });
  grants.setScope(SCOPE);
  const sessions = new SessionManager();
  const cascade = new LifecycleCascade({ sessionManager: sessions, logger });
  const protoStore = new ProtoSessionStore();
  const backend = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
  const admissionClient = createCashierAdmissionClient({
    baseUrl: BASE,
    fetch: fetchImpl,
    getDeviceToken: () => Promise.resolve(DEVICE_TOKEN),
  });
  const admission: CashierAdmissionDeps = {
    client: admissionClient,
    grantSeam: grants.seam,
    onDeviceRevoked: () => {
      cascade.notifyTerminalRevoked();
    },
  };
  const keeper = new CashierAdmissionKeeper({
    sessionManager: sessions,
    admission,
    isAtSafePoint: () => true,
    logger,
  });
  const pairingStore: PairingStore = {
    getStatus: () =>
      Promise.resolve({
        kind: 'paired',
        tenant_id: SCOPE.tenant_id,
        branch_id: SCOPE.branch_id,
        terminal_id: SCOPE.terminal_id,
        terminal_label: 'T1',
        paired_at: SCOPE.pairing_epoch,
      }),
    getCurrentTerminalId: () => SCOPE.terminal_id,
    persist: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
  const db = {
    prepare: (sql: string) =>
      /^\s*SELECT\s+closed_at/i.test(sql)
        ? { get: () => undefined }
        : /^\s*SELECT/i.test(sql)
          ? { get: () => pinRow }
          : { run: () => undefined },
  } as unknown as DatabaseHandle;
  const auditEmitter = { emit: vi.fn() } as unknown as AuditEmitter;
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  registerOperatorHandlers(ipcMain, {
    signInHandler: new SignInHandler({
      clerk: {} as ClerkExchanger,
      backend,
      sessionManager: sessions,
      deviceTokenAttestation: () => DEVICE_TOKEN,
      protoStore,
      logger,
    }),
    cashierSignInHandler: new CashierSignInHandler({
      db,
      safeStorage: pinSafeStorage,
      sessionManager: sessions,
      admission,
      pairingStore,
      protoStore,
      logger,
    }),
    signOutHandler: new SignOutHandler({
      backend,
      sessionManager: sessions,
      jwtFor: () => null,
      logger,
    }),
    rosterHandler: new RosterHandler({ cashierAdmissions: admissionClient, logger }),
    sessionManager: sessions,
    inactivityMonitor: { reportActivity: vi.fn() } as unknown as InactivityMonitor,
    auditEmitter,
    pairingStore,
    takeoverHandler: new TakeoverHandler({
      protoStore,
      sessionManager: sessions,
      backend,
      jwtHolder: { set: vi.fn(), get: vi.fn(() => null), clear: vi.fn() },
      auditEmitter,
      pairingStore,
      deviceTokenAttestation: () => DEVICE_TOKEN,
      cashierAdmission: admission,
      logger,
    }),
    pinManagementHandler: {} as PinManagementHandler,
    forcedCloseHandler: {} as ForcedCloseHandler,
    stuckShiftsHandler: {} as StuckShiftsHandler,
  });
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (fn === undefined) throw new Error(`no handler for ${channel}`);
    return await fn({} as IpcMainInvokeEvent, ...args);
  };
  return { invoke, answers, sessions, keeper, grants, audits, logLines };
}

function signIn(w: Wired): Promise<unknown> {
  return w.invoke(OPERATOR_IPC_CHANNELS.SIGN_IN, {
    kind: 'cashier',
    cashier_clerk_user_id: CLERK_ID,
    pin: PIN,
    display_name: 'Mona',
  });
}

function grantRows(): number {
  return rows(g.raw, 'cashier_offline_grants').length;
}

function admissibleNow(w: Wired, user = USER_ID): boolean {
  return w.grants.evaluate(user, new Date()).admissible;
}

/** A second cashier's grant, written straight through the seam. */
function seedOtherCashier(w: Wired): void {
  w.grants.seam.onCashierAdmitted({
    user_id: OTHER_USER_ID,
    operator_id: 'user_clerk_cashier_2',
    admission_id: '0192f6a0-aaaa-7bbb-8ccc-000000000002',
    display_name: 'Other',
    offline_grace_seconds: 86_400,
    server_time: '2026-10-04T10:00:00.000Z',
    received_at: new Date().toISOString(),
    pairing_generation: w.grants.seam.pairingGeneration?.(),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  g = grantDb();
  store = createOfflineGrantStore({
    db: g.handle,
    safeStorage: aeadSafeStorage(),
    now: () => new Date(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  g.raw.close();
});

describe('RT-113 P1.2 — the offline grant over the real cashier paths', () => {
  it('sign-in writes the grant; a heartbeat refreshes it; sign-in never leaks it', async () => {
    const w = wire();
    expect(await signIn(w)).toMatchObject({ kind: 'signed_in' });
    expect(grantRows()).toBe(1);
    expect(admissibleNow(w)).toBe(true);
    // An offline use, then the heartbeat at TTL/2 refreshes (counter back to 0).
    expect(w.grants.consumeOfflineUse(USER_ID, new Date()).admissible).toBe(true);
    await vi.advanceTimersByTimeAsync((TTL_S * 1000) / 2);
    const e = w.grants.evaluate(USER_ID, new Date());
    expect(e.admissible && e.grant.offline_admissions_used).toBe(0);
    const logs = w.logLines.join('\n');
    for (const v of [USER_ID, ADMISSION_ID, 'Mona', CLERK_ID]) expect(logs).not.toContain(v);
    w.keeper.stop();
  });

  it('a takeover writes the grant after active_elsewhere invalidated it (OD6)', async () => {
    const w = wire();
    await signIn(w); // grant written
    await w.invoke(OPERATOR_IPC_CHANNELS.SIGN_OUT);
    w.answers.push(() => json(200, { kind: 'active_elsewhere' }));
    const res = (await signIn(w)) as { kind: string; pending_takeover_id: string };
    expect(res.kind).toBe('takeover_required');
    expect(w.grants.evaluate(USER_ID, new Date())).toEqual({
      admissible: false,
      category: 'grant_invalidated',
    });
    expect(w.audits.map((a) => a.payload)).toEqual([{ reason: 'superseded' }]);
    const confirmed = (await w.invoke(OPERATOR_IPC_CHANNELS.TAKEOVER_CONFIRM, {
      pending_takeover_id: res.pending_takeover_id,
    })) as { kind: string };
    expect(confirmed.kind).toBe('signed_in');
    expect(admissibleNow(w)).toBe(true);
    w.keeper.stop();
  });

  it('a heartbeat 403 invalidates that user only', async () => {
    const w = wire();
    await signIn(w);
    seedOtherCashier(w);
    w.answers.push(() => errorJson(403));
    await vi.advanceTimersByTimeAsync((TTL_S * 1000) / 2);
    expect(admissibleNow(w)).toBe(false);
    expect(admissibleNow(w, OTHER_USER_ID)).toBe(true);
    expect(w.audits.map((a) => [a.acting_operator_id, a.payload])).toEqual([
      [CLERK_ID, { reason: 'forbidden' }],
    ]);
    w.keeper.stop();
  });

  it('a sign-in 403 invalidates that user only', async () => {
    const w = wire();
    await signIn(w);
    await w.invoke(OPERATOR_IPC_CHANNELS.SIGN_OUT);
    seedOtherCashier(w);
    w.answers.push(() => errorJson(403));
    expect(await signIn(w)).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(admissibleNow(w)).toBe(false);
    expect(admissibleNow(w, OTHER_USER_ID)).toBe(true);
    w.keeper.stop();
  });

  it('the FIRST heartbeat device 401 invalidates all grants; the session still waits for the second (OD5)', async () => {
    const w = wire();
    await signIn(w);
    seedOtherCashier(w);
    w.answers.push(() => errorJson(401));
    await vi.advanceTimersByTimeAsync((TTL_S * 1000) / 2);
    expect(w.sessions.getCurrent()?.authority_latch).toBeUndefined();
    expect(admissibleNow(w)).toBe(false);
    expect(admissibleNow(w, OTHER_USER_ID)).toBe(false);
    expect(w.audits.map((a) => a.payload['reason'])).toEqual([
      'device_unauthorized',
      'device_unauthorized',
    ]);
    w.keeper.stop();
  });

  it('a sign-in device 401 invalidates all grants', async () => {
    const w = wire();
    seedOtherCashier(w);
    w.answers.push(() => errorJson(401));
    expect(await signIn(w)).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(admissibleNow(w, OTHER_USER_ID)).toBe(false);
    w.keeper.stop();
  });

  it.each([
    ['a 5xx', () => errorJson(503)],
    ['a 429', () => errorJson(429)],
    ['a 409', () => errorJson(409)],
    ['a 400', () => errorJson(400)],
  ])('%s heartbeat never touches the grant', async (_label, answer) => {
    const w = wire();
    await signIn(w);
    w.answers.push(answer);
    await vi.advanceTimersByTimeAsync((TTL_S * 1000) / 2);
    expect(admissibleNow(w)).toBe(true);
    expect(w.audits).toEqual([]);
    w.keeper.stop();
  });

  it('Codex P1 4181552524: a sign-in answered after a re-pair writes no grant for the new pairing', async () => {
    const w = wire();
    let answer: (r: Response) => void = () => undefined;
    let markSent: () => void = () => undefined;
    const sent = new Promise<void>((resolve) => {
      markSent = resolve;
    });
    w.answers.push(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
          markSent();
        }),
    );
    const pending = signIn(w);
    await sent; // the request is on the wire (after the local PIN check)
    // The terminal is paired again while the request is in flight.
    w.grants.onPairingChange('repair');
    const NEW_SCOPE = { ...SCOPE, terminal_id: 'term-2', pairing_epoch: SCOPE.pairing_epoch + 1 };
    w.grants.setScope(NEW_SCOPE);
    answer(json(200, ADMITTED_BODY));
    expect(await pending).toMatchObject({ kind: 'signed_in' });
    expect(grantRows()).toBe(0);
    expect(w.grants.evaluate(USER_ID, new Date())).toEqual({
      admissible: false,
      category: 'grant_missing',
    });
    w.keeper.stop();
  });

  it('Codex P1 4181552524: a heartbeat answered after a re-pair writes no grant for the new pairing', async () => {
    const w = wire();
    await signIn(w);
    let answer: (r: Response) => void = () => undefined;
    w.answers.push(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync((TTL_S * 1000) / 2);
    w.grants.onPairingChange('repair');
    w.grants.setScope({ ...SCOPE, terminal_id: 'term-2', pairing_epoch: SCOPE.pairing_epoch + 1 });
    answer(json(200, ADMITTED_BODY));
    await vi.advanceTimersByTimeAsync(0);
    expect(grantRows()).toBe(0);
    w.keeper.stop();
  });

  it('a throwing store never breaks sign-in or the heartbeat, and a failed write still refuses', async () => {
    let failing = false;
    const breakable = new Proxy(store, {
      get(target, prop: keyof OfflineGrantStore) {
        const writes: (keyof OfflineGrantStore)[] = [
          'upsertFromAdmitted',
          'invalidate',
          'invalidateAll',
        ];
        if (failing && writes.includes(prop)) {
          return () => {
            throw new Error('disk I/O error');
          };
        }
        return target[prop];
      },
    });
    const w = wire(breakable);
    await signIn(w); // a good grant
    await w.invoke(OPERATOR_IPC_CHANNELS.SIGN_OUT);
    expect(admissibleNow(w)).toBe(true);

    failing = true;
    expect(await signIn(w)).toMatchObject({ kind: 'signed_in' });
    // The refresh failed: the OLD grant is still in the store, yet it no longer counts.
    expect(store.evaluate(SCOPE, USER_ID, new Date()).admissible).toBe(true);
    expect(admissibleNow(w)).toBe(false);
    w.answers.push(() => errorJson(403));
    await vi.advanceTimersByTimeAsync((TTL_S * 1000) / 2);
    // The heartbeat ran its course (the session ended at the safe point).
    expect(w.sessions.getCurrent()).toBeNull();
    expect(w.sessions.getLastEndCause()).toBe('account_disabled_mid_session');
    expect(admissibleNow(w)).toBe(false);
    w.keeper.stop();
  });
});
