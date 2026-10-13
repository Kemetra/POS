export const CART_IPC_CHANNELS = {
  CREATE: 'cart:create',
  LINES_ADD: 'cart:lines:add',
  LINES_UPDATE: 'cart:lines:update',
  LINES_REMOVE: 'cart:lines:remove',
  LINES_SET_NOTE: 'cart:lines:setNote',
  DISCOUNT_PLACEHOLDERS_ADD: 'cart:discountPlaceholders:add',
  DISCOUNT_PLACEHOLDERS_REMOVE: 'cart:discountPlaceholders:remove',
  VOID: 'cart:void',
  HANDOFF: 'cart:handoff',
  SUBSCRIBE: 'cart:subscribe',
  /** V5 active cart read — read-only, session-gated snapshot of a known cart. */
  SNAPSHOT: 'cart:snapshot',
  /** Audited cancel of a `frozen_handed_off` cart (`cart.void` refuses `frozen`). */
  CANCEL_POST_HANDOFF: 'cart:cancelPostHandoff',
  /**
   * RT-26 — Checkout Back/Esc: return a `frozen_handed_off` cart to `editing`
   * while no money or external payment activity exists for it. Main-guarded.
   */
  RETURN_TO_SALE: 'cart:returnToSale',
  /**
   * RT-26 — read-only: would main allow a Back for this cart and handoff right
   * now? Same proof as `cart:returnToSale`, never writes. Lets Checkout keep
   * Back disabled after a remount when tender history exists.
   */
  RETURN_TO_SALE_ELIGIBILITY: 'cart:returnToSaleEligibility',
  /**
   * RT-254 — main-authoritative Undo of the cart's last action (RT-245
   * contract). Main chooses the inverse; the renderer names only the target.
   */
  UNDO_LAST: 'cart:undoLast',
} as const;

/**
 * RT-440 (PK-2, spec 024 §3) — Park v1, registered by `ipc/cart-park.ts`. All
 * four are `cart:*`, so the central guards cover them: refused while the
 * session is locked, refused in recovery mode, re-checked at the sale boundary.
 */
export const CART_PARK_IPC_CHANNELS = {
  PARK: 'cart:park',
  LIST_PARKED: 'cart:listParked',
  PREVIEW_RESUME: 'cart:previewResume',
  RESUME: 'cart:resume',
} as const;

export type CartIpcChannel = (typeof CART_IPC_CHANNELS)[keyof typeof CART_IPC_CHANNELS];
