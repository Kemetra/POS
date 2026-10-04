/**
 * RT-197 I5 — state-machine property test: seeded, randomized interleavings
 * of submit, the resolver (ticks and on-demand), stop and session changes over
 * the real dispatcher and repository on sql.js, against a fake Backend-Core.
 *
 * For every seed:
 *   • at most one `confirmed` and one `payout_ready` audit per return, and a
 *     payout-ready exactly when confirmed;
 *   • every request carries an envelope issued to a manager/admin session —
 *     never a send for a non-admitted actor — and leaves while that very
 *     session is the live, unlocked one (the recheck and the send are one
 *     synchronous step: no switch can land between them);
 *   • every POST is for a return already journaled (journal before send);
 *   • a sale never has two unresolved returns at once;
 *   • after stop: no request, no audit of a send's outcome, and no journaled
 *     return changes (no attempt, confirmation, refusal or `unknown`).
 *
 * RT-197 FINDING (reported, not fixed — a behaviour change outside the
 * ticket's listed scope): only the dispatcher and the resolver observe the
 * stop latch; the service does not. A lookup / quote / submit / resolve whose
 * await is in flight when the domain stops still writes when it resumes:
 * either its refusal audit (`sale.return.refused`, no return id), or — for a
 * submit — its journal row, lines and `attempted` audit; the dispatcher then
 * defers that return, so it is never sent and stays `pending` for the next
 * start. In the app the DB closes right after the stop latch, so those writes
 * fail instead. The property pins exactly that much and no more: a return
 * journaled after stop is pending and never attempted, and the only audits
 * after stop are those service-level ones.
 *
 * A failing seed replays exactly (`runInterleaving(seed, STEPS)`).
 */
import { isDeepStrictEqual } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import { initReturnsSql } from './__helpers__/returns-fixture.js';
import { runInterleaving, type InterleavingRun } from './__helpers__/returns-interleaving.js';

beforeAll(async () => {
  await initReturnsSql();
});

const STEPS = 60;
const SEEDS = Array.from({ length: 40 }, (_, i) => 0x5eed + i * 7919);

/** Per return id, how many audits of `category` were committed. */
function countsPerReturn(audits: readonly AuditEvent[], category: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const audit of audits.filter((a) => a.action_category === category)) {
    const id = String(audit.payload['return_id']);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function envelopeOf(call: InterleavingRun['calls'][number]): string {
  return (call.headers['Authorization'] ?? '').replace(/^Bearer /, '');
}

function expectExactlyOnceConfirmation(run: InterleavingRun): void {
  const confirmed = countsPerReturn(run.audits, 'sale.return.confirmed');
  const payout = countsPerReturn(run.audits, 'sale.return.payout_ready');
  for (const [id, n] of confirmed) expect(n, `seed ${String(run.seed)} return ${id}`).toBe(1);
  expect([...payout.entries()], `seed ${String(run.seed)}`).toEqual([...confirmed.entries()]);
}

function expectOnlyAdmittedSends(run: InterleavingRun): void {
  const strangers = run.calls.map(envelopeOf).filter((e) => !run.admitted.has(e));
  expect(strangers, `seed ${String(run.seed)}`).toEqual([]);
}

function expectSentUnderTheLiveAdmittedSession(run: InterleavingRun): void {
  expect(run.liveAtSend, `seed ${String(run.seed)}`).toHaveLength(run.calls.length);
  const mismatched = run.calls.filter((call, i) => {
    const live = run.liveAtSend[i];
    return live?.envelope !== envelopeOf(call) || live.locked || live.role === 'cashier';
  });
  expect(mismatched, `seed ${String(run.seed)}`).toEqual([]);
}

function expectJournalBeforeSend(run: InterleavingRun): void {
  const posts = run.calls.filter((c) => c.method === 'POST');
  const unjournaled = posts
    .map((c) => c.headers['Idempotency-Key'] ?? '')
    .filter((key) => !run.journaledExternalIds.has(key));
  expect(unjournaled, `seed ${String(run.seed)}`).toEqual([]);
}

/** The FINDING's audits: an `attempted` for a return journaled after stop, or a service refusal. */
function isServiceLevelAudit(audit: AuditEvent, addedIds: ReadonlySet<string>): boolean {
  const returnId = audit.payload['return_id'];
  if (audit.action_category === 'sale.return.attempted') return addedIds.has(String(returnId));
  return audit.action_category === 'sale.return.refused' && returnId === null;
}

function expectQuietAfterStop(run: InterleavingRun): void {
  const at = `seed ${String(run.seed)}`;
  expect(run.callsAfterStop, `${at}: requests after stop`).toBe(0);
  const changed = [...run.journalAtStop].filter(
    ([id, row]) => !isDeepStrictEqual(run.journalAtEnd.get(id), row),
  );
  expect(changed, `${at}: journaled returns changed after stop`).toEqual([]);
  // The FINDING above: a return journaled after stop is pending and never sent.
  const added = [...run.journalAtEnd].filter(([id]) => !run.journalAtStop.has(id));
  for (const [, row] of added) expect(row, at).toMatchObject({ state: 'pending', attemptCount: 0 });
  const addedIds = new Set(added.map(([id]) => id));
  const otherAudits = run.auditsAfterStop.filter((a) => !isServiceLevelAudit(a, addedIds));
  expect(otherAudits, `${at}: audits after stop`).toEqual([]);
}

describe('I5: the return state machine under seeded random interleavings', () => {
  it.each(SEEDS)('seed %i holds every invariant', async (seed) => {
    const run = await runInterleaving(seed, STEPS);

    expectExactlyOnceConfirmation(run);
    expectOnlyAdmittedSends(run);
    expectSentUnderTheLiveAdmittedSession(run);
    expectJournalBeforeSend(run);
    expect(run.overlaps, `seed ${String(seed)}`).toEqual([]);
    expectQuietAfterStop(run);
  });

  it('a seed replays exactly: the same requests, envelopes and audits', async () => {
    const shape = (run: InterleavingRun) => ({
      requests: run.calls.map((c) => `${c.method} ${c.url} ${envelopeOf(c)}`),
      audits: run.audits.map((a) => `${a.action_category}:${String(a.payload['reason'])}`),
    });
    const [first, again] = [
      await runInterleaving(SEEDS[3] ?? 0, STEPS),
      await runInterleaving(SEEDS[3] ?? 0, STEPS),
    ];
    expect(shape(again)).toEqual(shape(first));
    expect(first.calls.length).toBeGreaterThan(0);
  });

  it('the seeds exercise the interesting paths (sends, confirmations, stops, refusals)', async () => {
    const runs: InterleavingRun[] = [];
    for (const seed of SEEDS.slice(0, 12)) runs.push(await runInterleaving(seed, STEPS));
    const categories = new Set(runs.flatMap((r) => r.audits.map((a) => a.action_category)));
    expect(runs.some((r) => r.stopped)).toBe(true);
    expect(runs.some((r) => !r.stopped)).toBe(true);
    expect(runs.some((r) => r.calls.some((c) => c.method === 'POST'))).toBe(true);
    expect([...categories].sort()).toEqual([
      'sale.return.attempted',
      'sale.return.confirmed',
      'sale.return.payout_ready',
      'sale.return.refused',
    ]);
  });
});
