import { useEffect, useState, type KeyboardEvent } from 'react';

/**
 * RT-242 (VNext W1-B; freeze 15 §3.3) — keyboard movement between cart rows
 * and the acknowledgement of the newest row.
 *
 * ↑ / ↓ move between rows. From a row control (+, −, ملاحظة, حذف) focus lands
 * on the same control of the neighbouring row, so a column of quantities can be
 * walked; from the cart region or a row itself it lands on the row. Tab order
 * is unchanged: row controls stay reachable by Tab.
 */
export const ROW_FLASH_MS = 150;

const ARROW_STEP: Readonly<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowUp: -1 };

function rowsOf(region: HTMLElement): HTMLElement[] {
  return Array.from(region.querySelectorAll<HTMLElement>('[data-line-id]'));
}

function hasModifier(event: KeyboardEvent<HTMLElement>): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/** Where focus starts: the row it is in (or none) and the row control it is on (or none). */
function originOf(target: EventTarget): { row: HTMLElement | null; action: string | null } {
  if (!(target instanceof HTMLElement)) return { row: null, action: null };
  const row = target.closest<HTMLElement>('[data-line-id]');
  return { row, action: row === null ? null : target.getAttribute('data-row-action') };
}

/** From outside the rows ↓ enters at the first row and ↑ at the last; inside, one step. */
function nextIndex(current: number, step: 1 | -1, count: number): number {
  if (current !== -1) return current + step;
  return step === 1 ? 0 : count - 1;
}

function targetIn(row: HTMLElement, action: string | null): HTMLElement {
  if (action === null) return row;
  return row.querySelector<HTMLElement>(`[data-row-action="${action}"]`) ?? row;
}

/** onKeyDown for the cart region: ArrowUp / ArrowDown only, everything else passes through. */
export function moveRowFocus(event: KeyboardEvent<HTMLElement>): void {
  const step = ARROW_STEP[event.key];
  if (step === undefined || hasModifier(event)) return;
  const rows = rowsOf(event.currentTarget);
  if (rows.length === 0) return;
  event.preventDefault();
  const origin = originOf(event.target);
  const current = origin.row === null ? -1 : rows.indexOf(origin.row);
  const next = rows[nextIndex(current, step, rows.length)];
  if (next !== undefined) targetIn(next, origin.action).focus();
}

function findRow(lineId: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-line-id]')).find(
      (row) => row.getAttribute('data-line-id') === lineId,
    ) ?? null
  );
}

/**
 * Scroll the line the last add landed on into view and flash it for
 * ROW_FLASH_MS (UX-06 Signal tier). Returns whether the flash is on. Under
 * reduced motion the CSS draws no flash; the scroll is instant either way.
 */
export function useNewestRowInView(lineId: string | null, nonce: number): boolean {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (lineId === null || nonce === 0) return undefined;
    const row = findRow(lineId);
    // jsdom has no layout and no scrollIntoView; the real window always does.
    if (row !== null && 'scrollIntoView' in row) row.scrollIntoView({ block: 'nearest' });
    setFlashing(true);
    const timer = window.setTimeout(() => {
      setFlashing(false);
    }, ROW_FLASH_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [lineId, nonce]);
  return flashing;
}
