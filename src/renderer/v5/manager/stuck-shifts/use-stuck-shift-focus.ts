import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * RT-502 — where focus goes when the forced-close dialog closes.
 *
 * The v5 Dialog returns focus to the row button that opened it. That button
 * can be gone by then: a success removes its row, and a `state_invalid`
 * refusal re-reads the list, which remounts every row. When focus was lost
 * (it sits on <body>), and once the list is not loading, focus goes to:
 * the same shift's button, else the row now at its place (the next one),
 * else the list heading, else the page-state notice (an empty list).
 * A manager who already moved focus somewhere keeps their place.
 */

interface Pending {
  readonly id: string;
  /** The row's position when the dialog closed; -1 when it was already gone. */
  readonly index: number;
}

export interface StuckShiftFocus {
  /** Call when the dialog closes for this shift (cancel, Esc or success). */
  afterClose: (shiftId: string) => void;
  rowRef: (shiftId: string, el: HTMLLIElement | null) => void;
  listRef: (el: HTMLUListElement | null) => void;
  headingRef: (el: HTMLHeadingElement | null) => void;
  stateRef: (el: HTMLDivElement | null) => void;
}

function focusWasLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

function rowAt(list: HTMLUListElement | null, index: number): Element | undefined {
  if (list === null || index < 0) return undefined;
  const rows = list.children;
  return rows.length === 0 ? undefined : rows[Math.min(index, rows.length - 1)];
}

function rowButton(row: Element | undefined): HTMLButtonElement | null {
  return row?.querySelector<HTMLButtonElement>('button:not([disabled])') ?? null;
}

/** Focus the first candidate that exists. */
function focusFirst(candidates: ReadonlyArray<HTMLElement | null>): void {
  candidates.find((el) => el !== null)?.focus();
}

export function useStuckShiftFocus(settled: boolean): StuckShiftFocus {
  const rows = useRef(new Map<string, HTMLLIElement>());
  const list = useRef<HTMLUListElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const state = useRef<HTMLDivElement | null>(null);
  const pending = useRef<Pending | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const target = pending.current;
    if (!settled || target === null) return;
    pending.current = null;
    if (!focusWasLost()) return;
    const row = rows.current.get(target.id) ?? rowAt(list.current, target.index);
    focusFirst([rowButton(row), heading.current, state.current]);
  }, [settled, tick]);

  const afterClose = useCallback((shiftId: string): void => {
    const row = rows.current.get(shiftId);
    const index = row === undefined ? -1 : Array.from(list.current?.children ?? []).indexOf(row);
    pending.current = { id: shiftId, index };
    setTick((n) => n + 1);
  }, []);

  return useMemo(
    () => ({
      afterClose,
      rowRef: (shiftId, el) => {
        if (el === null) rows.current.delete(shiftId);
        else rows.current.set(shiftId, el);
      },
      listRef: (el) => {
        list.current = el;
      },
      headingRef: (el) => {
        heading.current = el;
      },
      stateRef: (el) => {
        state.current = el;
      },
    }),
    [afterClose],
  );
}
