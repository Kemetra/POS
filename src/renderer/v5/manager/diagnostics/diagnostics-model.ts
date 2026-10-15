import type {
  CatalogueFreshnessResponse,
  CatalogueRefreshResponse,
  CatalogueSearchResponse,
} from '../../../../shared/bridge-api';
import { pluralAr } from '../../../../shared/formatters/arabic-plural';
import { formatHumanDateTime } from '../../../ui/format/human-format';
import { DIAGNOSTICS_COPY, SEARCH_RESULT_FORMS } from './diagnostics-copy';

/**
 * RT-503 (VN-S10 S10-6) — raw bridge states → what the manager reads. Pure; the
 * screen decides when to call the bridge, this decides only the words.
 */

/** What the sync panel shows for «آخر تحديث». `at` is the ISO instant to format. */
export type FreshnessView =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'never' }
  | { kind: 'empty'; at: string }
  | { kind: 'synced'; at: string };

export function freshnessView(f: CatalogueFreshnessResponse | null): FreshnessView {
  if (f === null) return { kind: 'loading' };
  if (f.kind === 'refused') return { kind: 'unavailable' };
  if (f.last_success_at === null) return { kind: 'never' };
  return f.is_empty
    ? { kind: 'empty', at: f.last_success_at }
    : { kind: 'synced', at: f.last_success_at };
}

/** The sentence a freshness state needs, or null when the time alone says it. */
export function freshnessText(view: FreshnessView): string | null {
  switch (view.kind) {
    case 'loading':
      return DIAGNOSTICS_COPY.loading;
    case 'unavailable':
      return DIAGNOSTICS_COPY.unavailable;
    case 'never':
      return DIAGNOSTICS_COPY.sync.neverSynced;
    case 'empty':
      return DIAGNOSTICS_COPY.sync.emptySynced;
    case 'synced':
      return null;
  }
}

const SYNC_TIME = { withYear: true } as const;

/** The shared formatter's absolute time; an unparseable instant is shown verbatim. */
export function formatSyncTime(iso: string): string {
  return formatHumanDateTime(iso, SYNC_TIME) ?? iso;
}

/** Honest status only: a started refresh is never described as finished. */
export function refreshMessage(kind: CatalogueRefreshResponse['kind']): string {
  return DIAGNOSTICS_COPY.refresh[kind];
}

/** null = nothing to say yet (no search was made). */
export function searchMessage(res: CatalogueSearchResponse | null): string | null {
  if (res === null) return null;
  switch (res.kind) {
    case 'results':
      return pluralAr(res.items.length, SEARCH_RESULT_FORMS);
    case 'not_found':
      return DIAGNOSTICS_COPY.search.none;
    default:
      // refused, too_short, catalogue_unavailable: the read is not available.
      return DIAGNOSTICS_COPY.unavailable;
  }
}
