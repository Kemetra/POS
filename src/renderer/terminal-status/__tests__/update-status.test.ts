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

  it.each([
    ['verify_failed', UPDATE_COPY.verifyFailed],
    ['verify_unavailable', UPDATE_COPY.verifyUnavailable],
    ['error', UPDATE_COPY.error],
  ] as const)('%s: a calm warning', (s, copy) => {
    expect(mapUpdateNotice(snap(s))).toEqual({ tone: 'warning', copy });
  });

  it.each(['idle', 'checking', 'downloading', 'installing', 'compat_blocked'] as const)(
    '%s: nothing to show',
    (s) => {
      expect(mapUpdateNotice(snap(s))).toBeNull();
    },
  );

  it('covers every state, and never uses the danger tone', () => {
    for (const s of UPDATE_STATUS_STATES) {
      const notice = mapUpdateNotice(snap(s));
      if (notice !== null) expect(['info', 'warning']).toContain(notice.tone);
    }
  });

  it('says what the design says, in Arabic, with no version or cause', () => {
    expect(UPDATE_COPY.ready).toBe('تحديث جاهز — سيُثبَّت بعد إغلاق الوردية.');
    for (const copy of Object.values(UPDATE_COPY)) {
      expect(copy).not.toMatch(/[0-9A-Za-z]/);
    }
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

  it('unsubscribes and forgets the snapshot on stop', async () => {
    const { bridge, unsubscribe } = fakeBridge(Promise.resolve(snap('downloaded')));
    const stop = connectUpdateStatus(bridge);
    await flush();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(useUpdateStatusStore.getState().snapshot).toBeNull();
  });
});
