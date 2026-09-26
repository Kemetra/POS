import { useState, useEffect } from 'react';

export type ViewportTier = 'expanded' | 'icon-only' | 'too-small';

const EXPANDED_QUERY = '(min-width: 1280px)';
const ICON_ONLY_QUERY = '(min-width: 1024px)';

function getTier(expanded: boolean, iconOnly: boolean): ViewportTier {
  if (expanded) return 'expanded';
  if (iconOnly) return 'icon-only';
  return 'too-small';
}

/**
 * T026 — Returns the current viewport tier based on matchMedia breakpoints.
 * Uses matchMedia listeners (not raw resize) for efficiency.
 * Debounces internal transitions by 100ms.
 */
export function useViewportTier(): ViewportTier {
  const [tier, setTier] = useState<ViewportTier>(() => {
    const expanded = window.matchMedia(EXPANDED_QUERY).matches;
    const iconOnly = window.matchMedia(ICON_ONLY_QUERY).matches;
    return getTier(expanded, iconOnly);
  });

  useEffect(() => {
    const expandedMql = window.matchMedia(EXPANDED_QUERY);
    const iconOnlyMql = window.matchMedia(ICON_ONLY_QUERY);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const update = (): void => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setTier(getTier(expandedMql.matches, iconOnlyMql.matches));
      }, 100);
    };

    expandedMql.addEventListener('change', update);
    iconOnlyMql.addEventListener('change', update);

    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      expandedMql.removeEventListener('change', update);
      iconOnlyMql.removeEventListener('change', update);
    };
  }, []);

  return tier;
}
