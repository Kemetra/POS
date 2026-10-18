import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { ForcedCloseHandler } from '../../../../src/main/operator/forced-close-handler.js';
import type { ForcedCloseHandlerDeps } from '../../../../src/main/operator/forced-close-handler.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import type { PairingStatus } from '../../../../src/shared/pairing-types.js';
import { isOperatorRefusal } from '../../../../src/shared/audit/event-shape.js';

/**
 * T085 — forced-close handler audit event emission shape.
 *
 * Verifies: manager/admin can force-close a stuck shift; audit event shape
 * matches FR-025 mandatory attributes; declared_count is absent (null);
 * lifecycle transitions to closed_forced; idempotency via INSERT OR IGNORE;
 * cashier is refused; branch-mismatch manager is refused.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');

const SHIFTS_SQL = readFileSync(path.join(REPO_ROOT, 'migrations', '0007_shifts.sql'), 'utf8');
const AUDIT_SQL = readFileSync(path.join(REPO_ROOT, 'migrations', '0004_audit_events.sql'), 'utf8');

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

// ─── DB factory ───────────────────────────────────────────────────────────────

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(SHIFTS_SQL);
  db.run(AUDIT_SQL);
  return db;
}

// ─── sql.js DatabaseHandle adapter ───────────────────────────────────────────

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
          stmt.run(params as Parameters<typeof stmt.run>[1]);
          stmt.free();
          return undefined;
        },
        get(...params: unknown[]): Record<string, unknown> | undefined {
          const stmt = db.prepare(sql);
          stmt.bind(params as Parameters<typeof stmt.bind>[1]);
          const has = stmt.step();
          const row = has ? (stmt.getAsObject() as Record<string, unknown>) : undefined;
          stmt.free();
          return row;
        },
      };
    },
  };
}

// ─── In-process AuditEmitter stub ────────────────────────────────────────────

interface CapturedEvent {
  event: AuditEvent;
}

function makeAuditEmitter(captured: CapturedEvent[], db?: SqlJsDatabase): AuditEmitter {
  return {
    emit(event: AuditEvent): void {
      captured.push({ event });
      // Write to audit_events so the idempotency SELECT in the handler can find it.
      if (db) {
        db.run(
          `INSERT OR IGNORE INTO audit_events
             (event_id, tenant_id, branch_id, originating_terminal_id,
              acting_operator_id, session_id, shift_id, action_category,
              created_at, approving_supervisor_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            event.event_id,
            event.tenant_id,
            event.branch_id,
            event.originating_terminal_id,
            event.acting_operator_id,
            event.session_id ?? null,
            event.shift_id ?? null,
            event.action_category,
            event.created_at,
            event.approving_supervisor_id ?? null,
            JSON.stringify(event.payload),
          ],
        );
      }
    },
  } as unknown as AuditEmitter;
}

function makeThrowingAuditEmitter(): AuditEmitter {
  return {
    emit(): void {
      throw new Error('audit store unavailable');
    },
  } as unknown as AuditEmitter;
}

// ─── Session + pairing fakes ──────────────────────────────────────────────────

function makeSession(overrides: Partial<OperatorSessionRecord> = {}): OperatorSessionRecord {
  return {
    id: 'session-mgr-1',
    operator_id: 'mgr-operator-1',
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    backend_session_id: 'bsess-1',
    started_at: '2026-05-12T08:00:00.000Z',
    last_activity_at: '2026-05-12T08:00:00.000Z',
    ...overrides,
  };
}

function makePairingStatus(terminalId = 'terminal-001'): PairingStatus {
  return {
    kind: 'paired',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: terminalId,
    terminal_label: 'Terminal 1',
    paired_at: 0,
  };
}

// ─── Shift seed helper ────────────────────────────────────────────────────────

function seedOpenShift(
  db: SqlJsDatabase,
  overrides: Partial<{
    id: string;
    tenant_id: string;
    branch_id: string;
    originating_terminal_id: string;
    opening_operator_id: string;
  }> = {},
): string {
  const id = overrides.id ?? 'shift-stuck-1';
  db.run(
    `INSERT INTO shifts
       (id, tenant_id, branch_id, originating_terminal_id,
        opening_operator_id, lifecycle_state, declared_count, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, 'open', NULL, '2026-05-12T06:00:00.000Z', NULL)`,
    [
      id,
      overrides.tenant_id ?? 'tenant-1',
      overrides.branch_id ?? 'branch-1',
      overrides.originating_terminal_id ?? 'terminal-cashier',
      overrides.opening_operator_id ?? 'cashier-op-1',
    ],
  );
  return id;
}

// ─── Handler factory ──────────────────────────────────────────────────────────

function makeHandler(
  db: SqlJsDatabase,
  session: OperatorSessionRecord | null,
  captured: CapturedEvent[],
  pairingTerminalId = 'terminal-001',
): ForcedCloseHandler {
  const handle = bindHandle(db);
  const deps: ForcedCloseHandlerDeps = {
    db: handle,
    sessionManager: { getCurrent: () => session },
    pairingStore: {
      getStatus: () => Promise.resolve(makePairingStatus(pairingTerminalId)),
    },
    auditEmitter: makeAuditEmitter(captured, db),
  };
  return new ForcedCloseHandler(deps);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('T085 — forced-close handler audit event shape', () => {
  it('manager can force-close a stuck shift and receives forced_closed result', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession({ role: 'manager' }), captured);

    const result = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    expect(result.kind).toBe('forced_closed');
    db.close();
  });

  it('admin can force-close a stuck shift', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession({ role: 'admin' }), captured);

    const result = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'cashier_no_show',
      event_id: randomUUID(),
    });

    expect(result.kind).toBe('forced_closed');
    db.close();
  });

  it('audit event has correct action_category and FR-025 mandatory attributes', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db, { opening_operator_id: 'cashier-op-1' });
    const captured: CapturedEvent[] = [];
    const session = makeSession({
      role: 'manager',
      operator_id: 'mgr-operator-1',
      branch_id: 'branch-1',
      tenant_id: 'tenant-1',
    });
    const handler = makeHandler(db, session, captured, 'terminal-001');

    await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: 'evt-t085-shape-1',
    });

    expect(captured).toHaveLength(1);
    const first = captured[0];
    if (!first) throw new Error('No captured event');
    const { event } = first;
    expect(event.action_category).toBe('shift.forced_close');
    // FR-025 mandatory attributes
    expect(event.acting_operator_id).toBe('mgr-operator-1');
    expect(event.originating_terminal_id).toBe('terminal-001');
    expect(typeof event.created_at).toBe('string');
    expect(event.shift_id).toBe(shiftId);
    expect(event.tenant_id).toBe('tenant-1');
    expect(event.branch_id).toBe('branch-1');
    db.close();
  });

  it('audit event payload carries shift_owner_id, forced_close_actor_id and reason', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db, { opening_operator_id: 'cashier-owner-2' });
    const captured: CapturedEvent[] = [];
    const session = makeSession({ role: 'manager', operator_id: 'mgr-actor-2' });
    const handler = makeHandler(db, session, captured);

    await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    const capturedFirst = captured[0];
    if (!capturedFirst) throw new Error('No captured event');
    const payload = capturedFirst.event.payload as Record<string, unknown>;
    expect(payload['shift_owner_id']).toBe('cashier-owner-2');
    expect(payload['forced_close_actor_id']).toBe('mgr-actor-2');
    expect(payload['forced_close_reason']).toBe('takeover_supersession');
    db.close();
  });

  it('declared_count is NULL after forced-close (FR-024(a) absent state)', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession({ role: 'manager' }), captured);

    await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    const row = db.exec(`SELECT declared_count FROM shifts WHERE id = '${shiftId}'`);
    const declaredCount = row[0]?.values[0]?.[0];
    expect(declaredCount).toBeNull();
    db.close();
  });

  it('lifecycle_state is closed_forced after forced-close', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession({ role: 'manager' }), captured);

    await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    const row = db.exec(`SELECT lifecycle_state FROM shifts WHERE id = '${shiftId}'`);
    expect(row[0]?.values[0]?.[0]).toBe('closed_forced');
    db.close();
  });

  it('closed_at is set after forced-close', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession({ role: 'manager' }), captured);

    await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    const row = db.exec(`SELECT closed_at FROM shifts WHERE id = '${shiftId}'`);
    const closedAt = row[0]?.values[0]?.[0];
    expect(typeof closedAt).toBe('string');
    expect((closedAt as string).length).toBeGreaterThan(0);
    db.close();
  });

  it('idempotency — second call with same event_id returns forced_closed no-op; audit not re-emitted', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession({ role: 'manager' }), captured);
    const eventId = randomUUID();

    // First call closes the shift and writes the audit row
    const result1 = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: eventId,
    });
    expect(result1.kind).toBe('forced_closed');
    expect(captured).toHaveLength(1);

    // Retry with the SAME event_id → idempotent success, no duplicate audit
    const result2 = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: eventId,
    });
    expect(result2.kind).toBe('forced_closed');
    if (result2.kind === 'forced_closed') {
      expect(result2.audit_event_id).toBe(eventId);
    }
    expect(captured).toHaveLength(1);
    db.close();
  });

  it('idempotency — second call with different event_id on closed shift returns state_invalid; audit emitted once', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession({ role: 'manager' }), captured);

    // First call closes the shift and emits audit
    const result1 = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });
    expect(result1.kind).toBe('forced_closed');
    expect(captured).toHaveLength(1);

    // Second call with a DIFFERENT event_id — shift already closed_forced → state_invalid
    const result2 = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });
    expect(isOperatorRefusal(result2)).toBe(true);
    if (isOperatorRefusal(result2)) {
      expect(result2.category).toBe('state_invalid');
    }
    expect(captured).toHaveLength(1);
    db.close();
  });

  it('audit emitter failure returns invalid_input; shift remains open with closed_at NULL', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const handle = bindHandle(db);
    const deps: ForcedCloseHandlerDeps = {
      db: handle,
      sessionManager: { getCurrent: () => makeSession({ role: 'manager' }) },
      pairingStore: {
        getStatus: () => Promise.resolve(makePairingStatus()),
      },
      auditEmitter: makeThrowingAuditEmitter(),
    };
    const handler = new ForcedCloseHandler(deps);

    const result = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    expect(isOperatorRefusal(result)).toBe(true);
    if (isOperatorRefusal(result)) {
      expect(result.category).toBe('invalid_input');
    }

    // Shift must remain open — closed_at NULL, lifecycle_state unchanged
    const row = db.exec(`SELECT lifecycle_state, closed_at FROM shifts WHERE id = '${shiftId}'`);
    const values = row[0]?.values[0];
    expect(values?.[0]).toBe('open');
    expect(values?.[1]).toBeNull();
    db.close();
  });

  it('cashier is refused (role_mismatch) — AC-9', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession({ role: 'cashier' }), captured);

    const result = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    expect(isOperatorRefusal(result)).toBe(true);
    if (isOperatorRefusal(result)) {
      expect(result.category).toBe('role_mismatch');
    }
    db.close();
  });

  it('null session is refused (not_signed_in)', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, null, captured);

    const result = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    expect(isOperatorRefusal(result)).toBe(true);
    if (isOperatorRefusal(result)) {
      expect(result.category).toBe('not_signed_in');
    }
    db.close();
  });

  it('branch-mismatch manager is refused (role_mismatch — P17)', async () => {
    const db = freshDb();
    // Shift is on branch-1, session is on branch-2
    const shiftId = seedOpenShift(db, { branch_id: 'branch-1' });
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(
      db,
      makeSession({ role: 'manager', branch_id: 'branch-2' }),
      captured,
    );

    const result = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    expect(isOperatorRefusal(result)).toBe(true);
    if (isOperatorRefusal(result)) {
      expect(result.category).toBe('role_mismatch');
    }
    db.close();
  });

  it('unknown shift returns state_invalid', async () => {
    const db = freshDb();
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession({ role: 'manager' }), captured);

    const result = await handler.forceCloseShift({
      shift_id: 'shift-does-not-exist',
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    expect(isOperatorRefusal(result)).toBe(true);
    if (isOperatorRefusal(result)) {
      expect(result.category).toBe('state_invalid');
    }
    db.close();
  });

  it('result contains audit_event_id matching the provided event_id', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession({ role: 'manager' }), captured);
    const eventId = randomUUID();

    const result = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: eventId,
    });

    if (result.kind === 'forced_closed') {
      expect(result.audit_event_id).toBe(eventId);
    } else {
      throw new Error(`Expected forced_closed, got ${result.kind}`);
    }
    db.close();
  });

  it('originating_terminal_id is empty string when terminal is unpaired', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handle = bindHandle(db);
    const deps: ForcedCloseHandlerDeps = {
      db: handle,
      sessionManager: { getCurrent: () => makeSession({ role: 'manager' }) },
      pairingStore: {
        getStatus: () => Promise.resolve({ kind: 'unpaired' as const }),
      },
      auditEmitter: makeAuditEmitter(captured),
    };
    const handler = new ForcedCloseHandler(deps);

    const result = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    expect(result.kind).toBe('forced_closed');
    expect(captured[0]?.event.originating_terminal_id).toBe('');
    db.close();
  });
});
