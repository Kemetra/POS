import { useEffect, useRef } from 'react';

function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * RT-313 — focus when a viewport guard stops blocking. The too-small notice
 * held focus on its heading; it unmounts as the screen remounts, which drops
 * focus to <body>. This runs after the screen's own mount effects, so a screen
 * that focuses its own control (the Sale's scan field) keeps it; only when
 * nothing took focus does it land on the guard's target (an element the guard
 * owns, with `tabIndex={-1}`), never on <body>.
 */
export function useFocusOnReturn(blocked: boolean, resolveTarget: () => HTMLElement | null): void {
  const wasBlocked = useRef(blocked);
  const resolveRef = useRef(resolveTarget);
  resolveRef.current = resolveTarget;

  useEffect(() => {
    const returned = wasBlocked.current && !blocked;
    wasBlocked.current = blocked;
    if (returned && focusIsLost()) resolveRef.current()?.focus();
  }, [blocked]);
}
