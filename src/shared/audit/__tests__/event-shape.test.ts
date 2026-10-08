import { describe, it, expect } from 'vitest';

import {
  AUDIT_ACTION_CATEGORIES,
  FR025_MANDATORY_ATTRIBUTES,
  OperatorRefusalError,
  REFUSAL_CATEGORIES,
  SYSTEM_DEVICE_ACTOR_ID,
  isOperatorRefusal,
  type AuditEvent,
} from '../event-shape.js';

/**
 * 004-operator-session T007 — AuditEvent shape with FR-025 mandatory
 * five attributes + the OperatorRefusal envelope.
 *
 * S1 carries this only as a type-only contract; the durable emitter
 * (T046) lands in S3 under §A1 / §A3. Establishing the contract here
 * keeps S3's emitter surgical when it arrives.
 */

describe('audit/event-shape (T007 — FR-025)', () => {
  it('exposes the five FR-025 mandatory attributes', () => {
    expect(FR025_MANDATORY_ATTRIBUTES).toContain('acting_operator_id');
    expect(FR025_MANDATORY_ATTRIBUTES).toContain('originating_terminal_id');
    expect(FR025_MANDATORY_ATTRIBUTES).toContain('created_at');
    expect(FR025_MANDATORY_ATTRIBUTES).toContain('action_category');
    expect(FR025_MANDATORY_ATTRIBUTES).toContain('shift_id');
  });

  it('AuditEvent type accepts a well-formed record', () => {
    // Type-only assertion: this compiles iff AuditEvent matches the
    // contract. The runtime expectations are trivially true; the test
    // is here to make the contract explicit and load-bearing.
    const record: AuditEvent = {
      event_id: '00000000-0000-4000-8000-000000000000',
      tenant_id: 't1',
      branch_id: 'b1',
      originating_terminal_id: 'term-A',
      acting_operator_id: 'op-1',
      session_id: 'sess-1',
      shift_id: null,
      action_category: 'operator.session.takeover',
      created_at: '2026-05-06T00:00:00.000Z',
      approving_supervisor_id: null,
      payload: { stable: true },
    };
    expect(record.action_category).toBe('operator.session.takeover');
  });

  it('action-category catalogue includes the 004-owned categories', () => {
    expect(AUDIT_ACTION_CATEGORIES).toContain('shift.forced_close');
    expect(AUDIT_ACTION_CATEGORIES).toContain('operator.session.takeover');
    expect(AUDIT_ACTION_CATEGORIES).toContain('cashier.pin.reset');
    expect(AUDIT_ACTION_CATEGORIES).toContain('cashier.pin.unlock');
  });

  it('action-category catalogue includes the 4 cart §A3 categories (FR-026 / Q5)', () => {
    expect(AUDIT_ACTION_CATEGORIES).toContain('cart.handoff_to_payment');
    expect(AUDIT_ACTION_CATEGORIES).toContain('cart.cancel.post_handoff');
    expect(AUDIT_ACTION_CATEGORIES).toContain('cart.discount.above_threshold');
    expect(AUDIT_ACTION_CATEGORIES).toContain('cart.discarded_on_session_end');
  });

  it('AuditEvent type accepts a cart category record (compile-time gate)', () => {
    const record: AuditEvent = {
      event_id: '00000000-0000-4000-8000-000000000005',
      tenant_id: 't1',
      branch_id: 'b1',
      originating_terminal_id: 'term-A',
      acting_operator_id: 'clerk-cashier-9',
      session_id: 'sess-9',
      shift_id: 'shift-9',
      action_category: 'cart.handoff_to_payment',
      created_at: '2026-05-15T00:00:00.000Z',
      approving_supervisor_id: null,
      payload: { cart_id: 'cart-9', handoff_action_id: 'ha-9', line_count: 1, subtotal_minor: 100 },
    };
    expect(record.action_category).toBe('cart.handoff_to_payment');
  });
});

describe('audit/event-shape — OperatorRefusal envelope (NFR-003 / PR-2)', () => {
  it('REFUSAL_CATEGORIES is the closed set the renderer maps generically', () => {
    expect(REFUSAL_CATEGORIES).toEqual([
      'invalid_input',
      'no_connection',
      'rate_limited',
      'role_mismatch',
      'not_signed_in',
      'state_invalid',
      // 019-cashier-pin-provisioning FR-11 — truthful "cannot provision yet" state.
      'not_ready',
    ]);
  });

  it('isOperatorRefusal accepts the canonical envelope', () => {
    expect(isOperatorRefusal({ kind: 'refused', category: 'invalid_input' })).toBe(true);
    expect(isOperatorRefusal({ kind: 'refused', category: 'role_mismatch' })).toBe(true);
  });

  it('isOperatorRefusal rejects shapes that do not match', () => {
    expect(isOperatorRefusal(null)).toBe(false);
    expect(isOperatorRefusal(undefined)).toBe(false);
    expect(isOperatorRefusal({})).toBe(false);
    expect(isOperatorRefusal({ kind: 'success' })).toBe(false);
    expect(isOperatorRefusal({ kind: 'refused', category: 'unknown' })).toBe(false);
    expect(isOperatorRefusal({ kind: 'refused' })).toBe(false);
  });

  it('OperatorRefusalError carries the category and a payload-free message', () => {
    const err = new OperatorRefusalError('role_mismatch');
    expect(err).toBeInstanceOf(Error);
    expect(err.category).toBe('role_mismatch');
    expect(err.name).toBe('OperatorRefusalError');
    // Message MUST NOT echo any caller-supplied data; the only dynamic
    // bit is the closed-set category itself.
    expect(err.message).toBe('operator refusal: role_mismatch');
  });
});

describe('RT-215 — SYSTEM_DEVICE_ACTOR_ID (Jira RT-215 comment 10879, branch 2)', () => {
  /** Real operator ids: a provider subject (Clerk `user_<base62>`) or a `users.id` UUID. */
  const CLERK_SUBJECT = /^user_[A-Za-z0-9]+$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('is the reserved literal system:device', () => {
    expect(SYSTEM_DEVICE_ACTOR_ID).toBe('system:device');
  });

  it('can never collide with a real operator id format', () => {
    expect(SYSTEM_DEVICE_ACTOR_ID).not.toMatch(CLERK_SUBJECT);
    expect(SYSTEM_DEVICE_ACTOR_ID).not.toMatch(UUID);
    // Neither format admits a ':' at all.
    expect(SYSTEM_DEVICE_ACTOR_ID).toContain(':');
    expect('user_2abcDEF123').toMatch(CLERK_SUBJECT);
    expect('0192f6a0-1b2c-7d3e-8f40-123456789abc').toMatch(UUID);
  });

  it('the two device-revoked categories are in the closed catalogue', () => {
    expect(AUDIT_ACTION_CATEGORIES).toContain('pairing.device_revoked');
    expect(AUDIT_ACTION_CATEGORIES).toContain('pairing.device_revoked_cleared');
  });
});
