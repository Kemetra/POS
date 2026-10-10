import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * RT-242 (D-C1) — the one serial lane every direct add runs through.
 *
 * Jobs run strictly in order, so two quick scans add two lines in scan order.
 * Each job receives `isCurrent`: false once the sale it was queued for has
 * ended (`cancelPending`, on void or «بيع جديد»), so a late lookup or add
 * neither creates the next sale's cart nor shows its line there. `busy` lets
 * the Sale hold handoff back until every add it has admitted has settled, so
 * the screen never races an add against the freeze.
 */
export interface AddLane {
  enqueue(job: (isCurrent: () => boolean) => Promise<void>): Promise<void>;
  cancelPending(): void;
  /** Resolves once every job queued so far has settled. */
  drain(): Promise<void>;
  readonly busy: boolean;
}

export function useAddLane(): AddLane {
  const laneRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const pendingRef = useRef(0);
  const [busy, setBusy] = useState(false);

  const settle = useCallback((): void => {
    pendingRef.current -= 1;
    if (pendingRef.current === 0) setBusy(false);
  }, []);

  const enqueue = useCallback(
    (job: (isCurrent: () => boolean) => Promise<void>): Promise<void> => {
      const generation = generationRef.current;
      const isCurrent = (): boolean => generation === generationRef.current;
      pendingRef.current += 1;
      setBusy(true);
      const run = (): Promise<void> => job(isCurrent);
      const next = laneRef.current.then(run, run).finally(settle);
      laneRef.current = next.catch(() => undefined);
      return next;
    },
    [settle],
  );

  const cancelPending = useCallback((): void => {
    generationRef.current += 1;
  }, []);

  const drain = useCallback((): Promise<void> => laneRef.current, []);

  return useMemo(
    () => ({ enqueue, cancelPending, drain, busy }),
    [enqueue, cancelPending, drain, busy],
  );
}
