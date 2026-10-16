import type { JSX, ReactNode } from 'react';

import { V5Icon, type V5IconName } from '../foundation/V5Icon';
import { EntryStrip } from './EntryStrip';
import './entry.css';

/**
 * RT-244 PR2 (G-1 references) — the Ready and pairing screens: the same entry
 * stage as sign-in (the wordmark strip, then the stage), holding one centred
 * card of about 440px with one sentence and one commit. The strip carries the
 * wordmark only; on Ready the terminal label is the card's one fact.
 *
 * `rootProps` carries the route's test id and data attributes, which the boot
 * router tests read from the root element.
 */
export function EntryCardScreen({
  children,
  rootProps,
}: Readonly<{
  children: ReactNode;
  rootProps: Readonly<Record<string, string>>;
}>): JSX.Element {
  return (
    <main className="v5-entry" dir="rtl" lang="ar" {...rootProps}>
      <EntryStrip />
      <div className="v5-entry__center">{children}</div>
    </main>
  );
}

/** The card's leading glyph: decorative, the heading beside it carries the meaning. */
export function EntryCardIcon({ name }: Readonly<{ name: V5IconName }>): JSX.Element {
  return (
    <span className="v5-entry__card-icon" aria-hidden="true">
      <V5Icon name={name} size={26} />
    </span>
  );
}
