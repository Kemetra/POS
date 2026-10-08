import { describe, expect, it, vi } from 'vitest';

import { subscribePairingStatus } from '../pairing-status.js';
import {
  PAIRING_PUSH_CHANNELS,
  type PairingStatusChangedEvent,
} from '../../shared/pairing-types.js';

/**
 * RT-215 — preload side of the `pairing:status-changed` push. The renderer
 * callback receives ONLY a validated `{ kind, reason? }` — never Electron's
 * IpcRendererEvent and never extra fields (no ids, no token).
 */

type Listener = (event: unknown, payload: unknown) => void;

function fakeRenderer(): {
  renderer: {
    on: (c: string, l: Listener) => void;
    removeListener: (c: string, l: Listener) => void;
  };
  channels: string[];
  push: (payload: unknown) => void;
  count: () => number;
} {
  const listeners = new Set<Listener>();
  const channels: string[] = [];
  return {
    renderer: {
      on: (c, l) => {
        channels.push(c);
        listeners.add(l);
      },
      removeListener: (_c, l) => {
        listeners.delete(l);
      },
    },
    channels,
    push: (payload) => {
      for (const l of listeners) l({ sender: { secret: true } }, payload);
    },
    count: () => listeners.size,
  };
}

describe('RT-215 subscribePairingStatus', () => {
  it('listens on pairing:status-changed', () => {
    const fake = fakeRenderer();
    subscribePairingStatus(fake.renderer, vi.fn());
    expect(fake.channels).toEqual([PAIRING_PUSH_CHANNELS.STATUS_CHANGED]);
    expect(PAIRING_PUSH_CHANNELS.STATUS_CHANGED).toBe('pairing:status-changed');
  });

  it.each<PairingStatusChangedEvent>([
    { kind: 'invalid', reason: 'device_revoked' },
    { kind: 'invalid', reason: 'decrypt_failed' },
    { kind: 'paired' },
    { kind: 'unpaired' },
  ])('forwards %j and nothing else', (event) => {
    const fake = fakeRenderer();
    const cb = vi.fn<(e: PairingStatusChangedEvent) => void>();
    subscribePairingStatus(fake.renderer, cb);
    fake.push({ ...event, terminal_id: 'leak', device_token: 'leak' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.[0]).toEqual(event);
  });

  it.each([
    null,
    'invalid',
    { kind: 'exploded' },
    { kind: 'invalid' },
    { kind: 'invalid', reason: 'made_up' },
    { nope: 1 },
  ])('drops a malformed payload %j', (payload) => {
    const fake = fakeRenderer();
    const cb = vi.fn();
    subscribePairingStatus(fake.renderer, cb);
    fake.push(payload);
    expect(cb).not.toHaveBeenCalled();
  });

  it('the returned function unsubscribes', () => {
    const fake = fakeRenderer();
    const cb = vi.fn();
    const off = subscribePairingStatus(fake.renderer, cb);
    expect(fake.count()).toBe(1);
    off();
    expect(fake.count()).toBe(0);
    fake.push({ kind: 'paired' });
    expect(cb).not.toHaveBeenCalled();
  });
});
