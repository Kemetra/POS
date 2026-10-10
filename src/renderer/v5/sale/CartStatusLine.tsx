import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { CartAnnouncement, UndoOffer } from '../../sale/useSaleUndo';
import { focusScanOwner } from '../../scan/scan-anchor';

/**
 * How long «تراجع» stays offered while untouched. Presentation only: main
 * decides eligibility from cart lineage, never from a timer (RT-245;
 * Constitution rebaseline, W1-B). Focus or pointer inside the notice pauses it.
 */
export const UNDO_NOTICE_MS = 8000;

function announcementText(announcement: CartAnnouncement): JSX.Element | string {
  switch (announcement.kind) {
    case 'added':
      return (
        <>
          أُضيف: <bdi>{announcement.name}</bdi>
        </>
      );
    case 'removed':
      return (
        <>
          حُذف <bdi>{announcement.name}</bdi>.
        </>
      );
    case 'undone':
      return 'تم التراجع.';
    case 'unavailable':
      return 'لم يعد التراجع متاحًا.';
  }
}

function undoLabel(offer: UndoOffer): string {
  return offer.kind === 'added' ? `تراجع عن إضافة ${offer.name}` : `تراجع عن حذف ${offer.name}`;
}

/**
 * Visible until the lifetime runs out. A pause (focus / hover) holds the
 * clock and resuming continues it where it stopped; only a new offer starts
 * a full lifetime again.
 */
function useOfferLifetime(seq: number | null, paused: boolean): boolean {
  const [expiredSeq, setExpiredSeq] = useState<number | null>(null);
  const remainingRef = useRef(UNDO_NOTICE_MS);
  const timedSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (timedSeqRef.current !== seq) {
      timedSeqRef.current = seq;
      remainingRef.current = UNDO_NOTICE_MS;
    }
    if (seq === null || paused) return undefined;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      setExpiredSeq(seq);
    }, remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [seq, paused]);
  return seq !== null && expiredSeq !== seq;
}

/** The offer belongs to the action the live region is announcing. */
function offersUndo(announcement: CartAnnouncement | null, offer: UndoOffer | null): boolean {
  return offer !== null && announcement?.seq === offer.seq;
}

/** Focus or pointer inside the notice pauses its lifetime. */
function useAttentionPause() {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const focusedRef = useRef(false);
  focusedRef.current = focused;
  const reset = useCallback((): void => {
    setFocused(false);
    setHovered(false);
  }, []);
  return {
    paused: focused || hovered,
    focusedRef,
    reset,
    handlers: {
      onFocus: (): void => {
        setFocused(true);
      },
      onBlur: (): void => {
        setFocused(false);
      },
      onPointerEnter: (): void => {
        setHovered(true);
      },
      onPointerLeave: (): void => {
        setHovered(false);
      },
    },
  };
}

/**
 * A focused «تراجع» that goes away (its Undo settled, a scan withdrew it)
 * fires no blur: drop the pause and hand focus back to the scan owner rather
 * than leaving it on the page body (15 §3.1 rule 6).
 */
function useReleaseWhenGone(
  shown: boolean,
  focusedRef: { readonly current: boolean },
  reset: () => void,
): void {
  useEffect(() => {
    if (shown || !focusedRef.current) return;
    reset();
    focusScanOwner();
  }, [shown, focusedRef, reset]);
}

/** The polite live region: the last cart action, and whether it can be undone. */
function LastActionAnnouncement(props: {
  announcement: CartAnnouncement | null;
  offer: UndoOffer | null;
}): JSX.Element {
  return (
    <p className="v5-sale-last-add" role="status" aria-live="polite">
      {props.announcement !== null && announcementText(props.announcement)}
      {offersUndo(props.announcement, props.offer) && (
        <span className="v5-visually-hidden"> · تراجع</span>
      )}
    </p>
  );
}

/**
 * RT-242 (M-S2 / M-S8, freeze A1 `UndoNotice`) — the Sale status line's last
 * cart action. The acknowledgement is a polite live region (UX-11) that also
 * says Undo is available («… · تراجع», the catalogue's own M-S2 form), while
 * the button itself sits beside it, outside the live region, so it is never
 * re-read. No button without a bridge that can undo (fail closed).
 */
export function CartStatusLine(props: {
  announcement: CartAnnouncement | null;
  offer: UndoOffer | null;
  canUndo: boolean;
  onUndo: () => void;
}): JSX.Element {
  const offer = props.canUndo ? props.offer : null;
  const attention = useAttentionPause();
  const visible = useOfferLifetime(offer?.seq ?? null, attention.paused);
  const shown = offer !== null && visible;
  useReleaseWhenGone(shown, attention.focusedRef, attention.reset);
  return (
    <div className="v5-sale-last-action" {...attention.handlers}>
      <LastActionAnnouncement announcement={props.announcement} offer={offer} />
      {shown && (
        <button
          type="button"
          className="v5-sale-undo"
          aria-label={undoLabel(offer)}
          onClick={props.onUndo}
        >
          تراجع
        </button>
      )}
    </div>
  );
}
