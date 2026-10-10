import {
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { CatalogueSearchState } from '../../stores/catalogueSearchStore';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import { useDebouncedSearch, type DebouncedSearch } from '../../stores/useDebouncedSearch';
import type { FreshnessState, RefreshFeedback } from '../../sale/useCatalogueFreshness';
import { V5Icon } from '../foundation/V5Icon';
import { LiveSearchResults } from './LiveSearchResults';
import { SCAN_ANCHOR_ID } from '../../scan/scan-anchor';
import { formatHumanDateTime } from '../../ui/format/human-format';

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
  /** Esc: close the results and hand focus back to the scan owner (15 §3.2). */
  onDismiss?: () => void;
  /** The scan-owner status and the last-add acknowledgement, owned by the workspace. */
  status?: ReactNode;
  searchRef: RefObject<HTMLInputElement | null>;
}

/** Absolute Arabic timestamp (Western digits, 24-hour); an unparseable value is shown verbatim rather than throwing. */
function formatStamp(iso: string): string {
  return formatHumanDateTime(iso, { withYear: true, month: 'long' }) ?? iso;
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

/** The search FSM states that have something to show below the command bar. */
function resultsOpen(state: CatalogueSearchState): boolean {
  return state.kind !== 'idle' && state.kind !== 'confirm_pending';
}

/**
 * RT-242 (VNext W1-B, Direction B) — the Sale command bar: the scan target and
 * typed search side by side above the cart, the scan-owner status and catalogue
 * freshness on one quiet line beneath, and the search results as a dropdown
 * over the cart. A pick adds at once (D-C1): the dropdown closes and the typed
 * query, having done its job, is cleared.
 */
export function LiveProductRail(props: Props): JSX.Element {
  const [query, setQuery] = useState('');
  // Owned here, not in the field, so Esc can drop a keystroke still inside the
  // debounce window; otherwise it would reopen the results after dismissal.
  const search = useDebouncedSearch(props.onSearch);
  const open = resultsOpen(props.state);
  function select(product: ProductSnapshotDisplay): void {
    search.cancel();
    setQuery('');
    props.onSelect(product);
  }
  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    search.cancel();
    setQuery('');
    if (props.onDismiss) props.onDismiss();
    else props.onRecover();
  }

  return (
    <section
      className="v5-sale-command"
      aria-labelledby="v5-live-products-title"
      onKeyDown={handleKeyDown}
    >
      <h2 id="v5-live-products-title" className="v5-visually-hidden">
        الأصناف والمنتجات
      </h2>
      <div className="v5-sale-command-fields">
        <ScanField onScan={props.onScan} />
        <SearchField
          query={query}
          setQuery={setQuery}
          search={search}
          onRecover={props.onRecover}
          searchRef={props.searchRef}
        />
      </div>
      <div className="v5-sale-command-status">
        {props.status}
        <FreshnessBar {...props} />
      </div>
      {open && <ResultsDropdown {...props} onSelect={select} />}
    </section>
  );
}

function ResultsDropdown(props: Props): JSX.Element {
  const count = props.state.kind === 'results' ? props.state.items.length : 0;
  return (
    <div className="v5-sale-dropdown">
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
    </div>
  );
}

/** The scan owner's focus anchor: unmistakably the scanner's, not a second search box. */
function ScanField(props: { onScan: (barcode: string) => void }): JSX.Element {
  const [barcode, setBarcode] = useState('');
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = barcode.trim();
    setBarcode('');
    if (value.length > 0) props.onScan(value);
  }
  return (
    <div className="v5-live-scan-field">
      <span aria-hidden="true" className="v5-live-scan-icon">
        <V5Icon name="scan" size={24} />
      </span>
      <div className="v5-sale-command-input">
        <label htmlFor={SCAN_ANCHOR_ID} className="v5-live-scan-label">
          التقاط مسح الباركود
        </label>
        <input
          id={SCAN_ANCHOR_ID}
          data-scan-target="search"
          type="text"
          inputMode="none"
          placeholder="امسح الباركود هنا"
          autoComplete="off"
          value={barcode}
          onChange={(event) => {
            setBarcode(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          aria-label="حقل التقاط مسح الباركود"
        />
      </div>
    </div>
  );
}

function SearchField(props: {
  query: string;
  setQuery: (value: string) => void;
  search: DebouncedSearch;
  onRecover: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
}): JSX.Element {
  const { search } = props;
  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const value = event.target.value;
    props.setQuery(value);
    if (value.length === 0) props.onRecover();
    search.onType(value);
  }
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    search.onScanSubmit(props.query);
  }
  return (
    <div className="v5-sale-search-field">
      <span aria-hidden="true" className="v5-sale-search-icon">
        <V5Icon name="search" />
      </span>
      <div className="v5-sale-command-input">
        <label htmlFor="v5-live-search">البحث بالاسم أو الباركود</label>
        <input
          ref={props.searchRef}
          id="v5-live-search"
          data-scan-target="search"
          type="search"
          value={props.query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="اسم الصنف أو الباركود"
          autoComplete="off"
          aria-describedby="v5-live-search-note"
        />
      </div>
      <p id="v5-live-search-note" className="v5-visually-hidden">
        اكتب حرفين للبحث، أو اضغط Enter للبحث فورًا.
      </p>
    </div>
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
