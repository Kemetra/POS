/**
 * RT-530 — the void send engine, on the real journal (sql.js): a void is sent
 * ONLY under its requester's own envelope, held (never dropped) otherwise, and
 * every answer lands as one transition plus one audit event.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createSaleVoidAudit } from '../sale-void-audit.js';
import type { RecordVoidOutcome, SaleVoidClient } from '../sale-void-client.js';
import { createSaleVoidRepository, type SaleVoidRepository } from '../sale-void-repository.js';
import { createSaleVoidSync, type SaleVoidSync, type VoidSender } from '../sale-void-sync.js';
import { buildVoidBodyJson } from '../sale-void-wire.js';
import {
  APPROVER_USER,
  REQUESTER_USER,
  SALE_REF,
  SCOPE,
  newVoidEntry,
} from './__helpers__/sale-void-fixture.js';

const EVENT_REF = '0190f5a2-7b3c-7d4e-8f90-0000000000e1';
const OTHER_USER = '0190f5a2-7b3c-7d4e-8f90-0000000000b9';

let db: SqlJsDatabase;
let repo: SaleVoidRepository;
let audit: AuditEvent[];
let clock: string;
let sender: VoidSender | null;
let saleRef: string | null;
let stopped: boolean;
let outcome: RecordVoidOutcome;
let client: { recordVoid: Mock<SaleVoidClient['recordVoid']> };
let sync: SaleVoidSync;

const REQUESTER_SENDER: VoidSender = {
  scope: SCOPE,
  operatorUserId: REQUESTER_USER,
  envelope: 'envelope-of-the-requester',
};

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-1' });
  const handle = handleFor(db);
  repo = createSaleVoidRepository(handle);
  audit = [];
  clock = '2026-06-07T12:00:00.000Z';
  sender = REQUESTER_SENDER;
  saleRef = SALE_REF;
  stopped = false;
  outcome = { kind: 'recorded', replayed: false, eventRef: EVENT_REF };
  client = {
    recordVoid: vi.fn<SaleVoidClient['recordVoid']>(() => Promise.resolve(outcome)),
  };
  sync = createSaleVoidSync({
    repo,
    client,
    saleRef: () => saleRef,
    audit: createSaleVoidAudit({
      sink: { emit: (event) => audit.push(event) },
      now: () => clock,
      newEventId: () => `evt-${String(audit.length)}`,
    }),
    currentSender: () => sender,
    transaction: (fn) => handle.transaction(fn)(),
    now: () => clock,
    logger: { warn: () => undefined },
    isStopped: () => stopped,
  });
  repo.insert(newVoidEntry(1));
});

afterEach(() => {
  db.close();
});

const sent = (): unknown[][] => client.recordVoid.mock.calls;

describe('sending under the requester envelope', () => {
  it('sends the journaled bytes and key under the requester envelope, and confirms', async () => {
    const summary = await sync.tick();
    expect(summary).toEqual({ confirmed: 1, refused: 0, unresolved: 0 });
    const row = repo.read('v1');
    if (row === null) throw new Error('journaled row missing');
    expect(sent()).toEqual([
      [
        {
          saleRef: SALE_REF,
          bodyJson: buildVoidBodyJson(row, SALE_REF),
          idempotencyKey: row.externalId,
        },
        'envelope-of-the-requester',
      ],
    ]);
    expect(row).toMatchObject({ state: 'confirmed', voidRef: EVENT_REF, attemptCount: 1 });
    expect(audit.map((e) => e.action_category)).toEqual(['sale.void.confirmed']);
    expect(audit[0]).toMatchObject({
      approving_supervisor_id: APPROVER_USER,
      acting_operator_id: 'op-requester',
      originating_terminal_id: 'term-1',
      payload: { void_id: 'v1', void_ref: EVENT_REF, replayed: false, amount_minor: 1500 },
    });
  });

  it('never sends a void under another operator envelope: it waits, untouched', async () => {
    sender = { scope: SCOPE, operatorUserId: OTHER_USER, envelope: 'envelope-of-someone-else' };
    expect(await sync.tick()).toEqual({ confirmed: 0, refused: 0, unresolved: 0 });
    expect(client.recordVoid).not.toHaveBeenCalled();
    expect(repo.read('v1')).toMatchObject({ state: 'pending', attemptCount: 0 });
    expect(audit).toEqual([]);
  });

  it('matches the requester case-insensitively', async () => {
    sender = { ...REQUESTER_SENDER, operatorUserId: REQUESTER_USER.toUpperCase() };
    await sync.tick();
    expect(client.recordVoid).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when nobody eligible is signed in online', async () => {
    sender = null;
    expect(await sync.tick()).toBeNull();
    expect(client.recordVoid).not.toHaveBeenCalled();
    expect(repo.read('v1')?.state).toBe('pending');
  });

  it("sends the requester's voids when the requester signs back in, after another operator held them", async () => {
    sender = { scope: SCOPE, operatorUserId: OTHER_USER, envelope: 'other' };
    await sync.tick();
    expect(client.recordVoid).not.toHaveBeenCalled();
    sender = REQUESTER_SENDER;
    await sync.tick();
    expect(repo.read('v1')?.state).toBe('confirmed');
  });

  it('holds a void until its sale has synced (no server reference), then sends it', async () => {
    saleRef = null;
    expect(await sync.tick()).toEqual({ confirmed: 0, refused: 0, unresolved: 1 });
    expect(client.recordVoid).not.toHaveBeenCalled();
    expect(repo.read('v1')).toMatchObject({ state: 'pending', attemptCount: 0 });
    saleRef = SALE_REF;
    await sync.tick();
    expect(repo.read('v1')?.state).toBe('confirmed');
  });

  it("sends only this terminal's rows", async () => {
    sender = { ...REQUESTER_SENDER, scope: { ...SCOPE, terminalId: 'term-2' } };
    expect(await sync.tick()).toEqual({ confirmed: 0, refused: 0, unresolved: 0 });
    expect(client.recordVoid).not.toHaveBeenCalled();
  });
});

describe('what the server answers', () => {
  it('a refusal is terminal, audited once and never retried', async () => {
    outcome = { kind: 'refused', reason: 'void_outside_business_day' };
    expect(await sync.tick()).toEqual({ confirmed: 0, refused: 1, unresolved: 0 });
    expect(repo.read('v1')).toMatchObject({
      state: 'refused',
      refusalReason: 'void_outside_business_day',
    });
    expect(audit.map((e) => e.action_category)).toEqual(['sale.void.refused']);
    expect(audit[0]?.payload).toMatchObject({ reason: 'void_outside_business_day' });
    await sync.tick();
    expect(client.recordVoid).toHaveBeenCalledTimes(1);
    expect(repo.listUnacknowledgedRefused(SCOPE).map((e) => e.voidId)).toEqual(['v1']);
  });

  it('a void refused for its business day is a visible terminal refusal, not a drop', async () => {
    outcome = { kind: 'refused', reason: 'void_outside_business_day' };
    clock = '2026-06-08T09:00:00.000Z';
    await sync.tick();
    const row = repo.read('v1');
    expect(row?.state).toBe('refused');
    expect(row?.acknowledgedAt).toBeNull();
    expect(repo.listUnacknowledgedRefused(SCOPE)).toHaveLength(1);
  });

  it('an unknown answer keeps the void queued and re-sends the same bytes under the same key', async () => {
    outcome = { kind: 'unknown', category: 'no_connection' };
    expect(await sync.tick()).toEqual({ confirmed: 0, refused: 0, unresolved: 1 });
    expect(repo.read('v1')).toMatchObject({
      state: 'unknown',
      lastErrorCategory: 'no_connection',
      attemptCount: 1,
    });
    clock = '2026-06-07T12:00:05.000Z';
    outcome = { kind: 'recorded', replayed: true, eventRef: EVENT_REF };
    await sync.tick();
    expect(repo.read('v1')).toMatchObject({ state: 'confirmed', attemptCount: 2 });
    expect(sent()).toHaveLength(2);
    expect(sent()[0]).toEqual(sent()[1]);
    expect(audit.map((e) => e.payload)).toEqual([expect.objectContaining({ replayed: true })]);
  });

  it('an unknown row waits out its backoff before the next send', async () => {
    outcome = { kind: 'unknown', category: 'server_error' };
    await sync.tick();
    clock = '2026-06-07T12:00:00.500Z';
    expect(await sync.tick()).toEqual({ confirmed: 0, refused: 0, unresolved: 1 });
    expect(client.recordVoid).toHaveBeenCalledTimes(1);
    clock = '2026-06-07T12:00:01.500Z';
    await sync.tick();
    expect(client.recordVoid).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an unreadable last attempt time', `UPDATE sale_void_journal SET last_attempt_at = 'garbage'`],
    [
      'a clock that went backwards',
      `UPDATE sale_void_journal SET last_attempt_at = '2026-06-07T13:00:00.000Z'`,
    ],
  ])('an unknown row is never stuck behind %s: it is re-sent', async (_label, skew) => {
    outcome = { kind: 'unknown', category: 'server_error' };
    await sync.tick();
    db.run(skew);
    clock = '2026-06-07T12:00:00.100Z';
    await sync.tick();
    expect(client.recordVoid).toHaveBeenCalledTimes(2);
  });

  it('a second confirmation of the same void writes no second audit event', async () => {
    await sync.tick();
    db.run(`UPDATE sale_void_journal SET state = state WHERE void_id = 'v1'`);
    expect(repo.markConfirmed({ voidId: 'v1', voidRef: 'other', now: 't' })).toBe(false);
    expect(audit).toHaveLength(1);
  });
});

describe('single flight, ordering and shutdown', () => {
  it('runs one pass at a time', async () => {
    let release: (value: RecordVoidOutcome) => void = () => undefined;
    client.recordVoid.mockImplementationOnce(
      () =>
        new Promise<RecordVoidOutcome>((resolve) => {
          release = resolve;
        }),
    );
    const first = sync.tick();
    expect(await sync.tick()).toBeNull();
    release(outcome);
    await first;
    expect(client.recordVoid).toHaveBeenCalledTimes(1);
  });

  it('sends oldest first and stops the pass when the sender changes mid-pass', async () => {
    seedSale(db, { sale_id: 'sale-2' });
    repo.insert(
      newVoidEntry(2, {
        saleId: 'sale-2',
        approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000a2',
        now: '2026-06-07T10:07:00.000Z',
      }),
    );
    client.recordVoid.mockImplementation(() => {
      sender = { scope: SCOPE, operatorUserId: OTHER_USER, envelope: 'other' };
      return Promise.resolve(outcome);
    });
    await sync.tick();
    expect(client.recordVoid).toHaveBeenCalledTimes(1);
    expect(repo.read('v1')?.state).toBe('confirmed');
    expect(repo.read('v2')).toMatchObject({ state: 'pending', attemptCount: 0 });
  });

  it('stops the pass when the same requester moves to another terminal scope mid-pass', async () => {
    seedSale(db, { sale_id: 'sale-2' });
    repo.insert(
      newVoidEntry(2, {
        saleId: 'sale-2',
        approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000a2',
        now: '2026-06-07T10:07:00.000Z',
      }),
    );
    client.recordVoid.mockImplementation(() => {
      sender = {
        scope: { ...SCOPE, terminalId: 'term-2' },
        operatorUserId: REQUESTER_USER,
        envelope: 'envelope-of-the-requester-on-term-2',
      };
      return Promise.resolve(outcome);
    });
    await sync.tick();
    expect(client.recordVoid).toHaveBeenCalledTimes(1);
    expect(repo.read('v2')).toMatchObject({ state: 'pending', attemptCount: 0 });
  });

  it('a send in flight at shutdown writes nothing when it settles', async () => {
    client.recordVoid.mockImplementationOnce(() => {
      stopped = true;
      return Promise.resolve(outcome);
    });
    await sync.tick();
    expect(repo.read('v1')).toMatchObject({ state: 'pending', attemptCount: 1 });
    expect(audit).toEqual([]);
    expect(await sync.tick()).toBeNull();
  });

  it('drain settles once the pass in flight has finished', async () => {
    const pass = sync.tick();
    await sync.drain(1000);
    await pass;
    expect(repo.read('v1')?.state).toBe('confirmed');
    await expect(sync.drain(10)).resolves.toBeUndefined();
  });
});
