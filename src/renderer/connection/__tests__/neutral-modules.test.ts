import { describe, expect, it } from 'vitest';
import * as neutralConnection from '../connection-state';
import * as shellConnection from '../../shell/connection/useConnectionState';
import * as neutralViewport from '../../viewport/useViewportTier';
import * as shellViewport from '../../shell/viewport/useViewportTier';

/**
 * 023 G0 — connection state and viewport tier moved out of `shell/` so v5 can
 * use them without importing legacy shell code. The shell paths re-export the
 * same objects, so there is still exactly one connection store.
 */
describe('neutral connection and viewport modules', () => {
  it('shell re-exports the one connection store and hook', () => {
    expect(shellConnection.useConnectionStateStore).toBe(neutralConnection.useConnectionStateStore);
    expect(shellConnection.useConnectionState).toBe(neutralConnection.useConnectionState);
  });

  it('shell re-exports the one viewport hook', () => {
    expect(shellViewport.useViewportTier).toBe(neutralViewport.useViewportTier);
  });

  it('owns the Arabic-first connection banner copy for every non-online state', () => {
    expect(neutralConnection.CONNECTION_BANNER_MESSAGES).toEqual({
      degraded: 'الاتصال بطيء — Connection slow',
      offline: 'غير متصل — البيع من قائمة الانتظار المحلية',
      syncing: 'جارٍ المزامنة…',
    });
  });
});
