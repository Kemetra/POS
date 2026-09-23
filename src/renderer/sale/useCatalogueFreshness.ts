import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CatalogueBridgeAPI,
  CatalogueFreshnessResponse,
  CatalogueRefreshResponse,
  PreloadBridgeAPI,
} from '../../shared/bridge-api';

type FreshnessBridge = Pick<CatalogueBridgeAPI, 'freshness' | 'refresh'>;
export type FreshnessState =
  | 'loading'
  | 'never-synced'
  | 'updated'
  | 'synced-empty'
  | 'unavailable';
export type RefreshFeedback = 'idle' | 'started' | 'already-running';
const POST_COMMIT_REREAD_DELAY_MS = 3_000;

function readBridge(): FreshnessBridge {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api?.catalogue) throw new Error('Sale freshness: catalogue bridge unavailable.');
  return api.catalogue;
}

function toState(response: CatalogueFreshnessResponse): {
  state: FreshnessState;
  lastSuccessAt: string | null;
} {
  const raw = response as unknown;
  if (raw === null || typeof raw !== 'object' || !('kind' in raw)) {
    return { state: 'unavailable', lastSuccessAt: null };
  }
  if (response.kind === 'refused') return { state: 'unavailable', lastSuccessAt: null };
  if (response.last_success_at === null) return { state: 'never-synced', lastSuccessAt: null };
  return {
    state: response.is_empty ? 'synced-empty' : 'updated',
    lastSuccessAt: response.last_success_at,
  };
}

export function useCatalogueFreshness(bridge?: FreshnessBridge): {
  state: FreshnessState;
  lastSuccessAt: string | null;
  feedback: RefreshFeedback;
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<FreshnessState>('loading');
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<RefreshFeedback>('idle');
  const [refreshing, setRefreshing] = useState(false);
  const rereadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSuccessAtRef = useRef<string | null>(null);
  lastSuccessAtRef.current = lastSuccessAt;

  const resolveBridge = useCallback((): FreshnessBridge => bridge ?? readBridge(), [bridge]);
  const load = useCallback(
    async (advancedFrom?: { stamp: string | null }): Promise<void> => {
      try {
        const next = toState(await resolveBridge().freshness({}));
        setState(next.state);
        setLastSuccessAt(next.lastSuccessAt);
        if (
          advancedFrom !== undefined &&
          next.lastSuccessAt !== null &&
          next.lastSuccessAt !== advancedFrom.stamp
        )
          setFeedback('idle');
      } catch {
        setState('unavailable');
        setLastSuccessAt(null);
      }
    },
    [resolveBridge],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () => () => {
      if (rereadTimerRef.current !== null) clearTimeout(rereadTimerRef.current);
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    if (rereadTimerRef.current !== null) {
      clearTimeout(rereadTimerRef.current);
      rereadTimerRef.current = null;
    }
    try {
      const result: CatalogueRefreshResponse = await resolveBridge().refresh({});
      if (result.kind === 'already_running') setFeedback('already-running');
      else if (result.kind === 'started') setFeedback('started');
      else setFeedback('idle');
      await load();
      if (result.kind === 'started') {
        const stamp = lastSuccessAtRef.current;
        rereadTimerRef.current = setTimeout(() => {
          rereadTimerRef.current = null;
          void load({ stamp });
        }, POST_COMMIT_REREAD_DELAY_MS);
      }
    } finally {
      setRefreshing(false);
    }
  }, [load, resolveBridge]);

  return { state, lastSuccessAt, feedback, refreshing, refresh };
}
