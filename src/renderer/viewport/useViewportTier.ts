import { useState, useEffect } from 'react';

/** The width tier: it decides the nav layout and the 1024px floor. */
export type ViewportTier = 'expanded' | 'icon-only' | 'too-small';

/**
 * RT-313 (RT-312 D1) — the height band. 768px and up is the full reference;
 * 600–767px is the compact-height band, which is not supported until it is
 * verified on pilot hardware (RT-407); below 600px operational use is blocked.
 */
export type HeightBand = 'full' | 'compact-height' | 'too-short';

export interface Viewport {
  readonly tier: ViewportTier;
  readonly height: HeightBand;
}

/** Which floor a viewport is under: the copy variant ScreenTooSmall shows. */
export type ViewportShortfall = 'width' | 'height' | 'both';

const EXPANDED_QUERY = '(min-width: 1280px)';
const ICON_ONLY_QUERY = '(min-width: 1024px)';
/*
 * The height floors are `min-height` queries, like the width ones, so they
 * read "at least": a fractional CSS height at 150% (599.33px) fails
 * `(min-height: 600px)` and blocks, as D1 requires. `(max-height: 599px)`
 * would match neither side of that gap and let it through.
 */
const FULL_HEIGHT_QUERY = '(min-height: 768px)';
const HEIGHT_FLOOR_QUERY = '(min-height: 600px)';

function getTier(expanded: boolean, iconOnly: boolean): ViewportTier {
  if (expanded) return 'expanded';
  if (iconOnly) return 'icon-only';
  return 'too-small';
}

function getHeightBand(full: boolean, aboveFloor: boolean): HeightBand {
  if (full) return 'full';
  if (aboveFloor) return 'compact-height';
  return 'too-short';
}

interface ViewportQueries {
  expanded: MediaQueryList;
  iconOnly: MediaQueryList;
  fullHeight: MediaQueryList;
  heightFloor: MediaQueryList;
}

function openQueries(): ViewportQueries {
  return {
    expanded: window.matchMedia(EXPANDED_QUERY),
    iconOnly: window.matchMedia(ICON_ONLY_QUERY),
    fullHeight: window.matchMedia(FULL_HEIGHT_QUERY),
    heightFloor: window.matchMedia(HEIGHT_FLOOR_QUERY),
  };
}

function readViewport(q: ViewportQueries): Viewport {
  return {
    tier: getTier(q.expanded.matches, q.iconOnly.matches),
    height: getHeightBand(q.fullHeight.matches, q.heightFloor.matches),
  };
}

/**
 * RT-313 — the floor a viewport is under, or null when it is supported:
 * narrower than 1024px or shorter than 600px blocks operational use.
 */
export function viewportShortfall({ tier, height }: Viewport): ViewportShortfall | null {
  const narrow = tier === 'too-small';
  const short = height === 'too-short';
  if (narrow && short) return 'both';
  if (narrow) return 'width';
  if (short) return 'height';
  return null;
}

/**
 * T026 — Returns the current width tier and (RT-313) height band from
 * matchMedia breakpoints. Uses matchMedia listeners (not raw resize) for
 * efficiency. One 100ms debounce covers every query, so a resize that crosses
 * a width and a height boundary together settles in a single transition.
 */
export function useViewportTier(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(() => readViewport(openQueries()));

  useEffect(() => {
    const queries = openQueries();
    const lists: MediaQueryList[] = [
      queries.expanded,
      queries.iconOnly,
      queries.fullHeight,
      queries.heightFloor,
    ];

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const update = (): void => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const next = readViewport(queries);
        // Keep the same object when nothing changed, so consumers do not re-render.
        setViewport((prev) =>
          prev.tier === next.tier && prev.height === next.height ? prev : next,
        );
      }, 100);
    };

    lists.forEach((mql) => {
      mql.addEventListener('change', update);
    });

    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      lists.forEach((mql) => {
        mql.removeEventListener('change', update);
      });
    };
  }, []);

  return viewport;
}
