import { describe, expect, it, vi } from 'vitest';

import { subscribeSessionState } from '../session-state.js';
import type { SessionStateEvent } from '../../shared/bridge-api.js';

/**
 * RT-117 (§A4) — preload side of the session-state push. The renderer callback
 * receives ONLY a validated `{ state }` — never Electron's IpcRendererEvent
 * (which carries a `sender` reference) and never extra fields.
 */

type Listener = (event: unknown, payload: unknown) => void;

function fakeRenderer(): {
  renderer: {
    on: (c: string, l: Listener) => void;
    removeListener: (c: string, l: Listener) => void;
  };
  push: (payload: unknown) => void;
  count: () => number;
} {
  const listeners = new Set<Listener>();
  return {
    renderer: {
      on: (_c, l) => {
        listeners.add(l);
      },
      removeListener: (_c, l) => {
        listeners.delete(l);
      },
    },
    push: (payload) => {
      for (const l of listeners) l({ sender: { secret: true } }, payload);
    },
    count: () => listeners.size,
  };
}

describe('RT-117 subscribeSessionState', () => {
  it.each(['locked', 'active', 'ended'] as const)(
    'forwards a %s event as { state } only',
    (state) => {
      const fake = fakeRenderer();
      const cb = vi.fn<(e: SessionStateEvent) => void>();
      subscribeSessionState(fake.renderer, cb);

      fake.push({ state, operator_id: 'leak', session_id: 'leak' });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0]?.[0]).toEqual({ state });
    },
  );

  it.each([null, 'locked', { state: 'exploded' }, { nope: 1 }])(
    'drops a malformed payload %j',
    (payload) => {
      const fake = fakeRenderer();
      const cb = vi.fn();
      subscribeSessionState(fake.renderer, cb);

      fake.push(payload);

      expect(cb).not.toHaveBeenCalled();
    },
  );

  it('the returned function unsubscribes', () => {
    const fake = fakeRenderer();
    const cb = vi.fn();
    const off = subscribeSessionState(fake.renderer, cb);

    off();
    fake.push({ state: 'locked' });

    expect(cb).not.toHaveBeenCalled();
    expect(fake.count()).toBe(0);
  });
});
