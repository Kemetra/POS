import type { JSX, ReactNode } from 'react';
import { ToneIcon, toneRole, type Tone } from './ToneIcon';
import { Icon } from '../../icons/Icon';
import type { IconName } from '../../icons/registry';
import './messages.css';

interface BannerProps {
  tone: Exclude<Tone, 'success'>;
  children: ReactNode;
  /** Actions that belong to this state (acknowledge, recover). */
  actions?: ReactNode;
  testId?: string;
  /**
   * A source glyph, when the source must be told apart (RT-605). It sits
   * beside the tone's glyph, never in its place, so the tone keeps its own
   * shape (P8; doc 25 §4.1).
   */
  icon?: IconName;
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
      <ToneIcon tone={tone} />
      {icon !== undefined && (
        <span className="v5-tone-icon v5-banner__source-icon" data-icon={icon}>
          <Icon name={icon} />
        </span>
      )}
      <div className="v5-banner__text">{children}</div>
      {actions !== undefined && <div className="v5-banner__actions">{actions}</div>}
    </div>
  );
}
