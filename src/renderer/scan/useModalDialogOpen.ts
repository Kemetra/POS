import { useEffect, useState } from 'react';

/**
 * RT-239 (VNext A2, rule 7) — is a modal dialog open right now?
 *
 * The same test the scan guard uses to refuse a burst (M-S6), observed from the
 * document so the visible scan status can never disagree with what the guard
 * will actually do.
 */
const MODAL_SELECTOR = '[aria-modal="true"]';

export function useModalDialogOpen(): boolean {
  const [open, setOpen] = useState(() => document.querySelector(MODAL_SELECTOR) !== null);
  useEffect(() => {
    const update = (): void => {
      setOpen(document.querySelector(MODAL_SELECTOR) !== null);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-modal'],
    });
    return () => {
      observer.disconnect();
    };
  }, []);
  return open;
}
