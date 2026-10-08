import { useEffect, useRef, type JSX } from 'react';

/**
 * ScreenTooSmall — frozen copy per contracts/shell-regions.md §"ScreenTooSmall".
 * Copy strings are load-bearing: they must not be changed without amending
 * the contract and the T013 test.
 *
 * RT-241 (VNext W1-A): the copy is the Arabic M-F2 message from the freeze
 * catalog (15 §5). It renders outside the frame on pairing/sign-in, so it sets
 * its own direction and language; the size is an isolated LTR run.
 */
export function ScreenTooSmall(): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <main
      className="screen-too-small"
      aria-labelledby="screen-too-small-heading"
      dir="rtl"
      lang="ar"
    >
      <div className="screen-too-small__card">
        <span className="screen-too-small__icon" aria-hidden="true" />
        <h1
          className="screen-too-small__title"
          id="screen-too-small-heading"
          tabIndex={-1}
          ref={headingRef}
        >
          الشاشة أصغر من <bdi dir="ltr">1024×768</bdi>.
        </h1>
        <p className="screen-too-small__body">كبّر النافذة أو استخدم شاشة أكبر.</p>
      </div>
    </main>
  );
}
