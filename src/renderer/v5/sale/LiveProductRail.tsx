import { useState, type ChangeEvent, type JSX, type KeyboardEvent, type RefObject } from 'react';
import type { CatalogueSearchState } from '../../stores/catalogueSearchStore';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import { useDebouncedSearch } from '../../stores/useDebouncedSearch';
import type { FreshnessState, RefreshFeedback } from '../../sale/useCatalogueFreshness';
import { V5Icon } from '../foundation/V5Icon';
import { LiveSearchResults } from './LiveSearchResults';

interface Props {
  state: CatalogueSearchState;
  freshness: FreshnessState;
  lastSuccessAt: string | null;
  feedback: RefreshFeedback;
  refreshing: boolean;
  onRefresh: () => void;
  onSearch: (query: string) => void;
  onScan: (barcode: string) => void;
  onSelect: (product: ProductSnapshotDisplay) => void;
  onRecover: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

/** Absolute Arabic timestamp; an unparseable value is shown verbatim rather than throwing. */
function formatStamp(iso: string): string {
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

const FRESHNESS_COPY: Record<FreshnessState, (stamp: string) => string> = {
  loading: () => 'جارٍ القراءة…',
  'never-synced': () => 'لم يُنزّل الكتالوج بعد',
  'synced-empty': (stamp) => `تم التحديث، لكن لا توجد منتجات (${stamp})`,
  updated: (stamp) => `آخر تحديث: ${stamp}`,
  unavailable: () => 'حالة الكتالوج غير متاحة',
};

/** States in which search cannot be trusted to find stock: say so, don't whisper it. */
const FRESHNESS_TONE: Record<FreshnessState, 'warning' | 'neutral'> = {
  loading: 'neutral',
  'never-synced': 'warning',
  'synced-empty': 'warning',
  updated: 'neutral',
  unavailable: 'warning',
};

const FEEDBACK_COPY: Record<RefreshFeedback, string | null> = {
  idle: null,
  started: 'جارٍ التحديث…',
  'already-running': 'جارٍ التحديث بالفعل',
};

export function LiveProductRail(props: Props): JSX.Element {
  const count = props.state.kind === 'results' ? props.state.items.length : 0;
  return (
    <section className="v5-sale-products" aria-labelledby="v5-live-products-title">
      <div className="v5-sale-region-heading">
        <h2 id="v5-live-products-title">الأصناف والمنتجات</h2>
      </div>
      <div className="v5-sale-search-area">
        <SearchFields {...props} />
      </div>
      <div className="v5-sale-list-heading">
        <span>
          نتائج البحث
          {count > 0 && <span className="v5-live-result-count"> · {count}</span>}
        </span>
        <span>السعر</span>
      </div>
      <div className="v5-live-results">
        <LiveSearchResults
          state={props.state}
          onSelect={props.onSelect}
          onRecover={props.onRecover}
        />
      </div>
      <FreshnessBar {...props} />
    </section>
  );
}

function SearchFields(props: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [barcode, setBarcode] = useState('');
  const search = useDebouncedSearch(props.onSearch);

  function handleSearchChange(event: ChangeEvent<HTMLInputElement>): void {
    const value = event.target.value;
    setQuery(value);
    if (value.length === 0) props.onRecover();
    search.onType(value);
  }
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    search.onScanSubmit(query);
  }
  function handleScanKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = barcode.trim();
    setBarcode('');
    if (value.length > 0) props.onScan(value);
  }

  return (
    <>
      <label htmlFor="v5-live-search">البحث بالاسم أو الباركود</label>
      <div className="v5-sale-search-field">
        <span aria-hidden="true" className="v5-sale-search-icon">
          <V5Icon name="search" />
        </span>
        <input
          ref={props.searchRef}
          id="v5-live-search"
          type="search"
          value={query}
          onChange={handleSearchChange}
          onKeyDown={handleSearchKeyDown}
          placeholder="اسم الصنف أو الباركود"
          autoComplete="off"
          aria-describedby="v5-live-search-note"
        />
      </div>
      <p id="v5-live-search-note">اكتب حرفين للبحث، أو اضغط Enter للبحث فورًا.</p>
      <label htmlFor="v5-live-scan" className="v5-live-scan-label">
        التقاط مسح الباركود
      </label>
      <div className="v5-live-scan-field">
        <span aria-hidden="true" className="v5-live-scan-icon">
          <V5Icon name="scan" />
        </span>
        <input
          id="v5-live-scan"
          type="text"
          inputMode="none"
          placeholder="امسح الباركود هنا"
          autoComplete="off"
          value={barcode}
          onChange={(event) => {
            setBarcode(event.target.value);
          }}
          onKeyDown={handleScanKeyDown}
          aria-label="حقل التقاط مسح الباركود"
        />
      </div>
    </>
  );
}

function FreshnessBar(props: Props): JSX.Element {
  const stamp = props.lastSuccessAt === null ? '' : formatStamp(props.lastSuccessAt);
  const feedback = FEEDBACK_COPY[props.feedback];
  return (
    <div
      className="v5-live-freshness"
      role="status"
      aria-live="polite"
      data-tone={FRESHNESS_TONE[props.freshness]}
    >
      <span>{FRESHNESS_COPY[props.freshness](stamp)}</span>
      {feedback !== null && <span>{feedback}</span>}
      <button type="button" onClick={props.onRefresh} disabled={props.refreshing}>
        تحديث الكتالوج
      </button>
    </div>
  );
}
