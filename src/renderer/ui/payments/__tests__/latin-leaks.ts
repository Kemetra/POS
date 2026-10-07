/**
 * RT-240 — every Latin word a cashier would read or hear on a subtree.
 *
 * Left-to-right runs (money, codes, times) and key caps are set aside first.
 * Text, `aria-label`, `title` and `placeholder` are swept; a left-to-right
 * field's placeholder is a code format, so it counts as left-to-right content.
 * Only the key names Esc and Enter pass.
 */
const ALLOWED = new Set(['Esc', 'Enter']);

export function latinLeaks(root: HTMLElement): string[] {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[dir="ltr"], kbd').forEach((el) => {
    el.remove();
  });
  const sources = [clone.textContent];
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (el.closest('[dir="ltr"]') !== null && el.getAttribute('dir') !== 'ltr') continue;
    const ltrField = el.getAttribute('dir') === 'ltr';
    for (const attr of ltrField
      ? ['aria-label', 'title']
      : ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value !== null) sources.push(value);
    }
  }
  return sources
    .flatMap((text) => text.match(/[A-Za-z]+/g) ?? [])
    .filter((word) => !ALLOWED.has(word));
}
