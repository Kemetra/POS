import { useEffect, useRef, type JSX } from 'react';
import type { ViewportShortfall } from '../../viewport/useViewportTier';

/** The digits of a copy string: Western, as an isolated LTR run inside the Arabic. */
function Ltr({ children }: { children: string }): JSX.Element {
  return <bdi dir="ltr">{children}</bdi>;
}

/** M-F2 (width). */
function WidthHeading(): JSX.Element {
  return (
    <>
      الشاشة أصغر من <Ltr>1024×768</Ltr>.
    </>
  );
}

/** M-F2 height variant (RT-312 D5), first sentence. */
const HEIGHT_HEADING = 'ارتفاع الشاشة أقل من الحد المدعوم.';

/** M-F2 (width) action. */
const WIDTH_ACTION = 'كبّر النافذة أو استخدم شاشة أكبر.';

/** M-F2 height variant (RT-312 D5), second sentence: the action. */
function HeightAction(): JSX.Element {
  return (
    <>
      كبّر النافذة، أو اضبط مقياس العرض في Windows على <Ltr>100%</Ltr> أو <Ltr>125%</Ltr>.
    </>
  );
}

interface ScreenTooSmallProps {
  /** Which floor the viewport is under (RT-313). Defaults to the width copy. */
  shortfall?: ViewportShortfall;
}

/**
 * ScreenTooSmall — frozen copy per contracts/shell-regions.md §"ScreenTooSmall".
 * Copy strings are load-bearing: they must not be changed without amending
 * the contract and the T013 test.
 *
 * RT-241 (VNext W1-A): the copy is the Arabic M-F2 message from the freeze
 * catalog (15 §5). It renders outside the frame on pairing/sign-in, so it sets
 * its own direction and language; the size is an isolated LTR run.
 *
 * RT-313 (RT-312 D5): three variants of M-F2. `width` is the copy above,
 * unchanged. `height` is the height message. `both` states the size in the
 * heading and gives the height action, which fixes both floors on a scaled
 * display. Focus goes to the heading on entry, and again when the variant
 * changes, so the new message is announced.
 */
export function ScreenTooSmall({ shortfall = 'width' }: ScreenTooSmallProps): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [shortfall]);

  return (
    <main
      className="screen-too-small"
      aria-labelledby="screen-too-small-heading"
      data-shortfall={shortfall}
      dir="rtl"
      lang="ar"
    >
      <div className="screen-too-small__card">
        <span className="screen-too-small__icon" aria-hidden="true" />
        <h1
          key={shortfall}
          className="screen-too-small__title"
          id="screen-too-small-heading"
          tabIndex={-1}
          ref={headingRef}
        >
          {shortfall === 'height' ? HEIGHT_HEADING : <WidthHeading />}
        </h1>
        <p className="screen-too-small__body">
          {shortfall === 'width' ? WIDTH_ACTION : <HeightAction />}
        </p>
      </div>
    </main>
  );
}
