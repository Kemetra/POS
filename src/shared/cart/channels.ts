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
} as const;

export type CartIpcChannel = (typeof CART_IPC_CHANNELS)[keyof typeof CART_IPC_CHANNELS];
