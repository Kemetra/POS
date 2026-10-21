import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import { Notice } from '../../foundation/Notice';
import '../manager.css';

interface HonestNoticeProps {
  notice: string;
  /** A navigation that belongs to the notice: a link, never a button that fakes one. */
  action?: { label: string; to: string };
  testId?: string;
}

/**
 * RT-503 (VN-S10 S10-6) — the one honest sentence of a page that has nothing
 * else to show (G-6): a neutral Notice, with an optional way out. The page
 * wraps it in `.v5-honest-state`, which gives it its neutral look.
 */
export function HonestNotice({ notice, action, testId }: Readonly<HonestNoticeProps>): JSX.Element {
  return (
    <Notice
      tone="info"
      {...(testId === undefined ? {} : { testId })}
      action={
        action === undefined ? undefined : (
          <Link className="v5-manager-btn v5-btn" to={action.to}>
            {action.label}
          </Link>
        )
      }
    >
      <p>{notice}</p>
    </Notice>
  );
}
