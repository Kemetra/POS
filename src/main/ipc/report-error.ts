import type { IpcMain } from 'electron';

/**
 * RT-634 (OBS-5) — `app:report-error` IPC handler.
 *
 * The renderer's only route to Sentry: an uncaught renderer error is sent here
 * as an untrusted `{ name, message, stack }` payload and handed to the
 * injected reporter (`observability/renderer-error-report.ts`), which
 * validates, caps, rate-limits and captures it in main. The handler resolves
 * `undefined` and never throws, so a broken reporter cannot bounce an error
 * back into the page that just failed.
 */

export const REPORT_ERROR_CHANNEL = 'app:report-error';

export function registerReportErrorHandler(
  ipcMain: IpcMain,
  report: (payload: unknown) => void,
): void {
  ipcMain.handle(REPORT_ERROR_CHANNEL, (_event, payload: unknown): undefined => {
    try {
      report(payload);
    } catch {
      // Best-effort: never reject into the renderer.
    }
    return undefined;
  });
}
