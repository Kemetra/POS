/**
 * RT-412 — the fit measurement on stubbed boxes. The test DOM does no layout,
 * so each element gets a block-axis box (top, height); overflow and the row
 * size are real inline styles read through getComputedStyle. The test DOM does
 * not expand the `overflow` shorthand (a browser does), so `overflow-y` is set.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  fitObservationTargets,
  requiredRowSpace,
  surfaceFits,
  visibleRowSpace,
} from '../fit-measure';

/** The element for `selector`; a missing one is a broken fixture. */
function must(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`no element ${selector}`);
  return el;
}

function box(el: Element, top: number, height: number): void {
  const rect = { top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top };
  Object.defineProperty(el, 'getBoundingClientRect', { value: () => rect, configurable: true });
  Object.defineProperty(el, 'getClientRects', {
    value: () => (height > 0 ? [rect] : []),
    configurable: true,
  });
}

function clientHeight(el: Element, value: number): void {
  Object.defineProperty(el, 'clientHeight', { value, configurable: true });
}

/**
 * <main> (clips, 0–500) > ledger (clips, `ledgerTop`–`ledgerBottom`) > pinned row;
 * the row's box is given per test.
 */
function ledger(ledgerBottom: number): { main: HTMLElement; root: HTMLElement; row: HTMLElement } {
  document.body.innerHTML = `
    <main class="v5-frame__main" style="overflow-y: hidden">
      <div class="root">
        <section class="ledger" style="overflow-y: hidden">
          <div class="plain"><div class="row" data-fit="pinned"></div></div>
        </section>
      </div>
    </main>`;
  const main = must('main');
  const root = must('.root');
  box(main, 0, 500);
  box(root, 0, 500);
  box(must('.ledger'), 100, ledgerBottom - 100);
  box(must('.plain'), 0, 0);
  return { main, root, row: must('.row') };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('pinned elements', () => {
  it.each([
    { name: 'fit when the clipping ancestor holds them whole', rowTop: 300, fits: true },
    {
      name: 'fail when a clipping ancestor cuts them (the RT-407 cancel slot, 44px under the ledger)',
      rowTop: 344,
      fits: false,
    },
    { name: 'allow one pixel of rounding at a fractional scale', rowTop: 301, fits: true },
    // `.plain` has an empty box but overflow visible: it never limits the row.
    { name: 'ignore ancestors that do not clip', rowTop: 200, fits: true },
  ])('$name', ({ rowTop, fits }) => {
    const { main, root, row } = ledger(400);
    box(row, rowTop, 100);
    expect(surfaceFits(root, main)).toBe(fits);
  });

  it('are skipped when not rendered (no client rects)', () => {
    const { main, root, row } = ledger(400);
    box(row, 0, 0);
    expect(surfaceFits(root, main)).toBe(true);
  });

  it('judge nothing without a layout engine: <main> has no height', () => {
    const { main, root, row } = ledger(400);
    box(row, 344, 100);
    box(main, 0, 0);
    expect(surfaceFits(root, main)).toBe(true);
  });
});

/** <main> (0–500) > root > list (clips itself; its own box given) > header. */
function list(
  top: number,
  height: number,
  rowSize = 52,
): {
  main: HTMLElement;
  root: HTMLElement;
  list: HTMLElement;
} {
  document.body.innerHTML = `
    <main style="overflow-y: hidden">
      <div class="root">
        <div class="list" data-fit-rows="4" style="overflow-y: auto; --v5-fit-row-size: ${String(rowSize)}px">
          <div class="head" data-fit-exclude></div>
        </div>
      </div>
    </main>`;
  const main = must('main');
  const root = must('.root');
  const el = must('.list');
  box(main, 0, 500);
  box(root, 0, 500);
  box(el, top, height);
  clientHeight(el, height);
  box(must('.head'), top, 32);
  return { main, root, list: el };
}

describe('row capacity', () => {
  it('counts the visible list height, the column labels excluded', () => {
    const { main, list: el } = list(100, 32 + 4 * 52);
    expect(visibleRowSpace(el, main)).toBe(4 * 52);
  });

  it('with no rows drawn yet, needs four rows of the minimum size', () => {
    const { list: el } = list(100, 32 + 4 * 52);
    expect(requiredRowSpace(el, 4, 52)).toBe(4 * 52);
  });

  it('four whole rows fit', () => {
    const { main, root } = list(100, 32 + 4 * 52);
    expect(surfaceFits(root, main)).toBe(true);
  });

  it('three and a bit do not (RT-407 worst case: 3.12 rows at 1280×600)', () => {
    const { main, root } = list(100, 32 + Math.round(3.12 * 52));
    expect(surfaceFits(root, main)).toBe(false);
  });

  it('a list cut by <main> counts only its visible part', () => {
    const { main, root } = list(300, 32 + 6 * 52);
    // 300 + 344 = 644, but <main> ends at 500: 200 visible, minus 32 = 3.2 rows.
    expect(surfaceFits(root, main)).toBe(false);
  });

  it('drawn rows count at their real height: two tall rows (a note, a badge) and two empty slots', () => {
    const { main, root, list: el } = list(100, 32 + 4 * 52);
    el.insertAdjacentHTML('beforeend', '<ol><li data-fit-row></li><li data-fit-row></li></ol>');
    for (const row of Array.from(el.querySelectorAll('[data-fit-row]'))) box(row, 0, 80);
    expect(requiredRowSpace(el, 4, 52)).toBe(2 * 80 + 2 * 52);
    // 208px on screen, 264px needed: fewer than four rows would show.
    expect(surfaceFits(root, main)).toBe(false);
  });

  it('only the first four drawn rows count, however long the cart is', () => {
    const { main, root, list: el } = list(100, 32 + 4 * 52);
    el.insertAdjacentHTML('beforeend', `<ol>${'<li data-fit-row></li>'.repeat(9)}</ol>`);
    for (const row of Array.from(el.querySelectorAll('[data-fit-row]'))) box(row, 0, 52);
    expect(requiredRowSpace(el, 4, 52)).toBe(4 * 52);
    expect(surfaceFits(root, main)).toBe(true);
  });

  it('a list without a row size is not judged', () => {
    const { main, root, list: el } = list(100, 40);
    el.style.removeProperty('--v5-fit-row-size');
    expect(surfaceFits(root, main)).toBe(true);
  });
});

describe('what to observe', () => {
  it('<main>, the marked elements and their clipping ancestors, nothing else', () => {
    const { main, root, row } = ledger(400);
    const targets = fitObservationTargets(root, main);
    expect(targets).toContain(main);
    expect(targets).toContain(row);
    expect(targets).toContain(document.querySelector('.ledger'));
    expect(targets).not.toContain(document.querySelector('.plain'));
    expect(targets).not.toContain(root);
  });
});
