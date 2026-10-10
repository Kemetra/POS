import { useEffect, useRef, useState, type JSX } from 'react';
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

/** Visible until the lifetime runs out; a pause (focus / hover) holds it, and a new offer restarts it. */
function useOfferLifetime(seq: number | null, paused: boolean): boolean {
  const [expiredSeq, setExpiredSeq] = useState<number | null>(null);
  useEffect(() => {
    if (seq === null || paused) return undefined;
    const timer = setTimeout(() => {
      setExpiredSeq(seq);
    }, UNDO_NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [seq, paused]);
  return seq !== null && expiredSeq !== seq;
}

/**
 * RT-242 (M-S2 / M-S8, freeze A1 `UndoNotice`) — the Sale status line's last
 * cart action. The acknowledgement is a polite live region (UX-11); «تراجع»
 * sits beside it, outside the live region, so it is announced once and never
 * re-read. No button without a bridge that can undo (fail closed).
 */
export function CartStatusLine(props: {
  announcement: CartAnnouncement | null;
  offer: UndoOffer | null;
  canUndo: boolean;
  onUndo: () => void;
}): JSX.Element {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const offer = props.canUndo ? props.offer : null;
  const visible = useOfferLifetime(offer?.seq ?? null, focused || hovered);
  const shown = offer !== null && visible;
  const focusedRef = useRef(false);
  focusedRef.current = focused;
  // A focused «تراجع» that goes away (its Undo settled, a scan withdrew it)
  // fires no blur: drop the pause, and hand focus back to the scan owner
  // rather than leaving it on the page body (15 §3.1 rule 6).
  useEffect(() => {
    if (shown || !focusedRef.current) return;
    setFocused(false);
    setHovered(false);
    focusScanOwner();
  }, [shown]);
  return (
    <div
      className="v5-sale-last-action"
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
      }}
      onPointerEnter={() => {
        setHovered(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
      }}
    >
      <p className="v5-sale-last-add" role="status" aria-live="polite">
        {props.announcement !== null && announcementText(props.announcement)}
      </p>
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
