/**
 * RT-240 — every Latin word a cashier would read or hear on a subtree.
 *
 * Left-to-right runs (money, codes, times) and key caps are set aside first.
 * Text, `aria-label`, `title` and `placeholder` are swept; a left-to-right
 * field's placeholder is a code format, so it counts as left-to-right content.
 * Only the key names Esc and Enter pass.
 */
const ALLOWED = new Set(['Esc', 'Enter']);

const SPOKEN = ['aria-label', 'title'] as const;
const SHOWN = [...SPOKEN, 'placeholder'] as const;

/** Text with every left-to-right run and key cap removed. */
function rtlText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[dir="ltr"], kbd').forEach((el) => {
    el.remove();
  });
  return clone.textContent;
}

/** Inside a left-to-right run, but not the run's own element. */
function insideLtrRun(el: Element): boolean {
  return el.closest('[dir="ltr"]') !== null && el.getAttribute('dir') !== 'ltr';
}

/** The attribute values a cashier reads or hears on one element. */
function attributeText(el: Element): string[] {
  const attrs = el.getAttribute('dir') === 'ltr' ? SPOKEN : SHOWN;
  return attrs.map((attr) => el.getAttribute(attr)).filter((v): v is string => v !== null);
}

export function latinLeaks(root: HTMLElement): string[] {
  const elements = [root, ...Array.from(root.querySelectorAll('*'))];
  const sources = [
    rtlText(root),
    ...elements.filter((el) => !insideLtrRun(el)).flatMap(attributeText),
  ];
  return sources
    .flatMap((text) => text.match(/[A-Za-z]+/g) ?? [])
    .filter((word) => !ALLOWED.has(word));
}
