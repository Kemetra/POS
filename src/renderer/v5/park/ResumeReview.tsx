import { useEffect, useRef, type JSX, type RefObject } from 'react';

import type { ResumePriceChange, ResumeUnavailableLine } from '../../../shared/cart/park-types';
import { formatHumanMoney } from '../../ui/format/human-format';
import { Notice } from '../foundation/Notice';
import { Icon } from '../../icons/Icon';
import { PARK_COPY, conflictLead, parkedTime } from './park-copy';
import { useCatalogueFreshness } from '../../sale/useCatalogueFreshness';
import type { CurrentSale, ResumeFlow, ResumePreview } from './useResumeFlow';

/** «آخر كتالوج: اليوم 13:02» (§4.2): the freshness the Sale already shows, beside the review. */
function useCatalogueStamp(): string | null {
  const { lastSuccessAt } = useCatalogueFreshness();
  if (lastSuccessAt === null) return null;
  const at = parkedTime(lastSuccessAt);
  return at.includes('/') ? at : `${PARK_COPY.today} ${at}`;
}

type ReviewView = Exclude<ResumeFlow['view'], { kind: 'list' }>;

/** The primary action's words, as drawn for each combination (PK3-Review* / Conflict*). */
export function acceptLabel(preview: ResumePreview, conflict: CurrentSale | null): string {
  const changes = preview.changes.length > 0 || preview.unavailable.length > 0;
  if (conflict !== null) return changes ? PARK_COPY.swapWithChanges : PARK_COPY.swap;
  return preview.changes.length > 0 ? PARK_COPY.acceptChanges : PARK_COPY.acceptRemoval;
}

const REFUSED_LINE: Readonly<Record<'catalogue_unavailable' | 'checkout_in_progress', string>> = {
  catalogue_unavailable: PARK_COPY.catalogueUnavailable,
  checkout_in_progress: PARK_COPY.checkoutInProgress,
};

/**
 * RT-445 — «مراجعة البيع قبل الاستئناف» (spec 024 §3.3): old price, new
 * price and difference per unit, and the lines that will be removed. Nothing
 * changes until the cashier accepts. A non-empty current sale adds the
 * VN-R10 choice (OD-7, OD-8).
 */
export function ResumeReview({ flow }: Readonly<{ flow: ResumeFlow }>): JSX.Element | null {
  const view = flow.view;
  const stamp = useCatalogueStamp();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  // Each new review (or refusal) puts focus on its first action, as drawn; a re-run preview is a new review.
  const shown = view.kind === 'review' ? view.preview : view.kind;
  useEffect(() => {
    (primaryRef.current ?? backRef.current)?.focus();
  }, [shown]);
  if (view.kind === 'list') return null;
  return (
    <section className="v5-park-screen" dir="rtl" lang="ar" aria-labelledby="v5-park-review-title">
      <div className="v5-park-head">
        <h1 id="v5-park-review-title">{PARK_COPY.reviewTitle}</h1>
        <p className="v5-park-muted">
          {view.sale.label === null ? PARK_COPY.unnamed : <bdi>{view.sale.label}</bdi>}
        </p>
        <span className="v5-park-grow" />
        <button type="button" className="v5-park-btn" onClick={flow.back}>
          {PARK_COPY.backToList}
        </button>
      </div>
      <section className="v5-park-panel" aria-labelledby="v5-park-review-heading">
        <div className="v5-park-panel__head">
          <h2 id="v5-park-review-heading">{PARK_COPY.reviewHeading}</h2>
          {stamp !== null && (
            <span className="v5-park-muted v5-park-small">{`${PARK_COPY.freshness} ${stamp}`}</span>
          )}
        </div>
        <div className="v5-park-review">
          <ReviewBody view={view} />
          <ReviewActions view={view} flow={flow} primaryRef={primaryRef} backRef={backRef} />
        </div>
      </section>
    </section>
  );
}

function ReviewBody({ view }: Readonly<{ view: ReviewView }>): JSX.Element {
  if (view.kind === 'refused') return <Notice tone="warning">{REFUSED_LINE[view.reason]}</Notice>;
  const { preview } = view;
  const changes = preview.changes.length > 0 || preview.unavailable.length > 0;
  return (
    <>
      {view.pricesChanged && <Notice tone="warning">{PARK_COPY.pricesChanged}</Notice>}
      {view.conflict !== null && <ConflictBlock sale={view.conflict} />}
      {changes && <p className="v5-park-lead">{PARK_COPY.reviewLead}</p>}
      {preview.changes.length > 0 && (
        <>
          <h3>{PARK_COPY.changesHeading}</h3>
          <ChangeTable changes={preview.changes} />
        </>
      )}
      {preview.unavailable.length > 0 && (
        <>
          <h3>{PARK_COPY.removedHeading}</h3>
          <RemovedTable lines={preview.unavailable} />
        </>
      )}
    </>
  );
}

function ReviewActions(
  props: Readonly<{
    view: ReviewView;
    flow: ResumeFlow;
    primaryRef: RefObject<HTMLButtonElement | null>;
    backRef: RefObject<HTMLButtonElement | null>;
  }>,
): JSX.Element {
  const { view, flow } = props;
  const review = view.kind === 'review' ? view : null;
  return (
    <div className="v5-park-review__actions">
      {review !== null && (
        <button
          ref={props.primaryRef}
          type="button"
          className="v5-park-btn v5-park-btn--primary"
          disabled={review.busy}
          onClick={flow.accept}
        >
          {acceptLabel(review.preview, review.conflict)}
        </button>
      )}
      <button
        ref={props.backRef}
        type="button"
        className="v5-park-btn"
        disabled={review?.busy === true}
        onClick={flow.back}
      >
        {review?.conflict ? PARK_COPY.keepCurrent : PARK_COPY.back}
      </button>
    </div>
  );
}

function ConflictBlock({ sale }: Readonly<{ sale: CurrentSale }>): JSX.Element {
  return (
    <div className="v5-park-conflict" role="group" aria-labelledby="v5-park-conflict-head">
      <p className="v5-park-conflict__head" id="v5-park-conflict-head">
        <Icon name="status.warning" />
        <span>
          {conflictLead(sale.lineCount)} <bdi dir="ltr">{formatHumanMoney(sale.totalMinor)}</bdi>.
        </span>
      </p>
      <p>{PARK_COPY.conflictBody}</p>
    </div>
  );
}

function money(minor: number): JSX.Element {
  return (
    <span className="v5-park-num" dir="ltr">
      {formatHumanMoney(minor)}
    </span>
  );
}

/** «+3.00» / «-4.00»: the sign, the arrow and the word carry the direction, never colour alone. */
function Difference({ change }: Readonly<{ change: ResumePriceChange }>): JSX.Element {
  const delta = change.new_unit_minor - change.old_unit_minor;
  const up = delta > 0;
  const amount = formatHumanMoney(Math.abs(delta)).replace(' EGP', '');
  return (
    <span className="v5-park-diff" data-direction={up ? 'up' : 'down'}>
      <Icon name={up ? 'increase' : 'decrease'} size="sm" />
      <span className="v5-park-num" dir="ltr">{`${up ? '+' : '\u2212'}${amount}`}</span>
      <span className="v5-park-diff__word">{up ? PARK_COPY.rose : PARK_COPY.fell}</span>
    </span>
  );
}

function ChangeTable({
  changes,
}: Readonly<{ changes: readonly ResumePriceChange[] }>): JSX.Element {
  return (
    <div className="v5-park-table" role="table" aria-label={PARK_COPY.changesTable}>
      <div className="v5-park-tr v5-park-tr--head" role="row">
        <span role="columnheader">{PARK_COPY.colItem}</span>
        <span role="columnheader">{PARK_COPY.colOld}</span>
        <span role="columnheader">{PARK_COPY.colNew}</span>
        <span role="columnheader">{PARK_COPY.colDiff}</span>
      </div>
      {changes.map((change) => (
        <div key={change.line_id} className="v5-park-tr" role="row">
          <span role="cell" className="v5-park-tr__name">
            <bdi>{change.display_name}</bdi>
          </span>
          <span role="cell" className="v5-park-old">
            {money(change.old_unit_minor)}
          </span>
          <span role="cell" className="v5-park-new">
            {money(change.new_unit_minor)}
          </span>
          <span role="cell">
            <Difference change={change} />
          </span>
        </div>
      ))}
    </div>
  );
}

function RemovedTable({
  lines,
}: Readonly<{ lines: readonly ResumeUnavailableLine[] }>): JSX.Element {
  return (
    <div className="v5-park-table" role="table" aria-label={PARK_COPY.removedTable}>
      {lines.map((line) => (
        <div key={line.line_id} className="v5-park-tr v5-park-tr--gone" role="row">
          <span role="cell" className="v5-park-tr__name">
            <bdi>{line.display_name}</bdi>
          </span>
          <span role="cell">
            <span className="v5-park-tag v5-park-tag--gone">
              <Icon name="status.danger" size="sm" />
              {PARK_COPY.removedTag}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
