import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../../../../src/main/operator/role-enforcement.js', () => ({
  requireRole: () => {
    throw new Error('unexpected non-refusal error');
  },
}));

import { ForcedCloseHandler } from '../../../../src/main/operator/forced-close-handler.js';
import type { ForcedCloseHandlerDeps } from '../../../../src/main/operator/forced-close-handler.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import { isOperatorRefusal } from '../../../../src/shared/audit/event-shape.js';

function makeDeps(): ForcedCloseHandlerDeps {
  return {
    db: {} as DatabaseHandle,
    sessionManager: { getCurrent: () => null },
    pairingStore: {
      getStatus: () => Promise.resolve({ kind: 'unpaired' as const }),
    },
    auditEmitter: { emit: vi.fn() } as ForcedCloseHandlerDeps['auditEmitter'],
    shiftCashup: { forceCloseShift: vi.fn() },
  };
}

describe('ForcedCloseHandler — requireRole non-OperatorRefusalError fallback', () => {
  it('returns invalid_input when requireRole throws a plain Error', async () => {
    const handler = new ForcedCloseHandler(makeDeps());

    const result = await handler.forceCloseShift({
      shift_id: 'any-shift',
      reason: 'takeover_supersession',
      counted_cash_minor: 0,
      event_id: randomUUID(),
    });

    expect(isOperatorRefusal(result)).toBe(true);
    if (isOperatorRefusal(result)) {
      expect(result.category).toBe('invalid_input');
    }
  });
});
