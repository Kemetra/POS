import type { JSX } from 'react';
import './brand.css';

/**
 * RT-695 (doc 25 IC-2, D-263-7) — the pharmacy cross: the brand mark in the
 * nav and the entry strip. A brand mark, not a registry icon, so it keeps its
 * own heavy stroke. Decorative: the «POS Pulse» wordmark beside it names it.
 */
export function PharmacyCross({ size }: Readonly<{ size: 14 | 18 }>): JSX.Element {
  return (
    <svg
      className="v5-brand-cross"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
