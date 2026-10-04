import { useEffect, useState, type JSX } from 'react';

import type { ReturnJournalView } from '../../shared/returns/types.js';
import { ReturnNotice } from './ReturnNotice';
import { formatReturnMoney } from './returns-format.js';
import { OUTCOME_COPY, refusalMessage } from './returns-messages.js';
import { mayBeRecorded, type Outcome } from './return-flow-state.js';
import { useFocusOnMount } from './useFocusOnMount.js';
import type { ReturnFlow } from './useReturnFlow.js';

/**
 * RT-15 S3 — step 4: what main answered for the submit (O3..O7, U1..U3).
 *
 * Only `confirmed` is success. An unconfirmed answer is never presented as
 * done and offers "check again". No outcome re-arms the submitted selection:
 * the only way on is a new return (fresh lookup, live quantities). There is
 * no payout, drawer or slip control here (S4).
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

function retOf(outcome: Outcome): ReturnJournalView | null {
  return outcome.kind === 'failed' ? null : outcome.ret;
}

function Facts({ ret, confirmed }: { ret: ReturnJournalView; confirmed: boolean }): JSX.Element {
  const amount = confirmed ? ret.returnTotalMinor : ret.quotedTotalMinor;
  return (
    <dl className="rt-facts">
      <dt>رقم البيع</dt>
      <dd>
        <bdi className="rt-num">{ret.saleNumber}</bdi>
      </dd>
      <dt>{confirmed ? 'مبلغ الاسترداد النقدي' : 'المبلغ المطلوب'}</dt>
      <dd>
        <bdi className="rt-num">
          {amount === null ? '—' : formatReturnMoney(amount, ret.currencyCode)}
        </bdi>
      </dd>
      {ret.returnRef !== null && (
        <>
          <dt>مرجع الخادم</dt>
          <dd>
            <bdi className="rt-num">{ret.returnRef}</bdi>
          </dd>
        </>
      )}
    </dl>
  );
}

function CheckAgain({ flow, outcome }: { flow: ReturnFlow; outcome: Outcome }) {
  if (outcome.kind !== 'unconfirmed') return null;
  const busy = flow.busy === 'check';
  return (
    <>
      <ReturnNotice notice={outcome.notice} />
      <button
        type="button"
        className="rt-btn rt-btn--primary"
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
function Announcement({ outcome }: { outcome: Outcome }): JSX.Element {
  const [shown, setShown] = useState<Outcome | null>(null);
  useEffect(() => {
    setShown(outcome);
  }, [outcome]);
  const confirmed = outcome.kind === 'confirmed';
  const tone: Tone = confirmed ? 'success' : 'danger';
  return (
    <div className={`rt-outcome rt-outcome--${tone}`} role={confirmed ? 'status' : 'alert'}>
      {shown !== null && <p className="rt-outcome__headline">{headline(shown)}</p>}
      {shown !== null && mayBeRecorded(shown) && <p>{OUTCOME_COPY.mayBeRecorded}</p>}
    </div>
  );
}

export function ReturnOutcome({ flow, outcome }: { flow: ReturnFlow; outcome: Outcome }) {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const confirmed = outcome.kind === 'confirmed';
  const ret = retOf(outcome);

  return (
    <section className="rt-returns__panel" aria-labelledby="rt-returns-outcome">
      <h2 id="rt-returns-outcome" ref={heading} tabIndex={-1} className="rt-returns__heading">
        نتيجة المرتجع
      </h2>
      <Announcement outcome={outcome} />
      {ret !== null && <Facts ret={ret} confirmed={confirmed} />}
      <div className="rt-returns__actions">
        <CheckAgain flow={flow} outcome={outcome} />
        <button
          type="button"
          className={`rt-btn ${outcome.kind === 'unconfirmed' ? 'rt-btn--secondary' : 'rt-btn--primary'}`}
          disabled={flow.busy === 'check'}
          onClick={flow.startOver}
        >
          مرتجع جديد
        </button>
      </div>
    </section>
  );
}
