/**
 * RT-608 (RT-28, spec 005 FR-023 revised) — the `subject_ref` a cashier's
 * `approval.request` carries for action kind `cart.discount.manual`.
 *
 * The manager approves ONE discount: this cart, this line, this
 * `placeholder_kind`. All three are in the ref, so an approval for one line or
 * kind can never be spent on another (MA-2 consume compares the ref exactly).
 * The line's version and the cart's scope are bound main-side by the resolver
 * (`src/main/cart/discount-approval.ts`), never by the renderer.
 *
 * Format: `<cart_id>_<line_id>_<placeholder_kind>`. Cart and line ids are
 * UUIDs (no `_`); the kind may contain `_`. It fits MA-2's bridge pattern
 * (`[A-Za-z0-9_-]{1,128}`); a kind outside that alphabet cannot be approved,
 * so the add fails closed.
 */
export interface DiscountApprovalIntent {
  readonly cart_id: string;
  readonly line_id: string;
  readonly placeholder_kind: string;
}

const SEPARATOR = '_';

export function discountApprovalSubjectRef(intent: DiscountApprovalIntent): string {
  return [intent.cart_id, intent.line_id, intent.placeholder_kind].join(SEPARATOR);
}

/** The intent a ref names, or null when it is not a well-formed discount ref. */
export function parseDiscountApprovalSubjectRef(ref: string): DiscountApprovalIntent | null {
  const [cart_id = '', line_id = '', ...kindParts] = ref.split(SEPARATOR);
  const placeholder_kind = kindParts.join(SEPARATOR);
  if ([cart_id, line_id, placeholder_kind].includes('')) return null;
  return { cart_id, line_id, placeholder_kind };
}
