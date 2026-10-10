import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerResumeStateHandler } from '../resume-state.js';
import { RESUME_STATE_IPC_CHANNELS } from '../../../shared/operator/channels.js';
import type { ResumeStateView } from '../../../shared/bridge-api.js';

/** RT-352 — `operator:get-resume-state` IPC. */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpcMain(): {
  ipcMain: Pick<IpcMain, 'handle'>;
  invoke: (c: string, ...a: unknown[]) => unknown;
} {
  const handlers = new Map<string, Listener>();
  return {
    ipcMain: {
      handle: (c: string, l: Listener) => {
        handlers.set(c, l);
      },
    },
    invoke: (c, ...a) => handlers.get(c)?.({} as IpcMainInvokeEvent, ...a),
  };
}

const HELD: ResumeStateView = {
  cart_id: 'cart-1',
  payment_attempt_id: null,
  other_held_cart_count: 2,
};

describe('RT-352 registerResumeStateHandler', () => {
  it('answers with the resume view and ignores any renderer arguments', () => {
    const fake = fakeIpcMain();
    const getResumeState = vi.fn(() => HELD);
    registerResumeStateHandler(fake.ipcMain, { getResumeState });

    expect(fake.invoke(RESUME_STATE_IPC_CHANNELS.GET_RESUME_STATE, { cart_id: 'forged' })).toEqual(
      HELD,
    );
    expect(getResumeState).toHaveBeenCalledWith();
  });

  it('logs a failing read and answers "nothing to resume" instead of throwing', () => {
    const fake = fakeIpcMain();
    const logger = { error: vi.fn() };
    registerResumeStateHandler(fake.ipcMain, {
      getResumeState: () => {
        throw new Error('db closed');
      },
      logger,
    });

    expect(fake.invoke(RESUME_STATE_IPC_CHANNELS.GET_RESUME_STATE)).toEqual({
      cart_id: null,
      payment_attempt_id: null,
      other_held_cart_count: 0,
    });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
