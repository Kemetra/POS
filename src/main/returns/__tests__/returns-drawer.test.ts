/**
 * RT-15 S4 — the return payout's drawer kick (invariants D1, D2).
 *
 * The same `DrawerKickTransport` port as a sale's drawer. Whatever the
 * transport does, the payout gets a closed outcome: opened, or failed with a
 * closed reason. A throw is `os_error`; no answer by the deadline is
 * `timeout`; an answer outside the contract is `os_error` (never "opened").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrawerKickTransport } from '../../drawer/drawer-kick-transport.js';
import { kickReturnDrawer, RETURN_DRAWER_TIMEOUT_MS } from '../returns-drawer.js';

function transport(kick: DrawerKickTransport['kick']): DrawerKickTransport {
  return { kick };
}

describe('return drawer kick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is opened when the transport reports opened', async () => {
    await expect(kickReturnDrawer(transport(() => Promise.resolve({ ok: true })))).resolves.toEqual(
      {
        ok: true,
      },
    );
  });

  it.each(['no_drawer_configured', 'printer_dk_failure', 'os_error'] as const)(
    'keeps the transport failure %s',
    async (failure_reason) => {
      const t = transport(() => Promise.resolve({ ok: false, failure_reason }));
      await expect(kickReturnDrawer(t)).resolves.toEqual({ ok: false, reason: failure_reason });
    },
  );

  it('maps a throwing transport to os_error', async () => {
    const t = transport(() => Promise.reject(new Error('usb gone')));
    await expect(kickReturnDrawer(t)).resolves.toEqual({ ok: false, reason: 'os_error' });
  });

  it('maps a synchronously throwing transport to os_error', async () => {
    const t = transport(() => {
      throw new Error('boom');
    });
    await expect(kickReturnDrawer(t)).resolves.toEqual({ ok: false, reason: 'os_error' });
  });

  it('maps an answer outside the contract to os_error, never opened', async () => {
    const t = transport(() => Promise.resolve({ ok: 'yes' } as unknown as { ok: true }));
    await expect(kickReturnDrawer(t)).resolves.toEqual({ ok: false, reason: 'os_error' });
    const odd = transport(() =>
      Promise.resolve({ ok: false, failure_reason: 'melted' } as unknown as { ok: true }),
    );
    await expect(kickReturnDrawer(odd)).resolves.toEqual({ ok: false, reason: 'os_error' });
  });

  it('times out a transport that never answers, and ignores a late answer', async () => {
    let late: (v: { ok: true }) => void = () => undefined;
    const t = transport(
      () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    );
    const outcome = kickReturnDrawer(t);
    await vi.advanceTimersByTimeAsync(RETURN_DRAWER_TIMEOUT_MS - 1);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'timeout' });
    late({ ok: true });
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});
