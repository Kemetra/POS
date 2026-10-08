/**
 * RT-15 S4 — the one payout rule both main and the renderer apply (Codex P1
 * on a55ae8e: the panel must never offer what main would refuse, above all a
 * manual attestation while a drawer kick may still open the drawer).
 */
import { describe, expect, it } from 'vitest';

import {
  allowedPayoutActions,
  payoutActionRefusal,
  type PayoutFacts,
  type PayoutKickState,
} from '../payout-rules.js';
import type { ReturnPayoutAction, ReturnState } from '../types.js';

function facts(state: ReturnState, kick: PayoutKickState | null): PayoutFacts {
  return { state, started: kick !== null, kick: kick ?? 'none' };
}

describe('payoutActionRefusal', () => {
  it.each<[ReturnState, PayoutKickState | null, ReturnPayoutAction, string | null]>([
    ['pending', null, 'start', 'not_payable'],
    ['paid_out', 'opened', 'manual', 'already_paid_out'],
    ['confirmed', null, 'start', null],
    ['confirmed', null, 'manual', 'payout_not_started'],
    ['confirmed', 'none', 'start', 'payout_started'],
    ['confirmed', 'failed_before_send', 'retry_drawer', null],
    ['confirmed', 'unknown', 'retry_drawer', 'drawer_retry_unsafe'],
    ['confirmed', 'unknown', 'manual', null],
    ['confirmed', 'opened', 'manual', null],
    ['confirmed', 'in_flight', 'retry_drawer', 'drawer_retry_unsafe'],
    ['confirmed', 'in_flight', 'manual', 'drawer_kick_in_progress'],
  ])('%s, kick %s, %s → %s', (state, kick, action, expected) => {
    expect(payoutActionRefusal(facts(state, kick), action)).toBe(expected);
  });
});

describe('allowedPayoutActions', () => {
  it.each<[ReturnState, PayoutKickState | null, readonly ReturnPayoutAction[]]>([
    ['confirmed', null, ['start']],
    ['confirmed', 'none', ['retry_drawer', 'manual']],
    ['confirmed', 'failed_before_send', ['retry_drawer', 'manual']],
    ['confirmed', 'unknown', ['manual']],
    ['confirmed', 'opened', ['manual']],
    // A kick in flight may still open the drawer: nothing until it settles.
    ['confirmed', 'in_flight', []],
    ['paid_out', 'opened', []],
    ['pending', null, []],
  ])('%s, kick %s → %j', (state, kick, expected) => {
    expect(allowedPayoutActions(facts(state, kick))).toEqual(expected);
  });
});
