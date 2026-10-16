/**
 * RT-530 — the sale-void journal (migration 0054) and its repository: guarded
 * transitions report whether they changed anything, one live void per sale,
 * one void per approval, and the schema triggers as the backstop.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  createSaleVoidRepository,
  type NewVoidEntry,
  type SaleVoidRepository,
} from '../sale-void-repository.js';
import { APPROVAL_A, APPROVAL_B, newVoidEntry, SCOPE } from './__helpers__/sale-void-fixture.js';

let db: SqlJsDatabase;
let repo: SaleVoidRepository;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-1' });
  seedSale(db, { sale_id: 'sale-2' });
  repo = createSaleVoidRepository(handleFor(db));
});

afterEach(() => {
  db.close();
});

const entry = (n: number, over: Partial<NewVoidEntry> = {}): NewVoidEntry => newVoidEntry(n, over);

describe('sale void journal', () => {
  it('inserts a pending row and reads it back by id, approval and sale', () => {
    repo.insert(entry(1));
    expect(repo.read('v1')).toMatchObject({
      state: 'pending',
      attemptCount: 0,
      amountMinor: 1500,
      cashMinor: 1500,
      businessDate: '2026-06-07',
      approvalId: APPROVAL_A,
      refusalReason: null,
      voidRef: null,
    });
    expect(repo.readByApproval(APPROVAL_A)?.voidId).toBe('v1');
    expect(repo.liveForSale('sale-1')?.voidId).toBe('v1');
    expect(repo.read('nope')).toBeNull();
  });

  it('runs the in-transaction hook with the inserted row, and rolls back when it throws', () => {
    const seen: string[] = [];
    repo.insert(entry(1), (inserted) => {
      seen.push(inserted.voidId);
    });
    expect(seen).toEqual(['v1']);
    expect(() => {
      repo.insert(entry(2, { saleId: 'sale-2', approvalId: APPROVAL_B }), () => {
        throw new Error('approval refused');
      });
    }).toThrow('approval refused');
    expect(repo.read('v2')).toBeNull();
  });

  it('allows one live void per sale, and one void per approval', () => {
    repo.insert(entry(1));
    expect(() => {
      repo.insert(entry(2, { approvalId: APPROVAL_B }));
    }).toThrow(/UNIQUE/i);
    expect(() => {
      repo.insert(entry(3, { saleId: 'sale-2' }));
    }).toThrow(/UNIQUE/i);
  });

  it('lets a refused void free the sale for a new request', () => {
    repo.insert(entry(1));
    repo.markRefused({ voidId: 'v1', reason: 'void_outside_business_day', now: 't1' });
    expect(repo.liveForSale('sale-1')).toBeNull();
    repo.insert(entry(2, { approvalId: APPROVAL_B }));
    expect(repo.liveForSale('sale-1')?.voidId).toBe('v2');
  });

  it('moves pending -> unknown -> confirmed once, and reports a second confirmation as unchanged', () => {
    repo.insert(entry(1));
    repo.recordAttempt({ voidId: 'v1', now: 't1' });
    expect(repo.markUnknown({ voidId: 'v1', now: 't2', category: 'no_connection' })).toBe(true);
    expect(repo.read('v1')).toMatchObject({
      state: 'unknown',
      attemptCount: 1,
      lastAttemptAt: 't1',
      lastErrorCategory: 'no_connection',
    });
    expect(repo.markConfirmed({ voidId: 'v1', voidRef: 'evt-1', now: 't3' })).toBe(true);
    expect(repo.markConfirmed({ voidId: 'v1', voidRef: 'evt-2', now: 't4' })).toBe(false);
    expect(repo.read('v1')).toMatchObject({
      state: 'confirmed',
      voidRef: 'evt-1',
      confirmedAt: 't3',
    });
    expect(repo.markRefused({ voidId: 'v1', reason: 'conflict', now: 't5' })).toBe(false);
    expect(repo.markUnknown({ voidId: 'v1', now: 't6', category: 'x' })).toBe(false);
  });

  it('refuses once with its reason; a refused row never changes state again', () => {
    repo.insert(entry(1));
    expect(repo.markRefused({ voidId: 'v1', reason: 'void_self_approval', now: 't1' })).toBe(true);
    expect(repo.markRefused({ voidId: 'v1', reason: 'conflict', now: 't2' })).toBe(false);
    expect(repo.markConfirmed({ voidId: 'v1', voidRef: 'e', now: 't3' })).toBe(false);
    expect(repo.read('v1')).toMatchObject({
      state: 'refused',
      refusalReason: 'void_self_approval',
    });
  });

  it('lists the unresolved rows oldest first and the refused ones until acknowledged', () => {
    repo.insert(entry(1, { now: '2026-06-07T10:00:01.000Z' }));
    repo.insert(
      entry(2, { saleId: 'sale-2', approvalId: APPROVAL_B, now: '2026-06-07T10:00:02.000Z' }),
    );
    expect(repo.listUnresolved(SCOPE).map((e) => e.voidId)).toEqual(['v1', 'v2']);
    expect(repo.listRecent(SCOPE, 10).map((e) => e.voidId)).toEqual(['v2', 'v1']);
    repo.markRefused({ voidId: 'v1', reason: 'already_reversed', now: 't' });
    expect(repo.listUnresolved(SCOPE).map((e) => e.voidId)).toEqual(['v2']);
    expect(repo.listUnacknowledgedRefused(SCOPE).map((e) => e.voidId)).toEqual(['v1']);
    expect(repo.acknowledge({ voidId: 'v1', now: 'ack' })).toBe(true);
    expect(repo.acknowledge({ voidId: 'v1', now: 'ack2' })).toBe(false);
    expect(repo.listUnacknowledgedRefused(SCOPE)).toEqual([]);
    expect(repo.read('v1')?.acknowledgedAt).toBe('ack');
    expect(repo.acknowledge({ voidId: 'v2', now: 'ack' })).toBe(false);
  });

  it('scopes every list to the terminal', () => {
    repo.insert(entry(1));
    const other = { ...SCOPE, terminalId: 'term-2' };
    expect(repo.listRecent(other, 10)).toEqual([]);
    expect(repo.listUnresolved(other)).toEqual([]);
  });
});

describe('sale void journal triggers', () => {
  const run = (sql: string, ...params: unknown[]): void => {
    db.run(sql, params as never[]);
  };

  it('never deletes a row', () => {
    repo.insert(entry(1));
    expect(() => {
      run(`DELETE FROM sale_void_journal WHERE void_id = 'v1'`);
    }).toThrow(/DELETE is denied/);
  });

  it('fixes the identity and the approval evidence at INSERT', () => {
    repo.insert(entry(1));
    for (const column of ['approver_user_id', 'amount_minor', 'business_date', 'sale_id']) {
      expect(() => {
        run(`UPDATE sale_void_journal SET ${column} = ${column} WHERE void_id = 'v1'`);
      }).toThrow(/immutable/);
    }
  });

  it('rejects an illegal state transition and a changed terminal outcome', () => {
    repo.insert(entry(1));
    repo.markConfirmed({ voidId: 'v1', voidRef: 'evt', now: 't' });
    expect(() => {
      run(`UPDATE sale_void_journal SET state = 'pending' WHERE void_id = 'v1'`);
    }).toThrow(/illegal state transition/);
    expect(() => {
      run(`UPDATE sale_void_journal SET void_ref = 'other' WHERE void_id = 'v1'`);
    }).toThrow(/immutable/);
  });

  it('keeps the shape CHECKs: a refused row needs a reason, a confirmed one a reference', () => {
    repo.insert(entry(1));
    expect(() => {
      run(`UPDATE sale_void_journal SET state = 'refused' WHERE void_id = 'v1'`);
    }).toThrow(/CHECK/i);
    expect(() => {
      run(`UPDATE sale_void_journal SET state = 'confirmed' WHERE void_id = 'v1'`);
    }).toThrow(/CHECK/i);
    expect(() => {
      repo.insert(
        entry(2, { externalId: 'pos-pulse-void:short', saleId: 'sale-2', approvalId: APPROVAL_B }),
      );
    }).toThrow(/CHECK/i);
  });
});
