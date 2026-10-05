import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import pino from 'pino';

import { registerOperatorHandlers } from '../../../../src/main/ipc/operator.js';
import { OPERATOR_IPC_CHANNELS } from '../../../../src/shared/operator/channels.js';
import { createBackendClient } from '../../../../src/main/operator/backend-client.js';
import { createCashierAdmissionClient } from '../../../../src/main/operator/cashier-admission-client.js';
import {
  NOOP_OFFLINE_GRANT_SEAM,
  type CashierAdmissionDeps,
} from '../../../../src/main/operator/cashier-admission.js';
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
import type { ClerkExchanger } from '../../../../src/main/operator/clerk-client.js';
import type { InactivityMonitor } from '../../../../src/main/operator/inactivity-monitor.js';
import type { PinManagementHandler } from '../../../../src/main/operator/pin-management.js';
import type { ForcedCloseHandler } from '../../../../src/main/operator/forced-close-handler.js';
import type { StuckShiftsHandler } from '../../../../src/main/operator/stuck-shifts-handler.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import type { SafeStorageLike } from '../../../../src/main/secrets/safe-storage.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';

import { contractErrors } from '../../../unit/main/operator/__helpers__/openapi-schema.js';

/**
 * RT-113 P2 / RT-182 — the cashier path end to end through the operator IPC
 * channels, the REAL clients and handlers, against a stub Backend-Core
 * (a recording `fetch`).
 *
 * The stub answers the device-authenticated cashier-admissions routes and,
 * like Backend-Core `main`, 401s anything else (the Clerk-gated operator
 * routes). It proves:
 *  - the cashier path never requests a Clerk-gated `/operators/*` route;
 *  - every request carries the device bearer and nothing secret elsewhere;
 *  - every request body is valid against the contract of record;
 *  - no PIN, device token or other secret reaches a request body, URL or log.
 */

const BASE = 'https://bc.example.test';
const DEVICE_TOKEN = 'dev-tok-0a1b2c3d4e5f-SECRET';
const PIN = '739182';
const USER_ID = '0192f6a0-1b2c-7d3e-8f40-123456789abc';
const CLERK_ID = 'user_clerk_cashier_1';
const ADMISSION_ID = '0192f6a0-aaaa-7bbb-8ccc-000000000001';
const TTL_S = 600;

const PREFIX = Buffer.from('SEALED:', 'utf8');
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.concat([PREFIX, Buffer.from(plain, 'utf8')]),
  decryptString: (buf) => buf.subarray(PREFIX.length).toString('utf8'),
};

let pinRow: Record<string, unknown>;

beforeAll(async () => {
  const { pin_hash, pin_salt } = await hashPin(PIN);
  const sealed = sealPinMaterial({ pin_hash, pin_salt }, safeStorage);
  pinRow = {
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term-1',
    cashier_clerk_user_id: CLERK_ID,
    user_id: USER_ID,
    pin_hash: sealed.pin_hash,
    pin_salt: sealed.pin_salt,
    failed_attempt_count: 0,
    lockout_until: null,
  };
}, 15_000);

interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ADMISSIONS = '/api/pos/v1/cashier-admissions';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorJson(status: number, code: string): Response {
  return json(status, { error: { code, message: 'x', request_id: 'r' } });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** Header names lower-cased by hand: happy-dom's `Headers` keeps the original case. */
function lowerHeaders(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries((headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

function recordRequest(input: RequestInfo | URL, init: RequestInit | undefined): Req {
  return {
    method: init?.method ?? 'GET',
    url: urlOf(input),
    headers: lowerHeaders(init?.headers),
    body: typeof init?.body === 'string' ? init.body : undefined,
  };
}

/** A contract-valid `admitted` (1.1.0-draft: with the RT-219 `admission_generation`). */
const ADMITTED_BODY = {
  kind: 'admitted',
  admission_id: ADMISSION_ID,
  offline_grace_seconds: 86_400,
  admission_ttl_seconds: TTL_S,
  server_time: '2026-10-04T10:00:00.000Z',
  display_name: 'Mona',
  admission_generation: 'gen-default-0000',
};

/** Like Backend-Core main: anything but the device-bearer cashier-admissions routes is 401. */
function deviceAuthorized(req: Req, path: string): boolean {
  return req.headers['authorization'] === `Bearer ${DEVICE_TOKEN}` && path.startsWith(ADMISSIONS);
}

type Route = { method: string; matches: (path: string) => boolean; respond: () => Response };

function stubBackendCore(): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requests: Req[];
  admitQueue: unknown[];
} {
  const requests: Req[] = [];
  const admitQueue: unknown[] = [];
  const admitted = ADMITTED_BODY;
  const routes: Route[] = [
    {
      method: 'GET',
      matches: (p) => p === `${ADMISSIONS}/roster`,
      respond: () =>
        json(200, {
          cashiers: [{ user_id: USER_ID, operator_id: CLERK_ID, display_name: 'Mona' }],
        }),
    },
    {
      method: 'POST',
      matches: (p) => p.endsWith('/end'),
      respond: () => json(200, { kind: 'ended' }),
    },
    {
      method: 'POST',
      matches: (p) => p === ADMISSIONS,
      respond: () => json(200, admitQueue.shift() ?? admitted),
    },
  ];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = recordRequest(input, init);
    requests.push(req);
    const path = req.url.slice(BASE.length);
    if (!deviceAuthorized(req, path)) return Promise.resolve(errorJson(401, 'unauthorized'));
    const route = routes.find((r) => r.method === req.method && r.matches(path));
    return Promise.resolve(route?.respond() ?? errorJson(400, 'validation_error'));
  };
  return { fetch: fetchImpl, requests, admitQueue };
}

function wire(opts: { deviceToken?: string } = {}): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  requests: Req[];
  admitQueue: unknown[];
  logLines: string[];
  sessions: SessionManager;
  keeper: CashierAdmissionKeeper;
} {
  const { fetch, requests, admitQueue } = stubBackendCore();
  const logLines: string[] = [];
  const logger = pino(
    { level: 'trace' },
    {
      write: (s: string) => {
        logLines.push(s);
      },
    },
  );
  const sessions = new SessionManager();
  const cascade = new LifecycleCascade({ sessionManager: sessions, logger });
  const protoStore = new ProtoSessionStore();
  const backend = createBackendClient({ baseUrl: BASE, fetch });
  const admissionClient = createCashierAdmissionClient({
    baseUrl: BASE,
    fetch,
    getDeviceToken: () => Promise.resolve(opts.deviceToken ?? DEVICE_TOKEN),
  });
  const admission: CashierAdmissionDeps = {
    client: admissionClient,
    grantSeam: NOOP_OFFLINE_GRANT_SEAM,
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
        tenant_id: 't1',
        branch_id: 'b1',
        terminal_id: 'term-1',
        terminal_label: 'T1',
        paired_at: 0,
      }),
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
      safeStorage,
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
  return { invoke, requests, admitQueue, logLines, sessions, keeper };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RT-113 P2 cashier path over IPC against a stub Backend-Core', () => {
  it('roster → sign-in (active elsewhere) → take over → heartbeat → sign-out', async () => {
    const w = wire();

    // 1. Roster: device roster, mapped for the picker.
    const roster = await w.invoke(OPERATOR_IPC_CHANNELS.LIST_BRANCH_ROSTER);
    expect(roster).toEqual({
      kind: 'roster',
      source: 'online',
      cashiers: [{ id: CLERK_ID, display_name: 'Mona', role: 'cashier' }],
    });

    // 2. Sign-in: the cashier is live on another till.
    w.admitQueue.push({ kind: 'active_elsewhere' });
    const signIn = (await w.invoke(OPERATOR_IPC_CHANNELS.SIGN_IN, {
      kind: 'cashier',
      cashier_clerk_user_id: CLERK_ID,
      pin: PIN,
      display_name: 'Mona',
    })) as { kind: string; pending_takeover_id?: string };
    expect(signIn.kind).toBe('takeover_required');

    // 3. Take over here: takeover:true admits this device.
    w.admitQueue.push({ ...ADMITTED_BODY, admission_generation: 'gen-takeover-0001' });
    const confirmed = (await w.invoke(OPERATOR_IPC_CHANNELS.TAKEOVER_CONFIRM, {
      pending_takeover_id: signIn.pending_takeover_id,
    })) as { kind: string };
    expect(confirmed.kind).toBe('signed_in');
    expect(w.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(w.sessions.getCurrent()?.admission_generation).toBe('gen-takeover-0001');

    // 4. One heartbeat at TTL/2: same admission, NEW generation (RT-219).
    w.admitQueue.push({ ...ADMITTED_BODY, admission_generation: 'gen-heartbeat-0002' });
    await vi.advanceTimersByTimeAsync((TTL_S * 1000) / 2);
    expect(w.sessions.getCurrent()?.admission_generation).toBe('gen-heartbeat-0002');

    // 5. Sign-out ends the admission (best-effort, fire-and-forget).
    await expect(w.invoke(OPERATOR_IPC_CHANNELS.SIGN_OUT)).resolves.toEqual({
      kind: 'signed_out',
    });
    await vi.advanceTimersByTimeAsync(0);

    const summary = w.requests.map((r) => `${r.method} ${r.url.slice(BASE.length)}`);
    expect(summary).toEqual([
      'GET /api/pos/v1/cashier-admissions/roster',
      'POST /api/pos/v1/cashier-admissions',
      'POST /api/pos/v1/cashier-admissions',
      'POST /api/pos/v1/cashier-admissions',
      `POST /api/pos/v1/cashier-admissions/${ADMISSION_ID}/end`,
    ]);

    // No Clerk-gated operator route is ever requested on the cashier path.
    for (const r of w.requests) expect(r.url).not.toContain('/operators/');

    // Device bearer on every call; no other credential header.
    for (const r of w.requests) {
      expect(r.headers['authorization']).toBe(`Bearer ${DEVICE_TOKEN}`);
      expect(Object.keys(r.headers).filter((h) => h !== 'content-type')).toEqual(['authorization']);
    }

    // RT-219: the `end` echoes the post-heartbeat generation, as JSON, per contract.
    const endRequest = w.requests.find((r) => r.url.endsWith('/end'));
    expect(endRequest?.headers['content-type']).toBe('application/json');
    const endBody = JSON.parse(endRequest?.body as string) as unknown;
    expect(endBody).toEqual({ admission_generation: 'gen-heartbeat-0002' });
    expect(contractErrors('PosCashierAdmissionEndRequest', endBody)).toEqual([]);

    // RT-219: no generation crosses IPC or reaches a log line.
    const ipcAnswers = JSON.stringify([roster, signIn, confirmed]);
    for (const generation of ['gen-takeover-0001', 'gen-heartbeat-0002']) {
      expect(ipcAnswers).not.toContain(generation);
      expect(w.logLines.join('\n')).not.toContain(generation);
    }

    // Every admission body is valid per contract: online, takeover, heartbeat.
    const bodies = w.requests
      .filter((r) => r.url === `${BASE}${ADMISSIONS}`)
      .map((r) => JSON.parse(r.body as string) as Record<string, unknown>);
    expect(bodies.map((b) => b['takeover'])).toEqual([false, true, false]);
    for (const b of bodies) {
      expect(contractErrors('PosCashierAdmissionRequest', b)).toEqual([]);
    }
    // A fresh key per attempt (sign-in, takeover, heartbeat).
    expect(new Set(bodies.map((b) => b['idempotency_key'])).size).toBe(3);

    // No PIN or device token in any URL, body or log line.
    const wire_ = JSON.stringify(w.requests.map((r) => [r.url, r.body]));
    expect(wire_).not.toContain(PIN);
    expect(wire_).not.toContain(DEVICE_TOKEN);
    const logs = w.logLines.join('\n');
    expect(logs).not.toContain(PIN);
    expect(logs).not.toContain(DEVICE_TOKEN);
    expect(logs).not.toContain(ADMISSION_ID);

    w.keeper.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a revoked device (401) refuses the cashier sign-in generically, with no session', async () => {
    const w = wire({ deviceToken: 'revoked-device-token' });
    const res = await w.invoke(OPERATOR_IPC_CHANNELS.SIGN_IN, {
      kind: 'cashier',
      cashier_clerk_user_id: CLERK_ID,
      pin: PIN,
      display_name: 'Mona',
    });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(w.sessions.getCurrent()).toBeNull();
    expect(w.requests.map((r) => `${r.method} ${r.url.slice(BASE.length)}`)).toEqual([
      'POST /api/pos/v1/cashier-admissions',
    ]);
    expect(vi.getTimerCount()).toBe(0);
    w.keeper.stop();
  });
});
