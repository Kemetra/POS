/**
 * RT-15 S2 — the journal repository: guarded transitions report whether they
 * changed anything (the no-double-confirmation seam), scoped listing, and the
 * per-sale unresolved check.
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
  createReturnsRepository,
  type NewJournalEntry,
  type ReturnsRepository,
} from '../returns-repository.js';
import { LINE_A, LINE_B, RETURN_REF, SALE_REF, SCOPE } from './__helpers__/returns-fixture.js';

let db: SqlJsDatabase;
let repo: ReturnsRepository;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-1' });
  seedSale(db, { sale_id: 'sale-2' });
  repo = createReturnsRepository(handleFor(db));
});

afterEach(() => {
  db.close();
});

function entry(n: number, overrides: Partial<NewJournalEntry> = {}): NewJournalEntry {
  return {
    returnId: `r${String(n)}`,
    scope: SCOPE,
    saleId: 'sale-1',
    saleNumber: 'SN-sale-1',
    serverSaleRef: SALE_REF,
    externalId: `pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-${String(n).padStart(12, '0')}`,
    operatorId: 'op',
    operatorSessionId: 'sess',
    currencyCode: 'EGP',
    quotedTotalMinor: 3500,
    requestBodyJson: '{"k":1}',
    lines: [
      { lineRef: LINE_B, quantity: 1 },
      { lineRef: LINE_A, quantity: 1 },
    ],
    now: `2026-10-04T10:00:0${String(n)}.000Z`,
    ...overrides,
  };
}

const CONFIRM = { returnId: 'r1', returnRef: RETURN_REF, returnTotalMinor: 3500, now: 't1' };

describe('returns repository', () => {
  it('inserts header + lines atomically and reads them back', () => {
    repo.insert(entry(1));
    expect(repo.read('r1')).toMatchObject({
      state: 'pending',
      attemptCount: 0,
      quotedTotalMinor: 3500,
      lines: [
        { lineRef: LINE_A, quantity: 1 },
        { lineRef: LINE_B, quantity: 1 },
      ],
    });
    expect(repo.read('nope')).toBeNull();
  });

  it('rolls the header back when a line is invalid', () => {
    expect(() => {
      repo.insert(entry(1, { lines: [{ lineRef: 'bad', quantity: 1 }] }));
    }).toThrow();
    expect(repo.read('r1')).toBeNull();
  });

  it('confirms once: a second confirmation or a late refusal changes nothing', () => {
    repo.insert(entry(1));
    expect(repo.markConfirmed(CONFIRM)).toBe(true);
    expect(repo.markConfirmed({ ...CONFIRM, now: 't2' })).toBe(false);
    expect(repo.markRefused({ returnId: 'r1', reason: 'conflict', now: 't3' })).toBe(false);
    expect(repo.markUnknown({ returnId: 'r1', now: 't4' })).toBe(false);
    expect(repo.read('r1')).toMatchObject({
      state: 'confirmed',
      returnRef: RETURN_REF,
      returnTotalMinor: 3500,
      confirmedAt: 't1',
    });
  });

  it('pays out only a confirmed return, once', () => {
    repo.insert(entry(1));
    expect(repo.markPaidOut({ returnId: 'r1', now: 't1' })).toBe(false);
    repo.markConfirmed(CONFIRM);
    expect(repo.markPaidOut({ returnId: 'r1', now: 't2' })).toBe(true);
    expect(repo.markPaidOut({ returnId: 'r1', now: 't3' })).toBe(false);
    expect(repo.read('r1')?.state).toBe('paid_out');
  });

  it('counts attempts only while unresolved', () => {
    repo.insert(entry(1));
    repo.recordAttempt({ returnId: 'r1', now: 't1' });
    repo.markUnknown({ returnId: 'r1', now: 't1' });
    repo.recordAttempt({ returnId: 'r1', now: 't2' });
    repo.markRefused({ returnId: 'r1', reason: 'over_return', now: 't3' });
    repo.recordAttempt({ returnId: 'r1', now: 't4' });
    expect(repo.read('r1')).toMatchObject({
      state: 'refused',
      refusalReason: 'over_return',
      attemptCount: 2,
    });
  });

  it('lists this terminal’s returns newest first and unresolved ones oldest first', () => {
    repo.insert(entry(1));
    repo.insert(entry(2, { saleId: 'sale-2' }));
    repo.insert(entry(3, { saleId: 'sale-2', scope: { ...SCOPE, terminalId: 'other-till' } }));
    repo.markConfirmed(CONFIRM);
    expect(repo.listRecent(SCOPE, 10).map((e) => e.returnId)).toEqual(['r2', 'r1']);
    expect(repo.listRecent(SCOPE, 1).map((e) => e.returnId)).toEqual(['r2']);
    expect(repo.listUnresolved(SCOPE).map((e) => e.returnId)).toEqual(['r2']);
    expect(repo.hasUnresolvedForSale('sale-1')).toBe(false);
    expect(repo.hasUnresolvedForSale('sale-2')).toBe(true);
  });
});

describe('D5: migration 0039 lets lines join a return only while it is pending and unsent', () => {
  const LINE_C = '0190f5a2-7b3c-7d4e-8f90-00000000000c';
  const HEADER_PENDING_UNSENT = /header must be pending and unsent/;

  function addLine(): void {
    db.run('INSERT INTO return_journal_lines (return_id, line_ref, quantity) VALUES (?, ?, 1)', [
      'r1',
      LINE_C,
    ]);
  }

  it.each<{ label: string; advance: () => void }>([
    {
      label: 'once attempted (still pending, attempt_count 1)',
      advance: () => {
        repo.recordAttempt({ returnId: 'r1', now: 't1' });
      },
    },
    { label: 'once unknown', advance: () => repo.markUnknown({ returnId: 'r1', now: 't1' }) },
    { label: 'once confirmed', advance: () => repo.markConfirmed(CONFIRM) },
    {
      label: 'once refused',
      advance: () => repo.markRefused({ returnId: 'r1', reason: 'conflict', now: 't1' }),
    },
    {
      label: 'once paid out',
      advance: () => {
        repo.markConfirmed(CONFIRM);
        repo.markPaidOut({ returnId: 'r1', now: 't2' });
      },
    },
  ])('rejects a line INSERT $label', ({ advance }) => {
    repo.insert(entry(1));
    advance();
    expect(addLine).toThrow(HEADER_PENDING_UNSENT);
    expect(repo.read('r1')?.lines).toHaveLength(2);
  });

  it('accepts a line INSERT while the header is pending with attempt_count 0', () => {
    repo.insert(entry(1));
    addLine();
    expect(repo.read('r1')?.lines).toHaveLength(3);
  });

  it('rejects a line for a header that does not exist', () => {
    expect(addLine).toThrow(HEADER_PENDING_UNSENT);
  });
});
