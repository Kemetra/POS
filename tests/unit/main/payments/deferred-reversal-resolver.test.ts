/**
 * 006 T230 — Deferred-reversal resolver test (RED).
 *
 * Asserts (per `specs/006-payments-tender/contracts/bridge-api.md`
 * §"Deferred reversal" + research §R-13):
 *
 *   1. The resolver scans `payment_tender_lines` for
 *      `state = 'reversal_pending'` rows on:
 *        (a) app start  — `start()` invokes `runOnce()` immediately;
 *        (b) network-restore signal from 003 — subscribed via
 *            `networkRestoreSignal.subscribe(cb)`; each fire calls
 *            `runOnce()`;
 *        (c) explicit cashier retry — `runOnce()` is exposed for
 *            wiring to a manual-retry bridge surface (Wave 5+).
 *   2. For each pending line, the resolver calls `vouchers.reverse`
 *      with the persisted `voucher_authority_redemption_id`.
 *   3. On `reversed`: drives `tenderLineFsm.confirmReversed` and
 *      emits `tender.reversed`. The `reversal_pending_since`
 *      timestamp from the original transition is forwarded into the
 *      audit payload (T231) so incident reconstruction can correlate
 *      the original outage with the resolution event.
 *   4. On `authority_unreachable`: the line stays in
 *      `reversal_pending`; the resolver logs a warning and moves on.
 *      No audit event is emitted on retry-failure (the original
 *      `tender.reversal_pending` already narrates the state).
 *   5. On `refused` (e.g., `redemption_not_found`): the line stays
 *      in `reversal_pending`; the resolver logs a warning with the
 *      structured refusal reason so manual incident-response can act.
 *      We never auto-transition to `reversed` on a refused V-A
 *      response because the refusal may itself be wrong (this is the
 *      conservative posture per advisor guidance).
 *   6. Idempotency: a per-line deterministic `action_id` lets V-A and
 *      the local outbox treat repeated retries as a no-op replay.
 *
 * **Wave 5 — TDD RED.** Forward-references the resolver factory.
 */

import { describe, expect, it, vi } from 'vitest';

import { createDeferredReversalResolver } from '../../../../src/main/payments/deferred-reversal-resolver.js';

import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeLineRow,
  makeTenderLineFsmDouble,
} from './__fixtures__/bridge-handler-deps.js';
import type {
  ReverseVoucherInput,
  ReverseVoucherOutcome,
} from '../../../../src/main/payments/voucher-authority-client/reverse.js';
import type { PaymentTenderLineRow } from '../../../../src/main/payments/repositories/payment-tender-lines.repository.js';

function makeReverseVoucherDouble(...outcomes: ReadonlyArray<ReverseVoucherOutcome>) {
  let i = 0;
  return vi.fn<
    (
      input: ReverseVoucherInput,
      options: { idempotencyKey: string },
    ) => Promise<ReverseVoucherOutcome>
  >(() => {
    const slot = outcomes[Math.min(i, outcomes.length - 1)] ?? {
      kind: 'reversed' as const,
      already_reversed: false,
      redemption_id: 'redemption-default',
      reversed_at: '2026-05-25T10:00:06.000Z',
    };
    i += 1;
    return Promise.resolve(slot);
  });
}

interface NetworkRestoreDouble {
  subscribe: ReturnType<typeof vi.fn>;
  fire: () => Promise<void>;
}

function makeNetworkRestoreSignal(): NetworkRestoreDouble {
  const callbacks: Array<() => void | Promise<void>> = [];
  const subscribe = vi.fn((cb: () => void | Promise<void>) => {
    callbacks.push(cb);
    return (): void => {
      const idx = callbacks.indexOf(cb);
      if (idx >= 0) callbacks.splice(idx, 1);
    };
  });
  return {
    subscribe,
    async fire(): Promise<void> {
      for (const cb of callbacks) await cb();
    },
  };
}

function makeLinesRepoForResolver(rows: readonly PaymentTenderLineRow[]) {
  return {
    findReversalPendingLines: vi.fn(() => [...rows]),
    findByLineId: vi.fn((id: string) => rows.find((r) => r.tender_line_id === id)),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const PENDING_LINE = (overrides: Partial<PaymentTenderLineRow> = {}): PaymentTenderLineRow =>
  makeLineRow({
    tender_line_id: 'tl-pending-1',
    payment_attempt_id: 'pa-1',
    tender_type: 'internal_voucher',
    amount_applied_minor: 1500,
    state: 'reversal_pending',
    voucher_authority_redemption_id: 'redemption-ABC',
    applied_at: '2026-05-25T09:00:00.000Z',
    reversal_pending_since: '2026-05-25T10:00:05.000Z',
    last_action_id: 'pend-action-1',
    ...overrides,
  });

describe('T230 — deferred-reversal resolver', () => {
  // ── (a) App start ─────────────────────────────────────────────────────────

  it('on start(): scans for reversal_pending lines and retries vouchers.reverse against V-A', async () => {
    const pending = PENDING_LINE();
    const linesRepo = makeLinesRepoForResolver([pending]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble({
      kind: 'reversed',
      already_reversed: false,
      redemption_id: 'redemption-ABC',
      reversed_at: '2026-05-25T10:05:00.000Z',
    });
    const networkRestoreSignal = makeNetworkRestoreSignal();
    const logger = makeLogger();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal,
      logger,
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.start();
    expect(linesRepo.findReversalPendingLines).toHaveBeenCalledTimes(1);
    expect(reverseVoucher).toHaveBeenCalledTimes(1);
    expect(reverseVoucher).toHaveBeenCalledWith(
      { redemption_id: 'redemption-ABC' },
      { idempotencyKey: 'tl-pending-1:resolver:retry' },
    );
    expect(tenderLineFsm.confirmReversed).toHaveBeenCalledTimes(1);
    expect(tenderLineFsm.confirmReversed.mock.calls[0]?.[0]).toMatchObject({
      tender_line_id: 'tl-pending-1',
      payment_attempt_id: 'pa-1',
    });
    // tender.reversed audit emitted.
    const reversedEvents = auditEmitter.captured.filter(
      (e) => e.action_category === 'tender.reversed',
    );
    expect(reversedEvents).toHaveLength(1);
  });

  // ── (b) Network-restore signal ────────────────────────────────────────────

  it('on networkRestoreSignal: re-scans pending lines and retries reverse', async () => {
    const linesRepo = makeLinesRepoForResolver([PENDING_LINE()]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble(
      { kind: 'authority_unreachable' },
      {
        kind: 'reversed',
        already_reversed: false,
        redemption_id: 'redemption-ABC',
        reversed_at: '2026-05-25T10:05:00.000Z',
      },
    );
    const networkRestoreSignal = makeNetworkRestoreSignal();
    const logger = makeLogger();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal,
      logger,
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.start();
    expect(reverseVoucher).toHaveBeenCalledTimes(1);
    // Still pending after first attempt — confirmReversed not called.
    expect(tenderLineFsm.confirmReversed).not.toHaveBeenCalled();
    // Fire the network-restore signal; resolver re-runs.
    await networkRestoreSignal.fire();
    expect(reverseVoucher).toHaveBeenCalledTimes(2);
    expect(tenderLineFsm.confirmReversed).toHaveBeenCalledTimes(1);
  });

  // ── (c) Explicit cashier retry → runOnce() ────────────────────────────────

  it('exposes runOnce() for explicit cashier-initiated retry', async () => {
    const linesRepo = makeLinesRepoForResolver([PENDING_LINE()]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNetworkRestoreSignal(),
      logger: makeLogger(),
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.runOnce();
    expect(linesRepo.findReversalPendingLines).toHaveBeenCalledTimes(1);
    expect(reverseVoucher).toHaveBeenCalledTimes(1);
  });

  // ── authority_unreachable on retry → stay pending, no audit ───────────────

  it('on V-A authority_unreachable: leaves line in reversal_pending; no tender.reversed audit', async () => {
    const linesRepo = makeLinesRepoForResolver([PENDING_LINE()]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble({ kind: 'authority_unreachable' });
    const logger = makeLogger();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNetworkRestoreSignal(),
      logger,
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.runOnce();
    expect(reverseVoucher).toHaveBeenCalledTimes(1);
    expect(tenderLineFsm.confirmReversed).not.toHaveBeenCalled();
    expect(
      auditEmitter.captured.find((e) => e.action_category === 'tender.reversed'),
    ).toBeUndefined();
    // Structured warn log for ops triage.
    expect(logger.warn).toHaveBeenCalled();
  });

  // ── V-A refused on retry → stay pending, no transition ────────────────────

  it('on V-A refused (e.g., redemption_not_found): leaves line in reversal_pending; logs warning', async () => {
    const linesRepo = makeLinesRepoForResolver([PENDING_LINE()]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble({
      kind: 'refused',
      reason: 'redemption_not_found',
    });
    const logger = makeLogger();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNetworkRestoreSignal(),
      logger,
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.runOnce();
    expect(tenderLineFsm.confirmReversed).not.toHaveBeenCalled();
    expect(
      auditEmitter.captured.find((e) => e.action_category === 'tender.reversed'),
    ).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    // The structured refusal reason MUST appear in the warn log for triage.
    const warnCalls = logger.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(warnCalls.some((c) => c.includes('redemption_not_found'))).toBe(true);
  });

  // ── Idempotency: deterministic per-line action_id ─────────────────────────

  it('uses a deterministic per-line action_id so V-A and local outbox treat retries as replay', async () => {
    const linesRepo = makeLinesRepoForResolver([PENDING_LINE()]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble(
      { kind: 'authority_unreachable' },
      {
        kind: 'reversed',
        already_reversed: false,
        redemption_id: 'redemption-ABC',
        reversed_at: '2026-05-25T10:06:00.000Z',
      },
    );
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNetworkRestoreSignal(),
      logger: makeLogger(),
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.runOnce();
    await resolver.runOnce();
    // The confirmReversed call (second runOnce, after the success outcome)
    // must reuse the same deterministic action_id format that the initial
    // unreachable retry used. We assert the action_id namespace pattern:
    // it incorporates the tender_line_id (so two retries against the same
    // pending line collide-by-design as replay).
    expect(tenderLineFsm.confirmReversed).toHaveBeenCalledTimes(1);
    const action_id = tenderLineFsm.confirmReversed.mock.calls[0]?.[0]?.action_id;
    expect(action_id).toBeDefined();
    expect(action_id).toContain('tl-pending-1');
    expect(action_id).toContain('resolver');
  });

  // ── Multiple lines: one ok, one unreachable ───────────────────────────────

  it('processes every pending line in a single pass, independent of outcomes', async () => {
    const line1 = PENDING_LINE({
      tender_line_id: 'tl-pending-1',
      voucher_authority_redemption_id: 'redemption-1',
    });
    const line2 = PENDING_LINE({
      tender_line_id: 'tl-pending-2',
      payment_attempt_id: 'pa-2',
      voucher_authority_redemption_id: 'redemption-2',
    });
    const linesRepo = makeLinesRepoForResolver([line1, line2]);
    const attemptsRepo = makeAttemptsRepoDouble([
      makeAttemptRow(),
      makeAttemptRow({ payment_attempt_id: 'pa-2' }),
    ]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble(
      {
        kind: 'reversed',
        already_reversed: false,
        redemption_id: 'redemption-1',
        reversed_at: '2026-05-25T10:05:00.000Z',
      },
      { kind: 'authority_unreachable' },
    );
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNetworkRestoreSignal(),
      logger: makeLogger(),
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.runOnce();
    expect(reverseVoucher).toHaveBeenCalledTimes(2);
    expect(tenderLineFsm.confirmReversed).toHaveBeenCalledTimes(1);
    expect(tenderLineFsm.confirmReversed.mock.calls[0]?.[0]?.tender_line_id).toBe('tl-pending-1');
  });

  // ── Defence-in-depth: voucher line missing redemption_id is skipped ───────

  it('skips a reversal_pending line missing voucher_authority_redemption_id (defence-in-depth)', async () => {
    const broken = PENDING_LINE({ voucher_authority_redemption_id: null });
    const linesRepo = makeLinesRepoForResolver([broken]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble();
    const logger = makeLogger();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNetworkRestoreSignal(),
      logger,
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.runOnce();
    expect(reverseVoucher).not.toHaveBeenCalled();
    expect(tenderLineFsm.confirmReversed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  // ── Defence-in-depth: line missing reversal_pending_since is skipped ─────

  it('skips a reversal_pending line missing reversal_pending_since (defence-in-depth)', async () => {
    const broken = PENDING_LINE({ reversal_pending_since: null });
    const linesRepo = makeLinesRepoForResolver([broken]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble();
    const logger = makeLogger();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNetworkRestoreSignal(),
      logger,
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.runOnce();
    expect(reverseVoucher).not.toHaveBeenCalled();
    expect(tenderLineFsm.confirmReversed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    const warnCalls = logger.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(warnCalls.some((c) => c.includes('missing_reversal_pending_since'))).toBe(true);
  });

  // ── Defence-in-depth: orphan line whose attempt row is missing ───────────

  it('skips a reversal_pending line whose payment_attempt row is missing (defence-in-depth)', async () => {
    const pending = PENDING_LINE({ payment_attempt_id: 'pa-missing' });
    const linesRepo = makeLinesRepoForResolver([pending]);
    // No attempt row for pa-missing.
    const attemptsRepo = makeAttemptsRepoDouble([]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble();
    const logger = makeLogger();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNetworkRestoreSignal(),
      logger,
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.runOnce();
    expect(reverseVoucher).not.toHaveBeenCalled();
    expect(tenderLineFsm.confirmReversed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    const warnCalls = logger.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(warnCalls.some((c) => c.includes('orphan_line_attempt_missing'))).toBe(true);
  });

  // ── FSM refused transition (race protection) ─────────────────────────────

  it('on FSM confirmReversed refused (race): logs warning; no audit emitted', async () => {
    const linesRepo = makeLinesRepoForResolver([PENDING_LINE()]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    // Simulate another resolver pass having already transitioned the row —
    // FSM refuses the duplicate transition.
    tenderLineFsm.confirmReversed.mockReturnValueOnce({
      kind: 'refused',
      reason: 'line_not_applied',
    });
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble({
      kind: 'reversed',
      already_reversed: false,
      redemption_id: 'redemption-ABC',
      reversed_at: '2026-05-25T10:05:00.000Z',
    });
    const logger = makeLogger();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNetworkRestoreSignal(),
      logger,
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.runOnce();
    expect(tenderLineFsm.confirmReversed).toHaveBeenCalledTimes(1);
    // FSM refused → no tender.reversed audit; structured warn log instead.
    expect(
      auditEmitter.captured.find((e) => e.action_category === 'tender.reversed'),
    ).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    const warnCalls = logger.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(warnCalls.some((c) => c.includes('fsm_refused_transition'))).toBe(true);
  });

  // ── Reentrancy guard ─────────────────────────────────────────────────────

  it('reentrancy guard: a second runOnce() during an in-flight sweep is a no-op', async () => {
    const linesRepo = makeLinesRepoForResolver([PENDING_LINE()]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    // Defer the reverseVoucher promise so we can start a second runOnce()
    // while the first is still in flight.
    let resolveOutcome: (o: ReverseVoucherOutcome) => void = () => {};
    const pendingPromise = new Promise<ReverseVoucherOutcome>((res) => {
      resolveOutcome = res;
    });
    const reverseVoucher = vi.fn<
      (
        input: ReverseVoucherInput,
        options: { idempotencyKey: string },
      ) => Promise<ReverseVoucherOutcome>
    >(() => pendingPromise);
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNetworkRestoreSignal(),
      logger: makeLogger(),
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    const firstRun = resolver.runOnce();
    // Second runOnce while the first hasn't resolved its V-A call — must be
    // a no-op (the guard prevents a double sweep).
    await resolver.runOnce();
    expect(linesRepo.findReversalPendingLines).toHaveBeenCalledTimes(1);
    expect(reverseVoucher).toHaveBeenCalledTimes(1);
    // Let the first sweep complete.
    resolveOutcome({
      kind: 'reversed',
      already_reversed: false,
      redemption_id: 'redemption-ABC',
      reversed_at: '2026-05-25T10:05:00.000Z',
    });
    await firstRun;
  });

  // ── Error from runOnce inside the signal subscription is caught ─────────

  it('on runOnce() rejection from the network-signal callback: logs error, does not throw', async () => {
    // Simulate the repo throwing during the scan (e.g., DB lost). The
    // app-start runOnce throws synchronously, but the signal-fired
    // runOnce is wrapped in `void runOnce().catch(...)` so it must
    // surface via logger.error and never re-throw.
    const linesRepo = {
      findReversalPendingLines: vi.fn((): never => {
        throw new Error('database_lost');
      }),
      findByLineId: vi.fn(),
    };
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble();
    const networkRestoreSignal = makeNetworkRestoreSignal();
    const logger = makeLogger();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal,
      logger,
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    // start() itself awaits runOnce() and will reject — we test the
    // signal-callback path separately so we manually subscribe + fire.
    // Subscribe a fresh resolver that doesn't auto-start, by firing the
    // signal directly after start() rejects.
    await expect(resolver.start()).rejects.toThrow('database_lost');
    // Now reset the throw-once thing isn't possible without resetting the
    // mock; the signal callback already subscribed. Fire it — the
    // `void runOnce().catch(...)` MUST log and not re-throw.
    await expect(networkRestoreSignal.fire()).resolves.toBeUndefined();
    // Wait a microtask for the catch handler to fire.
    await new Promise<void>((res) => setTimeout(res, 0));
    expect(logger.error).toHaveBeenCalled();
    const errCalls = logger.error.mock.calls.map((c) => JSON.stringify(c));
    expect(errCalls.some((c) => c.includes('database_lost'))).toBe(true);
  });

  // ── start() returns an unsubscribe for the network signal ─────────────────

  it('stop() unsubscribes from the network-restore signal', async () => {
    const linesRepo = makeLinesRepoForResolver([]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble();
    const networkRestoreSignal = makeNetworkRestoreSignal();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal,
      logger: makeLogger(),
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.start();
    expect(networkRestoreSignal.subscribe).toHaveBeenCalledTimes(1);
    resolver.stop();
    // After stop, firing the signal MUST NOT re-trigger findReversalPendingLines.
    const callsBefore = linesRepo.findReversalPendingLines.mock.calls.length;
    await networkRestoreSignal.fire();
    expect(linesRepo.findReversalPendingLines.mock.calls.length).toBe(callsBefore);
  });

  // ── CR-2: per-line throw isolation ───────────────────────────────────────

  it('per-line throw does NOT abort the sweep — remaining lines still retry', async () => {
    // Two pending lines. The first reverseVoucher call throws (e.g.,
    // V-A transport rejection). The resolver MUST log the failure, NOT
    // propagate, and continue to retry the second line in the same
    // pass. The first line stays in `reversal_pending` (no FSM
    // transition) for the next sweep.
    const lineA = PENDING_LINE({
      tender_line_id: 'tl-A',
      voucher_authority_redemption_id: 'redemption-A',
    });
    const lineB = PENDING_LINE({
      tender_line_id: 'tl-B',
      voucher_authority_redemption_id: 'redemption-B',
    });
    const linesRepo = makeLinesRepoForResolver([lineA, lineB]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = vi
      .fn<
        (
          input: ReverseVoucherInput,
          options: { idempotencyKey: string },
        ) => Promise<ReverseVoucherOutcome>
      >()
      .mockImplementationOnce(() => {
        throw new Error('transport blew up');
      })
      .mockImplementationOnce(() =>
        Promise.resolve({
          kind: 'reversed' as const,
          already_reversed: false,
          redemption_id: 'redemption-B',
          reversed_at: '2026-05-25T10:05:06.000Z',
        }),
      );
    const logger = makeLogger();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      logger,
      clock: () => new Date('2026-05-25T10:05:00.000Z'),
    });
    await resolver.runOnce();
    // Both lines were attempted.
    expect(reverseVoucher).toHaveBeenCalledTimes(2);
    // Line A threw → logged at error level; no FSM transition.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        tender_line_id: 'tl-A',
        error: 'transport blew up',
      }),
      'deferred_reversal_resolver:line_threw',
    );
    // Line B succeeded → FSM transition driven; tender.reversed emitted.
    expect(tenderLineFsm.confirmReversed).toHaveBeenCalledTimes(1);
    expect(tenderLineFsm.confirmReversed.mock.calls[0]?.[0]).toMatchObject({
      tender_line_id: 'tl-B',
    });
  });
});
