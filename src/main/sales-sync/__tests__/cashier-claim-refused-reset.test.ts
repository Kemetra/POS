/**
 * RT-225 step 3 — the support-only reset of `cashier_claim_refused` dead-letters.
 *
 * Support sets `POS_PULSE_SUPPORT_RESET_CASHIER_CLAIM_REFUSED=1` and restarts the
 * till; on start, before the drain runs, the current terminal's sales
 * dead-lettered as `cashier_claim_refused` go back to `pending`, so the drain
 * re-sends them (with `admissionCheckAt` where it applies). Unset, or any other
 * value, does nothing. The reset never throws into the boot path, and its log
 * lines carry a count only — no ids, no PII (P7).
 */
import { describe, expect, it } from 'vitest';

import {
  CASHIER_CLAIM_REFUSED_RESET_ENV,
  CASHIER_CLAIM_REFUSED_RESET_FAILED_LOG,
  CASHIER_CLAIM_REFUSED_RESET_LOG,
  isCashierClaimRefusedResetRequested,
  resetCashierClaimRefusedOnStart,
} from '../cashier-claim-refused-reset.js';
import type { DrainScope } from '../sale-sync-state-repo.js';

const SCOPE: DrainScope = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };
const NOW = '2026-06-08T09:00:00.000Z';

function recordingLogger() {
  const lines: Array<{ level: 'info' | 'warn'; obj: Record<string, unknown>; msg: string }> = [];
  return {
    lines,
    logger: {
      info: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'info', obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'warn', obj, msg }),
    },
  };
}

describe('RT-225 step 3 — the reset flag', () => {
  it('is the documented support variable', () => {
    expect(CASHIER_CLAIM_REFUSED_RESET_ENV).toBe('POS_PULSE_SUPPORT_RESET_CASHIER_CLAIM_REFUSED');
  });

  it.each(['1', ' 1 '])('"%s" requests the reset', (raw) => {
    expect(isCashierClaimRefusedResetRequested(raw)).toBe(true);
  });

  it.each([undefined, '', '0', 'true', 'yes', '11', 'on'])('%s does not', (raw) => {
    expect(isCashierClaimRefusedResetRequested(raw)).toBe(false);
  });
});

describe('RT-225 step 3 — resetCashierClaimRefusedOnStart', () => {
  it('not requested: the store is not touched and nothing is logged', () => {
    const { logger, lines } = recordingLogger();
    let calls = 0;
    const n = resetCashierClaimRefusedOnStart({
      requested: false,
      stateRepo: {
        resetCashierClaimRefused: () => {
          calls += 1;
          return 3;
        },
      },
      scope: SCOPE,
      now: NOW,
      logger,
    });
    expect(n).toBe(0);
    expect(calls).toBe(0);
    expect(lines).toEqual([]);
  });

  it('requested: resets in the drain scope and logs the count only', () => {
    const { logger, lines } = recordingLogger();
    const seen: Array<[DrainScope, string]> = [];
    const n = resetCashierClaimRefusedOnStart({
      requested: true,
      stateRepo: {
        resetCashierClaimRefused: (scope, now) => {
          seen.push([scope, now]);
          return 2;
        },
      },
      scope: SCOPE,
      now: NOW,
      logger,
    });
    expect(n).toBe(2);
    expect(seen).toEqual([[SCOPE, NOW]]);
    expect(lines).toEqual([
      { level: 'info', obj: { count: 2 }, msg: CASHIER_CLAIM_REFUSED_RESET_LOG },
    ]);
  });

  it('a failing store never throws into boot: logged once, nothing reset', () => {
    const { logger, lines } = recordingLogger();
    const n = resetCashierClaimRefusedOnStart({
      requested: true,
      stateRepo: {
        resetCashierClaimRefused: () => {
          throw new Error('SQLITE_BUSY tenant-1 sale-1');
        },
      },
      scope: SCOPE,
      now: NOW,
      logger,
    });
    expect(n).toBe(0);
    expect(lines).toEqual([
      { level: 'warn', obj: {}, msg: CASHIER_CLAIM_REFUSED_RESET_FAILED_LOG },
    ]);
  });

  it('the log names are closed-set sale_sync lines', () => {
    expect(CASHIER_CLAIM_REFUSED_RESET_LOG).toBe('sale_sync:cashier_claim_refused_reset');
    expect(CASHIER_CLAIM_REFUSED_RESET_FAILED_LOG).toBe(
      'sale_sync:cashier_claim_refused_reset_failed',
    );
  });
});
