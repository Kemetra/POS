import { useCallback, useRef, useState } from 'react';

import type { SaleListItem } from '../../../../../shared/bridge-api';
import type {
  SaleHistoryBridgeAPI,
  SaleHistoryListRequest,
  SaleHistoryListResponse,
  SaleHistoryLocalPage,
  SaleHistoryRefusalReason,
  SaleHistoryRow,
  SaleHistoryServerPage,
} from '../../../../../shared/sale-history/types';

/**
 * RT-542 — the history list state. One walk at a time: a new search replaces
 * the walk; "more" appends the next page of the SAME walk (the main process
 * keeps a walk on one source). A failed "more" keeps the rows shown and offers
 * a retry; a rejected cursor ends the walk (search again).
 */

type ServerMeta = Pick<
  SaleHistoryServerPage,
  'as_of' | 'store_timezone' | 'visibility' | 'unsynced' | 'unsynced_truncated'
>;

export type HistoryView =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'refused'; reason: SaleHistoryRefusalReason }
  | {
      phase: 'server';
      rows: SaleHistoryRow[];
      meta: ServerMeta;
      cursor: string | null;
      more: MoreState;
    }
  | {
      phase: 'local';
      rows: SaleListItem[];
      reason: SaleHistoryLocalPage['offline_reason'];
      cursor: string | null;
      more: MoreState;
    };

export type MoreState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed'; reason: SaleHistoryRefusalReason };

interface Range {
  from_day: string;
  to_day: string;
}

function firstView(res: SaleHistoryListResponse): HistoryView {
  if (res.kind === 'refused') return { phase: 'refused', reason: res.reason };
  if (res.source === 'local') {
    return {
      phase: 'local',
      rows: res.rows,
      reason: res.offline_reason,
      cursor: res.next_cursor,
      more: { kind: 'idle' },
    };
  }
  const { as_of, store_timezone, visibility, unsynced, unsynced_truncated } = res;
  return {
    phase: 'server',
    rows: res.rows,
    meta: { as_of, store_timezone, visibility, unsynced, unsynced_truncated },
    cursor: res.next_cursor,
    more: { kind: 'idle' },
  };
}

function appended(view: HistoryView, res: SaleHistoryListResponse): HistoryView {
  if (view.phase !== 'server' && view.phase !== 'local') return view;
  if (res.kind === 'refused') return { ...view, more: { kind: 'failed', reason: res.reason } };
  if (view.phase === 'server' && res.source === 'server') {
    return {
      ...view,
      rows: [...view.rows, ...res.rows],
      cursor: res.next_cursor,
      more: { kind: 'idle' },
    };
  }
  if (view.phase === 'local' && res.source === 'local') {
    return {
      ...view,
      rows: [...view.rows, ...res.rows],
      cursor: res.next_cursor,
      more: { kind: 'idle' },
    };
  }
  return { ...view, more: { kind: 'failed', reason: 'continuation_failed' } };
}

export interface SaleHistoryState {
  view: HistoryView;
  search(range: Range): Promise<void>;
  loadMore(): Promise<void>;
}

/** The bridge answer, or `fallback` when the call itself rejects. */
async function listOr(
  bridge: SaleHistoryBridgeAPI,
  req: Parameters<SaleHistoryBridgeAPI['list']>[0],
  fallback: SaleHistoryRefusalReason,
): Promise<SaleHistoryListResponse> {
  try {
    return await bridge.list(req);
  } catch {
    return { kind: 'refused', reason: fallback };
  }
}

/** The cursor of a walk that can load another page now, or null. */
function nextCursorOf(view: HistoryView): string | null {
  if (view.phase !== 'server' && view.phase !== 'local') return null;
  return view.more.kind === 'loading' ? null : view.cursor;
}

/** The next-page request of the current walk, or null when there is none to load. */
function moreRequest(range: Range | null, view: HistoryView): SaleHistoryListRequest | null {
  const cursor = nextCursorOf(view);
  return range === null || cursor === null ? null : { ...range, cursor };
}

/** Refusals after which the same cursor can never succeed: the walk ends. */
const WALK_ENDING: ReadonlySet<SaleHistoryRefusalReason> = new Set([
  'cursor_rejected',
  'invalid_request',
]);

function endsWalk(res: SaleHistoryListResponse): boolean {
  return res.kind === 'refused' && WALK_ENDING.has(res.reason);
}

/** The view after a "more" answer: a cursor that cannot succeed ends the walk. */
function afterMore(latest: HistoryView, res: SaleHistoryListResponse): HistoryView {
  if (endsWalk(res)) return { phase: 'refused', reason: 'cursor_rejected' };
  return appended(latest, res);
}

export function useSaleHistory(bridge: SaleHistoryBridgeAPI | null): SaleHistoryState {
  const [view, setView] = useState<HistoryView>({ phase: 'idle' });
  const walk = useRef(0);
  // One "more" at a time, even before the loading state re-renders.
  const moreInFlight = useRef(false);
  const range = useRef<Range | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const search = useCallback(
    async (next: Range): Promise<void> => {
      if (bridge === null) return;
      walk.current += 1;
      const mine = walk.current;
      range.current = next;
      setView({ phase: 'loading' });
      const res = await listOr(bridge, next, 'unavailable');
      if (walk.current === mine) setView(firstView(res));
    },
    [bridge],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    if (bridge === null || moreInFlight.current) return;
    const current = viewRef.current;
    const req = moreRequest(range.current, current);
    if (req === null) return;
    moreInFlight.current = true;
    const mine = walk.current;
    setView({ ...current, more: { kind: 'loading' } } as HistoryView);
    const res = await listOr(bridge, req, 'continuation_failed');
    moreInFlight.current = false;
    if (walk.current === mine) setView((latest) => afterMore(latest, res));
  }, [bridge]);

  return { view, search, loadMore };
}
