/**
 * RT-15 S2 — return audit events go through 004's validating AuditEmitter
 * (FR-025 attributes, forbidden-key scan) into the local store (AC11), and the
 * composition helpers wire and schedule the domain.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditEmitter } from '../../audit/audit-emitter.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import { AUDIT_ACTION_CATEGORIES } from '../../../shared/audit/event-shape.js';
import { createReturnsAudit } from '../returns-audit.js';
import { scheduleReturnsResolver } from '../compose-returns.js';
import type { JournalEntry } from '../returns-repository.js';
import { LINE_A, RETURN_REF, SALE_REF, SCOPE } from './__helpers__/returns-fixture.js';

const ENTRY: JournalEntry = {
  returnId: 'r1',
  scope: SCOPE,
  saleId: 'sale-1',
  saleNumber: 'SN-1',
  serverSaleRef: SALE_REF,
  externalId: 'pos-pulse-return:x',
  operatorId: 'op-manager',
  operatorSessionId: 'sess-1',
  currencyCode: 'EGP',
  quotedTotalMinor: 1500,
  requestBodyJson: '{}',
  lines: [{ lineRef: LINE_A, quantity: 1 }],
  state: 'confirmed',
  returnRef: RETURN_REF,
  returnTotalMinor: 1500,
  refusalReason: null,
  attemptCount: 1,
  createdAt: 't0',
  confirmedAt: 't1',
};

function auditWithStore() {
  const stored: AuditEvent[] = [];
  const emitter = new AuditEmitter({ insertIgnore: (e) => stored.push(e) });
  let n = 0;
  const audit = createReturnsAudit({
    sink: emitter,
    now: () => '2026-10-04T10:00:00.000Z',
    newEventId: () => `evt-${String((n += 1))}`,
  });
  return { audit, stored };
}

describe('returns audit (AC11)', () => {
  it('registers the four return categories', () => {
    expect(AUDIT_ACTION_CATEGORIES).toEqual(
      expect.arrayContaining([
        'sale.return.attempted',
        'sale.return.refused',
        'sale.return.confirmed',
        'sale.return.payout_ready',
      ]),
    );
  });

  it('writes attempted / confirmed / payout_ready with operator, terminal, saleRef and returnRef', () => {
    const { audit, stored } = auditWithStore();
    audit.attempted({ ...ENTRY, state: 'pending', returnRef: null, returnTotalMinor: null });
    audit.confirmed(ENTRY, true);
    audit.payoutReady(ENTRY);
    expect(stored.map((e) => [e.event_id, e.action_category])).toEqual([
      ['evt-1', 'sale.return.attempted'],
      ['evt-2', 'sale.return.confirmed'],
      ['evt-3', 'sale.return.payout_ready'],
    ]);
    for (const e of stored) {
      expect(e).toMatchObject({
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        originating_terminal_id: 'term-1',
        acting_operator_id: 'op-manager',
        session_id: 'sess-1',
        shift_id: null,
        approving_supervisor_id: null,
      });
      expect(e.payload['sale_ref']).toBe(SALE_REF);
    }
    expect(stored[0]?.payload).toEqual({
      return_id: 'r1',
      sale_id: 'sale-1',
      sale_ref: SALE_REF,
      quoted_total_minor: 1500,
      currency_code: 'EGP',
      line_count: 1,
    });
    expect(stored[1]?.payload).toMatchObject({ return_ref: RETURN_REF, replayed: true });
    expect(stored[2]?.payload).toEqual({
      return_id: 'r1',
      sale_ref: SALE_REF,
      return_ref: RETURN_REF,
      payout_minor: 1500,
      currency_code: 'EGP',
      method: 'cash',
    });
  });

  it('writes a refusal with the given payload', () => {
    const { audit, stored } = auditWithStore();
    audit.refused(
      { scope: SCOPE, operatorId: 'op-cashier', operatorSessionId: 's' },
      {
        return_id: null,
        sale_id: null,
        sale_ref: null,
        operation: 'lookup',
        reason: 'role_denied',
      },
    );
    expect(stored[0]).toMatchObject({
      action_category: 'sale.return.refused',
      acting_operator_id: 'op-cashier',
      payload: { operation: 'lookup', reason: 'role_denied' },
    });
  });

  it('refuses to write confirmation facts for an unconfirmed entry', () => {
    const { audit } = auditWithStore();
    expect(() => {
      audit.payoutReady({ ...ENTRY, returnRef: null });
    }).toThrow(/not confirmed/);
  });
});

describe('scheduleReturnsResolver', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks on startup and every interval until stopped; a failing tick is logged', async () => {
    vi.useFakeTimers();
    const tick = vi
      .fn<() => Promise<null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(null);
    const error = vi.fn();
    const drain = vi.fn<(timeoutMs: number) => Promise<void>>().mockResolvedValue(undefined);
    const stopDomain = vi.fn();
    const stop = scheduleReturnsResolver({
      resolver: { tick, drain },
      stopDomain,
      intervalMs: 1000,
      drainTimeoutMs: 15_000,
      logger: { error },
    });
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.anything(), 'returns_resolver:tick_unexpected');
    await stop();
    expect(stopDomain).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledWith(15_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
