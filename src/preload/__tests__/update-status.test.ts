/**
 * RT-322 (S-B) — preload side of the update status bridge.
 *
 *   • `get()` invokes `updateStatus:get` with `{}` and returns only a parsed
 *     snapshot; a refusal or a malformed answer rejects, never coerces;
 *   • `onChanged(cb)` listens on `updateStatus:changed`; the callback gets only a
 *     parsed snapshot (unknown fields dropped), never the IpcRendererEvent.
 */
import { describe, expect, it, vi } from 'vitest';

import { createUpdateStatusBridge, parseUpdateStatusSnapshot } from '../update-status.js';
import {
  UPDATE_STATUS_INVALID,
  UPDATE_STATUS_IPC_CHANNELS,
  type UpdateStatusSnapshot,
} from '../../shared/update-status/types.js';

type Listener = (event: unknown, payload: unknown) => void;

const VALID: UpdateStatusSnapshot = {
  v: 1,
  state: 'update_pending',
  availableVersion: '1.4.2',
};

function fakeRenderer(invokeResult: unknown = VALID) {
  const listeners = new Set<Listener>();
  const invoke = vi.fn((...args: unknown[]) => {
    void args;
    return Promise.resolve(invokeResult);
  });
  return {
    renderer: {
      invoke,
      on: (_c: string, l: Listener) => {
        listeners.add(l);
      },
      removeListener: (_c: string, l: Listener) => {
        listeners.delete(l);
      },
    },
    invoke,
    push: (payload: unknown) => {
      for (const l of listeners) l({ sender: {} }, payload);
    },
    count: () => listeners.size,
  };
}

describe('parseUpdateStatusSnapshot', () => {
  it('rebuilds a valid snapshot from known fields only', () => {
    expect(
      parseUpdateStatusSnapshot({
        ...VALID,
        origin: 'https://x.test',
        channel: 'lab',
        detail: 'x',
        blockers: ['open_shift'],
      }),
    ).toEqual(VALID);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a wrong version', { ...VALID, v: 2 }],
    ['an unknown state', { ...VALID, state: 'online' }],
    ['a url version', { v: 1, state: 'downloaded', availableVersion: 'https://x.test' }],
  ])('rejects %s', (_label, payload) => {
    expect(parseUpdateStatusSnapshot(payload)).toBeNull();
  });
});

describe('createUpdateStatusBridge', () => {
  it('get() invokes the getter with `{}` and returns the parsed snapshot', async () => {
    const { renderer, invoke } = fakeRenderer();
    await expect(createUpdateStatusBridge(renderer).get()).resolves.toEqual(VALID);
    expect(invoke).toHaveBeenCalledWith(UPDATE_STATUS_IPC_CHANNELS.GET, {});
  });

  it('get() rejects on a refusal and on a malformed answer', async () => {
    for (const answer of [UPDATE_STATUS_INVALID, { v: 1, state: 'nope' }]) {
      const { renderer } = fakeRenderer(answer);
      await expect(createUpdateStatusBridge(renderer).get()).rejects.toThrow(
        'update_status_unavailable',
      );
    }
  });

  it('onChanged delivers parsed snapshots only, never the event', () => {
    const { renderer, push } = fakeRenderer();
    const cb = vi.fn();
    createUpdateStatusBridge(renderer).onChanged(cb);
    push({ ...VALID, extra: 1 });
    push({ v: 1, state: 'bogus' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(VALID);
  });

  it('onChanged returns an unsubscribe', () => {
    const { renderer, count } = fakeRenderer();
    const stop = createUpdateStatusBridge(renderer).onChanged(() => undefined);
    expect(count()).toBe(1);
    stop();
    expect(count()).toBe(0);
  });

  it('exposes a getter and a subscription only', () => {
    const { renderer } = fakeRenderer();
    expect(Object.keys(createUpdateStatusBridge(renderer)).sort()).toEqual(['get', 'onChanged']);
  });
});
