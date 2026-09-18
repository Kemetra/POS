/**
 * 006 T231 — deferred-reversal resolver history preservation (RED).
 *
 * Asserts (tasks.md T231):
 *
 *   The resolver preserves the `reversal_pending_since` timestamp for
 *   incident reconstruction even after the line moves to `reversed`.
 *
 * **Reconciliation with the existing repo + data-model.md**:
 *
 *   The repo's `updateState({ state: 'reversed' })` transition clears
 *   `reversal_pending_since` on the ROW (set NULL — see
 *   `payment-tender-lines.repository.ts` UPDATE statement; matches
 *   data-model.md §"PaymentTenderLine" line 156).
 *
 *   T231 is satisfied at the AUDIT layer: the `tender.reversed` audit
 *   event payload carries the `reversal_pending_since` value the
 *   resolver read from the row before driving `confirmReversed`. The
 *   audit log is the durable incident-reconstruction surface
 *   (audit_events is append-only); a future operator running
 *   "show me the reversal history for line X" pulls it from the
 *   audit row, not the live tender line row. This decoupling lets the
 *   row state stay clean (one timestamp per terminal state) while the
 *   audit trail preserves the full timeline.
 *
 *   The resolver MUST therefore:
 *     1. Read the pending line's `reversal_pending_since` BEFORE
 *        driving `confirmReversed`.
 *     2. Pass it into `emitTenderReversed` so the audit payload
 *        carries both `reversed_at` (now) and
 *        `reversal_pending_since` (original outage moment).
 *
 * **Wave 5 — TDD RED.** Forward-references the resolver factory + an
 * additive optional field on `EmitTenderReversedInput`.
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

function makeNoopNetworkRestoreSignal() {
  return {
    subscribe: vi.fn(() => () => {}),
  };
}

function makeLinesRepoForResolver(rows: readonly PaymentTenderLineRow[]) {
  return {
    findReversalPendingLines: vi.fn(() => [...rows]),
    findByLineId: vi.fn((id: string) => rows.find((r) => r.tender_line_id === id)),
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('T231 — resolver preserves reversal_pending_since in audit', () => {
  it('forwards reversal_pending_since into the tender.reversed audit payload', async () => {
    const ORIGINAL_PENDING_AT = '2026-05-25T10:00:05.000Z';
    const RESOLVED_AT = '2026-05-25T10:30:00.000Z';
    const pending = makeLineRow({
      tender_line_id: 'tl-pending-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      state: 'reversal_pending',
      voucher_authority_redemption_id: 'redemption-ABC',
      applied_at: '2026-05-25T09:00:00.000Z',
      reversal_pending_since: ORIGINAL_PENDING_AT,
      last_action_id: 'pend-action-1',
    });
    const linesRepo = makeLinesRepoForResolver([pending]);
    const attemptsRepo = makeAttemptsRepoDouble([makeAttemptRow()]);
    const tenderLineFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const reverseVoucher = makeReverseVoucherDouble({
      kind: 'reversed',
      already_reversed: false,
      redemption_id: 'redemption-ABC',
      reversed_at: RESOLVED_AT,
    });
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo,
      tenderLineFsm,
      auditEmitter,
      reverseVoucher,
      networkRestoreSignal: makeNoopNetworkRestoreSignal(),
      logger: makeLogger(),
      clock: () => new Date(RESOLVED_AT),
    });
    await resolver.runOnce();

    const reversedEvent = auditEmitter.captured.find(
      (e) => e.action_category === 'tender.reversed',
    );
    expect(reversedEvent).toBeDefined();
    // Both timestamps land in the audit payload — `reversed_at` is the
    // resolution moment; `reversal_pending_since` is preserved from the
    // original `tender.reversal_pending` event for incident reconstruction.
    expect(reversedEvent?.payload).toMatchObject({
      tender_line_id: 'tl-pending-1',
      tender_type: 'internal_voucher',
      reversed_at: RESOLVED_AT,
      reversal_pending_since: ORIGINAL_PENDING_AT,
    });
  });

  it('idempotent V-A reverse (already_reversed=true) STILL forwards reversal_pending_since', async () => {
    // If the resolver retries after a process restart and V-A returns
    // already_reversed=true, the resolution path is still "treat as
    // reversed locally" — but the audit row must continue to preserve
    // the original `reversal_pending_since` from the row.
    const ORIGINAL_PENDING_AT = '2026-05-25T10:00:05.000Z';
    const RESOLVED_AT = '2026-05-25T10:35:00.000Z';
    const pending = makeLineRow({
      tender_line_id: 'tl-pending-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      state: 'reversal_pending',
      voucher_authority_redemption_id: 'redemption-ABC',
      applied_at: '2026-05-25T09:00:00.000Z',
      reversal_pending_since: ORIGINAL_PENDING_AT,
      last_action_id: 'pend-action-1',
    });
    const linesRepo = makeLinesRepoForResolver([pending]);
    const auditEmitter = makeAuditEmitterDouble();
    const resolver = createDeferredReversalResolver({
      linesRepo,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      tenderLineFsm: makeTenderLineFsmDouble(),
      auditEmitter,
      reverseVoucher: makeReverseVoucherDouble({
        kind: 'reversed',
        already_reversed: true,
        redemption_id: 'redemption-ABC',
        reversed_at: '2026-05-25T10:00:08.000Z',
      }),
      networkRestoreSignal: makeNoopNetworkRestoreSignal(),
      logger: makeLogger(),
      clock: () => new Date(RESOLVED_AT),
    });
    await resolver.runOnce();
    const reversedEvent = auditEmitter.captured.find(
      (e) => e.action_category === 'tender.reversed',
    );
    expect(reversedEvent?.payload).toMatchObject({
      reversal_pending_since: ORIGINAL_PENDING_AT,
    });
  });
});
