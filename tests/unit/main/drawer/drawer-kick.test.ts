/**
 * T310 / T311 / T313 / T321 / T340 — drawer-kick dispatcher (008 Slice 4).
 *
 * Unit tests over injected ports (drawer-events repo, transport, audit emitter)
 * — same DI posture as `print-dispatcher`. The dispatcher is pure orchestration
 * over those ports, so fakes (not a real DB) keep each gate isolated:
 *
 *   • T310 three-gate firing: kick fires ONLY for a cash-inclusive sale.
 *   • T311 cashless suppression: cashless → `suppressed` row + audit, NO kick.
 *   • T313 double-kick suppression: a prior `drawer_events` row → no-op.
 *   • T321 ack handling: success → `opened`; failure → `failed` +
 *     `last_successful_open_at_for_terminal` populated (Constitution §IV).
 *   • T340 audit redaction: drawer audit payloads carry only structural fields.
 *
 * (T320 separate-command + the kick-after-print ordering live in the transport
 * + the finalize-seam integration tests — the dispatcher only calls `kick()`.)
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createDrawerKickDispatcher,
  hasCashTender,
  type DrawerKickContext,
  type DrawerKickDependencies,
} from '../../../../src/main/drawer/drawer-kick.js';
import type {
  DrawerEventsRepository,
  DrawerEventRow,
  InsertDrawerEventInput,
} from '../../../../src/main/sales/repositories/drawer-events.repository.js';
import type {
  DrawerKickTransport,
  DrawerKickResult,
} from '../../../../src/main/drawer/drawer-kick-transport.js';
import type {
  SaleAuditEmitter,
  SaleRawAuditEvent,
} from '../../../../src/main/sales/audit-emitter.js';

const CASH_SUMMARY = JSON.stringify([{ tender_type: 'cash', amount_applied_minor: 5500 }]);
const CASHLESS_SUMMARY = JSON.stringify([
  {
    tender_type: 'external_card_terminal',
    amount_applied_minor: 5500,
    external_reference: 'AUTH-1',
  },
]);
const MIXED_SUMMARY = JSON.stringify([
  {
    tender_type: 'external_card_terminal',
    amount_applied_minor: 3000,
    external_reference: 'AUTH-1',
  },
  { tender_type: 'cash', amount_applied_minor: 2500, change_due_minor: 0 },
]);

function ctx(over: Partial<DrawerKickContext> = {}): DrawerKickContext {
  return {
    sale_id: 'sale-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    session_id: 'sess-1',
    attribution_operator_id: 'op-abc',
    tender_lines_summary_json: CASH_SUMMARY,
    triggering_print_event_id: 'pe-1',
    ...over,
  };
}

interface Harness {
  dispatcher: ReturnType<typeof createDrawerKickDispatcher>;
  inserted: InsertDrawerEventInput[];
  audits: SaleRawAuditEvent[];
  kick: ReturnType<typeof vi.fn>;
}

function harness(
  opts: {
    existingRow?: DrawerEventRow | null;
    kickResult?: DrawerKickResult;
    lastOpen?: string | null;
  } = {},
): Harness {
  const inserted: InsertDrawerEventInput[] = [];
  const audits: SaleRawAuditEvent[] = [];

  const drawerEventsRepo: DrawerEventsRepository = {
    insert: vi.fn((row: InsertDrawerEventInput) => {
      inserted.push(row);
    }),
    readBySale: vi.fn(() => opts.existingRow ?? null),
    findLastSuccessfulOpenForTerminal: vi.fn(() => opts.lastOpen ?? null),
  };

  const kick = vi.fn(
    (): Promise<DrawerKickResult> => Promise.resolve(opts.kickResult ?? { ok: true }),
  );
  const transport: DrawerKickTransport = { kick };

  const auditEmitter: Partial<SaleAuditEmitter> = {
    emitRaw: vi.fn((event: SaleRawAuditEvent) => {
      audits.push(event);
    }),
  };

  let seq = 0;
  const deps: DrawerKickDependencies = {
    drawerEventsRepo,
    transport,
    auditEmitter: auditEmitter as SaleAuditEmitter,
    now: () => '2026-05-27T10:00:06.000Z',
    newDrawerEventId: () => `de-${String((seq += 1))}`,
  };
  return { dispatcher: createDrawerKickDispatcher(deps), inserted, audits, kick };
}

describe('hasCashTender', () => {
  it('true when a cash line with a positive applied amount is present', () => {
    expect(hasCashTender(CASH_SUMMARY)).toBe(true);
    expect(hasCashTender(MIXED_SUMMARY)).toBe(true);
  });

  it('false for a cashless mix (card / voucher only)', () => {
    expect(hasCashTender(CASHLESS_SUMMARY)).toBe(false);
  });

  it('false for a zero-amount cash line (not an applied cash line)', () => {
    expect(hasCashTender(JSON.stringify([{ tender_type: 'cash', amount_applied_minor: 0 }]))).toBe(
      false,
    );
  });

  it('false for malformed JSON (degrades to cashless, never a spurious kick)', () => {
    expect(hasCashTender('not json{')).toBe(false);
    expect(hasCashTender('{}')).toBe(false);
    expect(hasCashTender('null')).toBe(false);
  });

  it('skips non-object array entries (null / primitive) without throwing', () => {
    // A defensive guard against a malformed persisted column whose array holds
    // a literal null or a primitive — must not crash the cash check.
    expect(hasCashTender('[null, 42, "cash"]')).toBe(false);
    expect(
      hasCashTender(JSON.stringify([null, { tender_type: 'cash', amount_applied_minor: 100 }])),
    ).toBe(true);
  });
});

describe('drawer-kick dispatcher — T310 gating + T321 ack (cash-inclusive)', () => {
  it('kicks and writes an opened row + sale.drawer.opened on success', async () => {
    const h = harness({ kickResult: { ok: true } });
    await h.dispatcher.dispatchOnFirstPrintSuccess(ctx());
    expect(h.kick).toHaveBeenCalledTimes(1);
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      sale_id: 'sale-1',
      outcome: 'opened',
      suppression_reason: null,
      failure_reason: null,
      triggering_print_event_id: 'pe-1',
      terminal_id: 'terminal-1',
    });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].action_category).toBe('sale.drawer.opened');
  });

  it('writes a failed row + sale.drawer.failed with last_successful_open_at on a kick fault', async () => {
    const h = harness({
      kickResult: { ok: false, failure_reason: 'printer_dk_failure' },
      lastOpen: '2026-05-27T08:30:00.000Z',
    });
    await h.dispatcher.dispatchOnFirstPrintSuccess(ctx());
    expect(h.kick).toHaveBeenCalledTimes(1);
    expect(h.inserted[0]).toMatchObject({
      outcome: 'failed',
      failure_reason: 'printer_dk_failure',
      last_successful_open_at_for_terminal: '2026-05-27T08:30:00.000Z',
    });
    expect(h.audits[0].action_category).toBe('sale.drawer.failed');
    expect(h.audits[0].payload).toMatchObject({
      failure_reason: 'printer_dk_failure',
      last_successful_open_at_for_terminal: '2026-05-27T08:30:00.000Z',
    });
  });

  it('failed row carries null last_successful_open_at when the terminal never opened before', async () => {
    const h = harness({
      kickResult: { ok: false, failure_reason: 'printer_dk_failure' },
      lastOpen: null,
    });
    await h.dispatcher.dispatchOnFirstPrintSuccess(ctx());
    expect(h.inserted[0].last_successful_open_at_for_terminal).toBeNull();
  });

  it('degrades a transport that throws to a failed row (never crosses the finalize seam)', async () => {
    const h = harness();
    h.kick.mockRejectedValueOnce(new Error('usb boom'));
    await expect(h.dispatcher.dispatchOnFirstPrintSuccess(ctx())).resolves.toBeUndefined();
    expect(h.inserted[0]).toMatchObject({ outcome: 'failed', failure_reason: 'os_error' });
    expect(h.audits[0].action_category).toBe('sale.drawer.failed');
  });
});

describe('drawer-kick dispatcher — RT-531 no drawer configured (cash drawer is optional)', () => {
  const NO_DRAWER: DrawerKickResult = { ok: false, failure_reason: 'no_drawer_configured' };

  it('writes ONE suppressed/no_drawer_configured row (never failed) + sale.drawer.suppressed', async () => {
    const h = harness({ kickResult: NO_DRAWER });
    await h.dispatcher.dispatchOnFirstPrintSuccess(ctx());
    expect(h.kick).toHaveBeenCalledTimes(1);
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      sale_id: 'sale-1',
      outcome: 'suppressed',
      suppression_reason: 'no_drawer_configured',
      failure_reason: null,
      last_successful_open_at_for_terminal: null,
      triggering_print_event_id: 'pe-1',
      terminal_id: 'terminal-1',
    });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].action_category).toBe('sale.drawer.suppressed');
    expect(h.audits[0].payload).toMatchObject({
      sale_id: 'sale-1',
      drawer_event_id: h.inserted[0].drawer_event_id,
      suppression_reason: 'no_drawer_configured',
    });
  });

  it('never raises a failure for it: no failed audit, no last-open lookup', async () => {
    const h = harness({ kickResult: NO_DRAWER, lastOpen: '2026-05-27T08:30:00.000Z' });
    await h.dispatcher.dispatchOnFirstPrintSuccess(ctx());
    expect(h.audits.map((a) => a.action_category)).not.toContain('sale.drawer.failed');
    expect(h.inserted[0].last_successful_open_at_for_terminal).toBeNull();
  });

  it('keeps one row per sale (FR-053): a repeat after the suppressed row is a no-op', async () => {
    const h = harness({ kickResult: NO_DRAWER });
    await h.dispatcher.dispatchOnFirstPrintSuccess(ctx());
    const [row] = h.inserted;
    const again = harness({
      kickResult: NO_DRAWER,
      existingRow: { ...(row as DrawerEventRow) },
    });
    await again.dispatcher.dispatchOnFirstPrintSuccess(ctx());
    expect(again.kick).not.toHaveBeenCalled();
    expect(again.inserted).toHaveLength(0);
    expect(again.audits).toHaveLength(0);
  });

  it.each(['printer_dk_failure', 'os_error'] as const)(
    'a configured drawer that fails (%s) is still a failed row + sale.drawer.failed',
    async (failure_reason) => {
      const h = harness({
        kickResult: { ok: false, failure_reason },
        lastOpen: '2026-05-27T08:30:00.000Z',
      });
      await h.dispatcher.dispatchOnFirstPrintSuccess(ctx());
      expect(h.inserted).toHaveLength(1);
      expect(h.inserted[0]).toMatchObject({
        outcome: 'failed',
        suppression_reason: null,
        failure_reason,
        last_successful_open_at_for_terminal: '2026-05-27T08:30:00.000Z',
      });
      expect(h.audits[0].action_category).toBe('sale.drawer.failed');
    },
  );

  it('a cashless sale is still suppressed as cashless_tender_mix, without a kick', async () => {
    const h = harness({ kickResult: NO_DRAWER });
    await h.dispatcher.dispatchOnFirstPrintSuccess(
      ctx({ tender_lines_summary_json: CASHLESS_SUMMARY }),
    );
    expect(h.kick).not.toHaveBeenCalled();
    expect(h.inserted[0]).toMatchObject({ suppression_reason: 'cashless_tender_mix' });
  });
});

describe('drawer-kick dispatcher — T311 cashless suppression', () => {
  it('does NOT kick; writes a suppressed/cashless_tender_mix row + sale.drawer.suppressed', async () => {
    const h = harness();
    await h.dispatcher.dispatchOnFirstPrintSuccess(
      ctx({ tender_lines_summary_json: CASHLESS_SUMMARY }),
    );
    expect(h.kick).not.toHaveBeenCalled();
    expect(h.inserted[0]).toMatchObject({
      outcome: 'suppressed',
      suppression_reason: 'cashless_tender_mix',
      failure_reason: null,
    });
    expect(h.audits[0].action_category).toBe('sale.drawer.suppressed');
    expect(h.audits[0].payload).toMatchObject({ suppression_reason: 'cashless_tender_mix' });
  });
});

describe('drawer-kick dispatcher — T313 double-kick suppression (FR-053)', () => {
  it('is a no-op when a prior drawer_events row already exists (opened)', async () => {
    const existing: DrawerEventRow = {
      drawer_event_id: 'de-prior',
      sale_id: 'sale-1',
      outcome: 'opened',
      suppression_reason: null,
      failure_reason: null,
      last_successful_open_at_for_terminal: null,
      triggering_print_event_id: 'pe-0',
      terminal_id: 'terminal-1',
      attempted_at: '2026-05-27T09:59:00.000Z',
    };
    const h = harness({ existingRow: existing });
    await h.dispatcher.dispatchOnFirstPrintSuccess(ctx());
    expect(h.kick).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('is a no-op when a prior suppressed row exists (reprint of a cashless sale)', async () => {
    const existing: DrawerEventRow = {
      drawer_event_id: 'de-prior',
      sale_id: 'sale-1',
      outcome: 'suppressed',
      suppression_reason: 'cashless_tender_mix',
      failure_reason: null,
      last_successful_open_at_for_terminal: null,
      triggering_print_event_id: 'pe-0',
      terminal_id: 'terminal-1',
      attempted_at: '2026-05-27T09:59:00.000Z',
    };
    const h = harness({ existingRow: existing });
    await h.dispatcher.dispatchOnFirstPrintSuccess(ctx());
    expect(h.inserted).toHaveLength(0);
  });
});

describe('drawer-kick dispatcher — T340 audit redaction', () => {
  it('drawer audit payloads carry only structural fields (no PAN / voucher / external_reference)', async () => {
    // The triggering sale is a mixed cash+card tender, but the drawer audit
    // must never echo the card/voucher detail — only sale_id + drawer_event_id
    // (+ reason/failure metadata). Asserted by VALUE on the emitted payloads.
    const opened = harness({ kickResult: { ok: true } });
    await opened.dispatcher.dispatchOnFirstPrintSuccess(
      ctx({ tender_lines_summary_json: MIXED_SUMMARY }),
    );
    for (const audit of opened.audits) {
      const json = JSON.stringify(audit.payload);
      expect(json).not.toContain('external_reference');
      expect(json).not.toContain('AUTH-1');
      expect(json).not.toContain('voucher');
      expect(json).not.toContain('pan');
      expect(Object.keys(audit.payload).sort()).toEqual(['drawer_event_id', 'sale_id']);
    }
  });

  it('the last_successful_open_at_for_terminal field is a UTC timestamp only', async () => {
    const h = harness({
      kickResult: { ok: false, failure_reason: 'printer_dk_failure' },
      lastOpen: '2026-05-27T08:30:00.000Z',
    });
    await h.dispatcher.dispatchOnFirstPrintSuccess(ctx());
    expect(h.audits[0].payload.last_successful_open_at_for_terminal).toBe(
      '2026-05-27T08:30:00.000Z',
    );
  });
});
