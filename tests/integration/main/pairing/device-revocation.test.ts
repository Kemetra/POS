import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../../../src/main/operator/__tests__/__helpers__/offline-grant-fixture.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import { createInMemorySecretStore } from '../../../../src/main/secrets/in-memory.js';
import { makeSecretKey, type SecretStore } from '../../../../src/shared/secret-store.js';
import {
  bindPairingStoreDb,
  createPairingStore,
  type PersistInput,
} from '../../../../src/main/pairing/store.js';
import { createSendableDeviceTokenReader } from '../../../../src/main/pairing/device-token.js';
import {
  DEVICE_401_CONFIRM_MS,
  createDeviceAuthDetector,
  deviceAuthConfirmDelayMs,
  withDeviceAuthObservation,
  type DeviceAuthDetector,
} from '../../../../src/main/pairing/device-auth-detector.js';
import {
  createDeviceRevocationFlow,
  createRosterConfirmationProbe,
  withDeviceRevocationRecovery,
} from '../../../../src/main/app/device-revocation-flow.js';
import { createCashierAdmissionClient } from '../../../../src/main/operator/cashier-admission-client.js';
import {
  admitCashierOnline,
  type CashierAdmissionDeps,
  type CashierAdmissionInvalidation,
} from '../../../../src/main/operator/cashier-admission.js';
import { CashierAdmissionKeeper } from '../../../../src/main/operator/cashier-admission-keeper.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import { createJwtHolder } from '../../../../src/main/operator/jwt-holder.js';
import { SignInHandler } from '../../../../src/main/operator/sign-in-handler.js';
import { ProtoSessionStore } from '../../../../src/main/operator/takeover-handler.js';
import type { BackendClient } from '../../../../src/main/operator/backend-client.js';
import type { ClerkExchanger } from '../../../../src/main/operator/clerk-client.js';
import { purgeOtherTerminalPinRecords } from '../../../../src/main/operator/pin-records-purge.js';
import { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../../../src/main/audit/audit-events-store.js';
import { createReadDownClient } from '../../../../src/main/catalogue/read-down/read-down-client.js';
import { createSaleSyncClient } from '../../../../src/main/sales-sync/create-sale-sync-client.js';
import type { PairingService } from '../../../../src/main/pairing/service.js';
import type {
  DeviceRevokedSource,
  PairingStatus,
  PairingStatusChangedEvent,
} from '../../../../src/shared/pairing-types.js';

/**
 * RT-215 — device-revoked state and pairing recovery, end to end on REAL
 * components: the pairing store on the full migration stack (sql.js), the
 * device-401 detector, the cashier-admission and read-down clients built on
 * the observed fetch, the session manager and heartbeat keeper, the audit
 * emitter, the PIN purge and the revocation flow — wired as `src/main/index.ts`
 * wires them. Only Backend-Core is a stub.
 */

const BASE = 'https://backend-core.test';
const KEY = makeSecretKey('terminal.device-token');
const OLD_TOKEN = 'device-token-OLD-SENTINEL-4d2a';
const NEW_TOKEN = 'device-token-NEW-SENTINEL-77c1';
const USER_ID = '0192f6a0-1b2c-7d3e-8f40-123456789abc';
const ADMISSION_ID = '0192f6a0-aaaa-7bbb-8ccc-000000000001';
const TTL_S = 600;
/** RT-219 (#544): every `admitted` carries an opaque generation the session holds. */
const GENERATION = 'gen-signin-0001';

interface SentRequest {
  path: string;
  authorization: string | null;
}

type DeviceStatus = 200 | 401;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const UNAUTHORIZED = (): Response => json(401, { error: 'unauthorized' });

const ADMITTED_BODY = {
  kind: 'admitted',
  admission_id: ADMISSION_ID,
  offline_grace_seconds: 86_400,
  admission_ttl_seconds: TTL_S,
  server_time: '2026-10-05T09:00:00.000Z',
  display_name: 'Mona',
  admission_generation: GENERATION,
};

/**
 * One device-bearer stub route: matched on the path, answering its 2xx while
 * the device is accepted and 401 while it is refused.
 */
interface StubRoute {
  matches: (path: string) => boolean;
  ok: () => Response;
}

const ADMISSIONS = '/api/pos/v1/cashier-admissions';

/** First match wins; anything else is an operator-credential route (sale sync, returns, vouchers). */
const STUB_ROUTES: readonly StubRoute[] = [
  {
    matches: (p) => p === `${ADMISSIONS}/roster`,
    ok: () => json(200, { cashiers: [] }),
  },
  {
    matches: (p) => p.startsWith(`${ADMISSIONS}/`) && p.endsWith('/end'),
    ok: () => new Response(null, { status: 204 }),
  },
  { matches: (p) => p === ADMISSIONS, ok: () => json(200, ADMITTED_BODY) },
  {
    matches: (p) => p === '/api/pos/v1/catalog/snapshot',
    ok: () => json(200, { items: [], cursor: 'c1', next_page_token: null }),
  },
];

/** One request as the stub sees it. */
interface StubRequest {
  path: string;
  deviceStatus: DeviceStatus;
}

function answer(request: StubRequest): Response {
  const route = STUB_ROUTES.find((r) => r.matches(request.path));
  if (route === undefined) return UNAUTHORIZED(); // operator-credential route: always 401 here
  return request.deviceStatus === 401 ? UNAUTHORIZED() : route.ok();
}

function urlOf(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  return new URL(input instanceof URL ? input.href : input.url);
}

/** Stub Backend-Core: the device-bearer routes answer `deviceStatus`; operator routes 401. */
function stubBackend(): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  sent: SentRequest[];
  deviceStatus: { value: DeviceStatus };
} {
  const sent: SentRequest[] = [];
  const deviceStatus = { value: 200 as DeviceStatus };
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = urlOf(input).pathname;
    sent.push({ path, authorization: new Headers(init?.headers).get('Authorization') });
    return Promise.resolve(answer({ path, deviceStatus: deviceStatus.value }));
  };
  return { fetch, sent, deviceStatus };
}

/** A pairing as the test persists it: the terminal and its device token. */
interface PairingFixture {
  terminal_id: string;
  device_token: string;
}

const PAIRING_A: PairingFixture = { terminal_id: 'term-1', device_token: OLD_TOKEN };
const PAIRING_B: PairingFixture = { terminal_id: 'term-2', device_token: NEW_TOKEN };

function pairing({ terminal_id, device_token }: PairingFixture): PersistInput {
  return {
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id,
    terminal_label: 'Till 1',
    paired_at: 1_760_000_000,
    branch_name: 'Branch',
    branch_address: 'Addr',
    tenant_tax_registration_id: 'TRN',
    printer_vendor_id: null,
    printer_product_id: null,
    printer_com_port: null,
    device_token,
  };
}

let raw: SqlJsDatabase;
let handle: DatabaseHandle;
let secrets: SecretStore;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  vi.useFakeTimers();
  raw = freshGrantDb();
  handle = handleFor(raw);
  secrets = createInMemorySecretStore();
});

afterEach(() => {
  vi.useRealTimers();
  raw.close();
});

/** A read-only query against the test database. */
interface SqlQuery {
  sql: string;
}

function rows(query: SqlQuery): unknown[][] {
  return raw.exec(query.sql)[0]?.values ?? [];
}

/** Seed one sale + its outbox row + sync state, as a finalized unsent sale. */
/** Which terminal a seeded row belongs to. */
interface TerminalRef {
  terminal_id: string;
}

/** A seeded PIN record: the terminal it was provisioned on and the cashier. */
interface PinFixture extends TerminalRef {
  user_id: string;
}

function seedUnsentSale({ terminal_id }: TerminalRef): void {
  raw.run(
    `INSERT INTO sales (sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id, envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label, selling_operator_id, selling_operator_display_name, selling_operator_session_id, subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json, settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address, local_calendar_day)
     VALUES ('sale-1', 'SN-1', 'R-1', 'h-1', 'pa', 'c', 'tenant-1', 'branch-1', ?, 'Till 1', 'op1', 'Op', 'sess1', 1000, 0, 0, '[]', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', 'TRN', 'Branch', 'Addr', '2026-10-05')`,
    [terminal_id],
  );
  raw.run(
    `INSERT INTO sale_sync_outbox (outbox_row_id, sale_id, envelope_handoff_action_id, tenant_id, branch_id, terminal_id, state, enqueued_at)
     VALUES ('ob-1', 'sale-1', 'h-1', 'tenant-1', 'branch-1', ?, 'pending', '2026-10-05T00:00:00Z')`,
    [terminal_id],
  );
}

function seedPin({ terminal_id, user_id }: PinFixture): void {
  raw.run(
    `INSERT INTO cashier_pin_records
       (tenant_id, branch_id, terminal_id, user_id, cashier_clerk_user_id, pin_hash, pin_salt,
        failed_attempt_count, lockout_until, created_at, created_by_operator_id)
     VALUES ('tenant-1', 'branch-1', ?, ?, NULL, X'01', X'02', 0, NULL, '2026-10-05T00:00:00Z', 'user_mgr')`,
    [terminal_id, user_id],
  );
}

function salesSnapshot(): unknown {
  return {
    sales: rows({ sql: 'SELECT * FROM sales ORDER BY sale_id' }),
    outbox: rows({ sql: 'SELECT * FROM sale_sync_outbox ORDER BY outbox_row_id' }),
    state: rows({ sql: 'SELECT * FROM sale_sync_state ORDER BY sale_id' }),
  };
}

interface Wired {
  store: ReturnType<typeof createPairingStore>;
  detector: DeviceAuthDetector;
  backend: ReturnType<typeof stubBackend>;
  sessions: SessionManager;
  keeper: CashierAdmissionKeeper;
  admission: CashierAdmissionDeps;
  invalidated: CashierAdmissionInvalidation[];
  jwt: ReturnType<typeof createJwtHolder>;
  envelope: ReturnType<typeof createJwtHolder>;
  pushed: PairingStatusChangedEvent[];
  safe: { value: boolean };
  readSendable: () => Promise<string | null>;
  readDown: ReturnType<typeof createReadDownClient>;
  observedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  service: PairingService;
  relaunches: { count: number };
  workersStarted: { value: boolean };
}

/** Everything wired as `src/main/index.ts` wires it. */
async function wire(): Promise<Wired> {
  const backend = stubBackend();
  const store = createPairingStore({
    secretStore: secrets,
    db: bindPairingStoreDb(handle),
    deviceTokenKey: KEY,
    now: () => new Date('2026-10-05T09:00:00.000Z'),
  });
  await store.persist(pairing(PAIRING_A));
  const readSendable = createSendableDeviceTokenReader({
    pairingStore: store,
    secretStore: secrets,
    deviceTokenKey: KEY,
  });
  const sessions = new SessionManager();
  const late: { onConfirmed: (source: DeviceRevokedSource) => void } = {
    onConfirmed: () => undefined,
  };
  const detector = createDeviceAuthDetector({
    probe: createRosterConfirmationProbe(
      createCashierAdmissionClient({
        baseUrl: BASE,
        fetch: backend.fetch,
        getDeviceToken: readSendable,
      }),
    ),
    confirmDelayMs: () => deviceAuthConfirmDelayMs(sessions.getCurrent()?.admission_ttl_seconds),
    onConfirmed: (source) => {
      late.onConfirmed(source);
    },
  });
  const admissionsFetch = withDeviceAuthObservation(backend.fetch, detector, {
    source: 'cashier_admissions',
    baseUrl: BASE,
  });
  const readDownFetch = withDeviceAuthObservation(backend.fetch, detector, {
    source: 'read_down',
    baseUrl: BASE,
  });
  const invalidated: CashierAdmissionInvalidation[] = [];
  const admission: CashierAdmissionDeps = {
    client: createCashierAdmissionClient({
      baseUrl: BASE,
      fetch: admissionsFetch,
      getDeviceToken: readSendable,
    }),
    grantSeam: {
      onCashierAdmitted: () => undefined,
      onCashierAdmissionInvalidated: (e) => invalidated.push(e),
    },
  };
  const safe = { value: true };
  const keeper = new CashierAdmissionKeeper({
    sessionManager: sessions,
    admission,
    isAtSafePoint: () => safe.value,
  });
  const refuseWhileRevoked = { refuseWhile: () => store.isDeviceRevoked() };
  const jwt = createJwtHolder(refuseWhileRevoked);
  const envelope = createJwtHolder(refuseWhileRevoked);
  const pushed: PairingStatusChangedEvent[] = [];
  const workersStarted = { value: true }; // booted paired: the workers ran
  const relaunches = { count: 0 };
  const auditEmitter = new AuditEmitter(bindAuditEventsStoreDb(handle));
  let n = 0;
  const flow = createDeviceRevocationFlow({
    markDeviceRevoked: () => store.markDeviceRevoked(),
    getStatus: () => store.getStatus(),
    sessions,
    isDeviceRevoked: () => store.isDeviceRevoked(),
    workersAlreadyStarted: () => workersStarted.value,
    relaunch: () => {
      relaunches.count += 1;
    },
    latchSession: () => {
      keeper.latchCurrentSession('terminal_session_terminated');
    },
    clearCredentials: () => {
      jwt.clearAll();
      envelope.clearAll();
    },
    invalidateGrants: () => {
      admission.grantSeam?.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' });
    },
    resetDetector: () => {
      detector.reset();
    },
    purgeOtherTerminalPins: (id) => purgeOtherTerminalPinRecords(handle, id),
    pushStatus: (e) => pushed.push(e),
    audit: auditEmitter,
    uuid: () => `evt-${String(++n)}`,
    now: () => new Date('2026-10-05T09:00:00.000Z'),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  late.onConfirmed = (source) => {
    flow.onConfirmed(source);
  };
  const service = withDeviceRevocationRecovery(
    {
      // The real service persists on success; this one pairs to term-2.
      submit: async () => {
        await store.persist(pairing(PAIRING_B));
        return {
          outcome: 'success',
          tenant_id: 'tenant-1',
          branch_id: 'branch-1',
          terminal_id: 'term-2',
          terminal_label: 'Till 1',
        };
      },
    },
    {
      getStatus: () => store.getStatus(),
      onPaired: (i) => flow.onPaired(i),
      hasSession: () => sessions.getCurrent() !== null,
    },
  );
  const readDown = createReadDownClient({
    baseUrl: BASE,
    fetch: readDownFetch,
    getDeviceToken: readSendable,
  });
  return {
    store,
    detector,
    backend,
    sessions,
    keeper,
    admission,
    invalidated,
    jwt,
    envelope,
    pushed,
    safe,
    readSendable,
    readDown,
    observedFetch: admissionsFetch,
    service,
    relaunches,
    workersStarted,
  };
}

function signInCashier(w: Wired): ReturnType<SessionManager['create']> {
  return w.sessions.create({
    operator_id: 'user_clerk_1',
    display_name: 'Mona',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    backend_session_id: 'bs-1',
    cashier_admission: {
      user_id: USER_ID,
      admission_id: ADMISSION_ID,
      admission_generation: GENERATION,
      admission_ttl_seconds: TTL_S,
      offline_grace_seconds: 86_400,
    },
  });
}

async function signInAttempt(w: Wired): Promise<void> {
  await admitCashierOnline(w.admission, {
    user_id: USER_ID,
    operator_id: 'user_clerk_1',
    takeover: false,
    idempotency_key: 'test-idempotency-key-0001',
  });
}

const rosterCalls = (w: Wired): number =>
  w.backend.sent.filter((r) => r.path.endsWith('/roster')).length;

const DEVICE_REVOKED: PairingStatus = { kind: 'invalid', reason: 'device_revoked' };

describe('RT-215 device revocation — end to end', () => {
  it('one transient 401 does not revoke: the confirmation call answers 2xx', async () => {
    const w = await wire();
    w.backend.deviceStatus.value = 401;
    await signInAttempt(w); // the first 401
    w.backend.deviceStatus.value = 200; // the blip is over
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);
    expect(rosterCalls(w)).toBe(1);
    expect(await w.store.getStatus()).toMatchObject({ kind: 'paired', terminal_id: 'term-1' });
    expect(await w.readSendable()).toBe(OLD_TOKEN);
    expect(w.pushed).toEqual([]);
  });

  it('two consecutive 401s revoke: durable status, holders cleared, grants invalidated, routed, audited', async () => {
    const w = await wire();
    w.jwt.set('bs-1', 'jwt-SENTINEL');
    w.envelope.set('bs-1', 'envelope-SENTINEL');
    w.backend.deviceStatus.value = 401;
    await signInAttempt(w);
    expect(await w.store.getStatus()).toMatchObject({ kind: 'paired' }); // not on the first
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);

    expect(await w.store.getStatus()).toEqual(DEVICE_REVOKED);
    expect(w.jwt.get('bs-1')).toBeNull();
    expect(w.envelope.get('bs-1')).toBeNull();
    expect(w.invalidated).toContainEqual({ reason: 'device_unauthorized' });
    expect(w.pushed).toEqual([{ kind: 'invalid', reason: 'device_revoked' }]); // no session: at once

    const audit = rows({
      sql: `SELECT acting_operator_id, action_category, payload, originating_terminal_id, session_id
         FROM audit_events WHERE action_category LIKE 'pairing.%'`,
    });
    expect(audit).toEqual([
      [
        'system:device',
        'pairing.device_revoked',
        '{"source":"cashier_admissions"}',
        'term-1',
        null,
      ],
    ]);
    expect(JSON.stringify(rows({ sql: 'SELECT * FROM audit_events' }))).not.toContain('SENTINEL');
  });

  it('a device-bearer 2xx in between resets the count (no confirmation call is made)', async () => {
    const w = await wire();
    w.backend.deviceStatus.value = 401;
    await signInAttempt(w);
    w.backend.deviceStatus.value = 200;
    await w.readDown.fetchSnapshot(); // a 2xx
    w.backend.deviceStatus.value = 401; // the server would refuse a confirmation now
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS * 2);
    expect(rosterCalls(w)).toBe(0);
    expect(await w.store.getStatus()).toMatchObject({ kind: 'paired' });
  });

  it('a read-down 401 is reported as device_unauthorized and counts', async () => {
    const w = await wire();
    w.backend.deviceStatus.value = 401;
    await expect(w.readDown.fetchSnapshot()).resolves.toEqual({ kind: 'device_unauthorized' });
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);
    expect(await w.store.getStatus()).toEqual(DEVICE_REVOKED);
    expect(rows({ sql: `SELECT payload FROM audit_events` })).toEqual([['{"source":"read_down"}']]);
  });

  it('operator-credential 401s are ignored, even on the observed fetch', async () => {
    const w = await wire();
    const saleSync = createSaleSyncClient({
      baseUrl: BASE,
      fetch: w.observedFetch,
      getOperatorToken: () => 'envelope-SENTINEL',
    });
    for (let i = 0; i < 3; i += 1) {
      await saleSync.postSale({
        externalId: `pos-pulse:test-${String(i)}`,
        sourceSystem: 'pos-pulse',
        tenantId: 'tenant-1',
        branchId: 'branch-1',
        terminalId: 'term-1',
        operatorId: 'op-1',
        occurredAt: '2026-10-05T09:00:00.000Z',
        totalMinor: 1000,
        lines: [
          {
            lineRef: 'l1',
            productRef: 'p1',
            lineName: 'Item',
            quantity: 1,
            unitPriceMinor: 1000,
            lineAmountMinor: 1000,
          },
        ],
      });
    }
    expect(w.backend.sent.filter((r) => r.path === '/api/pos/v1/sales')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS * 3);
    expect(w.detector.state).toBe('clear');
    expect(rosterCalls(w)).toBe(0);
    expect(await w.store.getStatus()).toMatchObject({ kind: 'paired' });
  });

  it('the token is never sent after the revocation (admission, roster, read-down, confirmation)', async () => {
    const w = await wire();
    w.backend.deviceStatus.value = 401;
    await signInAttempt(w);
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);
    expect(await w.store.getStatus()).toEqual(DEVICE_REVOKED);
    const before = w.backend.sent.length;

    w.backend.deviceStatus.value = 200;
    await signInAttempt(w);
    await w.admission.client.listRoster();
    await w.admission.client.end(ADMISSION_ID, GENERATION);
    await w.readDown.fetchSnapshot();
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS * 3);

    expect(w.backend.sent.slice(before)).toEqual([]); // nothing left the terminal
    expect(await secrets.get(KEY)).toBe(OLD_TOKEN); // still sealed, not deleted
  });

  it('is durable across a restart and routes to recovery at boot', async () => {
    const w = await wire();
    w.backend.deviceStatus.value = 401;
    await signInAttempt(w);
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);

    // "Restart": a fresh store and token reader over the same database.
    const rebooted = createPairingStore({
      secretStore: secrets,
      db: bindPairingStoreDb(handle),
      deviceTokenKey: KEY,
    });
    expect(await rebooted.getStatus()).toEqual(DEVICE_REVOKED); // the router starts at /pairing
    const reader = createSendableDeviceTokenReader({
      pairingStore: rebooted,
      secretStore: secrets,
      deviceTokenKey: KEY,
    });
    expect(await reader()).toBeNull();
  });

  it('latches at once (no new sale), keeps a live tender, and routes only at the safe point', async () => {
    const w = await wire();
    const record = signInCashier(w);
    w.safe.value = false; // a tender is live
    w.backend.deviceStatus.value = 401;
    await vi.advanceTimersByTimeAsync((TTL_S * 1000) / 2); // the heartbeat 401s
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS); // the confirmation 401s

    expect(await w.store.getStatus()).toEqual(DEVICE_REVOKED);
    expect(w.sessions.getCurrent()?.id).toBe(record.id);
    expect(w.sessions.getCurrent()?.authority_latch).toBe('terminal_session_terminated');
    expect(w.pushed).toEqual([]); // the sale is not interrupted

    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.sessions.getCurrent()?.id).toBe(record.id);

    w.safe.value = true; // the tender settled
    w.keeper.recheckSafePoint();
    expect(w.sessions.getCurrent()).toBeNull();
    expect(w.sessions.getLastEndCause()).toBe('terminal_session_terminated');
    expect(w.pushed).toEqual([{ kind: 'invalid', reason: 'device_revoked' }]);
  });

  it('re-pair clears the state, deletes other terminals’ PINs, and never touches a sale or the outbox', async () => {
    const w = await wire();
    seedUnsentSale({ terminal_id: 'term-1' });
    seedPin({ terminal_id: 'term-1', user_id: 'u1' });
    seedPin({ terminal_id: 'term-1', user_id: 'u2' });
    const salesBefore = salesSnapshot();

    w.backend.deviceStatus.value = 401;
    await signInAttempt(w);
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);
    expect(await w.store.getStatus()).toEqual(DEVICE_REVOKED);
    expect(salesSnapshot()).toEqual(salesBefore);

    seedPin({ terminal_id: 'term-2', user_id: 'u3' }); // a PIN provisioned for the new terminal is kept
    w.pushed.length = 0;
    await w.service.submit('NEW-CODE');

    expect(await w.store.getStatus()).toMatchObject({ kind: 'paired', terminal_id: 'term-2' });
    expect(rows({ sql: 'SELECT device_revoked_at FROM terminal_assignment' })).toEqual([[null]]);
    expect(await w.readSendable()).toBe(NEW_TOKEN);
    expect(w.detector.state).toBe('clear');
    expect(rows({ sql: 'SELECT terminal_id, user_id FROM cashier_pin_records' })).toEqual([
      ['term-2', 'u3'],
    ]);
    expect(w.pushed).toEqual([{ kind: 'paired' }]);
    expect(
      rows({
        sql: `SELECT action_category, payload, originating_terminal_id FROM audit_events
          WHERE action_category = 'pairing.device_revoked_cleared'`,
      }),
    ).toEqual([['pairing.device_revoked_cleared', '{"source":"re_pair"}', 'term-2']]);
    // The old terminal's unsent sale and outbox row: untouched (held, RT-221).
    expect(salesSnapshot()).toEqual(salesBefore);

    // A fresh 401 after the re-pair needs its own confirmation again.
    w.backend.deviceStatus.value = 401;
    await signInAttempt(w);
    expect(await w.store.getStatus()).toMatchObject({ kind: 'paired' });
  });

  it('Codex P1: a manager sign-in in flight when revocation is confirmed completes nothing', async () => {
    const w = await wire();
    let release: (v: unknown) => void = () => undefined;
    const signInCall = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const backend = { signIn: signInCall } as unknown as BackendClient;
    const handler = new SignInHandler({
      clerk: {
        exchange: () =>
          Promise.resolve({
            kind: 'ok',
            jwt: 'jwt-SENTINEL',
            operator_id: 'user_mgr',
            display_name: 'Sara',
            role: 'manager',
          }),
      } as unknown as ClerkExchanger,
      backend,
      sessionManager: w.sessions,
      jwtHolder: w.jwt,
      envelopeHolder: w.envelope,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: async () => (await w.readSendable()) ?? '',
      pairingEpoch: () => w.store.getPairingEpoch(),
    });
    const pending = handler.signIn({ kind: 'manager_admin', identifier: 'sara', password: 'pw' });
    await vi.waitFor(() => {
      expect(signInCall).toHaveBeenCalled();
    });

    // Revocation confirmed through the real detector while the sign-in waits.
    w.backend.deviceStatus.value = 401;
    await signInAttempt(w);
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);
    expect(await w.store.getStatus()).toEqual(DEVICE_REVOKED);

    release({
      kind: 'signed_in',
      operator: {
        id: 'user_mgr',
        display_name: 'Sara',
        role: 'manager',
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
      },
      operator_session: { id: 'bs-late', issued_at: '2026-10-05T09:00:00.000Z' },
      pos_operator_envelope: 'envelope-SENTINEL',
    });
    await expect(pending).resolves.toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(w.sessions.getCurrent()).toBeNull();
    expect(w.jwt.get('bs-late')).toBeNull();
    expect(w.envelope.get('bs-late')).toBeNull();
    // Defence in depth: the holders refuse any write while revoked.
    w.jwt.set('bs-late', 'jwt-SENTINEL');
    expect(w.jwt.get('bs-late')).toBeNull();
  });

  it('review F3: a session started after the revocation is latched and ended at once; holders cleared', async () => {
    const w = await wire();
    w.backend.deviceStatus.value = 401;
    await signInAttempt(w);
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);
    expect(await w.store.getStatus()).toEqual(DEVICE_REVOKED);

    signInCashier(w); // slipped past the handler checks (e.g. a dev fixture)
    expect(w.sessions.getCurrent()).toBeNull(); // no sale open: ended at its safe point at once
    expect(w.sessions.getLastEndCause()).toBe('terminal_session_terminated');
  });

  it('review F3: pairing is refused while a (latched) session is alive; allowed once it ends', async () => {
    const w = await wire();
    signInCashier(w);
    w.safe.value = false; // a live tender
    w.backend.deviceStatus.value = 401;
    await vi.advanceTimersByTimeAsync((TTL_S * 1000) / 2 + DEVICE_401_CONFIRM_MS);
    expect(await w.store.getStatus()).toEqual(DEVICE_REVOKED);

    // e.g. a renderer reload mid-tender reaching /pairing
    await expect(w.service.submit('NEW-CODE')).resolves.toEqual({ outcome: 'session_active' });
    expect(await w.store.getStatus()).toEqual(DEVICE_REVOKED); // nothing was paired

    w.safe.value = true;
    w.keeper.recheckSafePoint();
    expect(w.sessions.getCurrent()).toBeNull();
    await expect(w.service.submit('NEW-CODE')).resolves.toMatchObject({ outcome: 'success' });
  });

  it('review F2: a re-pair in a process whose workers ran relaunches; after it is persisted and audited', async () => {
    const w = await wire();
    w.backend.deviceStatus.value = 401;
    await signInAttempt(w);
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);
    await w.service.submit('NEW-CODE');
    expect(w.relaunches.count).toBe(1);
    expect(rows({ sql: 'SELECT terminal_id, device_revoked_at FROM terminal_assignment' })).toEqual(
      [['term-2', null]],
    );
    expect(
      rows({
        sql: `SELECT count(*) FROM audit_events WHERE action_category = 'pairing.device_revoked_cleared'`,
      }),
    ).toEqual([[1]]);
  });

  it('review F2: a first-ever pairing in this process does not relaunch', async () => {
    const w = await wire();
    w.workersStarted.value = false;
    await w.service.submit('NEW-CODE');
    expect(w.relaunches.count).toBe(0);
  });
});
