import { describe, it, expectTypeOf } from 'vitest';
import type { PreloadBridgeAPI } from '../shared/bridge-api';
import type { AppConfig } from '../shared/app-config';
import type { RendererErrorReport } from '../shared/renderer-error-report';

// Side-effect import keeps the global Window augmentation in scope for this file.
import '../shared/bridge-api';

/**
 * T029 — bridge-typing test.
 *
 * Asserts that `window.api` and `PreloadBridgeAPI` are the same shape, so any
 * preload implementation that drifts from the contract fails typecheck (and CI).
 *
 * T067 extension: covers `appConfig()` so a future drift of the renderer-
 * facing config shape is caught by typecheck.
 */
describe('window.api typing matches PreloadBridgeAPI', () => {
  it('Window["api"] equals PreloadBridgeAPI', () => {
    expectTypeOf<Window['api']>().toEqualTypeOf<PreloadBridgeAPI>();
  });

  it('PreloadBridgeAPI.ping returns Promise<"pong">', () => {
    expectTypeOf<PreloadBridgeAPI['ping']>().returns.resolves.toEqualTypeOf<'pong'>();
  });

  it('PreloadBridgeAPI.appVersion returns Promise<string>', () => {
    expectTypeOf<PreloadBridgeAPI['appVersion']>().returns.resolves.toEqualTypeOf<string>();
  });

  it('PreloadBridgeAPI.appConfig returns Promise<AppConfig>', () => {
    expectTypeOf<PreloadBridgeAPI['appConfig']>().returns.resolves.toEqualTypeOf<AppConfig>();
  });

  it('PreloadBridgeAPI.reportError takes a RendererErrorReport (RT-634)', () => {
    expectTypeOf<PreloadBridgeAPI['reportError']>().parameters.toEqualTypeOf<
      [RendererErrorReport]
    >();
    expectTypeOf<PreloadBridgeAPI['reportError']>().returns.toEqualTypeOf<Promise<void>>();
  });
});
