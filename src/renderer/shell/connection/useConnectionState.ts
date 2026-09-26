/**
 * Compatibility path. The connection store moved to `renderer/connection/`
 * (023 G0) so v5 can read it without importing shell code; this re-exports
 * the same store, so there is still exactly one.
 */
export { useConnectionState, useConnectionStateStore } from '../../connection/connection-state';
