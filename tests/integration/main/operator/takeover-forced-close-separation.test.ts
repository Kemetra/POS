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

/**
 * T086 — takeover ↔ forced-close separation invariant.
 *
 * Verifies that `operator.session.takeover` and `shift.forced_close` are
 * independent audit rows with separate event_ids, separate timestamps, and
 * separate action_categories — i.e. they are never conflated into one row
 * even when both actions happen in the same transaction workflow.
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

function makePairingStatus(): PairingStatus {
  return {
    kind: 'paired',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-001',
    terminal_label: 'Terminal 1',
    paired_at: 0,
  };
}

// ─── Shift seed helper ────────────────────────────────────────────────────────

function seedOpenShift(db: SqlJsDatabase, id = 'shift-stuck-1'): string {
  db.run(
    `INSERT INTO shifts
       (id, tenant_id, branch_id, originating_terminal_id,
        opening_operator_id, lifecycle_state, declared_count, opened_at, closed_at)
     VALUES (?, 'tenant-1', 'branch-1', 'terminal-cashier',
             'cashier-op-1', 'open', NULL, '2026-05-12T06:00:00.000Z', NULL)`,
    [id],
  );
  return id;
}

// ─── Captured event log ───────────────────────────────────────────────────────

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

// ─── Handler factory ──────────────────────────────────────────────────────────

function makeHandler(
  db: SqlJsDatabase,
  session: OperatorSessionRecord | null,
  captured: CapturedEvent[],
): ForcedCloseHandler {
  const handle = bindHandle(db);
  const deps: ForcedCloseHandlerDeps = {
    db: handle,
    sessionManager: { getCurrent: () => session },
    pairingStore: {
      getStatus: () => Promise.resolve(makePairingStatus()),
    },
    auditEmitter: makeAuditEmitter(captured),
  };
  return new ForcedCloseHandler(deps);
}

// ─── Helpers: simulate a preceding takeover audit event ───────────────────────

function simulateTakeoverAuditEvent(
  captured: CapturedEvent[],
  {
    takeoverEventId,
    shiftId,
    actingOperatorId,
    tenantId,
    branchId,
  }: {
    takeoverEventId: string;
    shiftId: string;
    actingOperatorId: string;
    tenantId: string;
    branchId: string;
  },
): void {
  // Simulates what TakeoverHandler.emitTakeoverAudit() would produce.
  captured.push({
    event: {
      event_id: takeoverEventId,
      action_category: 'operator.session.takeover',
      tenant_id: tenantId,
      branch_id: branchId,
      originating_terminal_id: 'terminal-001',
      acting_operator_id: actingOperatorId,
      session_id: 'session-mgr-1',
      shift_id: shiftId,
      created_at: new Date().toISOString(),
      approving_supervisor_id: null,
      payload: {
        displaced_operator_id: 'cashier-op-1',
        displaced_session_id: 'old-session-1',
        reason: 'manager_override',
      },
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('T086 — takeover ↔ forced-close audit separation invariant', () => {
  it('forced-close emits exactly one shift.forced_close event, not operator.session.takeover', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];
    const handler = makeHandler(db, makeSession(), captured);

    await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    const forcedCloseEvents = captured.filter(
      (c) => c.event.action_category === 'shift.forced_close',
    );
    const takeoverEvents = captured.filter(
      (c) => c.event.action_category === 'operator.session.takeover',
    );

    expect(forcedCloseEvents).toHaveLength(1);
    expect(takeoverEvents).toHaveLength(0);
    db.close();
  });

  it('when takeover precedes forced-close, both audit rows exist with distinct event_ids', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];

    const takeoverEventId = randomUUID();
    const forcedCloseEventId = randomUUID();

    // Simulate takeover audit event (emitted by TakeoverHandler, not ForcedCloseHandler)
    simulateTakeoverAuditEvent(captured, {
      takeoverEventId,
      shiftId,
      actingOperatorId: 'mgr-operator-1',
      tenantId: 'tenant-1',
      branchId: 'branch-1',
    });

    const handler = makeHandler(db, makeSession(), captured);
    await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: forcedCloseEventId,
    });

    expect(captured).toHaveLength(2);
    const eventIds = captured.map((c) => c.event.event_id);
    expect(new Set(eventIds).size).toBe(2);
    expect(eventIds).toContain(takeoverEventId);
    expect(eventIds).toContain(forcedCloseEventId);
    db.close();
  });

  it('takeover and forced-close audit rows have distinct action_categories', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];

    simulateTakeoverAuditEvent(captured, {
      takeoverEventId: randomUUID(),
      shiftId,
      actingOperatorId: 'mgr-operator-1',
      tenantId: 'tenant-1',
      branchId: 'branch-1',
    });

    const handler = makeHandler(db, makeSession(), captured);
    await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    const categories = captured.map((c) => c.event.action_category);
    expect(categories).toContain('operator.session.takeover');
    expect(categories).toContain('shift.forced_close');
    // No category appears twice — they are independent
    expect(new Set(categories).size).toBe(categories.length);
    db.close();
  });

  it('takeover and forced-close rows reference the same shift_id but have valid timestamps', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];

    const beforeTakeover = new Date().toISOString();

    simulateTakeoverAuditEvent(captured, {
      takeoverEventId: randomUUID(),
      shiftId,
      actingOperatorId: 'mgr-operator-1',
      tenantId: 'tenant-1',
      branchId: 'branch-1',
    });

    const handler = makeHandler(db, makeSession(), captured);
    await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: randomUUID(),
    });

    // Both rows reference the same shift
    for (const { event } of captured) {
      expect(event.shift_id).toBe(shiftId);
    }

    // Each row has a valid ISO timestamp after the test started
    for (const { event } of captured) {
      expect(new Date(event.created_at).toISOString()).toBe(event.created_at);
      expect(new Date(event.created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(beforeTakeover).getTime(),
      );
    }

    db.close();
  });

  it('forced-close event_id does not collide with takeover event_id', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db);
    const captured: CapturedEvent[] = [];

    const takeoverEventId = randomUUID();
    const forcedCloseEventId = randomUUID();

    simulateTakeoverAuditEvent(captured, {
      takeoverEventId,
      shiftId,
      actingOperatorId: 'mgr-operator-1',
      tenantId: 'tenant-1',
      branchId: 'branch-1',
    });

    const handler = makeHandler(db, makeSession(), captured);
    const result = await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'takeover_supersession',
      event_id: forcedCloseEventId,
    });

    expect(result.kind).toBe('forced_closed');
    if (result.kind === 'forced_closed') {
      expect(result.audit_event_id).toBe(forcedCloseEventId);
      expect(result.audit_event_id).not.toBe(takeoverEventId);
    }
    db.close();
  });

  it('forced-close acting_operator_id is the manager who initiated the close, not the shift owner', async () => {
    const db = freshDb();
    const shiftId = seedOpenShift(db, 'shift-separation-3');
    const captured: CapturedEvent[] = [];

    const handler = makeHandler(
      db,
      makeSession({ operator_id: 'manager-who-closes', role: 'manager' }),
      captured,
    );
    await handler.forceCloseShift({
      shift_id: shiftId,
      reason: 'cashier_no_show',
      event_id: randomUUID(),
    });

    const fcEvent = captured.find((c) => c.event.action_category === 'shift.forced_close');
    if (!fcEvent) throw new Error('No shift.forced_close event captured');
    expect(fcEvent.event.acting_operator_id).toBe('manager-who-closes');

    const payload = fcEvent.event.payload as Record<string, unknown>;
    expect(payload['shift_owner_id']).toBe('cashier-op-1');
    expect(payload['forced_close_actor_id']).toBe('manager-who-closes');
    db.close();
  });
});
