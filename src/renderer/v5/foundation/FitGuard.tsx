import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { useScanSuspended } from '../../scan/ScanGuardHost';
import { HeightAction } from '../../ui/states/ScreenTooSmall';
import { fitObservationTargets, surfaceFits } from './fit-measure';
import { ToneIcon } from './ToneIcon';
import './fit-guard.css';

/** The screens that carry the RT-312 D2 guarantee. */
export type FitSurface = 'sale' | 'checkout';

/** M-F3 (RT-412) heading: which screen cannot be shown whole. */
const HEADING: Readonly<Record<FitSurface, string>> = {
  checkout: 'لا تتّسع الشاشة لعرض الدفع كاملًا.',
  sale: 'لا تتّسع الشاشة لعرض البيع كاملًا.',
};

/** The digits of a copy string: Western, as an isolated LTR run inside the Arabic. */
function Ltr({ children }: { children: string }): JSX.Element {
  return <bdi dir="ltr">{children}</bdi>;
}

/** M-F3 action while a frame banner shows: dealing with one is the fastest way back. */
function BannerAction(): JSX.Element {
  return (
    <>
      تعامل مع أحد التنبيهات أعلاه، أو كبّر النافذة، أو اضبط مقياس العرض في Windows على{' '}
      <Ltr>100%</Ltr> أو <Ltr>125%</Ltr>.
    </>
  );
}

interface Fit {
  readonly fits: boolean;
  /** A frame banner (operational notice or connection) takes height above the screen. */
  readonly banners: boolean;
}

const FITS: Fit = { fits: true, banners: false };

function hasFrameBanners(main: Element): boolean {
  const body = main.parentElement;
  if (body === null) return false;
  return Array.from(body.children).some(
    (child) => child !== main && child.getBoundingClientRect().height > 0,
  );
}

/** Observe exactly `next`: stop observing what left it, start on what is new. */
function syncObserved(
  observer: ResizeObserver,
  observed: Set<Element>,
  next: ReadonlySet<Element>,
): void {
  const gone = Array.from(observed).filter((el) => !next.has(el));
  const added = Array.from(next).filter((el) => !observed.has(el));
  gone.forEach((el) => {
    observer.unobserve(el);
    observed.delete(el);
  });
  added.forEach((el) => {
    observer.observe(el);
    observed.add(el);
  });
}

function sameFit(a: Fit, b: Fit): boolean {
  return a.fits === b.fits && a.banners === b.banners;
}

/**
 * Re-measures whenever <main>, a marked element or one of its clipping
 * ancestors changes size, or the screen's tree changes (a pinned row mounts,
 * the Back reason appears). One measurement per frame at most; the observed
 * set only changes when the elements do, so observing never re-triggers itself.
 */
function useSurfaceFit(rootRef: RefObject<HTMLElement | null>): Fit {
  const [fit, setFit] = useState<Fit>(FITS);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null || typeof ResizeObserver === 'undefined') return undefined;
    const stop = root.closest('.v5-frame__main') ?? document.documentElement;
    const observed = new Set<Element>();
    let pending = false;
    let frame = 0;

    const schedule = (): void => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const mutation = new MutationObserver(schedule);

    function measure(): void {
      pending = false;
      syncObserved(resize, observed, new Set(fitObservationTargets(root as Element, stop)));
      const next: Fit = {
        fits: surfaceFits(root as Element, stop),
        banners: hasFrameBanners(stop),
      };
      setFit((prev) => (sameFit(prev, next) ? prev : next));
    }

    mutation.observe(root, { childList: true, subtree: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [rootRef]);

  return fit;
}

function isNowhere(target: Node | null): boolean {
  return target === null || target === document.body || target === document.documentElement;
}

/** A key the block swallows: anything but Tab, aimed at a covered area or at nowhere. */
function isCoveredKey(
  event: KeyboardEvent,
  areas: ReadonlyArray<RefObject<HTMLElement | null>>,
): boolean {
  if (event.key === 'Tab') return false;
  const target = event.target as Node | null;
  return isNowhere(target) || areas.some((ref) => ref.current?.contains(target) === true);
}

function modalIsOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/**
 * While blocked, no key reaches the covered screen. `inert` stops focus and
 * clicks but not window listeners (Checkout's Esc = Back), so:
 *  - keys aimed at the screen, the notice or nowhere (<body>) are swallowed in
 *    the capture phase. The scan guard listens earlier in the same phase and
 *    refuses a burst itself;
 *  - keys on a banner or the navigation reach that control (and React's root
 *    listener), then stop at the document, before the screen's window
 *    shortcuts. An open modal dialog owns the keyboard and is left alone.
 * Tab passes, so the keyboard still reaches the banners and the navigation.
 */
function useBlockedKeys(
  blocked: boolean,
  areas: ReadonlyArray<RefObject<HTMLElement | null>>,
): void {
  const areasRef = useRef(areas);
  areasRef.current = areas;

  useEffect(() => {
    if (!blocked) return undefined;
    const swallow = (event: KeyboardEvent): void => {
      if (!isCoveredKey(event, areasRef.current)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const stopAtDocument = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' && !modalIsOpen()) event.stopPropagation();
    };
    window.addEventListener('keydown', swallow, { capture: true });
    document.addEventListener('keydown', stopAtDocument);
    return () => {
      window.removeEventListener('keydown', swallow, { capture: true });
      document.removeEventListener('keydown', stopAtDocument);
    };
  }, [blocked]);
}

function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * Entering a block: focus on the screen (or already lost) moves to the notice
 * heading. Returns whether it moved; when it did not (a banner or the navigation
 * keeps it), the notice has to be announced another way.
 */
function focusOnEntry(root: HTMLElement | null, heading: HTMLElement | null): boolean {
  if (!focusIsLost() && root?.contains(document.activeElement) !== true) return false;
  heading?.focus();
  return true;
}

/** Leaving a block: lost focus goes back to the last control used, else to <main>. */
function focusOnExit(previous: HTMLElement | null, root: HTMLElement | null): void {
  if (!focusIsLost()) return;
  if (previous?.isConnected === true) previous.focus();
  if (focusIsLost()) root?.closest<HTMLElement>('.v5-frame__main')?.focus();
}

/** The last element that took focus inside `rootRef`. */
function useLastFocused(rootRef: RefObject<HTMLElement | null>): RefObject<HTMLElement | null> {
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return undefined;
    const remember = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement) lastFocused.current = event.target;
    };
    root.addEventListener('focusin', remember);
    return () => {
      root.removeEventListener('focusin', remember);
    };
  }, [rootRef]);
  return lastFocused;
}

/**
 * Focus across a block. On entry, focus inside the screen (or already lost)
 * moves to the notice heading, so the message is announced; focus on a banner
 * or the navigation stays where the cashier put it, and the returned flag asks
 * for the notice to be announced through the live region instead (never both,
 * so it is not read twice). On exit, lost focus goes back to the control the
 * cashier last used on the screen, else to <main>.
 */
function useBlockFocus(
  blocked: boolean,
  rootRef: RefObject<HTMLElement | null>,
  headingRef: RefObject<HTMLHeadingElement | null>,
): boolean {
  const lastFocused = useLastFocused(rootRef);
  const wasBlocked = useRef(blocked);
  const [announce, setAnnounce] = useState(false);
  useEffect(() => {
    const changed = blocked !== wasBlocked.current;
    wasBlocked.current = blocked;
    if (!changed) return;
    if (blocked) setAnnounce(!focusOnEntry(rootRef.current, headingRef.current));
    else {
      setAnnounce(false);
      focusOnExit(lastFocused.current, rootRef.current);
    }
  }, [blocked, rootRef, headingRef, lastFocused]);
  return blocked && announce;
}

interface FitGuardProps {
  surface: FitSurface;
  children: ReactNode;
}

/**
 * RT-412 (RT-312 D2) — the in-surface block notice. In the 600–767px band the
 * compact composition (RT-407) keeps the screen's must-see elements in view,
 * except when stacked frame banners leave too little height. Then the screen is
 * not usable as drawn, so it is covered by this notice instead of being shown
 * clipped.
 *
 * The trigger is measured, not a fixed threshold: the screen marks what must
 * stay visible (`data-fit`, see fit-measure.ts), and the guard checks it
 * against the height the screen actually received, so banners appearing or
 * clearing re-decide on their own.
 *
 * Mid-payment the screen stays MOUNTED under the notice (owner decision, unlike
 * the < 600px floor): it is inert, no key or scan reaches it, and it comes back
 * exactly as it was. The frame banners stay above and usable, because acting
 * on one is usually the way back.
 *
 * The wrapper is `display: contents`, so the screen's own layout (and the
 * RT-407 composition it relies on) is unchanged; the notice is positioned over
 * <main>.
 */
export function FitGuard({ surface, children }: FitGuardProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const { fits, banners } = useSurfaceFit(rootRef);
  const blocked = !fits;

  useScanSuspended(blocked);
  useBlockedKeys(blocked, [rootRef, noticeRef]);
  const announce = useBlockFocus(blocked, rootRef, headingRef);

  return (
    <>
      <div ref={rootRef} className="v5-fit-guard" inert={blocked}>
        {children}
      </div>
      {/* Always mounted, so a change is announced. Filled only when focus stayed
          on a banner or the navigation; otherwise focus reads the heading. */}
      <p className="v5-fit-guard__live" role="status" data-testid="fit-block-live">
        {announce ? HEADING[surface] : ''}
      </p>
      {blocked && (
        <section
          ref={noticeRef}
          className="v5-fit-block"
          aria-labelledby={headingId}
          data-surface={surface}
          data-testid="fit-block"
          dir="rtl"
          lang="ar"
        >
          <div className="v5-fit-block__card">
            <ToneIcon tone="warning" />
            <h2 ref={headingRef} id={headingId} className="v5-fit-block__title" tabIndex={-1}>
              {HEADING[surface]}
            </h2>
            <p className="v5-fit-block__body">{banners ? <BannerAction /> : <HeightAction />}</p>
          </div>
        </section>
      )}
    </>
  );
}
