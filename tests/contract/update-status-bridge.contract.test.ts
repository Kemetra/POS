/**
 * Contract test: the update status bridge is read-only and leaks nothing but its
 * closed vocabulary. Shape compliance is enforced at compile time through the
 * bridge-api types; the runtime assertions pin the surface and the redaction
 * across main (sanitize) → preload (parse).
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import type { UpdateStatusBridgeAPI } from '../../src/shared/bridge-api.js';
import {
  UPDATE_STATUS_IPC_CHANNELS,
  UPDATE_STATUS_STATES,
} from '../../src/shared/update-status/types.js';
import { registerUpdateStatusHandlers } from '../../src/main/ipc/update-status.js';
import { createUpdateStatusBridge } from '../../src/preload/update-status.js';
import type { UpdateStatus } from '../../src/main/update/update-types.js';

/** main handler wired straight to the preload bridge, as electron would. */
function endToEnd(read: () => UpdateStatus): UpdateStatusBridgeAPI {
  type Handler = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown;
  const handlers: Handler[] = [];
  registerUpdateStatusHandlers(
    {
      handle: (_c: string, fn: Handler) => {
        handlers.push(fn);
      },
    } as unknown as IpcMain,
    { read },
  );
  return createUpdateStatusBridge({
    invoke: (_c, ...args) => Promise.resolve(handlers[0]?.({} as IpcMainInvokeEvent, ...args)),
    on: vi.fn(),
    removeListener: vi.fn(),
  });
}

describe('updateStatus bridge contract', () => {
  it('uses exactly two channels, both named updateStatus:*', () => {
    expect(Object.values(UPDATE_STATUS_IPC_CHANNELS).sort()).toEqual([
      'updateStatus:changed',
      'updateStatus:get',
    ]);
  });

  it('has no install trigger and no channel or origin setter', () => {
    const bridge = endToEnd(() => ({ state: 'idle' }));
    expect(Object.keys(bridge).sort()).toEqual(['get', 'onChanged']);
    for (const name of Object.keys(bridge)) {
      expect(name).not.toMatch(/install|set|channel|origin|check|restart|quit/i);
    }
  });

  it('answers truthfully for every state, with the vocabulary intact', async () => {
    for (const state of UPDATE_STATUS_STATES) {
      const got = await endToEnd(() => ({ state })).get();
      expect(got).toEqual({ v: 1, state });
    }
  });

  it('never lets a path, url, origin, channel or stack reach the renderer', async () => {
    const hostile = {
      state: 'error',
      detail: 'Cannot fetch https://updates.example.test/lab/latest.yml at C:\\app\\x.js:1',
      availableVersion: 'https://updates.example.test',
      blockers: ['C:\\secret', 'open_shift'],
      origin: 'https://updates.example.test',
      channel: 'lab',
      stack: 'Error: x\n at y',
    } as unknown as UpdateStatus;
    const got = await endToEnd(() => hostile).get();
    expect(got).toEqual({ v: 1, state: 'error' });
    const text = JSON.stringify(got);
    expect(text).not.toMatch(/https?:|C:\\|updates\.example|lab|Error:/);
  });
});
