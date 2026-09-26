/**
 * Compatibility path. The viewport-tier hook moved to `renderer/viewport/`
 * (023 G0) so v5 can use it without importing shell code.
 */
export { useViewportTier, type ViewportTier } from '../../viewport/useViewportTier';
