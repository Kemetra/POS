import { describe, expect, it } from 'vitest';
import * as neutralConnection from '../connection-state';

/**
 * 023 G0 — connection state and viewport tier live outside the (now retired)
 * `shell/` folder so the v5 frame can use them directly. RT-504 removed the
 * shell compat re-exports, so there is exactly one connection store.
 */
describe('neutral connection module', () => {
  it('owns the Arabic-first connection banner copy for every non-online state', () => {
    expect(neutralConnection.CONNECTION_BANNER_MESSAGES).toEqual({
      degraded: 'الاتصال بطيء',
      offline: 'غير متصل — البيع من قائمة الانتظار المحلية',
      syncing: 'جارٍ المزامنة…',
    });
  });
});
