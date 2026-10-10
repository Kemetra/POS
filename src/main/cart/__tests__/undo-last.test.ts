/**
 * RT-254 — defensive branches of the Undo decision module that the sql.js
 * integration suite (`tests/unit/main/cart/cart-undo-last.test.ts`) cannot
 * reach through the bridge: unreadable or inconsistent persisted rows must
 * refuse (never guess an inverse or a replay outcome).
 */
import { describe, it, expect } from 'vitest';

import { planUndo, replayUndo } from '../undo-last.js';
import type { CartLineRow, CartRow, CartStore, OutboxRow } from '../cart-store.js';

const REQ = { cart_id: 'cart-1', target_action_id: 'tgt', idempotency_key: 'undo' };

function outboxRow(overrides: Partial<OutboxRow>): OutboxRow {
  return {
    action_id: 'undo',
    cart_id: 'cart-1',
    line_id: 'line-1',
    action_kind: 'cart.line.remove',
    acting_operator_id: 'op',
    attribution_operator_id: null,
    operator_session_id: 's',
    payload_json: JSON.stringify({
      undo_of_action_id: 'tgt',
      effect: 'removed',
      result_version: 2,
    }),
    applied_at: 't',
    synced_at: null,
    ...overrides,
  };
}

function line(overrides: Partial<CartLineRow>): CartLineRow {
  return {
    line_id: 'line-1',
    cart_id: 'cart-1',
    item_ref: 'SKU-A',
    display_name: 'A',
    quantity: 2,
    unit_price_minor: 100,
    line_subtotal_minor: 200,
    note: null,
    version: 1,
    last_action_id: 'tgt',
    created_at: 't',
    updated_at: 't',
    removed_at: null,
    ...overrides,
  };
}

const CART = { cart_id: 'cart-1', last_action_id: 'tgt' } as CartRow;

function storeWith(target: OutboxRow | undefined, current: CartLineRow | undefined): CartStore {
  return {
    getOutboxRow: () => target,
    getLine: () => current,
    findActiveLineByItemRef: () => undefined,
  } as unknown as CartStore;
}

describe('replayUndo — refuses anything that is not this exact Undo', () => {
  it('returns the recorded effect and version', () => {
    expect(replayUndo(REQ, outboxRow({}))).toEqual({
      kind: 'ok',
      effect: 'removed',
      line_id: 'line-1',
      version: 2,
    });
  });

  it.each([
    ['unreadable payload', { payload_json: '{not json' }],
    ['array payload', { payload_json: '[]' }],
    ['other cart', { cart_id: 'cart-2' }],
    ['no line', { line_id: null }],
    ['effect disagrees with kind', { action_kind: 'cart.line.restore' }],
    [
      'unknown effect',
      {
        payload_json: JSON.stringify({ undo_of_action_id: 'tgt', effect: 'x', result_version: 2 }),
      },
    ],
    [
      'invalid version',
      {
        payload_json: JSON.stringify({
          undo_of_action_id: 'tgt',
          effect: 'removed',
          result_version: 0,
        }),
      },
    ],
  ])('%s → idempotency_payload_mismatch', (_label, overrides) => {
    expect(replayUndo(REQ, outboxRow(overrides))).toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
  });
});

describe('planUndo — ineligible persisted state → undo_not_available', () => {
  const UNAVAILABLE = { kind: 'refused', reason: 'undo_not_available' };

  it('an unreadable target payload', () => {
    const target = outboxRow({ action_id: 'tgt', action_kind: 'cart.line.add', payload_json: '{' });
    expect(planUndo(storeWith(target, line({})), CART, REQ)).toEqual(UNAVAILABLE);
  });

  it('a remove target whose line is active again', () => {
    const target = outboxRow({
      action_id: 'tgt',
      action_kind: 'cart.line.remove',
      payload_json: '{}',
    });
    expect(planUndo(storeWith(target, line({ removed_at: null })), CART, REQ)).toEqual(UNAVAILABLE);
  });

  it('a merge without a positive integer quantity_added', () => {
    const target = outboxRow({
      action_id: 'tgt',
      action_kind: 'cart.line.merge',
      payload_json: JSON.stringify({ item_ref: 'SKU-A', quantity_added: 1.5 }),
    });
    expect(planUndo(storeWith(target, line({ quantity: 3 })), CART, REQ)).toEqual(UNAVAILABLE);
  });

  it('a merge whose decremented subtotal is not a safe integer', () => {
    const target = outboxRow({
      action_id: 'tgt',
      action_kind: 'cart.line.merge',
      payload_json: JSON.stringify({ quantity_added: 1 }),
    });
    const huge = line({ quantity: 3, unit_price_minor: Number.MAX_SAFE_INTEGER });
    expect(planUndo(storeWith(target, huge), CART, REQ)).toEqual(UNAVAILABLE);
  });

  it('a line that no longer exists', () => {
    const target = outboxRow({
      action_id: 'tgt',
      action_kind: 'cart.line.add',
      payload_json: '{}',
    });
    expect(planUndo(storeWith(target, undefined), CART, REQ)).toEqual(UNAVAILABLE);
  });
});
