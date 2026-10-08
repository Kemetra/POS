/**
 * RT-221 — the sale-sync engine's current-terminal resolver.
 *
 * The engine's scope comes from the pairing status (the same source as its
 * tenant/branch). Only a `paired` status yields a `terminal_id`; every other
 * state — unpaired, invalid (orphaned row, missing token, decrypt failure) or a
 * status read that fails — yields null, so nothing is eligible to sync.
 */
import { describe, expect, it } from 'vitest';

import type { PairingStatus } from '../../../shared/pairing-types.js';
import { createCurrentTerminalResolver } from '../current-terminal.js';

const PAIRED: PairingStatus = {
  kind: 'paired',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'term-new',
  terminal_label: 'Till 1',
  paired_at: 1_780_000_000,
};

describe('RT-221 — createCurrentTerminalResolver', () => {
  it('returns the terminal_id of a paired terminal', async () => {
    const resolve = createCurrentTerminalResolver(() => Promise.resolve(PAIRED));
    await expect(resolve()).resolves.toBe('term-new');
  });

  it('reads the pairing status on every call (a re-pair is seen without a restart)', async () => {
    let status: PairingStatus = PAIRED;
    const resolve = createCurrentTerminalResolver(() => Promise.resolve(status));
    await expect(resolve()).resolves.toBe('term-new');
    status = { ...PAIRED, terminal_id: 'term-newer' };
    await expect(resolve()).resolves.toBe('term-newer');
  });

  it('returns null for an unpaired terminal', async () => {
    const resolve = createCurrentTerminalResolver(() => Promise.resolve({ kind: 'unpaired' }));
    await expect(resolve()).resolves.toBeNull();
  });

  it.each(['missing_token', 'orphaned_row', 'decrypt_failed'] as const)(
    'returns null for an invalid pairing (%s)',
    async (reason) => {
      const resolve = createCurrentTerminalResolver(() =>
        Promise.resolve({ kind: 'invalid', reason }),
      );
      await expect(resolve()).resolves.toBeNull();
    },
  );

  it('fails closed: a status read that throws yields null', async () => {
    const resolve = createCurrentTerminalResolver(() =>
      Promise.reject(new Error('safeStorage unavailable')),
    );
    await expect(resolve()).resolves.toBeNull();
  });
});
