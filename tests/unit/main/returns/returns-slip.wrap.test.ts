/**
 * RT-829 — every dynamic value on the cash return slip wraps to the 42-column roll
 * by display width: wide, emoji and combining values in each dynamic field, in BOTH
 * the HTML and the ESC/POS output, the full value printed, no cluster split.
 *
 * Values stay within the slip's 120-code-point line-name cap (SLIP_LINE_NAME_MAX),
 * so the full-value assertion measures wrapping, not the cap.
 */
import { describe, expect, it } from 'vitest';

import {
  WIDE_VALUES,
  escposLines,
  expectFitsRoll,
  htmlLines,
} from '../receipts/__helpers__/printed-lines.js';
import {
  LINE_A,
  NOW,
  RETURN_REF,
  SALE_REF,
  SCOPE,
} from '../../../../src/main/returns/__tests__/__helpers__/returns-fixture.js';
import {
  renderReturnSlip,
  slipText,
  type ReturnSlipSource,
} from '../../../../src/main/returns/returns-slip.js';
import type { JournalEntry } from '../../../../src/main/returns/returns-repository.js';
import type { PayoutRow } from '../../../../src/main/returns/returns-payout-repository.js';

const ENTRY: JournalEntry = {
  returnId: 'ret-1',
  scope: SCOPE,
  saleId: 'sale-1',
  saleNumber: 'T1-000042',
  serverSaleRef: SALE_REF,
  externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-0000000000e1',
  operatorId: 'op',
  operatorSessionId: 'sess',
  currencyCode: 'EGP',
  quotedTotalMinor: 3500,
  requestBodyJson: '{}',
  lines: [{ lineRef: LINE_A, quantity: 1 }],
  state: 'paid_out',
  returnRef: RETURN_REF,
  returnTotalMinor: 3500,
  refusalReason: null,
  attemptCount: 1,
  lastAttemptAt: NOW,
  createdAt: NOW,
  confirmedAt: NOW,
};

const PAYOUT: PayoutRow = {
  returnId: 'ret-1',
  startedOperatorId: 'op',
  startedSessionId: 'sess',
  startedAt: NOW,
  paidOperatorId: 'op',
  paidOperatorName: 'Mona',
  paidSessionId: 'sess',
  paidAt: NOW,
  method: 'drawer',
  kickOutcome: 'opened' as const,
  kickCount: 1,
  kickedAt: NOW,
};

const SOURCE: ReturnSlipSource = {
  entry: ENTRY,
  payout: PAYOUT,
  lines: [{ lineRef: LINE_A, quantity: 1, lineName: 'Panadol', amountMinor: 1500 }],
  sale: { branchName: 'Branch', terminalLabel: 'T1' },
};

type Build = (v: string) => ReturnSlipSource;

const FIELDS: ReadonlyArray<readonly [string, Build]> = [
  ['branchName', (v) => ({ ...SOURCE, sale: { branchName: v, terminalLabel: 'T1' } })],
  ['terminalLabel', (v) => ({ ...SOURCE, sale: { branchName: 'B', terminalLabel: v } })],
  ['returnRef', (v) => ({ ...SOURCE, entry: { ...ENTRY, returnRef: v } })],
  ['saleNumber', (v) => ({ ...SOURCE, entry: { ...ENTRY, saleNumber: v } })],
  ['serverSaleRef', (v) => ({ ...SOURCE, entry: { ...ENTRY, serverSaleRef: v } })],
  ['paidOperatorName', (v) => ({ ...SOURCE, payout: { ...PAYOUT, paidOperatorName: v } })],
  [
    'line name',
    (v) => ({
      ...SOURCE,
      lines: [{ lineRef: LINE_A, quantity: 1, lineName: v, amountMinor: 1500 }],
    }),
  ],
];

describe('RT-829 — wide, emoji and combining values wrap by display width on the return slip', () => {
  for (const [field, build] of FIELDS) {
    for (const [kind, value] of WIDE_VALUES) {
      it(`${field} (${kind}): every line ≤ 42 display columns, full value, no split cluster, HTML and ESC/POS`, () => {
        const out = renderReturnSlip(build(value), { kind: 'original' });
        for (const lines of [htmlLines(out.html), escposLines(out.escpos)]) {
          expectFitsRoll(lines, value);
        }
      });
    }
  }
});

describe('RT-829 — internal spacing on the return slip', () => {
  it('keeps a run of spaces inside a line and drops the gap at the break', () => {
    const value = 'ababababab   cdcdcdcdcd   efefefefef';
    expect(slipText(value, 'Paid by: ')).toEqual([
      'Paid by: ababababab   cdcdcdcdcd',
      '    efefefefef',
    ]);
  });
});
