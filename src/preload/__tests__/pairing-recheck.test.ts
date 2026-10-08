import { describe, expect, it, vi } from 'vitest';

import { invokePairingRecheck } from '../pairing-recheck.js';
import { PAIRING_IPC_CHANNELS, type PairingRecheckResult } from '../../shared/pairing-types.js';

/**
 * RT-215 10897-A — preload side of `pairing:recheck`. The renderer only
 * TRIGGERS the recheck (no argument crosses the bridge) and receives ONLY a
 * validated `{ outcome }`; never a token, never an extra field.
 */

function fakeRenderer(answer: () => Promise<unknown>) {
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(answer);
  return { renderer: { invoke }, invoke };
}

describe('RT-215 10897-A invokePairingRecheck', () => {
  it('invokes pairing:recheck with NO argument', async () => {
    const fake = fakeRenderer(() => Promise.resolve({ outcome: 'cleared' }));
    await invokePairingRecheck(fake.renderer);
    expect(fake.invoke).toHaveBeenCalledWith(PAIRING_IPC_CHANNELS.RECHECK);
    expect(fake.invoke.mock.calls[0]).toHaveLength(1);
  });

  it.each<PairingRecheckResult>([
    { outcome: 'cleared' },
    { outcome: 'still_revoked' },
    { outcome: 'unreachable' },
  ])('forwards %j and nothing else', async (result) => {
    const fake = fakeRenderer(() => Promise.resolve({ ...result, device_token: 'leak' }));
    await expect(invokePairingRecheck(fake.renderer)).resolves.toEqual(result);
  });

  it.each([null, 'cleared', { outcome: 'made_up' }, { nope: 1 }])(
    'reads a malformed answer %j as unreachable (never as cleared)',
    async (payload) => {
      const fake = fakeRenderer(() => Promise.resolve(payload));
      await expect(invokePairingRecheck(fake.renderer)).resolves.toEqual({
        outcome: 'unreachable',
      });
    },
  );
});
