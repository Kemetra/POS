import { useSyncExternalStore } from 'react';

/**
 * RT-239 (VNext A2, rule 7) — is a modal dialog open right now?
 *
 * The same test the scan guard uses to refuse a burst (M-S6), observed from the
 * document so the visible scan status can never disagree with what the guard
 * will actually do.
 *
 * The document is the store: the value is read during render, and the mutation
 * observer's callback asks React for a synchronous re-render. A queued state
 * update could lag behind the guard on a loaded runner (CI showed the status
 * still «جاهز للمسح» over a second after a dialog opened).
 */
const MODAL_SELECTOR = '[aria-modal="true"]';

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-modal'],
  });
  // A dialog takes focus on open and returns it on close, so a focus change is a
  // second trigger that does not depend on the observer. happy-dom (the test
  // DOM) holds an observer's callback behind a WeakRef, so a GC pass can stop it
  // reporting; React re-reads the snapshot and bails out when nothing changed.
  document.addEventListener('focusin', onChange);
  document.addEventListener('focusout', onChange);
  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', onChange);
    document.removeEventListener('focusout', onChange);
  };
}

function isModalOpen(): boolean {
  return document.querySelector(MODAL_SELECTOR) !== null;
}

export function useModalDialogOpen(): boolean {
  return useSyncExternalStore(subscribe, isModalOpen);
}
