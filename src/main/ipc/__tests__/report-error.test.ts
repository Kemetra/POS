import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { REPORT_ERROR_CHANNEL, registerReportErrorHandler } from '../report-error.js';
import { LOCKED_ALLOWED_CHANNELS } from '../session-lock-guard.js';
import { isRefusedInRecoveryMode } from '../recovery-mode-guard.js';
import { isSaleChannel } from '../sale-boundary-guard.js';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * RT-634 (OBS-5) — `app:report-error`: the renderer's only route to Sentry.
 * Fire-and-forget: the handler resolves `undefined` and never throws, so a
 * broken reporter cannot surface an error into the renderer.
 */

function register(report: (payload: unknown) => void): IpcHandler {
  const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
  registerReportErrorHandler({ handle } as unknown as IpcMain, report);
  expect(handle).toHaveBeenCalledWith(REPORT_ERROR_CHANNEL, expect.any(Function));
  const fn = handle.mock.calls[0]?.[1];
  if (!fn) throw new Error('handler not registered');
  return fn;
}

describe('registerReportErrorHandler', () => {
  it('uses the app:report-error channel', () => {
    expect(REPORT_ERROR_CHANNEL).toBe('app:report-error');
  });

  it('passes the raw payload to the reporter and resolves undefined', async () => {
    const report = vi.fn();
    const fn = register(report);
    await expect(
      Promise.resolve(fn({} as IpcMainInvokeEvent, { message: 'm' })),
    ).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith({ message: 'm' });
  });

  it('never throws when the reporter throws', () => {
    const fn = register(() => {
      throw new Error('broken');
    });
    expect(() => fn({} as IpcMainInvokeEvent, {})).not.toThrow();
  });

  it('stays reachable while the session is locked, and is not a sale channel', () => {
    expect(LOCKED_ALLOWED_CHANNELS.has(REPORT_ERROR_CHANNEL)).toBe(true);
    expect(isSaleChannel(REPORT_ERROR_CHANNEL)).toBe(false);
    expect(isRefusedInRecoveryMode(REPORT_ERROR_CHANNEL)).toBe(false);
  });
});
