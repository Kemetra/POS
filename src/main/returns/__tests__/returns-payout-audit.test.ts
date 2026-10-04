/**
 * RT-15 S4 — payout, drawer and slip audit events (invariants U1, A4).
 *
 * Each goes through 004's validating AuditEmitter. The acting operator is the
 * one who paid out (the authorization snapshot), not the operator who
 * recorded the return; the payload carries references and minor units only.
 */
import { describe, expect, it } from 'vitest';

import { AuditEmitter } from '../../audit/audit-emitter.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import { AUDIT_ACTION_CATEGORIES } from '../../../shared/audit/event-shape.js';
import { createReturnsAudit, type ReturnActor } from '../returns-audit.js';
import type { JournalEntry } from '../returns-repository.js';
import { LINE_A, RETURN_REF, SALE_REF, SCOPE } from './__helpers__/returns-fixture.js';

const ENTRY: JournalEntry = {
  returnId: 'r1',
  scope: SCOPE,
  saleId: 'sale-1',
  saleNumber: 'SN-1',
  serverSaleRef: SALE_REF,
  externalId: 'pos-pulse-return:x',
  operatorId: 'op-returner',
  operatorSessionId: 'sess-returner',
  currencyCode: 'EGP',
  quotedTotalMinor: 1500,
  requestBodyJson: '{}',
  lines: [{ lineRef: LINE_A, quantity: 1 }],
  state: 'confirmed',
  returnRef: RETURN_REF,
  returnTotalMinor: 1500,
  refusalReason: null,
  attemptCount: 1,
  lastAttemptAt: 't1',
  createdAt: 't0',
  confirmedAt: 't1',
};

const PAYER: ReturnActor = {
  scope: SCOPE,
  operatorId: 'op-payer',
  operatorSessionId: 'sess-payer',
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

const PAYOUT_CATEGORIES = [
  'sale.return.payout_started',
  'sale.return.drawer_opened',
  'sale.return.drawer_failed',
  'sale.return.paid_out',
  'sale.return.slip_printed',
  'sale.return.slip_print_failed',
  'sale.return.slip_reprinted',
];

describe('payout audit events (U1)', () => {
  it('registers the seven payout categories', () => {
    expect(AUDIT_ACTION_CATEGORIES).toEqual(expect.arrayContaining(PAYOUT_CATEGORIES));
  });

  it('attributes every payout event to the paying operator on this terminal (A4)', () => {
    const { audit, stored } = auditWithStore();
    audit.payoutStarted(PAYER, ENTRY);
    audit.drawer(PAYER, ENTRY, { ok: true });
    audit.drawer(PAYER, ENTRY, {
      ok: false,
      reason: 'no_drawer_configured',
      kickOutcome: 'failed_before_send',
    });
    audit.paidOut(PAYER, ENTRY, 'manual');
    audit.slip(PAYER, ENTRY, { copy: false, ok: true });
    audit.slip(PAYER, ENTRY, { copy: true, ok: false, failureReason: 'printer_offline' });
    audit.slip(PAYER, ENTRY, { copy: true, ok: true });
    expect(stored.map((e) => e.action_category)).toEqual([
      'sale.return.payout_started',
      'sale.return.drawer_opened',
      'sale.return.drawer_failed',
      'sale.return.paid_out',
      'sale.return.slip_printed',
      'sale.return.slip_print_failed',
      'sale.return.slip_reprinted',
    ]);
    for (const e of stored) {
      expect(e).toMatchObject({
        originating_terminal_id: 'term-1',
        acting_operator_id: 'op-payer',
        session_id: 'sess-payer',
      });
      expect(e.payload).toMatchObject({ return_id: 'r1', return_ref: RETURN_REF });
    }
  });

  it('carries the server-confirmed amount and the method on payout_started and paid_out', () => {
    const { audit, stored } = auditWithStore();
    audit.payoutStarted(PAYER, { ...ENTRY, quotedTotalMinor: 9999 });
    audit.paidOut(PAYER, { ...ENTRY, quotedTotalMinor: 9999 }, 'drawer');
    expect(stored[0]?.payload).toEqual({
      return_id: 'r1',
      sale_ref: SALE_REF,
      return_ref: RETURN_REF,
      payout_minor: 1500,
      currency_code: 'EGP',
    });
    expect(stored[1]?.payload).toEqual({
      return_id: 'r1',
      sale_id: 'sale-1',
      sale_ref: SALE_REF,
      return_ref: RETURN_REF,
      payout_minor: 1500,
      currency_code: 'EGP',
      method: 'drawer',
      tender: 'cash',
    });
  });

  it('records why the drawer or the slip failed', () => {
    const { audit, stored } = auditWithStore();
    audit.drawer(PAYER, ENTRY, { ok: false, reason: 'timeout', kickOutcome: 'unknown' });
    audit.slip(PAYER, ENTRY, { copy: false, ok: false, failureReason: 'os_print_error' });
    expect(stored[0]?.payload).toEqual({
      return_id: 'r1',
      return_ref: RETURN_REF,
      failure_reason: 'timeout',
      kick_outcome: 'unknown',
    });
    expect(stored[1]?.payload).toEqual({
      return_id: 'r1',
      return_ref: RETURN_REF,
      copy: false,
      failure_reason: 'os_print_error',
    });
  });

  it('refuses to audit a payout of a return that is not confirmed', () => {
    const { audit } = auditWithStore();
    const pending = {
      ...ENTRY,
      state: 'pending' as const,
      returnRef: null,
      returnTotalMinor: null,
    };
    expect(() => {
      audit.payoutStarted(PAYER, pending);
    }).toThrow(/not confirmed/);
  });
});
