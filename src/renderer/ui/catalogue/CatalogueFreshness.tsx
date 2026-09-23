import type { JSX } from 'react';
import type { CatalogueBridgeAPI } from '../../../shared/bridge-api.js';
import { useCatalogueFreshness, type FreshnessState } from '../../sale/useCatalogueFreshness.js';

type FreshnessBridge = Pick<CatalogueBridgeAPI, 'freshness' | 'refresh'>;
export interface CatalogueFreshnessProps {
  bridge?: FreshnessBridge;
}

function formatAbsolute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ar-EG', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

const STATE_ICON: Record<Exclude<FreshnessState, 'loading'>, string> = {
  'never-synced': '⃝',
  updated: '●',
  'synced-empty': '⚠',
  unavailable: '⛔',
};

/** Legacy indicator retained as a presentation consumer of the neutral freshness controller. */
export function CatalogueFreshness({ bridge }: CatalogueFreshnessProps): JSX.Element {
  const { state, lastSuccessAt, feedback, refreshing, refresh } = useCatalogueFreshness(bridge);
  return (
    <div
      role="status"
      aria-live="polite"
      className="catalogue-freshness"
      data-testid="catalogue-freshness"
      data-state={state}
    >
      {state !== 'loading' && (
        <span className="catalogue-freshness__icon" aria-hidden="true">
          {STATE_ICON[state]}
        </span>
      )}
      <span className="catalogue-freshness__label">
        {state === 'loading' && 'جارٍ القراءة…'}
        {state === 'never-synced' && 'لم يُنزّل الكتالوج بعد'}
        {state === 'updated' && lastSuccessAt !== null && (
          <>
            آخر تحديث:{' '}
            <time dateTime={lastSuccessAt} data-testid="catalogue-freshness-time">
              {formatAbsolute(lastSuccessAt)}
            </time>
          </>
        )}
        {state === 'synced-empty' && lastSuccessAt !== null && (
          <>
            تم التحديث، لكن لا توجد منتجات (
            <time dateTime={lastSuccessAt} data-testid="catalogue-freshness-time">
              {formatAbsolute(lastSuccessAt)}
            </time>
            )
          </>
        )}
        {state === 'unavailable' && 'حالة الكتالوج غير متاحة'}
      </span>
      {feedback !== 'idle' && (
        <span className="catalogue-freshness__feedback">
          {feedback === 'started' && 'جارٍ التحديث…'}
          {feedback === 'already-running' && 'جارٍ التحديث بالفعل'}
        </span>
      )}
      <button
        type="button"
        className="btn btn--ghost btn--md catalogue-freshness__refresh"
        onClick={() => {
          void refresh();
        }}
        disabled={refreshing}
      >
        تحديث الكتالوج (Refresh)
      </button>
    </div>
  );
}
