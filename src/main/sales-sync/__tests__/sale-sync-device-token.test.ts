/**
 * RT-224 step 2 (Codex P2 on #547) — the sale-sync device-token reader never rejects.
 *
 * The device token is read from the OS secret store (DPAPI / keychain), which can
 * fail transiently. A rejection must not abort the drain (that would also stop
 * manager sales that could go out under an envelope), and it must not break the
 * client's never-reject contract. So a read failure reads as "no device
 * credential": cashier sales stay queued, envelope traffic continues.
 *
 * `onReadFailure` fires once per failure episode (re-armed by a successful read)
 * and receives nothing — no token, no error text.
 */
import { describe, expect, it } from 'vitest';

import { createSaleSyncDeviceTokenReader } from '../sale-sync-device-token.js';

const TOKEN = 'device-token-SECRET';

function reader(opts: {
  paired?: () => Promise<boolean>;
  read?: () => Promise<string | null | undefined>;
}) {
  const failures: unknown[][] = [];
  const reads: number[] = [];
  const read = createSaleSyncDeviceTokenReader({
    isPaired: opts.paired ?? (() => Promise.resolve(true)),
    readToken: () => {
      reads.push(1);
      return (opts.read ?? (() => Promise.resolve(TOKEN)))();
    },
    onReadFailure: (...args: unknown[]) => failures.push(args),
  });
  return { read, failures, reads };
}

describe('RT-224 — sale-sync device-token reader', () => {
  it('paired → the stored token', async () => {
    const r = reader({});
    expect(await r.read()).toBe(TOKEN);
  });

  it('unpaired → null, without touching the secret store', async () => {
    const r = reader({ paired: () => Promise.resolve(false) });
    expect(await r.read()).toBeNull();
    expect(r.reads).toEqual([]);
  });

  it('no stored token → null', async () => {
    const r = reader({ read: () => Promise.resolve(undefined) });
    expect(await r.read()).toBeNull();
  });

  it('a secret-store rejection → null (never rejects), reported once with no arguments', async () => {
    const r = reader({ read: () => Promise.reject(new Error(`DPAPI failure ${TOKEN}`)) });
    await expect(r.read()).resolves.toBeNull();
    await expect(r.read()).resolves.toBeNull();
    await expect(r.read()).resolves.toBeNull();
    expect(r.failures).toEqual([[]]);
  });

  it('a pairing-status rejection → null (never rejects)', async () => {
    const r = reader({ paired: () => Promise.reject(new Error('db busy')) });
    await expect(r.read()).resolves.toBeNull();
    expect(r.failures).toEqual([[]]);
  });

  it('a successful read re-arms the failure report', async () => {
    let fail = true;
    const r = reader({
      read: () => (fail ? Promise.reject(new Error('x')) : Promise.resolve(TOKEN)),
    });
    await r.read();
    fail = false;
    expect(await r.read()).toBe(TOKEN);
    fail = true;
    await r.read();
    expect(r.failures).toHaveLength(2);
  });
});
