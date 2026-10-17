import { useEffect, useState, type JSX } from 'react';

import type { ReturnJournalView, ReturnsBridgeAPI } from '../../shared/returns/types.js';
import { ToneIcon } from '../v5/foundation/ToneIcon';
import { PayoutPanel } from './PayoutPanel';
import { ReturnNotice } from './ReturnNotice';
import { ReturnsPanel } from './ReturnsPanel';
import { formatReturnMoney } from './returns-format.js';
import { OUTCOME_COPY, refusalMessage } from './returns-messages.js';
import { mayBeRecorded, type Outcome } from './return-flow-state.js';
import { useFocusOnMount } from './useFocusOnMount.js';
import type { Reload } from './usePayout.js';
import type { ReturnFlow } from './useReturnFlow.js';

/**
 * RT-15 S3 — step 4: what main answered for the submit (O3..O7, U1..U3).
 *
 * Only `confirmed` is success. An unconfirmed answer is never presented as
 * done and offers "check again". No outcome re-arms the submitted selection:
 * the only way on is a new return (fresh lookup, live quantities).
 *
 * RT-15 S4: a confirmed return carries its payout (drawer, then slip) below
 * the outcome; nothing else offers one.
 */
type Tone = 'success' | 'danger';

function headline(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'confirmed':
      return outcome.replayed ? OUTCOME_COPY.replayed : OUTCOME_COPY.confirmed;
    case 'unconfirmed':
      return outcome.still ? OUTCOME_COPY.stillUnconfirmed : OUTCOME_COPY.unconfirmed;
    case 'refused':
      return refusalMessage(outcome.reason);
    case 'failed':
      return OUTCOME_COPY.submitFailed;
  }
}

/**
 * One filled commit per region: "check again" (unconfirmed) or the payout
 * (confirmed, RT-15 S4) owns it; otherwise starting a new return does.
 */
function newReturnIsSecondary(outcome: Outcome): boolean {
  return outcome.kind === 'unconfirmed' || outcome.kind === 'confirmed';
}

function retOf(outcome: Outcome): ReturnJournalView | null {
  return outcome.kind === 'failed' ? null : outcome.ret;
}

function Facts({
  ret,
  confirmed,
}: Readonly<{ ret: ReturnJournalView; confirmed: boolean }>): JSX.Element {
  const amount = confirmed ? ret.returnTotalMinor : ret.quotedTotalMinor;
  return (
    <dl className="v5-manager-facts">
      <dt>رقم البيع</dt>
      <dd>
        <bdi className="v5-manager-num v5-returns-code">{ret.saleNumber}</bdi>
      </dd>
      <dt>{confirmed ? 'مبلغ الاسترداد النقدي' : 'المبلغ المطلوب'}</dt>
      <dd>
        <bdi className="v5-manager-num">
          {amount === null ? '—' : formatReturnMoney(amount, ret.currencyCode)}
        </bdi>
      </dd>
      {ret.returnRef !== null && (
        <>
          <dt>مرجع الخادم</dt>
          <dd>
            <bdi className="v5-manager-num v5-returns-code">{ret.returnRef}</bdi>
          </dd>
        </>
      )}
    </dl>
  );
}

function CheckAgain({ flow, outcome }: Readonly<{ flow: ReturnFlow; outcome: Outcome }>) {
  if (outcome.kind !== 'unconfirmed') return null;
  const busy = flow.busy === 'check';
  return (
    <>
      <ReturnNotice notice={outcome.notice} />
      <button
        type="button"
        className="v5-manager-btn v5-manager-btn--primary"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void flow.checkAgain()}
      >
        تحقّق مجددًا
      </button>
    </>
  );
}

/**
 * K2: the live region is rendered empty first and filled after mount, so
 * assistive tech announces the outcome (a region inserted already filled is
 * often not read). Focus still moves to the step heading.
 */
function Announcement({ outcome }: Readonly<{ outcome: Outcome }>): JSX.Element {
  const [shown, setShown] = useState<Outcome | null>(null);
  useEffect(() => {
    setShown(outcome);
  }, [outcome]);
  const confirmed = outcome.kind === 'confirmed';
  const tone: Tone = confirmed ? 'success' : 'danger';
  return (
    // An <output> is a status region; anything but a confirmed outcome interrupts as an alert.
    // The element stays the same across "check again", so the region is never re-inserted.
    <output className="v5-notice" data-tone={tone} role={confirmed ? undefined : 'alert'}>
      {shown !== null && (
        <>
          <ToneIcon tone={tone} />
          <span className="v5-notice__text">
            <span className="v5-returns-headline">{headline(shown)}</span>
            {mayBeRecorded(shown) && <span>{OUTCOME_COPY.mayBeRecorded}</span>}
          </span>
        </>
      )}
    </output>
  );
}

/** What the payout below a confirmed outcome talks to. */
export interface PayoutDeps {
  readonly bridge: ReturnsBridgeAPI;
  readonly reload: Reload;
  /** The journal's latest view of a return, or null (Codex P2: never a stale panel). */
  readonly latest: (returnId: string) => ReturnJournalView | null;
}

export function ReturnOutcome({
  flow,
  outcome,
  payout,
}: Readonly<{
  flow: ReturnFlow;
  outcome: Outcome;
  payout: PayoutDeps;
}>) {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const confirmed = outcome.kind === 'confirmed';
  const ret = retOf(outcome);
  const withPayout = confirmed && ret !== null;

  const facts = (
    <>
      <Announcement outcome={outcome} />
      {ret !== null && <Facts ret={ret} confirmed={confirmed} />}
    </>
  );

  return (
    <ReturnsPanel id="v5-returns-outcome" title="نتيجة المرتجع" headingRef={heading}>
      <div className="v5-manager-panel__body">
        {/* G6R (RD-3): the announcement and facts beside the payout. The wrapper
            stays mounted across "check again", so the live region is never re-inserted. */}
        <div className={withPayout ? 'v5-returns-outcome' : undefined}>
          <div className="v5-returns-outcome__col">{facts}</div>
          {withPayout && (
            <PayoutPanel
              bridge={payout.bridge}
              ret={payout.latest(ret.returnId) ?? ret}
              reload={payout.reload}
            />
          )}
        </div>
        <div className="v5-returns-actions">
          <CheckAgain flow={flow} outcome={outcome} />
          <button
            type="button"
            className={
              newReturnIsSecondary(outcome)
                ? 'v5-manager-btn'
                : 'v5-manager-btn v5-manager-btn--primary'
            }
            disabled={flow.busy === 'check'}
            onClick={flow.startOver}
          >
            مرتجع جديد
          </button>
        </div>
      </div>
    </ReturnsPanel>
  );
}
