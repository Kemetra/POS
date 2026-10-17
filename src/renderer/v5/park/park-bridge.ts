import type { CartBridgeAPI, PreloadBridgeAPI } from '../../../shared/bridge-api';
import type { CartParkBridgeAPI } from '../../../shared/cart/park-types';

/**
 * RT-445 — the renderer's only way to the PK-2 park bridge
 * (`api.cart.parked.{park, listParked, previewResume, resume}`, RT-440).
 * Main is authoritative: the renderer names ids, its choice and a key, never
 * an owner, a price or a total.
 */

/** `window.api.cart`, or null outside the preload (a test without a bridge). */
export function windowCartBridge(): CartBridgeAPI | null {
  const api = (window as unknown as { api?: Partial<PreloadBridgeAPI> }).api;
  return api?.cart ?? null;
}

/** The park namespace of a cart bridge, or null when this build has none. */
export function parkBridgeOf(cart: CartBridgeAPI | null | undefined): CartParkBridgeAPI | null {
  return cart?.parked ?? null;
}

/**
 * A rejected call (transport, a missing handler). It is not a refusal from
 * main, so it carries no reason; the UI answers it with the generic line (OD-9).
 */
export interface ParkUnreachable {
  readonly kind: 'unreachable';
}

const UNREACHABLE: ParkUnreachable = { kind: 'unreachable' };

export async function callPark<T>(call: () => Promise<T>): Promise<T | ParkUnreachable> {
  try {
    return await call();
  } catch {
    return UNREACHABLE;
  }
}

/** A fresh idempotency key (the renderer runs in a secure context). */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
