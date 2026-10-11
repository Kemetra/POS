import { describe, expect, it, beforeAll, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { PinManagementHandler } from '../pin-management.js';
import type { PinManagementHandlerDeps } from '../pin-management.js';
import { unsealPinMaterial } from '../pin-seal.js';
import { verifyPin } from '../pin-credential.js';
import type { DatabaseHandle } from '../../db/client.js';
import type { AuditEmitter } from '../../audit/audit-emitter.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import { SessionManager, type OperatorSessionRecord } from '../session-manager.js';
import type { PairingStatus } from '../../../shared/pairing-types.js';
import type { SafeStorageLike } from '../../secrets/safe-storage.js';
import { createBackendClient } from '../backend-client.js';
import type { BackendClient, BackendRosterResponse } from '../backend-client.js';
import { createJwtHolder, type JwtHolder } from '../jwt-holder.js';
import { jwtWithExp } from './__helpers__/jwt-fixture.js';
import type { Logger } from 'pino';

/**
 * 019-cashier-pin-provisioning T014–T018 — provisionCashierPin handler.
 *
 * The create path: a manager/admin provisions a rostered cashier's FIRST PIN,
 * born keyed on the provider-neutral `user_id` (028 §16). Mirrors the proven
 * sql.js real-DB harness from tests/integration/main/operator/forced-close.test.ts
 * so column/PK/CHECK semantics match production better-sqlite3 exactly.
 *
 * Covered:
 *  - T014 success + verifier-consumable: row born keyed on user_id (clerk col
 *    also populated), sealed, failed=0, lockout=null; the sealed row unseals +
 *    verifies the provisioned PIN (NFR-2 offline-unlock proof; analyze C1).
 *  - T015 role-gate: cashier session → role_mismatch, no row.
 *  - T016 create-only: existing neutral OR legacy clerk-keyed row → state_invalid,
 *    no duplicate, no secret replaced (FR-5).
 *  - T017 not_ready: roster entry has no user_id → not_ready, no row, no fallback
 *    to a clerk-keyed row (FR-11).
 *  - T018 invalid/unpaired: bad PIN shape or unpaired terminal → invalid_input.
 *  - no_connection: a live roster fetch failure surfaces truthfully (advisor note).
 *  - RT-214: the roster call carries the signed-in manager's operator-identity
 *    JWT (held in the operator JWT holder, keyed on backend_session_id); no
 *    request goes out without one; 401/403 map to existing refusal categories;
 *    neither the JWT nor the PIN reaches a log line or the IPC result.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');

const PIN_BASE_SQL = readFileSync(
  path.join(REPO_ROOT, 'migrations', '0006_cashier_pin_records.sql'),
  'utf8',
);
const PIN_USER_ID_SQL = readFileSync(
  path.join(REPO_ROOT, 'migrations', '0035_add_user_id_to_cashier_pin_records.sql'),
  'utf8',
);

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

// ─── DB factory (0006 + 0035) ─────────────────────────────────────────────────

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(PIN_BASE_SQL);
  db.run(PIN_USER_ID_SQL);
  return db;
}

// ─── sql.js DatabaseHandle adapter (copied from forced-close.test.ts) ──────────

function bindHandle(db: SqlJsDatabase): DatabaseHandle {
  return {
    pragma(): unknown {
      return undefined;
    },
    exec(sql: string): void {
      db.run(sql);
    },
    transaction<T extends (...args: never[]) => unknown>(fn: T): T {
      return fn;
    },
    close(): void {
      /* managed by test */
    },
    prepare(sql: string) {
      return {
        run(...params: unknown[]): unknown {
          const stmt = db.prepare(sql);
          stmt.run(params as NonNullable<Parameters<typeof stmt.run>[0]>);
          stmt.free();
          return undefined;
        },
        get(...params: unknown[]): Record<string, unknown> | undefined {
          const stmt = db.prepare(sql);
          stmt.bind(params as NonNullable<Parameters<typeof stmt.bind>[0]>);
          const has = stmt.step();
          const row = has ? (stmt.getAsObject() as Record<string, unknown>) : undefined;
          stmt.free();
          return row;
        },
      };
    },
  };
}

// ─── Fakes ─────────────────────────────────────────────────────────────────────

interface CapturedEvent {
  event: AuditEvent;
}

function makeAuditEmitter(captured: CapturedEvent[]): AuditEmitter {
  return {
    emit(event: AuditEvent): void {
      captured.push({ event });
    },
  } as unknown as AuditEmitter;
}

/** Reversible fake DPAPI: enc:<plain> on the way in, strip the prefix coming out. */
function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8');
      return s.startsWith('enc:') ? s.slice(4) : s;
    },
  };
}

function makeSession(overrides: Partial<OperatorSessionRecord> = {}): OperatorSessionRecord {
  return {
    id: 'session-mgr-1',
    operator_id: 'mgr-operator-1',
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    backend_session_id: 'bsess-1',
    started_at: '2026-06-13T08:00:00.000Z',
    last_activity_at: '2026-06-13T08:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
    ...overrides,
  };
}

function makePairingStatus(kind: 'paired' | 'unpaired' = 'paired'): PairingStatus {
  if (kind === 'unpaired') {
    return { kind: 'unpaired' };
  }
  return {
    kind: 'paired',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-001',
    terminal_label: 'Terminal 1',
    paired_at: 0,
  };
}

// The cashier we provision: clerk subject = 'clerk-cashier-A', neutral user_id below.
const CASHIER_CLERK_ID = 'clerk-cashier-A';
const CASHIER_USER_ID = '99999999-9999-7999-8999-999999999999';

/** Roster carrying the held DP-2 user_id field (fixture; live until DP-2 ships). */
function rosterWithUserId(): BackendRosterResponse {
  return {
    kind: 'roster',
    cashiers: [
      {
        id: CASHIER_CLERK_ID,
        user_id: CASHIER_USER_ID,
        display_name: 'Cashier A',
        role: 'cashier',
      },
      {
        id: 'clerk-cashier-B',
        user_id: 'other-neutral',
        display_name: 'Cashier B',
        role: 'cashier',
      },
    ],
  };
}

/** Pre-DP-2 roster: entries carry NO user_id (the truthful not_ready state). */
function rosterWithoutUserId(): BackendRosterResponse {
  return {
    kind: 'roster',
    cashiers: [{ id: CASHIER_CLERK_ID, display_name: 'Cashier A', role: 'cashier' }],
  };
}

function fakeBackend(roster: BackendRosterResponse): BackendClient {
  return {
    signIn: vi.fn(),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    listRoster: vi.fn(() => Promise.resolve(roster)),
    confirmTakeover: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    getStuckShifts: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
  };
}

/** A fake backend whose `listRoster` spy is held as a plain function (no unbound method). */
function spiedBackend(): { backend: BackendClient; listRoster: ReturnType<typeof vi.fn> } {
  const listRoster = vi.fn(() => Promise.resolve(rosterWithUserId()));
  return { backend: { ...fakeBackend(rosterWithUserId()), listRoster }, listRoster };
}

// ─── Handler factory ─────────────────────────────────────────────────────────

/** The manager's held operator-identity JWT (opaque test value). */
const MANAGER_JWT = 'manager-operator-identity-jwt';

function makeHandler(opts: {
  db: SqlJsDatabase;
  session: OperatorSessionRecord | null;
  captured: CapturedEvent[];
  roster?: BackendRosterResponse;
  pairing?: PairingStatus;
  /** Override the whole backend (e.g. the real client over a fake fetch). */
  backend?: BackendClient;
  /** JWT held for `bsess-1`; `null` holds nothing. Defaults to MANAGER_JWT. */
  jwt?: string | null;
  logger?: Logger;
  /** RT-358 — a real session manager instead of the static `session`. */
  sessionManager?: SessionManager;
  /** RT-358 — a pre-filled holder instead of one built from `jwt`. */
  jwtHolder?: JwtHolder;
  /** RT-358 — replaces the pairing read (e.g. to act during its await). */
  getStatus?: () => Promise<PairingStatus>;
  clearEnvelope?: (backendSessionId: string) => void;
  nowMs?: () => number;
  monoNowMs?: () => number;
}): PinManagementHandler {
  const jwtHolder = opts.jwtHolder ?? createJwtHolder();
  const jwt = opts.jwt === undefined ? MANAGER_JWT : opts.jwt;
  if (opts.jwtHolder === undefined && jwt !== null) jwtHolder.set('bsess-1', jwt);
  const deps: PinManagementHandlerDeps = {
    db: bindHandle(opts.db),
    safeStorage: fakeSafeStorage(),
    sessionManager:
      opts.sessionManager ??
      ({
        getCurrent: () => opts.session,
      } as PinManagementHandlerDeps['sessionManager']),
    pairingStore: {
      getStatus:
        opts.getStatus ?? (() => Promise.resolve(opts.pairing ?? makePairingStatus('paired'))),
    } as PinManagementHandlerDeps['pairingStore'],
    auditEmitter: makeAuditEmitter(opts.captured),
    backend: opts.backend ?? fakeBackend(opts.roster ?? rosterWithUserId()),
    jwtHolder,
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
    ...(opts.clearEnvelope === undefined ? {} : { clearEnvelope: opts.clearEnvelope }),
    ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
    ...(opts.monoNowMs === undefined ? {} : { monoNowMs: opts.monoNowMs }),
  };
  return new PinManagementHandler(deps);
}

/** A pino-shaped logger that records every call's arguments. */
function capturingLogger(): { logger: Logger; lines: unknown[][] } {
  const lines: unknown[][] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args);
  };
  const logger = { info: record, warn: record, error: record, debug: record } as unknown as Logger;
  return { logger, lines };
}

function selectRow(db: SqlJsDatabase, clerkId: string): Record<string, unknown> | undefined {
  const stmt = db.prepare(
    `SELECT user_id, cashier_clerk_user_id, pin_hash, pin_salt,
            failed_attempt_count, lockout_until
       FROM cashier_pin_records
      WHERE cashier_clerk_user_id = ?`,
  );
  stmt.bind([clerkId]);
  const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : undefined;
  stmt.free();
  return row;
}

function rowCount(db: SqlJsDatabase): number {
  const r = db.exec(`SELECT COUNT(*) FROM cashier_pin_records`);
  return Number(r[0]?.values[0]?.[0] ?? 0);
}

/** Asserts a row exists for the cashier and returns it narrowed (no `!`). */
function requireRow(db: SqlJsDatabase, clerkId: string): Record<string, unknown> {
  const row = selectRow(db, clerkId);
  if (row === undefined) throw new Error(`expected a cashier_pin_records row for ${clerkId}`);
  return row;
}

/** Asserts at least one audit event was captured and returns the first (no `!`). */
function requireFirstEvent(captured: CapturedEvent[]): AuditEvent {
  const first = captured[0];
  if (first === undefined) throw new Error('expected at least one captured audit event');
  return first.event;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('019 — PinManagementHandler.provisionCashierPin', () => {
  it('T014 success: creates a row born keyed on user_id (clerk col also populated), sealed, neutral state', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({ db, session: makeSession({ role: 'manager' }), captured });

    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: '4729',
    });

    expect(result.kind).toBe('pin_provisioned');

    const row = selectRow(db, CASHIER_CLERK_ID);
    expect(row).toBeDefined();
    expect(row?.['user_id']).toBe(CASHIER_USER_ID);
    expect(row?.['cashier_clerk_user_id']).toBe(CASHIER_CLERK_ID);
    expect(row?.['failed_attempt_count']).toBe(0);
    expect(row?.['lockout_until']).toBeNull();
    // Sealed material present and non-empty.
    expect(row?.['pin_hash']).toBeInstanceOf(Uint8Array);
    expect((row?.['pin_hash'] as Uint8Array).length).toBeGreaterThan(0);
    expect(row?.['pin_salt']).toBeInstanceOf(Uint8Array);

    db.close();
  });

  it('T014 verifier-consumable (NFR-2): the just-provisioned sealed row unseals + verifies the PIN', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({ db, session: makeSession({ role: 'manager' }), captured });

    await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: '135790',
    });

    const row = requireRow(db, CASHIER_CLERK_ID);
    const ss = fakeSafeStorage();
    // Same read path the cashier-sign-in handler uses: unseal → verifyPin.
    const unsealed = unsealPinMaterial(
      {
        pin_hash: Buffer.from(row['pin_hash'] as Uint8Array),
        pin_salt: Buffer.from(row['pin_salt'] as Uint8Array),
      },
      ss,
    );
    const verdict = await verifyPin('135790', {
      pin_hash: unsealed.pin_hash,
      pin_salt: unsealed.pin_salt,
      failed_attempt_count: 0,
      lockout_until: null,
    });
    expect(verdict.kind).toBe('match');

    // And a wrong PIN does NOT match — proves the test isn't trivially passing.
    const wrong = await verifyPin('000000', {
      pin_hash: unsealed.pin_hash,
      pin_salt: unsealed.pin_salt,
      failed_attempt_count: 0,
      lockout_until: null,
    });
    expect(wrong.kind).toBe('no_match');

    db.close();
  });

  it('T014 emits a secret-free cashier.pin.provisioned audit event', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({ db, session: makeSession({ role: 'manager' }), captured });

    const eventId = randomUUID();
    await handler.provisionCashierPin({
      event_id: eventId,
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: '4729',
    });

    expect(captured).toHaveLength(1);
    const ev = requireFirstEvent(captured);
    expect(ev.action_category).toBe('cashier.pin.provisioned');
    expect(ev.event_id).toBe(eventId);
    expect(ev.acting_operator_id).toBe('mgr-operator-1');
    expect(ev.payload['target_cashier_id']).toBe(CASHIER_USER_ID);
    expect(ev.payload['terminal_id']).toBe('terminal-001');
    // No secret anywhere in the serialized event.
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain('4729');
    expect(serialized.toLowerCase()).not.toContain('pin_hash');
    expect(serialized.toLowerCase()).not.toContain('pin_salt');

    db.close();
  });

  it('T015 role-gate: a cashier session is refused role_mismatch and writes no row', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({ db, session: makeSession({ role: 'cashier' }), captured });

    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: '4729',
    });

    expect(result).toEqual({ kind: 'refused', category: 'role_mismatch' });
    expect(rowCount(db)).toBe(0);
    expect(captured).toHaveLength(0);
    db.close();
  });

  it('T016 create-only: a pre-existing NEUTRAL-keyed row → state_invalid, no duplicate', async () => {
    const db = freshDb();
    // Seed an existing 019-style row (both keys populated).
    db.run(
      `INSERT INTO cashier_pin_records
         (tenant_id, branch_id, terminal_id, cashier_clerk_user_id, user_id,
          pin_hash, pin_salt, failed_attempt_count, lockout_until,
          created_at, created_by_operator_id)
       VALUES ('tenant-1','branch-1','terminal-001', ?, ?, X'dead', X'beef', 0, NULL,
               '2026-06-13T00:00:00.000Z','prior-mgr')`,
      [CASHIER_CLERK_ID, CASHIER_USER_ID],
    );
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({ db, session: makeSession({ role: 'manager' }), captured });

    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: '4729',
    });

    expect(result).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(rowCount(db)).toBe(1);
    // Secret NOT replaced — the seeded sentinel hash is intact.
    const row = requireRow(db, CASHIER_CLERK_ID);
    expect(Buffer.from(row['pin_hash'] as Uint8Array)).toEqual(Buffer.from([0xde, 0xad]));
    expect(captured).toHaveLength(0);
    db.close();
  });

  it('T016 create-only: a LEGACY clerk-keyed row (user_id NULL) → state_invalid (FR-5)', async () => {
    const db = freshDb();
    // Legacy row: clerk-keyed, user_id NULL (pre-019/017).
    db.run(
      `INSERT INTO cashier_pin_records
         (tenant_id, branch_id, terminal_id, cashier_clerk_user_id,
          pin_hash, pin_salt, failed_attempt_count, lockout_until,
          created_at, created_by_operator_id)
       VALUES ('tenant-1','branch-1','terminal-001', ?, X'dead', X'beef', 0, NULL,
               '2026-06-13T00:00:00.000Z','prior-mgr')`,
      [CASHIER_CLERK_ID],
    );
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({ db, session: makeSession({ role: 'manager' }), captured });

    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: '4729',
    });

    expect(result).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(rowCount(db)).toBe(1);
    // No second row created, legacy row's user_id still NULL (not upgraded in place).
    const row = requireRow(db, CASHIER_CLERK_ID);
    expect(row['user_id']).toBeNull();
    expect(captured).toHaveLength(0);
    db.close();
  });

  it('T017 not_ready: roster entry has no user_id → not_ready, no row, no clerk fallback (FR-11)', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({
      db,
      session: makeSession({ role: 'manager' }),
      captured,
      roster: rosterWithoutUserId(),
    });

    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: '4729',
    });

    expect(result).toEqual({ kind: 'refused', category: 'not_ready' });
    expect(rowCount(db)).toBe(0);
    expect(captured).toHaveLength(0);
    db.close();
  });

  it('T017 not_ready: target_cashier_id not present on any roster entry → not_ready, no row', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({ db, session: makeSession({ role: 'manager' }), captured });

    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: 'not-a-rostered-cashier',
      initial_pin: '4729',
    });

    expect(result).toEqual({ kind: 'refused', category: 'not_ready' });
    expect(rowCount(db)).toBe(0);
    db.close();
  });

  it('RT-235 review: a roster entry whose user_id is the empty string is not_ready, no row (sign-in rejects an empty neutral id)', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({
      db,
      session: makeSession({ role: 'manager' }),
      captured,
      roster: {
        kind: 'roster',
        cashiers: [
          { id: CASHIER_CLERK_ID, user_id: '', display_name: 'Cashier A', role: 'cashier' },
        ],
      },
    });

    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: '4729',
    });

    expect(result).toEqual({ kind: 'refused', category: 'not_ready' });
    expect(rowCount(db)).toBe(0);
    expect(captured).toHaveLength(0);
    db.close();
  });

  it('RT-235 the neutral user_id is resolved main-side: a request naming the user_id (not the roster id) is not_ready, no row', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({ db, session: makeSession({ role: 'manager' }), captured });

    // The renderer only ever holds the roster `id`; a raw user_id must never be accepted as the key.
    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_USER_ID,
      initial_pin: '4729',
    });

    expect(result).toEqual({ kind: 'refused', category: 'not_ready' });
    expect(rowCount(db)).toBe(0);
    db.close();
  });

  it('T018 invalid_input: a non 4–6 digit PIN is refused, value never echoed, no row', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({ db, session: makeSession({ role: 'manager' }), captured });

    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: 'abc', // not digits
    });

    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(rowCount(db)).toBe(0);
    db.close();
  });

  it('T018 invalid_input: an unpaired terminal is refused, no row', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({
      db,
      session: makeSession({ role: 'manager' }),
      captured,
      pairing: makePairingStatus('unpaired'),
    });

    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: '4729',
    });

    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(rowCount(db)).toBe(0);
    db.close();
  });

  it('no_connection: a roster fetch failure surfaces truthfully (not invalid_input)', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler({
      db,
      session: makeSession({ role: 'manager' }),
      captured,
      roster: { kind: 'no_connection' },
    });

    const result = await handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: '4729',
    });

    expect(result).toEqual({ kind: 'refused', category: 'no_connection' });
    expect(rowCount(db)).toBe(0);
    db.close();
  });
});

// ─── RT-214 — the manager roster call carries the manager's operator JWT ─────

describe('RT-214 — provisionCashierPin authenticates the manager roster call', () => {
  const PIN = '4729';

  function provision(
    handler: PinManagementHandler,
  ): ReturnType<PinManagementHandler['provisionCashierPin']> {
    return handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_CLERK_ID,
      initial_pin: PIN,
    });
  }

  it('passes the held manager JWT (keyed on the session backend_session_id) to listRoster', async () => {
    const db = freshDb();
    const { backend, listRoster } = spiedBackend();
    const handler = makeHandler({ db, session: makeSession(), captured: [], backend });

    await expect(provision(handler)).resolves.toMatchObject({ kind: 'pin_provisioned' });
    expect(listRoster).toHaveBeenCalledExactlyOnceWith('branch-1', MANAGER_JWT);
    db.close();
  });

  it('end to end through the real client: the request carries Authorization: Bearer <manager jwt>', async () => {
    const db = freshDb();
    const requests: Request[] = [];
    const backend = createBackendClient({
      baseUrl: 'https://backend-core.test',
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          new Response(JSON.stringify(rosterWithUserId()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });
    const handler = makeHandler({ db, session: makeSession(), captured: [], backend });

    await expect(provision(handler)).resolves.toMatchObject({ kind: 'pin_provisioned' });
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(new URL(req?.url ?? '').pathname).toBe('/api/pos/v1/operators/roster');
    expect(req?.headers.get('authorization')).toBe(`Bearer ${MANAGER_JWT}`);
    db.close();
  });

  for (const [label, jwt] of [
    ['no JWT held', null],
    ['an empty JWT held', ''],
  ] as const) {
    it(`${label} → not_signed_in, no roster request, no row`, async () => {
      const db = freshDb();
      const captured: CapturedEvent[] = [];
      const { backend, listRoster } = spiedBackend();
      const handler = makeHandler({ db, session: makeSession(), captured, backend, jwt });

      await expect(provision(handler)).resolves.toEqual({
        kind: 'refused',
        category: 'not_signed_in',
      });
      expect(listRoster).not.toHaveBeenCalled();
      expect(rowCount(db)).toBe(0);
      expect(captured).toHaveLength(0);
      db.close();
    });
  }

  it('a JWT held for a DIFFERENT backend session is not used → not_signed_in, no request', async () => {
    const db = freshDb();
    const { backend, listRoster } = spiedBackend();
    const handler = makeHandler({
      db,
      session: makeSession({ backend_session_id: 'bsess-other' }),
      captured: [],
      backend,
    });

    await expect(provision(handler)).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    expect(listRoster).not.toHaveBeenCalled();
    db.close();
  });

  for (const [roster, category] of [
    // RT-358 (RT-247 D-A1): a 401 asks the manager to sign in again in place.
    [{ kind: 'unauthenticated' }, 'reauth_required'],
    [{ kind: 'no_token' }, 'not_signed_in'],
    [{ kind: 'forbidden' }, 'role_mismatch'],
    [{ kind: 'refused' }, 'invalid_input'],
  ] as const) {
    it(`roster ${roster.kind} → ${category}, no row, no audit event`, async () => {
      const db = freshDb();
      const captured: CapturedEvent[] = [];
      const handler = makeHandler({ db, session: makeSession(), captured, roster });

      await expect(provision(handler)).resolves.toEqual({ kind: 'refused', category });
      expect(rowCount(db)).toBe(0);
      expect(captured).toHaveLength(0);
      db.close();
    });
  }

  for (const [status, category] of [
    [401, 'reauth_required'],
    [403, 'role_mismatch'],
  ] as const) {
    it(`real client: HTTP ${String(status)} from Backend-Core → ${category}`, async () => {
      const db = freshDb();
      const backend = createBackendClient({
        baseUrl: 'https://backend-core.test',
        fetch: () => Promise.resolve(new Response('{"error":"unauthorized"}', { status })),
      });
      const handler = makeHandler({ db, session: makeSession(), captured: [], backend });

      await expect(provision(handler)).resolves.toEqual({ kind: 'refused', category });
      expect(rowCount(db)).toBe(0);
      db.close();
    });
  }

  it('neither the JWT nor the PIN reaches a log line or the IPC result', async () => {
    const outcomes: unknown[] = [];
    const { logger, lines } = capturingLogger();
    for (const opts of [
      {},
      { jwt: null },
      { roster: { kind: 'unauthenticated' } as const },
      { roster: { kind: 'forbidden' } as const },
    ]) {
      const db = freshDb();
      const handler = makeHandler({ db, session: makeSession(), captured: [], logger, ...opts });
      outcomes.push(await provision(handler));
      db.close();
    }

    expect(lines.length).toBeGreaterThan(0);
    const logged = JSON.stringify(lines);
    const returned = JSON.stringify(outcomes);
    for (const secret of [MANAGER_JWT, PIN]) {
      expect(logged).not.toContain(secret);
      expect(returned).not.toContain(secret);
    }
    expect(logged.toLowerCase()).not.toContain('bearer');
  });
});

// ─── RT-358 (RT-247 D-A1) — re-auth required, retry once, fail closed ────────

describe('RT-358 — provisionCashierPin with an expired manager sign-in JWT', () => {
  const NOW_MS = Date.parse('2026-10-11T12:00:00.000Z');
  const MONO = 9_000_000;
  const EXPIRED = jwtWithExp(NOW_MS / 1000 - 60);
  const VALID = jwtWithExp(NOW_MS / 1000 + 600);

  function liveSession(sm = new SessionManager(), backend_session_id = 'bsess-1'): SessionManager {
    sm.create({
      operator_id: 'mgr-operator-1',
      display_name: 'Manager One',
      role: 'manager',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      backend_session_id,
    });
    return sm;
  }

  function rosterOnce(...answers: BackendRosterResponse[]): {
    backend: BackendClient;
    listRoster: ReturnType<typeof vi.fn>;
  } {
    const queue = [...answers];
    const listRoster = vi.fn(() => Promise.resolve(queue.shift() ?? rosterWithUserId()));
    return { backend: { ...fakeBackend(rosterWithUserId()), listRoster }, listRoster };
  }

  function provision(
    handler: PinManagementHandler,
    target = CASHIER_CLERK_ID,
  ): ReturnType<PinManagementHandler['provisionCashierPin']> {
    return handler.provisionCashierPin({
      event_id: randomUUID(),
      target_cashier_id: target,
      initial_pin: '4729',
    });
  }

  function build(opts: {
    db: SqlJsDatabase;
    sm: SessionManager;
    holder: JwtHolder;
    backend: BackendClient;
    getStatus?: () => Promise<PairingStatus>;
    clearEnvelope?: (id: string) => void;
  }): PinManagementHandler {
    return makeHandler({
      db: opts.db,
      session: null,
      captured: [],
      backend: opts.backend,
      sessionManager: opts.sm,
      jwtHolder: opts.holder,
      ...(opts.getStatus === undefined ? {} : { getStatus: opts.getStatus }),
      ...(opts.clearEnvelope === undefined ? {} : { clearEnvelope: opts.clearEnvelope }),
      nowMs: () => NOW_MS,
      monoNowMs: () => MONO,
    });
  }

  function holderWith(jwt: string, marked = false): JwtHolder {
    const h = createJwtHolder();
    h.set('bsess-1', jwt, marked ? { reauthenticatedAtMs: MONO - 100 } : undefined);
    return h;
  }

  it('an expired JWT → reauth_required, and no roster request is sent', async () => {
    const db = freshDb();
    const { backend, listRoster } = rosterOnce();
    const sm = liveSession();
    const res = await provision(build({ db, sm, holder: holderWith(EXPIRED), backend }));

    expect(res).toEqual({ kind: 'refused', category: 'reauth_required' });
    expect(listRoster).not.toHaveBeenCalled();
    expect(rowCount(db)).toBe(0);
    expect(sm.getCurrent()).not.toBeNull();
    db.close();
  });

  it('a 401 on an unmarked request → reauth_required; the session is not ended', async () => {
    const db = freshDb();
    const { backend } = rosterOnce({ kind: 'unauthenticated' });
    const sm = liveSession();
    const res = await provision(build({ db, sm, holder: holderWith(VALID), backend }));

    expect(res).toEqual({ kind: 'refused', category: 'reauth_required' });
    expect(sm.getCurrent()).not.toBeNull();
    db.close();
  });

  it('the marked retry skips the exp pre-check (fast clock) and provisions on success', async () => {
    const db = freshDb();
    const { backend, listRoster } = rosterOnce(rosterWithUserId());
    const sm = liveSession();
    const holder = holderWith(EXPIRED, true);
    const res = await provision(build({ db, sm, holder, backend }));

    expect(res).toMatchObject({ kind: 'pin_provisioned' });
    expect(listRoster).toHaveBeenCalledWith('branch-1', EXPIRED);
    expect(holder.hasFreshMark('bsess-1', MONO)).toBe(false);
    db.close();
  });

  it('a 401 on the marked retry ends that session and clears its JWT, mark and envelope', async () => {
    const db = freshDb();
    const { backend, listRoster } = rosterOnce({ kind: 'unauthenticated' });
    const sm = liveSession();
    const holder = holderWith(EXPIRED, true);
    const cleared: string[] = [];
    const res = await provision(
      build({ db, sm, holder, backend, clearEnvelope: (id) => cleared.push(id) }),
    );

    expect(res).toEqual({ kind: 'refused', category: 'not_signed_in' });
    expect(listRoster).toHaveBeenCalledTimes(1);
    expect(sm.getCurrent()).toBeNull();
    expect(sm.getLastEndCause()).toBe('account_disabled_mid_session');
    expect(holder.get('bsess-1')).toBeNull();
    expect(cleared).toEqual(['bsess-1']);
    expect(rowCount(db)).toBe(0);
    db.close();
  });

  it('the mark is consumed by a successful call: a later 401 asks for re-auth again', async () => {
    const db = freshDb();
    const { backend } = rosterOnce(rosterWithUserId(), { kind: 'unauthenticated' });
    const sm = liveSession();
    const handler = build({ db, sm, holder: holderWith(VALID, true), backend });

    await expect(provision(handler)).resolves.toMatchObject({ kind: 'pin_provisioned' });
    await expect(provision(handler, 'clerk-cashier-B')).resolves.toEqual({
      kind: 'refused',
      category: 'reauth_required',
    });
    expect(sm.getCurrent()).not.toBeNull();
    db.close();
  });

  it.each([
    [
      'locked',
      (sm: SessionManager) => {
        sm.lock('2026-10-11T12:00:00.000Z');
      },
    ],
    [
      'latched',
      (sm: SessionManager) =>
        sm.latchAuthority(sm.getCurrent()?.id ?? '', 'terminal_session_terminated'),
    ],
  ])('a %s session → state_invalid at entry, no request', async (_label, mutate) => {
    const db = freshDb();
    const { backend, listRoster } = rosterOnce();
    const sm = liveSession();
    mutate(sm);
    const res = await provision(build({ db, sm, holder: holderWith(VALID), backend }));

    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(listRoster).not.toHaveBeenCalled();
    db.close();
  });

  it('a lock while the pairing read is awaited → state_invalid, no request', async () => {
    const db = freshDb();
    const { backend, listRoster } = rosterOnce();
    const sm = liveSession();
    const getStatus = (): Promise<PairingStatus> => {
      sm.lock('2026-10-11T12:00:00.000Z');
      return Promise.resolve(makePairingStatus('paired'));
    };
    const res = await provision(build({ db, sm, holder: holderWith(VALID), backend, getStatus }));

    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(listRoster).not.toHaveBeenCalled();
    db.close();
  });

  it('a new session during the pairing read → not_signed_in, no request', async () => {
    const db = freshDb();
    const { backend, listRoster } = rosterOnce();
    const sm = liveSession();
    const getStatus = (): Promise<PairingStatus> => {
      sm.end('signed_out');
      liveSession(sm, 'bsess-1');
      return Promise.resolve(makePairingStatus('paired'));
    };
    const res = await provision(build({ db, sm, holder: holderWith(VALID), backend, getStatus }));

    expect(res).toEqual({ kind: 'refused', category: 'not_signed_in' });
    expect(listRoster).not.toHaveBeenCalled();
    db.close();
  });

  it.each([
    [
      'locks',
      (sm: SessionManager) => {
        sm.lock('2026-10-11T12:00:00.000Z');
      },
      'state_invalid',
    ],
    [
      'is latched',
      (sm: SessionManager) =>
        sm.latchAuthority(sm.getCurrent()?.id ?? '', 'terminal_session_terminated'),
      'state_invalid',
    ],
    [
      'is replaced',
      (sm: SessionManager) => {
        sm.end('signed_out');
        liveSession(sm, 'bsess-2');
      },
      'not_signed_in',
    ],
  ] as const)(
    'the session %s while the roster request is in flight → no PIN written',
    async (_label, mutate, category) => {
      const db = freshDb();
      const sm = liveSession();
      const listRoster = vi.fn(() => {
        mutate(sm);
        return Promise.resolve(rosterWithUserId());
      });
      const backend = { ...fakeBackend(rosterWithUserId()), listRoster };
      const res = await provision(build({ db, sm, holder: holderWith(VALID), backend }));

      expect(res).toEqual({ kind: 'refused', category });
      expect(rowCount(db)).toBe(0);
      db.close();
    },
  );

  it('an unmarked 401 after a lock during the roster request → state_invalid, no prompt', async () => {
    const db = freshDb();
    const sm = liveSession();
    const listRoster = vi.fn(() => {
      sm.lock('2026-10-11T12:00:00.000Z');
      return Promise.resolve({ kind: 'unauthenticated' } as const);
    });
    const backend = { ...fakeBackend(rosterWithUserId()), listRoster };
    const res = await provision(build({ db, sm, holder: holderWith(VALID), backend }));

    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(sm.getCurrent()).not.toBeNull();
    db.close();
  });

  it('a late marked 401 after the session was replaced ends nothing and clears nothing', async () => {
    const db = freshDb();
    const sm = liveSession();
    const holder = holderWith(VALID, true);
    const cleared: string[] = [];
    const listRoster = vi.fn(() => {
      sm.end('signed_out');
      liveSession(sm, 'bsess-2');
      holder.set('bsess-2', 'jwt-2', { reauthenticatedAtMs: MONO });
      return Promise.resolve({ kind: 'unauthenticated' } as const);
    });
    const backend = { ...fakeBackend(rosterWithUserId()), listRoster };
    const res = await provision(
      build({ db, sm, holder, backend, clearEnvelope: (id) => cleared.push(id) }),
    );

    expect(res).toEqual({ kind: 'refused', category: 'not_signed_in' });
    expect(sm.getCurrent()?.backend_session_id).toBe('bsess-2');
    expect(holder.get('bsess-2')).toBe('jwt-2');
    expect(holder.hasFreshMark('bsess-2', MONO)).toBe(true);
    expect(cleared).toEqual([]);
    db.close();
  });
});
