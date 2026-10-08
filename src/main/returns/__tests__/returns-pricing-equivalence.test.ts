/**
 * RT-197 I4 — the till prices a return exactly as Backend-Core does.
 *
 * Backend-Core prices each returned line in Postgres `numeric`
 * (Kemetra/Backend-Core @ 1e7c5b2,
 * `apps/api/src/catalog/sales/sale-returns.service.ts`):
 *
 *   :183  qty   = the request quantity            ($3::numeric[])
 *   :186  sold  = sale_lines.quantity             (numeric(19,6))
 *         a     = sale_lines.line_amount          (numeric(19,4))
 *   :187  c     = COALESCE(SUM(sale_return_lines.quantity), 0)  — already returned
 *   :199  line_amount =
 *           (round(a * (c + qty) / sold, 4) - round(a * c / sold, 4))::numeric(19,4)
 *
 * The vectors below are that expression's own output: each row was evaluated
 * by PostgreSQL 16 with the same column types (a numeric(19,4), sold and c
 * numeric(19,6), qty numeric), stepping c through successive partial returns.
 * The POS `priceReturnLine` (bigint ten-thousandths) must reproduce every one.
 */
import { describe, expect, it } from 'vitest';

import { parseAmount4, priceReturnLine } from '../returns-money.js';

interface Step {
  /** c — whole quantity already returned on the line before this return. */
  readonly returned: number;
  /** qty — whole quantity returned now. */
  readonly quantity: number;
  /** Backend-Core's `line_amount` for it (numeric(19,4) text). */
  readonly want: string;
}

interface Vector {
  readonly label: string;
  /** a — the sale line's `line_amount`. */
  readonly lineAmount: string;
  /** sold — the sale line's quantity. */
  readonly sold: number;
  readonly steps: readonly Step[];
}

/** Successive partial returns of `quantities`, priced by Backend-Core as `wants`. */
function steps(quantities: readonly number[], wants: readonly string[]): Step[] {
  let returned = 0;
  return quantities.map((quantity, i) => {
    const step = { returned, quantity, want: wants[i] ?? 'missing' };
    returned += quantity;
    return step;
  });
}

const VECTORS: readonly Vector[] = [
  {
    label: 'partial returns of a conforming line, one at a time',
    lineAmount: '45.0000',
    sold: 3,
    steps: steps([1, 1, 1], ['15.0000', '15.0000', '15.0000']),
  },
  {
    label: 'partial returns of a conforming line, 2 then 1',
    lineAmount: '45.0000',
    sold: 3,
    steps: steps([2, 1], ['30.0000', '15.0000']),
  },
  {
    label: 'cumulative rounding: 10.00 over 3',
    lineAmount: '10.0000',
    sold: 3,
    steps: steps([1, 1, 1], ['3.3333', '3.3334', '3.3333']),
  },
  {
    label: 'cumulative rounding: 0.10 over 3',
    lineAmount: '0.1000',
    sold: 3,
    steps: steps([1, 1, 1], ['0.0333', '0.0334', '0.0333']),
  },
  {
    label: 'cumulative rounding: 1.00 over 6, returned 1, 2, 3',
    lineAmount: '1.0000',
    sold: 6,
    steps: steps([1, 2, 3], ['0.1667', '0.3333', '0.5000']),
  },
  {
    label: 'cumulative rounding: 100.00 over 7, one at a time',
    lineAmount: '100.0000',
    sold: 7,
    steps: steps(
      [1, 1, 1, 1, 1, 1, 1],
      ['14.2857', '14.2857', '14.2857', '14.2858', '14.2857', '14.2857', '14.2857'],
    ),
  },
  {
    label: 'odd quantity: 99.99 over 7, returned 3 then 4',
    lineAmount: '99.9900',
    sold: 7,
    steps: steps([3, 4], ['42.8529', '57.1371']),
  },
  {
    label: 'odd quantity: 12.3456 over 11, returned 5 then 6',
    lineAmount: '12.3456',
    sold: 11,
    steps: steps([5, 6], ['5.6116', '6.7340']),
  },
  {
    label: 'odd quantity: 20.00 over 9, returned 4 then 5',
    lineAmount: '20.0000',
    sold: 9,
    steps: steps([4, 5], ['8.8889', '11.1111']),
  },
  {
    label: 'zero-price line, returned 2 then 3',
    lineAmount: '0.0000',
    sold: 5,
    steps: steps([2, 3], ['0.0000', '0.0000']),
  },
  {
    label: 'zero-price single unit',
    lineAmount: '0.0000',
    sold: 1,
    steps: steps([1], ['0.0000']),
  },
  {
    label: 'a half rounds away from zero (round(0.00015, 4) = 0.0002)',
    lineAmount: '0.0003',
    sold: 2,
    steps: steps([1, 1], ['0.0002', '0.0001']),
  },
  {
    label: 'a large amount over 13, returned 6 then 7',
    lineAmount: '123456789.1235',
    sold: 13,
    steps: steps([6, 7], ['56980056.5185', '66476732.6050']),
  },
];

const CASES = VECTORS.flatMap((v) =>
  v.steps.map((s) => ({ ...s, label: v.label, lineAmount: v.lineAmount, sold: v.sold })),
);

describe('I4: priceReturnLine reproduces Backend-Core’s return pricing', () => {
  it.each(CASES)(
    '$label: c=$returned, q=$quantity of $sold → $want',
    ({ lineAmount, sold, returned, quantity, want }) => {
      const lineAmount4 = parseAmount4(lineAmount) ?? -1n;
      const priced = priceReturnLine({ lineAmount4, sold, returned, quantity });
      expect(priced).toBe(parseAmount4(want));
    },
  );
});
