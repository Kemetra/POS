/**
 * RT-412 (RT-312 D2) — does a screen still show what it must, at the height it
 * actually received?
 *
 * A screen marks what has to stay fully visible with `data-fit="pinned"` (the
 * Checkout due, change, commit and cancel; the Sale total, commit and void), and
 * a scrolling list that must keep a capacity with `data-fit-rows="<n>"`. The
 * list's row size is the `--v5-fit-row-size` custom property it carries; a
 * `data-fit-exclude` child (the sticky column labels) is not row space.
 *
 * Only the block axis is measured: this is the height guard. Every number comes
 * from the laid-out boxes, so the check follows the CSS instead of a copy of it.
 * Where nothing is laid out (jsdom), every box is empty and the screen fits.
 */

/** Sub-pixel slack: fractional DPI rounds a box edge by up to a device pixel. */
const TOLERANCE_PX = 1;

/** The same slack for a row capacity: a row a pixel short of whole still counts. */
const ROW_TOLERANCE = 0.02;

const CLIPPING = new Set(['hidden', 'clip', 'auto', 'scroll']);

/** Whether the element cuts its content off on the block axis (the axis this guard measures). */
function clips(el: Element): boolean {
  return CLIPPING.has(getComputedStyle(el).overflowY);
}

/** The visible block-axis extent of `el` once every clipping ancestor up to `stop` is applied. */
function visibleBlockSize(el: Element, stop: Element): number {
  const rect = el.getBoundingClientRect();
  let top = rect.top;
  let bottom = rect.bottom;
  for (let a = el.parentElement; a !== null; a = a.parentElement) {
    if (clips(a)) {
      const box = a.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
    if (a === stop) break;
  }
  return Math.max(0, bottom - top);
}

/** A pinned element is fine when it is not rendered, or when no clipping ancestor cuts it. */
function pinnedFits(el: Element, stop: Element): boolean {
  if (el.getClientRects().length === 0) return true;
  const height = el.getBoundingClientRect().height;
  return height - visibleBlockSize(el, stop) <= TOLERANCE_PX;
}

/** How many rows of the list's row size fit in the part of it that is on screen. */
export function rowCapacity(list: HTMLElement, stop: Element): number | null {
  const row = Number.parseFloat(getComputedStyle(list).getPropertyValue('--v5-fit-row-size'));
  if (!Number.isFinite(row) || row <= 0) return null;
  const excluded = Array.from(list.querySelectorAll<HTMLElement>('[data-fit-exclude]')).reduce(
    (sum, child) => sum + child.getBoundingClientRect().height,
    0,
  );
  const visible = Math.min(list.clientHeight, visibleBlockSize(list, stop));
  return (visible - excluded) / row;
}

function rowsFit(list: HTMLElement, stop: Element): boolean {
  if (list.getClientRects().length === 0) return true;
  const required = Number.parseInt(list.dataset.fitRows ?? '', 10);
  const capacity = rowCapacity(list, stop);
  if (!Number.isSafeInteger(required) || capacity === null) return true;
  return capacity >= required - ROW_TOLERANCE;
}

/**
 * True when every pinned element inside `root` is fully visible and every
 * marked list keeps its row capacity, clipping measured up to `stop` (the
 * frame's <main>).
 */
export function surfaceFits(root: Element, stop: Element): boolean {
  // No layout engine (the test DOM): <main> has no height, so there is nothing to judge.
  if (stop.getBoundingClientRect().height === 0) return true;
  for (const el of Array.from(root.querySelectorAll('[data-fit="pinned"]'))) {
    if (!pinnedFits(el, stop)) return false;
  }
  for (const list of Array.from(root.querySelectorAll<HTMLElement>('[data-fit-rows]'))) {
    if (!rowsFit(list, stop)) return false;
  }
  return true;
}

/** The elements whose size changes can change the answer: the marked ones and what clips them. */
export function fitObservationTargets(root: Element, stop: Element): Element[] {
  const targets = new Set<Element>([stop]);
  for (const el of Array.from(root.querySelectorAll('[data-fit="pinned"], [data-fit-rows]'))) {
    targets.add(el);
    for (let a = el.parentElement; a !== null; a = a.parentElement) {
      if (clips(a)) targets.add(a);
      if (a === stop) break;
    }
  }
  return Array.from(targets);
}
