import type { Logger } from 'pino';

import { CartBridgeHandlers, type ItemRefResolver } from './cart-bridge.js';
import { bindCartStore } from './cart-store.js';
import { resolveItemRef as fixtureResolver } from './resolve-item-ref.js';
import type { DatabaseHandle } from '../db/client.js';
import type { AuditEmitter } from '../audit/audit-emitter.js';
import type { OperatorSessionRecord } from '../operator/session-manager.js';

export interface CartHandlersDeps {
  dbHandle: DatabaseHandle;
  getCurrentSession: () => OperatorSessionRecord | null;
  /**
   * #380 (F-007) — returns the pairing row's REAL terminal_id, or null when
   * unpaired. Threaded into CartBridgeHandlers so cart rows stamp the real
   * terminal_id (not session.branch_id). Wired to
   * `pairingStore.getCurrentTerminalId` in the composition root.
   */
  getTerminalId: () => string | null;
  logger: Logger;
  auditEmitter: AuditEmitter;
  /**
   * `app.isPackaged` from Electron.  Must be `true` in production builds.
   * When `true`, the dev fixture resolver is unconditionally skipped even if
   * `POS_PULSE_DEV_ITEM_RESOLVER` is set in the environment.
   */
  isPackaged: boolean;
  /**
   * 009 R7 — the REAL catalogue-backed resolver (`createCatalogueResolver`).
   * When supplied it is the production resolver: it wins in any packaged build
   * and in a dev build with the fixture flag absent. The dev fixture
   * (`POS_PULSE_DEV_ITEM_RESOLVER` + unpackaged) still takes precedence so 005's
   * dev workflow is unchanged. When omitted (e.g. 005's own tests, or before
   * 009 ships), the handler falls back to `DEFAULT_ITEM_REF_RESOLVER` (refuses
   * generically) — the prior behaviour.
   */
  productionResolver?: ItemRefResolver;
  /**
   * Post-handoff cancel guard (`bindCartPaymentGuard`): true while the cart
   * has a started or settled payment attempt. Required so production can
   * never cancel a paid or paying sale through `cart.cancelPostHandoff`.
   */
  hasPaymentForCart: (cart_id: string) => boolean;
}

/**
 * Returns `true` only when the `POS_PULSE_DEV_ITEM_RESOLVER` env variable
 * is explicitly set to a truthy value.  Mirrors the truthy-value list used
 * by the T001 cart feature flag so operator behaviour is consistent.
 */
function isDevResolverEnvSet(): boolean {
  const raw = process.env['POS_PULSE_DEV_ITEM_RESOLVER'];
  return typeof raw === 'string' && ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Production factory for `CartBridgeHandlers`.
 *
 * Wires the DB-backed `CartStore` from `dbHandle`.
 *
 * `resolveItemRef` is wired to the T053 fixture resolver ONLY when both
 * conditions hold:
 *   1. `deps.isPackaged` is `false` (dev / CI build), AND
 *   2. `POS_PULSE_DEV_ITEM_RESOLVER` is truthy in the environment.
 *
 * In all other cases (any packaged build, or env flag absent/falsy) the dep
 * is omitted and `CartBridgeHandlers` falls back to `DEFAULT_ITEM_REF_RESOLVER`
 * which refuses generically — the correct production behaviour until the real
 * item-catalogue feature ships (R7 seam / future feature).
 *
 * SECURITY: `deps.isPackaged === true` short-circuits unconditionally; ops
 * cannot enable fixture data in a packaged build by exporting the env var.
 */
export function createCartBridgeHandlers(deps: CartHandlersDeps): CartBridgeHandlers {
  const useFixtureResolver = !deps.isPackaged && isDevResolverEnvSet();

  // Precedence (additive — preserves 005's dev behaviour exactly):
  //   dev + fixture flag  → fixture resolver (the dev escape hatch; never in a
  //                         packaged build — `!isPackaged` guards it)
  //   otherwise           → 009's production resolver when supplied; else the
  //                         dep is omitted and CartBridgeHandlers falls back to
  //                         DEFAULT_ITEM_REF_RESOLVER (refuses generically).
  const resolveItemRef = useFixtureResolver ? fixtureResolver : deps.productionResolver;

  const baseDeps = {
    getCurrentSession: deps.getCurrentSession,
    getTerminalId: deps.getTerminalId,
    cartStore: bindCartStore(deps.dbHandle),
    logger: deps.logger,
    auditEmitter: deps.auditEmitter,
    hasPaymentForCart: deps.hasPaymentForCart,
  };

  // Only attach `resolveItemRef` when one was resolved — omitting it lets
  // CartBridgeHandlers apply its DEFAULT_ITEM_REF_RESOLVER fallback
  // (`exactOptionalPropertyTypes`: never set the key to `undefined`).
  return new CartBridgeHandlers(
    resolveItemRef !== undefined ? { ...baseDeps, resolveItemRef } : baseDeps,
  );
}
