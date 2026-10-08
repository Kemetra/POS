import type { JSX, ReactNode } from 'react';
import { ToneIcon, toneRole, type Tone } from './ToneIcon';
import './messages.css';

interface BannerProps {
  tone: Exclude<Tone, 'success'>;
  children: ReactNode;
  /** Actions that belong to this state (acknowledge, recover). */
  actions?: ReactNode;
  testId?: string;
}

/**
 * RT-241 (VNext W1-A) — persistent operational state in the frame's status
 * area (freeze 15 §4 `Banner`). It never auto-dismisses: it leaves when the
 * state it reports is over, or when its own action resolves it.
 */
export function Banner({ tone, children, actions, testId }: BannerProps): JSX.Element {
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
      <div className="v5-banner__text">{children}</div>
      {actions !== undefined && <div className="v5-banner__actions">{actions}</div>}
    </div>
  );
}
