import type { JSX, ReactNode } from 'react';
import { ToneIcon, toneRole, type Tone } from './ToneIcon';
import { V5Icon, type V5IconName } from './V5Icon';
import './messages.css';

interface BannerProps {
  tone: Exclude<Tone, 'success'>;
  children: ReactNode;
  /** Actions that belong to this state (acknowledge, recover). */
  actions?: ReactNode;
  testId?: string;
  /** A source glyph in place of the tone's, when the source must be told apart. */
  icon?: V5IconName;
}

/**
 * RT-241 (VNext W1-A) — persistent operational state in the frame's status
 * area (freeze 15 §4 `Banner`). It never auto-dismisses: it leaves when the
 * state it reports is over, or when its own action resolves it.
 */
export function Banner({
  tone,
  children,
  actions,
  testId,
  icon,
}: Readonly<BannerProps>): JSX.Element {
  return (
    <div
      role={toneRole(tone)}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className="v5-banner"
      data-tone={tone}
      data-testid={testId}
    >
      {icon === undefined ? (
        <ToneIcon tone={tone} />
      ) : (
        <span className="v5-tone-icon" data-icon={icon}>
          <V5Icon name={icon} size={20} />
        </span>
      )}
      <div className="v5-banner__text">{children}</div>
      {actions !== undefined && <div className="v5-banner__actions">{actions}</div>}
    </div>
  );
}
