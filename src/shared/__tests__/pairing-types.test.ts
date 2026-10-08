import { describe, expect, it } from 'vitest';

import { PAIRING_IPC_CHANNELS, type PairingIpcChannel } from '../pairing-types.js';

/**
 * 002-terminal-pairing T005 contract test — the IPC channel-name constants
 * are part of the cross-process contract: the preload binds these names to
 * the bridge methods, and the main process registers handlers under
 * exactly these names. Renaming a constant without updating both sides
 * fails the manual smoke as "no handler for channel" — this small test
 * is a cheap regression guard against accidental rename.
 *
 * Constitution III (no ad-hoc strings): channel names are enumerated.
 */
describe('PAIRING_IPC_CHANNELS', () => {
  it('exposes the GET_STATUS and SUBMIT channels with the canonical strings', () => {
    expect(PAIRING_IPC_CHANNELS.GET_STATUS).toBe('pairing:get-status');
    expect(PAIRING_IPC_CHANNELS.SUBMIT).toBe('pairing:submit');
  });

  it('contains exactly three channels (RT-215 10897-A added RECHECK; no other namespace creep)', () => {
    expect(PAIRING_IPC_CHANNELS.RECHECK).toBe('pairing:recheck');
    expect(Object.keys(PAIRING_IPC_CHANNELS)).toHaveLength(3);
  });

  it('every channel name is namespaced under "pairing:" (Constitution III hygiene)', () => {
    for (const name of Object.values(PAIRING_IPC_CHANNELS)) {
      expect(name.startsWith('pairing:')).toBe(true);
    }
  });

  it('PairingIpcChannel union type covers exactly the runtime values', () => {
    // Type-level test: the assignment compiles iff PairingIpcChannel is the
    // union of the two literal strings. Renaming a constant without updating
    // the type breaks this at compile time.
    const channels: ReadonlyArray<PairingIpcChannel> = [
      PAIRING_IPC_CHANNELS.GET_STATUS,
      PAIRING_IPC_CHANNELS.SUBMIT,
      PAIRING_IPC_CHANNELS.RECHECK,
    ];
    expect(channels).toContain('pairing:get-status');
    expect(channels).toContain('pairing:submit');
  });
});
