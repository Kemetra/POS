/**
 * RT-322 (S-B, design §6) — the update notice mapping and the store that feeds
 * it. Calm: only a ready update and the three "not installed" outcomes show.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatusBridgeAPI } from '../../../shared/bridge-api';
import {
  UPDATE_STATUS_STATES,
  type UpdateStatusSnapshot,
  type UpdateStatusState,
} from '../../../shared/update-status/types';
import { UPDATE_COPY } from '../status-copy';
import { mapUpdateNotice } from '../update-status-mapping';
import { connectUpdateStatus, useUpdateStatusStore } from '../update-status-store';

const snap = (state: UpdateStatusState): UpdateStatusSnapshot => ({ v: 1, state });

describe('mapUpdateNotice', () => {
  it('shows nothing before a snapshot is known', () => {
    expect(mapUpdateNotice(null)).toBeNull();
  });

  it.each(['downloaded', 'update_pending'] as const)(
    '%s: update ready, installs after close',
    (s) => {
      expect(mapUpdateNotice(snap(s))).toEqual({ tone: 'info', copy: UPDATE_COPY.ready });
    },
  );

  it.each(UPDATE_STATUS_STATES.filter((s) => s !== 'downloaded' && s !== 'update_pending'))(
    '%s: nothing on the cashier surface (failures are for the operator)',
    (s) => {
      expect(mapUpdateNotice(snap(s))).toBeNull();
    },
  );

  it('says what the design says, in Arabic, with no version or cause', () => {
    expect(UPDATE_COPY.ready).toBe('تحديث جاهز — سيُثبَّت بعد إغلاق الوردية.');
    expect(Object.keys(UPDATE_COPY)).toEqual(['ready']);
    expect(UPDATE_COPY.ready).not.toMatch(/[0-9A-Za-z]/);
  });
});

function fakeBridge(initial: Promise<UpdateStatusSnapshot>): {
  bridge: UpdateStatusBridgeAPI;
  push: (s: UpdateStatusSnapshot) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let cb: ((s: UpdateStatusSnapshot) => void) | null = null;
  const unsubscribe = vi.fn();
  return {
    bridge: {
      get: () => initial,
      onChanged: (c) => {
        cb = c;
        return unsubscribe;
      },
    },
    push: (s) => cb?.(s),
    unsubscribe,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('connectUpdateStatus', () => {
  afterEach(() => {
    useUpdateStatusStore.setState({ snapshot: null });
  });

  it('is a no-op without a bridge', () => {
    const stop = connectUpdateStatus(undefined);
    expect(() => {
      stop();
    }).not.toThrow();
    expect(useUpdateStatusStore.getState().snapshot).toBeNull();
  });

  it('reads once on connect', async () => {
    const { bridge } = fakeBridge(Promise.resolve(snap('downloaded')));
    connectUpdateStatus(bridge);
    await flush();
    expect(useUpdateStatusStore.getState().snapshot).toEqual(snap('downloaded'));
  });

  it('drops a read that lands after a newer push', async () => {
    let resolve!: (s: UpdateStatusSnapshot) => void;
    const { bridge, push } = fakeBridge(
      new Promise((r) => {
        resolve = r;
      }),
    );
    connectUpdateStatus(bridge);
    push(snap('update_pending'));
    resolve(snap('downloading'));
    await flush();
    expect(useUpdateStatusStore.getState().snapshot).toEqual(snap('update_pending'));
  });

  it('leaves the store alone when the read is refused', async () => {
    const { bridge } = fakeBridge(Promise.reject(new Error('update_status_unavailable')));
    connectUpdateStatus(bridge);
    await flush();
    expect(useUpdateStatusStore.getState().snapshot).toBeNull();
  });

  it('reads again when the session unlocks, and ignores other session events', async () => {
    let answer = snap('idle');
    const get = vi.fn(() => Promise.resolve(answer));
    const bridge: UpdateStatusBridgeAPI = { get, onChanged: () => () => undefined };
    let emit: (state: 'active' | 'locked' | 'ended') => void = () => undefined;
    const unsubscribeSession = vi.fn();
    connectUpdateStatus(bridge, {
      onSessionStateChanged: (cb) => {
        emit = (state) => {
          cb({ state });
        };
        return unsubscribeSession;
      },
    });
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    answer = snap('downloaded');
    emit('locked');
    emit('ended');
    expect(get).toHaveBeenCalledTimes(1);
    emit('active');
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(useUpdateStatusStore.getState().snapshot).toEqual(snap('downloaded'));
  });

  it('unsubscribes and forgets the snapshot on stop', async () => {
    const { bridge, unsubscribe } = fakeBridge(Promise.resolve(snap('downloaded')));
    const stop = connectUpdateStatus(bridge);
    await flush();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(useUpdateStatusStore.getState().snapshot).toBeNull();
  });
});
