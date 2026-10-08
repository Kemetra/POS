/**
 * RT-17 slice 4 part 1 — the tally of refusals that answer a probe of the
 * blind count (10941 "Slice 4 must" item 3).
 *
 * The cashier's count is blind (10920 decision 2), but two refusals still say
 * something about the hidden expected cash:
 *   • `payOut` — a pay-out refused because it exceeds the expected drawer
 *     cash. The renderer only sees the generic `pay_out_not_accepted`, but a
 *     refused amount is still an upper bound, so repeated tries could narrow
 *     the expected cash down;
 *   • `varianceClose` — a close refused for a non-zero variance without an
 *     approver: it says the count was not exactly the expected cash;
 *   • `approverFailure` — RT-17 slice 4 part 2, review round 1 P2-4: a failed
 *     manager approval of a variance close (wrong PIN, locked, expired, or the
 *     closer's own record), so repeated guessing is visible to a manager.
 *
 * The tally counts them for the CURRENT shift only (another shift starts again
 * at zero) so a manager sees the count in the status. It is in memory by
 * design (no new persistence in this part): it is zero again after a restart.
 */

export type ShiftProbeKind = 'payOut' | 'varianceClose' | 'approverFailure';

export type ShiftProbeRefusals = Record<ShiftProbeKind, number>;

export interface ShiftProbeTally {
  record(probe: { shiftId: string; kind: ShiftProbeKind }): void;
  /** The counts of `shiftId` (zero for another shift, or for none). */
  countsFor(shiftId: string | null): ShiftProbeRefusals;
}

function noProbes(): ShiftProbeRefusals {
  return { payOut: 0, varianceClose: 0, approverFailure: 0 };
}

export function createShiftProbeTally(): ShiftProbeTally {
  let current = { shiftId: null as string | null, counts: noProbes() };
  return {
    record({ shiftId, kind }) {
      if (current.shiftId !== shiftId) current = { shiftId, counts: noProbes() };
      current.counts[kind] += 1;
    },
    countsFor(shiftId) {
      if (shiftId === null || current.shiftId !== shiftId) return noProbes();
      return { ...current.counts };
    },
  };
}
