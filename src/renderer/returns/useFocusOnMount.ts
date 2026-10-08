import { useEffect, useRef, type RefObject } from 'react';

/**
 * RT-15 S3 — K2: a step takes focus when it appears, so keyboard and screen
 * reader users land on it. Steps focus their heading (tabIndex -1), never a
 * commit control, so a stray Enter cannot confirm anything (D3).
 */
export function useFocusOnMount<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
