import type { JSX, ReactNode } from 'react';
import { ToneIcon, toneRole, type Tone } from './ToneIcon';
import './messages.css';

interface NoticeProps {
  tone: Tone;
  children: ReactNode;
  /** An action that belongs to this message, kept inside it. */
  action?: ReactNode;
  /**
   * Off when another live region already announces the same message (one
   * announcement per event): the notice is then visual only.
   */
  announce?: boolean;
  testId?: string;
}

/**
 * RT-241 (VNext W1-A) — an inline message inside its own region (freeze 15
 * §4 `Notice`): field validation, an empty state, an outcome. `success` is for
 * proven facts only.
 */
export function Notice({
  tone,
  children,
  action,
  announce = true,
  testId,
}: NoticeProps): JSX.Element {
  return (
    <div
      role={announce ? toneRole(tone) : undefined}
      className="v5-notice"
      data-tone={tone}
      data-testid={testId}
    >
      <ToneIcon tone={tone} />
      <div className="v5-notice__text">{children}</div>
      {action !== undefined && <div className="v5-notice__action">{action}</div>}
    </div>
  );
}
