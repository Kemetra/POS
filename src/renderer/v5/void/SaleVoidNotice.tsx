import { useEffect, useState, type JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';

import type { SaleVoidBridgeAPI } from '../../../shared/sale-void/types';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { VOID_COPY } from './void-copy';
import './void.css';

const VOID_PATH = '/app/void';

interface Props {
  /** Tests inject a bridge (null = none); production reads `window.api`. */
  readonly bridge?: SaleVoidBridgeAPI | null;
  /** How often the attention count re-reads (ms); 0 turns the refresh off. */
  readonly refreshMs?: number;
  /**
   * Which part to render: the attention banner, the quiet link, or both. The
   * frame notices strip renders the banner with the other banners and the link
   * after «حالة الوردية», so the two quiet links can share one row.
   */
  readonly part?: 'banner' | 'link' | 'all';
}

function windowBridge(): SaleVoidBridgeAPI | null {
  const api = (window as unknown as { api?: { saleVoid?: SaleVoidBridgeAPI } }).api;
  return api?.saleVoid ?? null;
}

/** How many refused voids staff have not acknowledged; null while unknown. */
function useAttentionCount(
  bridge: SaleVoidBridgeAPI,
  pathname: string,
  refreshMs: number,
): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      bridge.list().then(
        (answer) => {
          if (!live) return;
          setCount(
            answer.kind === 'list' ? answer.voids.filter((v) => v.needs_attention).length : null,
          );
        },
        () => {
          if (live) setCount(null);
        },
      );
    };
    read();
    const timer = refreshMs > 0 ? setInterval(read, refreshMs) : null;
    return () => {
      live = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [bridge, pathname, refreshMs]);
  return count;
}

/**
 * RT-530 — the void presence in the v5 frame: the way to «إلغاء بيع», and a
 * persistent banner while Backend-Core has refused a queued void nobody has
 * acknowledged yet (a refused void is never dropped silently). Renders nothing
 * with the flag off, no session or no bridge, and calls nothing then.
 */
export function SaleVoidNotice({
  bridge,
  refreshMs = 15_000,
  part = 'all',
}: Props): JSX.Element | null {
  const enabled = useFeatureFlagsStore((s) => s.saleVoid);
  const signedIn = useOperatorSessionStore((s) => s.state.kind === 'signedIn');
  const api = bridge === undefined ? windowBridge() : bridge;
  if (!enabled || !signedIn) return null;
  if (api === null) return null;
  return (
    <>
      {part !== 'link' && <AttentionBanner bridge={api} refreshMs={refreshMs} />}
      {part !== 'banner' && <VoidLink />}
    </>
  );
}

/** A refused void needs attention, and the operator is not already on the void screen. */
function needsAttentionBanner(attention: number | null, pathname: string): boolean {
  const unseen = attention !== null && attention > 0;
  return unseen && !pathname.startsWith(VOID_PATH);
}

/** The persistent banner while a refused void is unacknowledged. */
function AttentionBanner(props: {
  bridge: SaleVoidBridgeAPI;
  refreshMs: number;
}): JSX.Element | null {
  const { pathname } = useLocation();
  const attention = useAttentionCount(props.bridge, pathname, props.refreshMs);
  if (!needsAttentionBanner(attention, pathname)) return null;
  return (
    <div className="v5-void-banner" role="alert" data-testid="void-attention-banner">
      <p>{VOID_COPY.attentionBanner}</p>
      <Link className="v5-live-btn v5-live-btn--primary v5-btn v5-btn--primary" to={VOID_PATH}>
        {VOID_COPY.attentionAction}
      </Link>
    </div>
  );
}

/** The quiet way to «إلغاء بيع»; it needs no attention count. */
function VoidLink(): JSX.Element | null {
  const { pathname } = useLocation();
  if (pathname.startsWith(VOID_PATH)) return null;
  return (
    <p className="v5-void-link">
      <Link to={VOID_PATH}>{VOID_COPY.link}</Link>
    </p>
  );
}
