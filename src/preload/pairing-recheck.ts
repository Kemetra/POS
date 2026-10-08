import {
  PAIRING_IPC_CHANNELS,
  PAIRING_RECHECK_OUTCOMES,
  type PairingRecheckOutcome,
  type PairingRecheckResult,
} from '../shared/pairing-types';

/**
 * RT-215 10897-A — preload side of `pairing:recheck` (the "Check again").
 *
 * The renderer only TRIGGERS it: no argument crosses the bridge. Only a
 * validated `{ outcome }` comes back; any extra field is dropped, and an
 * answer that is not a known outcome reads as `unreachable` (never `cleared`).
 */

interface InvokerLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

const OUTCOMES: ReadonlySet<string> = new Set(PAIRING_RECHECK_OUTCOMES);

function isOutcome(value: unknown): value is PairingRecheckOutcome {
  return typeof value === 'string' && OUTCOMES.has(value);
}

export async function invokePairingRecheck(renderer: InvokerLike): Promise<PairingRecheckResult> {
  const answer = await renderer.invoke(PAIRING_IPC_CHANNELS.RECHECK);
  const outcome =
    typeof answer === 'object' && answer !== null
      ? (answer as { outcome?: unknown }).outcome
      : undefined;
  return { outcome: isOutcome(outcome) ? outcome : 'unreachable' };
}
