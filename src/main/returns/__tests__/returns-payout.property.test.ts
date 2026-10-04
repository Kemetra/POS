/**
 * RT-15 S4 X7 — payout exactly-once under seeded random interleavings of
 * start / retry_drawer / manual / double click / reprint / crash-restart /
 * lock / sign-out / operator switch, with random drawer and printer outcomes.
 *
 * For every seed:
 *   • per return, at most one `paid_out` audit; `paid_out` state iff exactly
 *     one `paid_out` audit iff a completed payout row;
 *   • every `paid_out` audit follows a `payout_started` audit of that return
 *     (claim before payout), and pays the journal's server-confirmed total;
 *   • a `drawer` payout follows a drawer that opened (never a failed kick);
 *   • a return that was never confirmed is never claimed or paid;
 *   • every drawer kick happened while some return was confirmed AND claimed;
 *   • a crashed domain writes nothing after the crash (its in-flight kicks and
 *     prints settle without a journal, payout or audit write).
 *
 * A failing seed replays exactly (`runPayoutInterleaving(seed, STEPS)`).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import { committedAudits, initReturnsSql } from './__helpers__/returns-fixture.js';
import {
  runPayoutInterleaving,
  type PayoutRun,
} from './__helpers__/returns-payout-interleaving.js';

beforeAll(async () => {
  await initReturnsSql();
});

const STEPS = 60;
const SEEDS = Array.from({ length: 40 }, (_, i) => 0x9a1d + i * 7919);

const runs: PayoutRun[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) run.harness.close();
});

async function run(seed: number): Promise<PayoutRun> {
  const result = await runPayoutInterleaving(seed, STEPS);
  runs.push(result);
  return result;
}

function ofReturn(audits: readonly AuditEvent[], category: string, returnId: string) {
  return audits.filter(
    (a) => a.action_category === category && a.payload['return_id'] === returnId,
  );
}

function scalar(r: PayoutRun, sql: string, returnId: string): unknown {
  return r.harness.db.exec(sql, [returnId])[0]?.values[0]?.[0] ?? null;
}

function expectPaidOutAtMostOnce(r: PayoutRun, audits: readonly AuditEvent[]): void {
  for (const returnId of r.confirmed) {
    const at = `seed ${String(r.seed)} return ${returnId}`;
    const paid = ofReturn(audits, 'sale.return.paid_out', returnId);
    const state = scalar(r, 'SELECT state FROM return_journal WHERE return_id = ?', returnId);
    const paidAt = scalar(r, 'SELECT paid_at FROM return_payouts WHERE return_id = ?', returnId);
    expect(paid.length, at).toBeLessThanOrEqual(1);
    expect(state === 'paid_out', at).toBe(paid.length === 1);
    expect(paidAt !== null, at).toBe(paid.length === 1);
  }
}

function expectClaimBeforePayoutAndConfirmedAmount(r: PayoutRun, audits: readonly AuditEvent[]) {
  for (const returnId of r.confirmed) {
    const at = `seed ${String(r.seed)} return ${returnId}`;
    const paid = ofReturn(audits, 'sale.return.paid_out', returnId)[0];
    if (paid === undefined) continue;
    const started = ofReturn(audits, 'sale.return.payout_started', returnId);
    expect(started, at).toHaveLength(1);
    expect(audits.indexOf(started[0] as AuditEvent), at).toBeLessThan(audits.indexOf(paid));
    const total = scalar(
      r,
      'SELECT return_total_minor FROM return_journal WHERE return_id = ?',
      returnId,
    );
    expect(paid.payload['payout_minor'], at).toBe(total);
  }
}

/** A `drawer` payout follows a drawer that opened: the return's last drawer event is `opened`. */
function expectDrawerPayoutAfterOpened(r: PayoutRun, audits: readonly AuditEvent[]): void {
  for (const returnId of r.confirmed) {
    const paid = ofReturn(audits, 'sale.return.paid_out', returnId)[0];
    if (paid?.payload['method'] !== 'drawer') continue;
    const drawerEvents = audits
      .slice(0, audits.indexOf(paid))
      .filter(
        (a) =>
          a.payload['return_id'] === returnId && /drawer_(opened|failed)$/.test(a.action_category),
      );
    expect(drawerEvents.at(-1)?.action_category, `seed ${String(r.seed)} return ${returnId}`).toBe(
      'sale.return.drawer_opened',
    );
  }
}

function expectNeverPaidUnconfirmed(r: PayoutRun): void {
  const at = `seed ${String(r.seed)}`;
  expect(scalar(r, 'SELECT state FROM return_journal WHERE return_id = ?', r.unconfirmed), at).toBe(
    'unknown',
  );
  expect(
    scalar(r, 'SELECT COUNT(*) FROM return_payouts WHERE return_id = ?', r.unconfirmed),
    at,
  ).toBe(0);
}

function expectKicksOnlyWhenClaimed(r: PayoutRun): void {
  const unclaimed = r.claimedAtKick.filter((claimed) => claimed.length === 0);
  expect(unclaimed, `seed ${String(r.seed)}`).toEqual([]);
}

function expectQuietAfterCrash(r: PayoutRun): void {
  for (const [i, crash] of r.crashes.entries()) {
    expect(crash.settled, `seed ${String(r.seed)} crash ${String(i)}`).toEqual(crash.at);
  }
}

describe('X7: payout exactly-once under seeded random interleavings', () => {
  it.each(SEEDS)('seed %i holds every invariant', async (seed) => {
    const r = await run(seed);
    const audits = committedAudits(r.harness.db);

    expectPaidOutAtMostOnce(r, audits);
    expectClaimBeforePayoutAndConfirmedAmount(r, audits);
    expectDrawerPayoutAfterOpened(r, audits);
    expectNeverPaidUnconfirmed(r);
    expectKicksOnlyWhenClaimed(r);
    expectQuietAfterCrash(r);
  });

  it('a seed replays exactly: the same audits', async () => {
    // Return ids are random UUIDs: name each return by its place in the run.
    const shape = (r: PayoutRun) => {
      const label = (id: unknown): string =>
        id === r.unconfirmed
          ? 'unconfirmed'
          : `confirmed-${String(r.confirmed.indexOf(String(id)))}`;
      return committedAudits(r.harness.db).map(
        (a) => `${a.action_category}:${label(a.payload['return_id'])}`,
      );
    };
    const first = shape(await run(SEEDS[5] ?? 0));
    const again = shape(await run(SEEDS[5] ?? 0));
    expect(again).toEqual(first);
  });

  it('the seeds exercise the interesting paths', async () => {
    const seen = new Set<string>();
    let crashes = 0;
    let kicks = 0;
    for (const seed of SEEDS.slice(0, 12)) {
      const r = await run(seed);
      for (const a of committedAudits(r.harness.db)) seen.add(a.action_category);
      crashes += r.crashes.length;
      kicks += r.claimedAtKick.length;
    }
    expect(crashes).toBeGreaterThan(0);
    expect(kicks).toBeGreaterThan(0);
    expect([...seen].filter((c) => c.startsWith('sale.return.')).sort()).toEqual(
      expect.arrayContaining([
        'sale.return.drawer_failed',
        'sale.return.drawer_opened',
        'sale.return.paid_out',
        'sale.return.payout_started',
        'sale.return.refused',
        'sale.return.slip_print_failed',
        'sale.return.slip_printed',
        'sale.return.slip_reprinted',
      ]),
    );
  });
});
