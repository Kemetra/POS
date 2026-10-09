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
  'nav-settings':
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4L10.7 6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z',
} as const;

export type V5IconName = keyof typeof PATHS;

export function V5Icon({ name, size = 20 }: { name: V5IconName; size?: number }): JSX.Element {
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
