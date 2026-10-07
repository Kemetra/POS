import { useCallback, useEffect, useRef } from 'react';
import type { CartLineItem } from '../../sale/useSaleCartController';
import { focusScanOwner } from '../../scan/scan-anchor';

/**
 * RT-239 (VNext A2, rule 6) — where focus goes when a row is removed from the
 * keyboard: the neighbouring row's same control, or the scan owner when the
 * cart becomes empty. (A pointer click returns to the scan owner instead.)
 *
 * The removal itself is async (the cart bridge confirms it), so the row is
 * only gone when the lines change. A plan that never completes (a refused
 * removal) is dropped after `PLAN_TTL_MS` so it cannot move focus later.
 */
export type RemovalControl = 'remove' | 'decrement';

const PLAN_TTL_MS = 3000;

interface RemovalPlan {
  readonly removedId: string;
  readonly neighbourId: string | null;
  readonly control: RemovalControl;
  readonly at: number;
}

function rowControl(lineId: string, control: RemovalControl): HTMLElement | null {
  const row = Array.from(document.querySelectorAll('[data-line-id]')).find(
    (el) => el.getAttribute('data-line-id') === lineId,
  );
  const target = row?.querySelector(`[data-row-action="${control}"]`);
  return target instanceof HTMLElement ? target : null;
}

export function useRemovalFocus(
  lines: readonly CartLineItem[],
): (line: CartLineItem, control: RemovalControl) => void {
  const plan = useRef<RemovalPlan | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  useEffect(() => {
    const pending = plan.current;
    if (pending === null) return;
    if (Date.now() - pending.at > PLAN_TTL_MS) {
      plan.current = null;
      return;
    }
    if (lines.some((line) => line.lineId === pending.removedId)) return;
    plan.current = null;
    const next =
      pending.neighbourId === null ? null : rowControl(pending.neighbourId, pending.control);
    if (next === null) focusScanOwner();
    else next.focus();
  }, [lines]);

  return useCallback((line, control) => {
    const all = linesRef.current;
    const index = all.findIndex((item) => item.lineId === line.lineId);
    const neighbour = all[index + 1] ?? all[index - 1] ?? null;
    plan.current = {
      removedId: line.lineId,
      neighbourId: neighbour?.lineId ?? null,
      control,
      at: Date.now(),
    };
  }, []);
}
