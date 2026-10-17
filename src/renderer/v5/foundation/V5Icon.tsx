import type { JSX } from 'react';

/**
 * The small v5 icon set: one 24-unit grid, one 1.75 stroke, currentColor, so
 * every glyph inherits its control's colour and contrast. Icons are always
 * decorative here; the visible text label next to them carries the meaning.
 */
const PATHS = {
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20',
  scan: 'M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 8v8M11 8v8M14 8v8M17 8v8',
  minus: 'M6 12h12',
  plus: 'M12 6v12M6 12h12',
  // Points toward the inline end of an RTL line: "forward" for this product.
  forward: 'M19 12H5M11 6l-6 6 6 6',
  cross: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  // RT-241 — status tones: each has its own shape, so a tone never rests on colour alone.
  'status-info': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
  'status-success': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12.5l2.5 2.5L16 9.5',
  'status-warning': 'M12 4 2.5 20h19L12 4ZM12 10v4M12 17h.01',
  'status-danger': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9 9l6 6M15 9l-6 6',
  // RT-242 — slim-rail nav glyphs; the visible short label beside each carries the meaning.
  'nav-dashboard': 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  'nav-cart': 'M3 5h2l2.2 10.2a1 1 0 0 0 1 .8h8.6a1 1 0 0 0 1-.8L20 8H6.2M9 20h.01M17 20h.01',
  'nav-sales': 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  'nav-returns': 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  'nav-audit': 'M9 4h6v3H9zM7 5.5H5V21h14V5.5h-2M8.5 12h7M8.5 16h5',
  'nav-inventory': 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5 12 12l9-4.5M12 12v9',
  // RT-243 — Checkout glyphs; the tile label beside each carries the meaning.
  'tender-cash': 'M3 7h18v10H3zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6 10v.01M18 14v.01',
  'tender-card': 'M3 6h18v12H3zM3 10h18M7 15h4',
  'tender-voucher': 'M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4zM14 7v10',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  // RT-244 — entry screens. `backspace` points left, as on the LTR keypad it sits
  // on; `back` points toward the inline start of an RTL line ("back" for this
  // product). The visible label or aria-label carries the meaning.
  backspace: 'M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7zM12 9l5 6M17 9l-5 6',
  back: 'M9 6l6 6-6 6',
  key: 'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM11 12l8-8M16 7l2.5 2.5M14 9l2 2',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  // RT-244 PR2 — the Ready card (a terminal) and the pairing card (a link).
  terminal: 'M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM8 20h8M12 16v4',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  // RT-424 — Manager → Cashiers (G-3): the «بدون رقم سري» badge and «إعادة المحاولة».
  dash: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.5 12h7',
  retry: 'M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5',
  // RT-605 — the printer-failure banner's own glyph (a printer with a warning
  // mark on the slip), so it is never mistaken for the offline banner.
  printer:
    'M6 9V4h12v5M6 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1M6 15h12v5H6zM12 16.5v1.2M12 19.4v.05',
  // RT-499 — the manager home cards (G-6); the title beside each carries the meaning.
  'manager-shift': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  'manager-cashiers':
    'M9 12.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3 19c.8-3.3 3.2-5 6-5s5.2 1.7 6 5M16 5.5a3.5 3.5 0 0 1 0 7M18 14c1.6.6 2.6 2.4 3 5',
  'manager-held': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM10 9v6M14 9v6',
  'manager-stuck': 'M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3ZM9 12h6',
  // RT-445 — park / resume (PK-3): «تعليق البيع» and the price difference's direction.
  pause: 'M7.5 5h3v14h-3zM13.5 5h3v14h-3z',
  'arrow-up': 'M12 19V6M6.5 11.5 12 6l5.5 5.5',
  'arrow-down': 'M12 5v13M6.5 12.5 12 18l5.5-5.5',
  'nav-settings':
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4L10.7 6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z',
} as const;

export type V5IconName = keyof typeof PATHS;

export function V5Icon({
  name,
  size = 20,
}: Readonly<{ name: V5IconName; size?: number }>): JSX.Element {
  return (
    <svg
      className="v5-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'cross' ? 3 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
