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

    function track(): void {
      const next = new Set(fitObservationTargets(root as Element, stop));
      for (const el of observed) {
        if (!next.has(el)) {
          resize.unobserve(el);
          observed.delete(el);
        }
      }
      for (const el of next) {
        if (!observed.has(el)) {
          resize.observe(el);
          observed.add(el);
        }
      }
    }

    function measure(): void {
      pending = false;
      track();
      const next: Fit = {
        fits: surfaceFits(root as Element, stop),
        banners: hasFrameBanners(stop),
      };
      setFit((prev) => (prev.fits === next.fits && prev.banners === next.banners ? prev : next));
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

/**
 * While blocked, no key reaches the covered screen. `inert` stops focus and
 * clicks but not window listeners (Checkout's Esc = Back), so keys aimed at the
 * screen, the notice or nowhere (<body>) are swallowed in the capture phase.
 * The scan guard listens earlier in the same phase and refuses a burst itself.
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
      if (event.key === 'Tab') return;
      const target = event.target as Node | null;
      const nowhere =
        target === null || target === document.body || target === document.documentElement;
      const covered = areasRef.current.some((ref) => ref.current?.contains(target) === true);
      if (!nowhere && !covered) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', swallow, { capture: true });
    return () => {
      window.removeEventListener('keydown', swallow, { capture: true });
    };
  }, [blocked]);
}

function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * Focus across a block. On entry, focus inside the screen (or already lost)
 * moves to the notice heading, so the message is announced; focus on a banner
 * or the navigation stays where the cashier put it. On exit, lost focus goes
 * back to the control the cashier last used on the screen, else to <main>.
 */
function useBlockFocus(
  blocked: boolean,
  rootRef: RefObject<HTMLElement | null>,
  headingRef: RefObject<HTMLHeadingElement | null>,
): void {
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

  const wasBlocked = useRef(blocked);
  useEffect(() => {
    const entered = blocked && !wasBlocked.current;
    const left = !blocked && wasBlocked.current;
    wasBlocked.current = blocked;
    if (entered) {
      const active = document.activeElement;
      if (focusIsLost() || rootRef.current?.contains(active) === true) headingRef.current?.focus();
      return;
    }
    if (!left || !focusIsLost()) return;
    const previous = lastFocused.current;
    if (previous?.isConnected === true) previous.focus();
    if (focusIsLost()) rootRef.current?.closest<HTMLElement>('.v5-frame__main')?.focus();
  }, [blocked, rootRef, headingRef]);
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
  useBlockFocus(blocked, rootRef, headingRef);

  return (
    <>
      <div ref={rootRef} className="v5-fit-guard" inert={blocked}>
        {children}
      </div>
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
