/**
 * Compatibility path. The dev toggle slice moved to `renderer/connection/`
 * (RT-498, VN-S10 S10-1) so the v5 frame can read `?conn=` without importing
 * shell code; this re-exports the same module. Deleted with the shell (S10-Z).
 */
export {
  getDevToggles,
  useDevToggles,
  type DevToggles,
  type PaneState,
} from '../../connection/dev-toggles';
