import { useCallback, useEffect, useRef, useState } from 'react';

import type { CartBridgeAPI, PreloadBridgeAPI } from '../../shared/bridge-api';
import { CartState } from '../../shared/cart/cart-state';
import { useCartStore } from '../stores/cart-store';
import { usePaymentStore } from '../stores/payment-store';

/**
 * RT-26 — Checkout Back / Esc to the active sale.
 *
 * Main is the authority: this asks `cart.returnToSale` and changes renderer
 * state ONLY after main confirms. On `ok` the payment store is reset (the old
 * envelope and any attempt projection are gone — main already invalidated
 * them), the renderer cart mirrors `frozen_handed_off → editing`, and
 * `onReturned` navigates to the Sale, which re-reads the authoritative cart
 * snapshot. A refusal or a transport failure changes nothing and resolves
 * `false`, so the cashier stays in the payment flow.
 *
 * The idempotency key is reused for retries of the SAME handoff: if main
 * applied the Back but the response was lost, the retry replays `ok` instead
 * of being refused as stale.
 */
export interface CheckoutBackToSaleOptions {
  /** Test seam; production reads `window.api.cart` at call time. */
  readonly bridge?: CartBridgeAPI;
  /** Called after main confirmed the return and the stores were updated. */
  readonly onReturned: () => void;
}

function readCartBridge(): CartBridgeAPI | null {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  return api?.cart ?? null;
}

type ActiveCart = ReturnType<typeof useCartStore.getState>['activeCart'];
type MountedEnvelope = NonNullable<ReturnType<typeof usePaymentStore.getState>['envelope']>;
type ReturnToSaleResult = Awaited<ReturnType<NonNullable<CartBridgeAPI['returnToSale']>>>;
type ReturnToSale = (
  req: Parameters<NonNullable<CartBridgeAPI['returnToSale']>>[0],
) => Promise<ReturnToSaleResult | null>;

/** Fail closed: only the cart the renderer holds, frozen on this envelope. */
function isFrozenOnEnvelope(cart: ActiveCart, envelope: MountedEnvelope): boolean {
  return cart?.cart_id === envelope.cart_id && cart.state === CartState.frozen_handed_off;
}

/** The envelope Back may leave, or null when the renderer state does not allow it. */
function returnableEnvelope(): MountedEnvelope | null {
  const envelope = usePaymentStore.getState().envelope;
  if (envelope === null) return null;
  return isFrozenOnEnvelope(useCartStore.getState().activeCart, envelope) ? envelope : null;
}

/** The bridge's `returnToSale` (called as a method), or null when it is not wired. */
function resolveReturnToSale(bridge: CartBridgeAPI | undefined): ReturnToSale | null {
  const cartBridge = bridge ?? readCartBridge();
  if (cartBridge?.returnToSale === undefined) return null;
  return (req) => cartBridge.returnToSale?.(req) ?? Promise.resolve(null);
}

interface HandoffKey {
  readonly handoff_action_id: string;
  readonly key: string;
}

/** Reuse the key for the same handoff (a retry replays); a new handoff gets a new key. */
function keyForHandoff(current: HandoffKey | null, handoff_action_id: string): HandoffKey {
  return current?.handoff_action_id === handoff_action_id
    ? current
    : { handoff_action_id, key: crypto.randomUUID() };
}

/** Ask main; a refusal or a transport failure is `false`. */
async function requestReturn(
  returnToSale: ReturnToSale,
  envelope: MountedEnvelope,
  idempotency_key: string,
): Promise<boolean> {
  const res = await returnToSale({
    cart_id: envelope.cart_id,
    handoff_action_id: envelope.handoff_action_id,
    idempotency_key,
  }).catch(() => null);
  return res?.kind === 'ok';
}

/** After main's `ok`: mirror the cart edge and drop the old envelope + attempt. */
function applyReturned(cart_id: string): void {
  useCartStore.getState().applyReturnedToSale(cart_id);
  // Only if the payment store still belongs to the cart that returned.
  if (usePaymentStore.getState().envelope?.cart_id === cart_id) {
    usePaymentStore.getState().reset();
  }
}

export function useCheckoutBackToSale(options: CheckoutBackToSaleOptions): () => Promise<boolean> {
  const { bridge, onReturned } = options;
  const keyRef = useRef<HandoffKey | null>(null);

  return useCallback(async (): Promise<boolean> => {
    const envelope = returnableEnvelope();
    const returnToSale = resolveReturnToSale(bridge);
    if (envelope === null || returnToSale === null) return false;

    keyRef.current = keyForHandoff(keyRef.current, envelope.handoff_action_id);
    if (!(await requestReturn(returnToSale, envelope, keyRef.current.key))) return false;

    applyReturned(envelope.cart_id);
    onReturned();
    return true;
  }, [bridge, onReturned]);
}

// ── Eligibility (read-only) ───────────────────────────────────────────────

/**
 * What Checkout may show for Back, per mounted handoff:
 *   - `returnable` — main confirmed the payments record allows a Back;
 *   - `blocked`    — main says no (tender history, settled / force-failed, …);
 *   - `unknown`    — not asked yet, or main could not answer. Back stays
 *                    disabled: the renderer never assumes eligibility.
 */
export type BackToSaleEligibility = 'unknown' | 'returnable' | 'blocked';

type EligibilityQuery = (req: {
  cart_id: string;
  handoff_action_id: string;
}) => Promise<Awaited<ReturnType<NonNullable<CartBridgeAPI['returnToSaleEligibility']>>> | null>;

/** The bridge's `returnToSaleEligibility` (called as a method), or null when not wired. */
function resolveEligibilityQuery(bridge: CartBridgeAPI | undefined): EligibilityQuery | null {
  const cartBridge = bridge ?? readCartBridge();
  if (cartBridge?.returnToSaleEligibility === undefined) return null;
  return (req) => cartBridge.returnToSaleEligibility?.(req) ?? Promise.resolve(null);
}

/** Ask main once; a refusal or a transport failure stays `unknown` (fail closed). */
async function queryEligibility(
  query: EligibilityQuery,
  cart_id: string,
  handoff_action_id: string,
): Promise<BackToSaleEligibility> {
  const res = await query({ cart_id, handoff_action_id }).catch(() => null);
  if (res?.kind !== 'ok') return 'unknown';
  return res.returnable ? 'returnable' : 'blocked';
}

interface EligibilityRequest {
  readonly cart_id: string;
  readonly handoff_action_id: string;
}

/** An eligibility answer, tagged with the handoff it was read for. */
interface EligibilityResult {
  readonly handoff: string;
  readonly value: BackToSaleEligibility;
}

const selectCartId = (s: ReturnType<typeof usePaymentStore.getState>): string | null =>
  s.envelope?.cart_id ?? null;
const selectHandoffId = (s: ReturnType<typeof usePaymentStore.getState>): string | null =>
  s.envelope?.handoff_action_id ?? null;

/** The request for the mounted envelope, or null when none is mounted. */
function eligibilityRequest(
  cart_id: string | null,
  handoff_action_id: string | null,
): EligibilityRequest | null {
  if (cart_id === null) return null;
  return handoff_action_id === null ? null : { cart_id, handoff_action_id };
}

/** Only an answer for the CURRENT handoff counts; anything else is `unknown`. */
function currentEligibility(
  result: EligibilityResult | null,
  handoffId: string | null,
): BackToSaleEligibility {
  return result?.handoff === handoffId ? result.value : 'unknown';
}

/**
 * Ask main for one handoff and report the answer unless cancelled. Returns the
 * effect cleanup (or undefined when there is nothing to ask).
 */
function startEligibilityRead(
  bridge: CartBridgeAPI | undefined,
  req: EligibilityRequest | null,
  onResult: (result: EligibilityResult) => void,
): (() => void) | undefined {
  const query = resolveEligibilityQuery(bridge);
  if (req === null || query === null) return undefined;
  let cancelled = false;
  void queryEligibility(query, req.cart_id, req.handoff_action_id).then((value) => {
    if (!cancelled) onResult({ handoff: req.handoff_action_id, value });
  });
  return () => {
    cancelled = true;
  };
}

/**
 * RT-26 — main's durable answer to "may this handoff go Back?", read once per
 * mounted envelope. Tender history is monotonic (it never disappears for a
 * cart), so one read per handoff plus the surface's live in-mount signals is
 * enough; a remount re-reads instead of trusting lost component state.
 */
export function useBackToSaleEligibility(bridge?: CartBridgeAPI): BackToSaleEligibility {
  const cartId = usePaymentStore(selectCartId);
  const handoffId = usePaymentStore(selectHandoffId);
  const [result, setResult] = useState<EligibilityResult | null>(null);

  useEffect(
    () => startEligibilityRead(bridge, eligibilityRequest(cartId, handoffId), setResult),
    [bridge, cartId, handoffId],
  );

  return currentEligibility(result, handoffId);
}
