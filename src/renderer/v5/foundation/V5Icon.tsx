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
