import { describe, expect, it } from 'vitest';

import { MANAGER_ACTION_KINDS, isManagerActionKind } from '../manager-action-kinds.js';

/** RT-438 (MA-1) — the closed RT-114 §3 catalogue the credential policy keys on. */
describe('manager action kinds', () => {
  it('is the RT-114 §3 catalogue, without the reserved kinds', () => {
    expect(MANAGER_ACTION_KINDS).toContain('shift.variance_accept');
    expect(MANAGER_ACTION_KINDS).not.toContain('drawer.no_sale');
    expect(MANAGER_ACTION_KINDS).not.toContain('price.override');
    expect(new Set(MANAGER_ACTION_KINDS).size).toBe(MANAGER_ACTION_KINDS.length);
  });

  it.each(MANAGER_ACTION_KINDS)('accepts %s', (kind) => {
    expect(isManagerActionKind(kind)).toBe(true);
  });

  it.each([undefined, null, 42, '', 'price.override', 'SHIFT.VARIANCE_ACCEPT', {}])(
    'rejects %s',
    (value) => {
      expect(isManagerActionKind(value)).toBe(false);
    },
  );
});
