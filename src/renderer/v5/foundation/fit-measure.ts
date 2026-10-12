/**
 * RT-412 (RT-312 D2) — does a screen still show what it must, at the height it
 * actually received?
 *
 * A screen marks what has to stay fully visible with `data-fit="pinned"` (the
 * Checkout due, change, commit and cancel; the Sale total, commit and void), and
 * a scrolling list that must keep a capacity with `data-fit-rows="<n>"`. Its
 * drawn rows (`data-fit-row`) count at their real height, the slots not filled
 * yet at the `--v5-fit-row-size` minimum the list carries; a `data-fit-exclude`
 * child (the sticky column labels) is not row space.
 *
 * Only the block axis is measured: this is the height guard. Every number comes
 * from the laid-out boxes, so the check follows the CSS instead of a copy of it.
 * Where nothing is laid out (jsdom), every box is empty and the screen fits.
 */

/** Sub-pixel slack: fractional DPI rounds a box edge by up to a device pixel. */
const TOLERANCE_PX = 1;

const CLIPPING = new Set(['hidden', 'clip', 'auto', 'scroll']);

/** Whether the element cuts its content off on the block axis (the axis this guard measures). */
function clips(el: Element): boolean {
  return CLIPPING.has(getComputedStyle(el).overflowY);
}

/** The ancestors of `el` that clip it, nearest first, up to and including `stop`. */
function clippingAncestors(el: Element, stop: Element): Element[] {
  const found: Element[] = [];
  for (let a = el.parentElement; a !== null; a = a.parentElement) {
    if (clips(a)) found.push(a);
    if (a === stop) break;
  }
  return found;
}

/** The visible block-axis extent of `el` once every clipping ancestor up to `stop` is applied. */
function visibleBlockSize(el: Element, stop: Element): number {
  const rect = el.getBoundingClientRect();
  let top = rect.top;
  let bottom = rect.bottom;
  for (const box of clippingAncestors(el, stop).map((a) => a.getBoundingClientRect())) {
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  return Math.max(0, bottom - top);
}

/** A pinned element is fine when it is not rendered, or when no clipping ancestor cuts it. */
function pinnedFits(el: Element, stop: Element): boolean {
  if (el.getClientRects().length === 0) return true;
  const height = el.getBoundingClientRect().height;
  return height - visibleBlockSize(el, stop) <= TOLERANCE_PX;
}

function heightOf(el: Element): number {
  return el.getBoundingClientRect().height;
}

/** The list's minimum row size (`--v5-fit-row-size`), or null when it has none. */
function rowSize(list: HTMLElement): number | null {
  const size = Number.parseFloat(getComputedStyle(list).getPropertyValue('--v5-fit-row-size'));
  return Number.isFinite(size) && size > 0 ? size : null;
}

/**
 * The height `required` rows take: the rows already drawn at their real height
 * (a long name, a badge or a note makes a row taller than the minimum), and
 * the slots not filled yet at the minimum row size.
 */
export function requiredRowSpace(list: HTMLElement, required: number, size: number): number {
  const drawn = Array.from(list.querySelectorAll('[data-fit-row]')).slice(0, required);
  return drawn.reduce((sum, row) => sum + heightOf(row), 0) + (required - drawn.length) * size;
}

/** The row space of the list that is on screen: its visible part, the column labels excluded. */
export function visibleRowSpace(list: HTMLElement, stop: Element): number {
  const excluded = Array.from(list.querySelectorAll('[data-fit-exclude]')).reduce(
    (sum, child) => sum + heightOf(child),
    0,
  );
  return Math.min(list.clientHeight, visibleBlockSize(list, stop)) - excluded;
}

function rowsFit(list: HTMLElement, stop: Element): boolean {
  if (list.getClientRects().length === 0) return true;
  const required = Number.parseInt(list.dataset.fitRows ?? '', 10);
  const size = rowSize(list);
  if (!Number.isSafeInteger(required) || size === null) return true;
  return visibleRowSpace(list, stop) >= requiredRowSpace(list, required, size) - TOLERANCE_PX;
}

/**
 * True when every pinned element inside `root` is fully visible and every
 * marked list keeps its row capacity, clipping measured up to `stop` (the
 * frame's <main>).
 */
export function surfaceFits(root: Element, stop: Element): boolean {
  // No layout engine (the test DOM): <main> has no height, so there is nothing to judge.
  if (stop.getBoundingClientRect().height === 0) return true;
  const pinned = Array.from(root.querySelectorAll('[data-fit="pinned"]'));
  const lists = Array.from(root.querySelectorAll<HTMLElement>('[data-fit-rows]'));
  return pinned.every((el) => pinnedFits(el, stop)) && lists.every((list) => rowsFit(list, stop));
}

/** The elements whose size changes can change the answer: the marked ones and what clips them. */
export function fitObservationTargets(root: Element, stop: Element): Element[] {
  const marked = Array.from(root.querySelectorAll('[data-fit="pinned"], [data-fit-rows]'));
  const targets = new Set<Element>([stop]);
  for (const el of marked) {
    targets.add(el);
    clippingAncestors(el, stop).forEach((a) => targets.add(a));
  }
  return Array.from(targets);
}
