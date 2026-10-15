/**
 * Codex P2 4186872826 — the best-effort sign-out of a session the epoch
 * refusal abandoned. Every outcome (sent, rejected, synchronous throw) is
 * contained and logged without the credential or the session id.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { signOutAbandonedSession } from '../pairing-epoch.js';

const SESSION = { session_id: 'sess-1', jwt: 'jwt-1' };

function fakeLogger(): { logger: Logger; outcomes: () => unknown[] } {
  const info = vi.fn();
  return {
    logger: { info } as unknown as Logger,
    outcomes: () => info.mock.calls.map(([fields]) => (fields as { outcome: string }).outcome),
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('signOutAbandonedSession', () => {
  it('sends the session id with the provider JWT and logs "sent"', async () => {
    const signOut = vi.fn().mockResolvedValue({});
    const { logger, outcomes } = fakeLogger();
    signOutAbandonedSession({ signOut }, SESSION, logger);
    expect(signOut).toHaveBeenCalledWith({ session_id: 'sess-1' }, 'jwt-1');
    await flush();
    expect(outcomes()).toEqual(['sent']);
  });

  it.each([
    ['a rejection', 'failed', () => Promise.reject(new Error('offline'))],
    [
      'a synchronous throw',
      'threw',
      () => {
        throw new Error('boom');
      },
    ],
  ])('contains %s and logs "%s"', async (_label, outcome, impl: () => Promise<never>) => {
    const signOut = vi.fn(impl);
    const { logger, outcomes } = fakeLogger();
    expect(() => {
      signOutAbandonedSession({ signOut }, SESSION, logger);
    }).not.toThrow();
    await flush();
    expect(outcomes()).toEqual([outcome]);
  });

  it('does nothing without a JWT', () => {
    const signOut = vi.fn();
    signOutAbandonedSession({ signOut }, { session_id: 'sess-1', jwt: null }, undefined);
    signOutAbandonedSession({ signOut }, { session_id: 'sess-1', jwt: '' }, undefined);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('never logs the credential or the session id', async () => {
    const signOut = vi.fn().mockResolvedValue({});
    const info = vi.fn();
    signOutAbandonedSession({ signOut }, SESSION, { info } as unknown as Logger);
    await flush();
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain('jwt-1');
    expect(logged).not.toContain('sess-1');
  });
});
