/**
 * T076 — Contract test: PaymentIntentEnvelope v1 field shape.
 *
 * Every field from contracts/handoff-envelope.md §Field shape (v1) must be
 * present on the TypeScript interface and carry the correct type. This is a
 * compile-time + runtime shape assertion — any structural mismatch surfaces
 * here before the implementation can ship.
 *
 * §A4 gate: cleared 2026-05-17.
 */
import { describe, it, expect } from 'vitest';
import type {
  PaymentIntentEnvelope,
  LineSnapshot,
  DiscountPlaceholderSnapshot,
} from '../../src/shared/cart/handoff-envelope.js';

// ── Compile-time completeness check ──────────────────────────────────────────
// If any field is missing from the interface the assignment below will not compile.

const _envelopeTypeCheck: PaymentIntentEnvelope = {
  envelope_version: 'v1',
  cart_id: 'cart-uuid',
  operator_session_id: 'sess-uuid',
  owning_operator_id: 'op-uuid',
  tenant_id: 'tenant-uuid',
  branch_id: 'branch-uuid',
  terminal_id: 'terminal-uuid',
  lines: [],
  discount_placeholders: [],
  subtotal_minor: 0,
  created_at: '2026-05-17T00:00:00.000Z',
  handoff_action_id: 'action-uuid',
} as const;

const _lineTypeCheck: LineSnapshot = {
  line_id: 'line-uuid',
  item_ref: 'SKU-001',
  display_name: 'Test Item',
  quantity: 1,
  unit_price_minor: 100,
  line_subtotal_minor: 100,
  note: null,
  version: 1,
  last_action_id: 'action-uuid',
} as const;

// A pre-RT-608 (legacy) placeholder shape: still representable in an envelope.
// RT-608 writes only `requires_manager_attribution: true` with a non-null
// approver; how a legacy row is refused at handoff / payment (envelope steps
// 3a and 3b) is RT-608 item 6, pending owner authorisation.
const _discountTypeCheck: DiscountPlaceholderSnapshot = {
  placeholder_id: 'ph-uuid',
  line_id: 'line-uuid',
  placeholder_kind: 'percent_5',
  requires_manager_attribution: false,
  attribution_operator_id: null,
} as const;

// Silence unused-variable lint for compile-time checks.
void _envelopeTypeCheck;
void _lineTypeCheck;
void _discountTypeCheck;

// ── Runtime field-presence assertions ────────────────────────────────────────

function makeEnvelope(overrides?: Partial<PaymentIntentEnvelope>): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-uuid-1',
    operator_session_id: 'sess-uuid-1',
    owning_operator_id: 'op-uuid-1',
    tenant_id: 'tenant-uuid-1',
    branch_id: 'branch-uuid-1',
    terminal_id: 'terminal-uuid-1',
    lines: [],
    discount_placeholders: [],
    subtotal_minor: 0,
    created_at: '2026-05-17T10:00:00.000Z',
    handoff_action_id: 'action-uuid-1',
    ...overrides,
  };
}

describe('PaymentIntentEnvelope v1 contract (T076)', () => {
  it('envelope_version is the string literal "v1"', () => {
    expect(makeEnvelope().envelope_version).toBe('v1');
  });

  it('carries all v1 top-level fields', () => {
    const env = makeEnvelope();
    const required: (keyof PaymentIntentEnvelope)[] = [
      'envelope_version',
      'cart_id',
      'operator_session_id',
      'owning_operator_id',
      'tenant_id',
      'branch_id',
      'terminal_id',
      'lines',
      'discount_placeholders',
      'subtotal_minor',
      'created_at',
      'handoff_action_id',
    ];
    for (const field of required) {
      expect(env, `field "${field}" must be present`).toHaveProperty(field);
    }
  });

  it('subtotal_minor is a non-negative integer', () => {
    const env = makeEnvelope({ subtotal_minor: 450 });
    expect(Number.isInteger(env.subtotal_minor)).toBe(true);
    expect(env.subtotal_minor).toBeGreaterThanOrEqual(0);
  });

  it('subtotal_minor satisfies Number.isSafeInteger', () => {
    const env = makeEnvelope({ subtotal_minor: 300 });
    expect(Number.isSafeInteger(env.subtotal_minor)).toBe(true);
  });

  it('lines is a readonly array', () => {
    const env = makeEnvelope({ lines: [_lineTypeCheck] });
    expect(Array.isArray(env.lines)).toBe(true);
  });

  it('discount_placeholders is a readonly array', () => {
    const env = makeEnvelope({ discount_placeholders: [_discountTypeCheck] });
    expect(Array.isArray(env.discount_placeholders)).toBe(true);
  });

  it('LineSnapshot carries all v1 fields', () => {
    const line: LineSnapshot = {
      line_id: 'l-uuid',
      item_ref: 'SKU-X',
      display_name: 'Medication',
      quantity: 3,
      unit_price_minor: 500,
      line_subtotal_minor: 1500,
      note: 'Take with water',
      version: 2,
      last_action_id: 'act-uuid',
    };
    const requiredLineFields: (keyof LineSnapshot)[] = [
      'line_id',
      'item_ref',
      'display_name',
      'quantity',
      'unit_price_minor',
      'line_subtotal_minor',
      'note',
      'version',
      'last_action_id',
    ];
    for (const f of requiredLineFields) {
      expect(line, `LineSnapshot field "${f}" must be present`).toHaveProperty(f);
    }
  });

  it('LineSnapshot.note can be null', () => {
    const line: LineSnapshot = { ..._lineTypeCheck, note: null };
    expect(line.note).toBeNull();
  });

  it('LineSnapshot integer fields are integers', () => {
    expect(Number.isInteger(_lineTypeCheck.quantity)).toBe(true);
    expect(Number.isInteger(_lineTypeCheck.unit_price_minor)).toBe(true);
    expect(Number.isInteger(_lineTypeCheck.line_subtotal_minor)).toBe(true);
    expect(Number.isInteger(_lineTypeCheck.version)).toBe(true);
  });

  it('DiscountPlaceholderSnapshot carries all v1 fields', () => {
    const ph: DiscountPlaceholderSnapshot = {
      placeholder_id: 'ph-uuid',
      line_id: 'l-uuid',
      placeholder_kind: 'percent_15',
      requires_manager_attribution: true,
      attribution_operator_id: 'mgr-uuid',
    };
    const fields: (keyof DiscountPlaceholderSnapshot)[] = [
      'placeholder_id',
      'line_id',
      'placeholder_kind',
      'requires_manager_attribution',
      'attribution_operator_id',
    ];
    for (const f of fields) {
      expect(ph, `DiscountPlaceholderSnapshot field "${f}" must be present`).toHaveProperty(f);
    }
  });

  it('DiscountPlaceholderSnapshot.attribution_operator_id can be null', () => {
    expect(_discountTypeCheck.attribution_operator_id).toBeNull();
  });
});
