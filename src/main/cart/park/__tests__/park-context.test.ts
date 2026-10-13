/**
 * RT-440 (PK-2) — the transaction wrapper: a row that moved between the
 * checks and the write rolls back as a closed refusal; anything else
 * propagates (never turned into a refusal).
 */
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseHandle } from '../../../db/client.js';
import { inTransaction, ParkRefused, type ParkResumeDeps } from '../park-context.js';
import { parkOne } from '../park-service.js';
import type { ParkStore } from '../park-store.js';

function depsWith(store: Partial<ParkStore>): ParkResumeDeps {
  const db = {
    transaction: (fn: () => unknown) => fn,
  } as unknown as DatabaseHandle;
  return {
    db,
    store: store as ParkStore,
    cartStore: { cancelCartAndOutbox: vi.fn() },
    getCurrentSession: () => null,
    getTerminalId: () => 'term-1',
    auditEmitter: { emit: vi.fn() },
    prices: () => ({ kind: 'unavailable' }),
  };
}

const at = {
  terminal_id: 'term-1',
  session: {
    id: 's1',
    operator_id: 'op-1',
    display_name: 'op',
    role: 'cashier' as const,
    tenant_id: 't',
    branch_id: 'b',
    started_at: '2026-10-13T09:00:00.000Z',
    backend_session_id: '',
    last_activity_at: '2026-10-13T09:00:00.000Z',
    lock_state: 'active' as const,
    locked_at: null,
  },
};

describe('inTransaction', () => {
  it('answers not_parkable when the cart moved before the park write', () => {
    const deps = depsWith({ activeLineCount: () => 1, markParked: () => false });
    const result = inTransaction(deps, () => {
      parkOne(deps, { at, cart_id: 'c1', label: null, key: 'k', when: 'now' });
      return { kind: 'parked' as const };
    });
    expect(result).toEqual({ kind: 'refused', reason: 'not_parkable' });
    expect(deps.auditEmitter.emit).not.toHaveBeenCalled();
  });

  it('turns a thrown ParkRefused into its refusal', () => {
    const deps = depsWith({});
    expect(
      inTransaction(deps, () => {
        throw new ParkRefused('not_parked');
      }),
    ).toEqual({ kind: 'refused', reason: 'not_parked' });
  });

  it('rethrows anything else', () => {
    const deps = depsWith({});
    expect(() =>
      inTransaction(deps, () => {
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
  });
});
