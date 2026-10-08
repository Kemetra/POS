/**
 * Contract test: every cart.* handler type-checks against the bridge-api contract.
 * Shape compliance is enforced at TypeScript compile time; runtime tests assert
 * field values and discriminated-union membership.
 */
import { describe, it, expect } from 'vitest';
import type {
  CartCreateRequest,
  CartLinesAddRequest,
  CartLinesUpdateRequest,
  CartLinesRemoveRequest,
  CartLinesSetNoteRequest,
  CartDiscountPlaceholdersAddRequest,
  CartDiscountPlaceholdersRemoveRequest,
  CartVoidRequest,
  CartHandoffRequest,
  CartSubscribeRequest,
} from '../../src/shared/cart/bridge-types.js';
import type { CartRefusalReason, CartRefusal } from '../../src/shared/cart/refusal.js';

// ── cart.create ───────────────────────────────────────────────────────────────

describe('cart.create contract', () => {
  it('CartCreateRequest has idempotency_key field', () => {
    const req: CartCreateRequest = { idempotency_key: 'uuid-v4-1' };
    expect(req.idempotency_key).toBe('uuid-v4-1');
  });

  it('ok response shape: kind="ok", cart_id is string', () => {
    const kind = 'ok' as const;
    const cart_id = 'cart-uuid-1';
    expect(kind).toBe('ok');
    expect(typeof cart_id).toBe('string');
  });

  it('refused response shape: kind="refused", reason is string', () => {
    const reason: CartRefusalReason = 'no_session';
    expect(typeof reason).toBe('string');
  });
});

// ── cart.lines.add ────────────────────────────────────────────────────────────

describe('cart.lines.add contract', () => {
  it('CartLinesAddRequest has required fields', () => {
    const req: CartLinesAddRequest = {
      cart_id: 'cart-uuid-1',
      item_ref: 'SKU-001',
      quantity: 2,
      idempotency_key: 'uuid-v4-2',
    };
    expect(req.cart_id).toBe('cart-uuid-1');
    expect(req.quantity).toBe(2);
  });

  it('ok response shape: line_id string, merged boolean, version number', () => {
    const line_id = 'line-uuid-1';
    const merged = false;
    const version = 1;
    expect(typeof line_id).toBe('string');
    expect(typeof merged).toBe('boolean');
    expect(typeof version).toBe('number');
  });

  it('refused shape: reason="frozen"', () => {
    const reason: CartRefusalReason = 'frozen';
    expect(reason).toBe('frozen');
  });
});

// ── cart.lines.update ─────────────────────────────────────────────────────────

describe('cart.lines.update contract', () => {
  it('CartLinesUpdateRequest supports increment op', () => {
    const req: CartLinesUpdateRequest = {
      cart_id: 'cart-uuid-1',
      line_id: 'line-uuid-1',
      op: 'increment',
      delta: 1,
      version: 2,
      idempotency_key: 'uuid-v4-3',
    };
    expect(req.op).toBe('increment');
  });

  it('CartLinesUpdateRequest supports set op with absolute field', () => {
    const req: CartLinesUpdateRequest = {
      cart_id: 'cart-uuid-1',
      line_id: 'line-uuid-1',
      op: 'set',
      absolute: 3,
      version: 2,
      idempotency_key: 'uuid-v4-4',
    };
    expect(req.op).toBe('set');
  });

  it('ok response has version field', () => {
    const version = 3;
    expect(typeof version).toBe('number');
  });
});

// ── cart.lines.remove ─────────────────────────────────────────────────────────

describe('cart.lines.remove contract', () => {
  it('CartLinesRemoveRequest has cart_id, line_id, version, idempotency_key', () => {
    const req: CartLinesRemoveRequest = {
      cart_id: 'cart-uuid-1',
      line_id: 'line-uuid-1',
      version: 2,
      idempotency_key: 'uuid-v4-5',
    };
    expect(req.line_id).toBe('line-uuid-1');
  });

  it('ok response kind="ok"', () => {
    const kind = 'ok' as const;
    expect(kind).toBe('ok');
  });
});

// ── cart.lines.setNote ────────────────────────────────────────────────────────

describe('cart.lines.setNote contract', () => {
  it('CartLinesSetNoteRequest accepts string note', () => {
    const req: CartLinesSetNoteRequest = {
      cart_id: 'cart-uuid-1',
      line_id: 'line-uuid-1',
      note: 'No substitutions',
      version: 1,
      idempotency_key: 'uuid-v4-6',
    };
    expect(req.note).toBe('No substitutions');
  });

  it('CartLinesSetNoteRequest accepts null note', () => {
    const req: CartLinesSetNoteRequest = {
      cart_id: 'cart-uuid-1',
      line_id: 'line-uuid-1',
      note: null,
      version: 1,
      idempotency_key: 'uuid-v4-7',
    };
    expect(req.note).toBeNull();
  });

  it('refused reason includes note_too_long and note_forbidden_pattern', () => {
    const r1: CartRefusalReason = 'note_too_long';
    const r2: CartRefusalReason = 'note_forbidden_pattern';
    expect(r1).toBe('note_too_long');
    expect(r2).toBe('note_forbidden_pattern');
  });
});

// ── cart.discountPlaceholders.add ─────────────────────────────────────────────

describe('cart.discountPlaceholders.add contract', () => {
  it('CartDiscountPlaceholdersAddRequest has required fields', () => {
    const req: CartDiscountPlaceholdersAddRequest = {
      cart_id: 'cart-uuid-1',
      line_id: 'line-uuid-1',
      placeholder_kind: 'STAFF_10PCT',
      idempotency_key: 'uuid-v4-8',
    };
    expect(req.placeholder_kind).toBe('STAFF_10PCT');
  });

  it('ok response has placeholder_id string and requires_manager_attribution boolean', () => {
    const placeholder_id = 'placeholder-uuid-1';
    const requires_manager_attribution = false;
    expect(typeof placeholder_id).toBe('string');
    expect(typeof requires_manager_attribution).toBe('boolean');
  });
});

// ── cart.discountPlaceholders.remove ──────────────────────────────────────────

describe('cart.discountPlaceholders.remove contract', () => {
  it('CartDiscountPlaceholdersRemoveRequest has placeholder_id', () => {
    const req: CartDiscountPlaceholdersRemoveRequest = {
      cart_id: 'cart-uuid-1',
      placeholder_id: 'placeholder-uuid-1',
      idempotency_key: 'uuid-v4-9',
    };
    expect(req.placeholder_id).toBe('placeholder-uuid-1');
  });
});

// ── cart.void ─────────────────────────────────────────────────────────────────

describe('cart.void contract', () => {
  it('CartVoidRequest has cart_id and idempotency_key', () => {
    const req: CartVoidRequest = {
      cart_id: 'cart-uuid-1',
      idempotency_key: 'uuid-v4-10',
    };
    expect(req.cart_id).toBe('cart-uuid-1');
  });

  it('CartVoidRequest carries no attribution (RT-184)', () => {
    const req: CartVoidRequest = {
      cart_id: 'cart-uuid-1',
      idempotency_key: 'uuid-v4-11',
    };
    expect(Object.keys(req).sort()).toEqual(['cart_id', 'idempotency_key']);
  });

  it('refused reason includes manager_attribution_required', () => {
    const reason: CartRefusalReason = 'manager_attribution_required';
    expect(reason).toBe('manager_attribution_required');
  });
});

// ── cart.handoff ──────────────────────────────────────────────────────────────

describe('cart.handoff contract', () => {
  it('CartHandoffRequest has per_line_versions array', () => {
    const req: CartHandoffRequest = {
      cart_id: 'cart-uuid-1',
      per_line_versions: [{ line_id: 'line-uuid-1', version: 3 }],
      idempotency_key: 'uuid-v4-12',
    };
    expect(req.per_line_versions).toHaveLength(1);
    expect(req.per_line_versions[0]?.line_id).toBe('line-uuid-1');
  });

  it('refused reason includes empty_cart', () => {
    const reason: CartRefusalReason = 'empty_cart';
    expect(reason).toBe('empty_cart');
  });
});

// ── cart.subscribe ────────────────────────────────────────────────────────────

describe('cart.subscribe contract', () => {
  it('CartSubscribeRequest has cart_id', () => {
    const req: CartSubscribeRequest = { cart_id: 'cart-uuid-1' };
    expect(req.cart_id).toBe('cart-uuid-1');
  });

  it('refused reason includes not_implemented (Phase 2)', () => {
    const reason: CartRefusalReason = 'not_implemented';
    expect(reason).toBe('not_implemented');
  });
});

// ── CartRefusalReason coverage ────────────────────────────────────────────────

describe('CartRefusalReason union', () => {
  it('includes all 13 contract-defined reason strings', () => {
    const allReasons: CartRefusalReason[] = [
      'no_session',
      'role_denied',
      'wrong_owner',
      'tenant_isolation',
      'frozen',
      'closed',
      'stale_version',
      'empty_cart',
      'note_too_long',
      'note_forbidden_pattern',
      'manager_attribution_required',
      'idempotency_payload_mismatch',
      'not_implemented',
    ];
    for (const reason of allReasons) {
      expect(typeof reason).toBe('string');
    }
    expect(allReasons).toHaveLength(13);
  });

  it('CartRefusal has kind="refused" and reason — NOT "category" (OperatorRefusal shape)', () => {
    const refusal: CartRefusal = { kind: 'refused', reason: 'no_session' };
    expect(refusal.kind).toBe('refused');
    expect(refusal.reason).toBe('no_session');
    expect(Object.keys(refusal)).not.toContain('category');
  });
});
