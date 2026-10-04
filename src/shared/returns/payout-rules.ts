/**
 * RT-15 S4 — the one rule for which payout action a return allows. Main
 * enforces it (`payoutRefusal`) and the renderer offers only what it allows
 * (the payout panel), so the two cannot drift (Codex P1 on a55ae8e: never
 * offer a manual attestation while a drawer kick may still open the drawer).
 */
import type {
  ReturnPayoutAction,
  ReturnPayoutKick,
  ReturnState,
  ReturnsRefusalReason,
} from './types.js';

/**
 * What is known about a started payout's drawer kick: the recorded outcome,
 * or `in_flight` (sent, not recorded, within its lease: it may still open the
 * drawer). A kick still unrecorded after its lease is `unknown`.
 */
export type PayoutKickState = ReturnPayoutKick | 'in_flight';

export interface PayoutFacts {
  readonly state: ReturnState;
  /** A payout was started (claimed) for the return. */
  readonly started: boolean;
  /** The started payout's kick (`none` when not started). */
  readonly kick: PayoutKickState;
}

const ACTIONS: readonly ReturnPayoutAction[] = ['start', 'retry_drawer', 'manual'];

type StartedRule = (kick: PayoutKickState) => ReturnsRefusalReason | null;

/** Why each action is refused on a started payout (or null). */
const STARTED_RULES: Readonly<Record<ReturnPayoutAction, StartedRule>> = {
  start: () => 'payout_started',
  // P1: the drawer again only after a kick that provably never reached it.
  retry_drawer: (kick) =>
    kick === 'none' || kick === 'failed_before_send' ? null : 'drawer_retry_unsafe',
  // A manual payout completes whatever the drawer did, once no kick is in flight.
  manual: (kick) => (kick === 'in_flight' ? 'drawer_kick_in_progress' : null),
};

/** Why `action` is refused for a return with these facts, or null. */
export function payoutActionRefusal(
  facts: PayoutFacts,
  action: ReturnPayoutAction,
): ReturnsRefusalReason | null {
  if (facts.state === 'paid_out') return 'already_paid_out';
  if (facts.state !== 'confirmed') return 'not_payable';
  if (!facts.started) return action === 'start' ? null : 'payout_not_started';
  return STARTED_RULES[action](facts.kick);
}

/** The actions a return with these facts allows now. */
export function allowedPayoutActions(facts: PayoutFacts): readonly ReturnPayoutAction[] {
  return ACTIONS.filter((action) => payoutActionRefusal(facts, action) === null);
}
