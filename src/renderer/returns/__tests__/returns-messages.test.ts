import { describe, expect, it } from 'vitest';

import {
  LOCAL_RETURN_REFUSALS,
  RETURN_DRAWER_FAILURES,
  RETURN_STATES,
  SERVER_RETURN_REFUSALS,
} from '../../../shared/returns/types.js';
import {
  OUTCOME_COPY,
  PAYOUT_COPY,
  drawerFailureMessage,
  refusalMessage,
  stateLabel,
} from '../returns-messages.js';

/**
 * RT-15 S3 — O1 (AC10): every refusal the bridge can answer has its own
 * message, and no two read alike. The reason lists come from the shared S2
 * tuples, so a reason added in main without copy here fails this test.
 */
const ALL_REASONS = [...SERVER_RETURN_REFUSALS, ...LOCAL_RETURN_REFUSALS];

describe('returns refusal copy (O1)', () => {
  it('covers all 34 reasons (24 from S2/S3, 10 from S4 payout) with a non-empty Arabic message', () => {
    expect(ALL_REASONS).toHaveLength(34);
    for (const reason of ALL_REASONS) {
      const message = refusalMessage(reason);
      expect(message.trim().length, reason).toBeGreaterThan(0);
      expect(message, reason).toMatch(/[؀-ۿ]/);
    }
  });

  it('gives every reason a distinct message, distinct from every outcome message', () => {
    const messages = [...ALL_REASONS.map(refusalMessage), ...Object.values(OUTCOME_COPY)];
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('falls back to a generic message for a reason main has not taught the renderer', () => {
    const unknown = refusalMessage('brand_new_reason' as never);
    expect(unknown.length).toBeGreaterThan(0);
    expect(ALL_REASONS.map(refusalMessage)).not.toContain(unknown);
  });
});

describe('journal state labels (H1)', () => {
  it('labels each of the 5 journal states distinctly', () => {
    const labels = RETURN_STATES.map(stateLabel);
    expect(new Set(labels).size).toBe(5);
    for (const label of labels) expect(label).toMatch(/[؀-ۿ]/);
  });
});

describe('drawer failure and payout copy (RT-15 S4)', () => {
  it('says why the drawer did not open, one distinct Arabic line per reason', () => {
    const lines = RETURN_DRAWER_FAILURES.map(drawerFailureMessage);
    expect(new Set(lines).size).toBe(RETURN_DRAWER_FAILURES.length);
    for (const line of lines) expect(line).toMatch(/[؀-ۿ]/);
  });

  it('falls back to a generic line for a drawer reason the renderer does not know', () => {
    expect(drawerFailureMessage('melted' as never)).toBe(OUTCOME_COPY.unknownReason);
  });

  it('never reuses a refusal line as payout copy, and uses no em dash', () => {
    const payout = Object.values(PAYOUT_COPY);
    const refusals = new Set(ALL_REASONS.map(refusalMessage));
    expect(payout.filter((line) => refusals.has(line))).toEqual([]);
    expect(payout.filter((line) => line.includes('—'))).toEqual([]);
  });
});
