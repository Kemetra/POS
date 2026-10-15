import { describe, expect, it } from 'vitest';

import { verifyPin, hashPin } from '../pin-credential.js';
import { verifyPinWithWindow, unlockPinRow, rowMatchesScope } from '../pin-lockout.js';

/**
 * 019-cashier-pin-provisioning T024 — verifier-untouched guard (FR-8).
 *
 * The whole feature exists to move the cashier_pin_records identity key from
 * the provider-coupled Clerk subject to the provider-neutral `user_id`. That
 * is only safe BECAUSE the unlock-time verifier never keys on identity — it
 * reads the row's secret material (hash/salt) and lockout state, not *who* the
 * cashier is. A clerk-keyed row and a born-neutral row therefore verify
 * identically; 019 changes the key without touching the verifier.
 *
 * This guard is the structural proof of that premise. It fails if a future
 * change gives any verifier function an identity parameter — the tripwire that
 * would mean the verifier started caring about identity, breaking born-neutral.
 *
 * `Function.length` counts the parameters before the first default/rest arg,
 * so an added `cashierId` (or any identity arg) bumps it and trips this test.
 */

describe('019 T024 — PIN verifier never keys on identity (FR-8)', () => {
  it('verifyPin takes exactly (pin, row) — no identity parameter', () => {
    expect(verifyPin).toHaveLength(2);
  });

  it('verifyPinWithWindow takes exactly (pin, row) — no identity parameter', () => {
    expect(verifyPinWithWindow).toHaveLength(2);
  });

  it('unlockPinRow takes exactly (row) — operates on the row, not an identity', () => {
    expect(unlockPinRow).toHaveLength(1);
  });

  it('hashPin takes exactly (pin) — hashing is identity-free', () => {
    expect(hashPin).toHaveLength(1);
  });

  it('rowMatchesScope keys on the composite SCOPE, not the cashier principal type', () => {
    // The scope guard intentionally DOES compare cashier_clerk_user_id (the
    // current PK column) — but that is per-terminal scope matching, not an
    // identity argument to the verifier. It takes (row, scope), 2 params.
    expect(rowMatchesScope).toHaveLength(2);
  });
});
