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

function rowsOf(region: HTMLElement): HTMLElement[] {
  return Array.from(region.querySelectorAll<HTMLElement>('[data-line-id]'));
}

function targetIn(row: HTMLElement, action: string | null): HTMLElement {
  if (action === null) return row;
  const control = row.querySelector<HTMLElement>(`[data-row-action="${action}"]`);
  return control ?? row;
}

/** onKeyDown for the cart region: ArrowUp / ArrowDown only, everything else passes through. */
export function moveRowFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const region = event.currentTarget;
  const rows = rowsOf(region);
  if (rows.length === 0) return;
  const origin = event.target instanceof HTMLElement ? event.target : null;
  const currentRow = origin?.closest<HTMLElement>('[data-line-id]') ?? null;
  const action = currentRow === null ? null : (origin?.getAttribute('data-row-action') ?? null);
  const index = currentRow === null ? -1 : rows.indexOf(currentRow);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  // From the region itself ↓ enters at the first row, ↑ at the last.
  const nextIndex = index === -1 ? (step === 1 ? 0 : rows.length - 1) : index + step;
  const next = rows[nextIndex];
  event.preventDefault();
  if (next === undefined) return;
  targetIn(next, action).focus();
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
