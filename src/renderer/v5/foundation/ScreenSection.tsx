import { useId, type JSX, type ReactNode } from 'react';
import './screen-section.css';

interface ScreenSectionProps {
  /** The screen's one <h1>; it also names the region. */
  readonly title: string;
  readonly children: ReactNode;
}

/**
 * RT-498 (VN-S10 S10-1) — a screen inside the v5 frame: a region named by its
 * own <h1>. The frame owns the one <main>, the nav and the brand, so a screen
 * never adds a landmark of its own. It replaces the legacy shell's layout
 * primitive for the screens that moved off it; their content is recomposed per surface
 * in S10-2 … S10-6. The section scrolls when its content is taller than the
 * frame's main, which clips.
 */
export function ScreenSection({ title, children }: ScreenSectionProps): JSX.Element {
  const titleId = useId();
  return (
    <section
      className="v5-screen-section"
      aria-labelledby={titleId}
      data-testid="v5-screen-section"
    >
      <h1 id={titleId} className="v5-screen-section__title">
        {title}
      </h1>
      <div className="v5-screen-section__body">{children}</div>
    </section>
  );
}
